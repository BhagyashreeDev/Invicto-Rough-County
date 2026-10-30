import puppeteer from "puppeteer";

const timeout_option = {
    timeout: 90000,
};

function createPropertyObject() {
    return {
        processed_date: "",
        order_number: "",
        borrower_name: "",
        owner_name: [],
        property_address: "",
        parcel_number: "",
        land_value: "",
        improvements: "",
        total_assessed_value: "N/A",
        exemption: "",
        total_taxable_value: "N/A",
        delinquent: "NONE",
        taxing_authority: "Charlotte County Treasurer, P.O. Box 101, Charlotte Court House, VA 23923",
        notes: "",
        tax_history: []
    };
}

function createTaxHistory() {
    return {
        jurisdiction: "County",
        year: "",
        payment_type: "",
        status: "",
        base_amount: "",
        amount_paid: "",
        amount_due: "",
        mailing_date: "N/A",
        due_date: "",
        delq_date: "",
        paid_date: "",
        good_through_date: "-",
    };
}

const generate_notes = (year, keys, status1, status2) => {
    let notes = "";
    try {
        notes =
            keys === 1
                ? `ALL PRIORS ARE PAID,`
                : `PRIORS ARE DELINQUENT,`;
        notes += ` ${year} 1ST INSTALLMENT IS ${status1.toUpperCase()}, 2ND INSTALLMENT IS ${status2.toUpperCase()},`;
        notes += ` NORMALLY TAXES ARE PAID SEMI-ANNUALLY,`;
        notes += ` NORMAL DUE DATES ARE 06/05 AND 12/05`;
    } catch (error) {
        console.log(error);
    } finally {
        return notes;
    }
};

async function launchBrowser() {
    const browser = await puppeteer.launch({
        headless: false,
        defaultViewport: null,
        args: ["--start-maximized"],
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60_000);
    page.setDefaultTimeout(30_000);
    return { browser, page };
}

async function searchAccountNumber(mapID, page) {
    await page.waitForSelector("#reiSearch", timeout_option);
    await page.type("#reiSearch", mapID);

    const btnSelector = "button[ng-click='searchChg()'][type='submit']";
    await page.waitForSelector(btnSelector, timeout_option);
    await page.click(btnSelector);
}

async function handleDisclaimer(page) {
    await page.waitForSelector("#loginForm", timeout_option);
    await page.waitForSelector('button[ng-click="goToPPB()"]');

    await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.click('button[ng-click="goToREI()"]')
    ]);

    await page.waitForSelector("#disclaimer", timeout_option);
    const acceptBtnSelector = 'button[ng-click="acceptDisclaimer()"]';

    await page.waitForSelector(acceptBtnSelector, {
        visible: true,
        ...timeout_option
    });

    await page.click(acceptBtnSelector);
}

/**
 * Finds the card containing mapID inside its Description, gets the Deeded Owner,
 * and clicks the Select button in that matching card.
 */
async function selectRowByMapID(page, mapID) {
    const resultCardSelector = "div[ng-repeat*='billableLookup']";
    await page.waitForSelector(resultCardSelector, timeout_option);

    const matchedCardHandle = await page.evaluateHandle((searchID) => {
        const normalize = (str) => str.replace(/[\u00A0\s]+/g, ' ').trim().toLowerCase();
        const target = normalize(searchID);

        const cards = Array.from(document.querySelectorAll("div[ng-repeat*='billableLookup']"));
        for (const card of cards) {
            const h6Elements = Array.from(card.querySelectorAll("h6"));
            const descHeader = h6Elements.find(
                (h6) => h6.innerText.trim().toLowerCase() === "description"
            );
            if (descHeader && descHeader.parentElement) {
                const descText = descHeader.parentElement.querySelector("p")?.innerText || "";
                if (normalize(descText).includes(target)) {
                    return card;
                }
            }
        }
        return null;
    }, mapID);

    const card = matchedCardHandle.asElement();
  
    // Extract Deeded Owner from the matched card
    const deededOwner = await page.evaluate((cardEl) => {
        const h6Elements = Array.from(cardEl.querySelectorAll("h6"));
        const targetHeader = h6Elements.find(
            (h6) => h6.innerText.trim().toLowerCase() === "deeded owner"
        );
        if (targetHeader && targetHeader.parentElement) {
            const p = targetHeader.parentElement.querySelector("p");
            return p ? p.innerText.trim() : "";
        }
        return "";
    }, card);

    // Locate and click the Select button in the matched card
    const selectBtn = await card.$("button[ng-click*='selectButtonClicked']");
    if (!selectBtn) {
        await matchedCardHandle.dispose();
        throw new Error(`Select button not found inside matching row for Map ID: "${mapID}"`);
    }

    await selectBtn.click();
    await matchedCardHandle.dispose();

    return deededOwner;
}

async function getDetails(page) {
    await page.waitForSelector("#detailTotalsGrid tbody tr[data-uid]", timeout_option);

    const data = await page.evaluate(() => {
        const trs = document.querySelectorAll('#detailTotalsGrid table[role="grid"] tbody tr');

        let parcelAddress = "";
        const duesRecords = [];
        let isFirstRow = true;

        for (const tr of trs) {
            const cells = tr.querySelectorAll("td");

            if (!parcelAddress) {
                parcelAddress = cells[2].innerText.trim();
            }

            const dueText = cells[19].innerText.trim();
            const dueAmount = parseFloat(dueText.replace(/[^0-9.-]+/g, "")) || 0;

            const recordObject = {
                taxYear: cells[0].innerText.trim(),
                bill1Total: cells[14].innerText.trim(),
                bill1Balance: cells[16].innerText.trim(),
                bill2Total: cells[17].innerText.trim(),
                bill2Balance: cells[18].innerText.trim(),
                dueNow: dueText
            };

            if (isFirstRow) {
                duesRecords.push(recordObject);
                if (dueAmount <= 0) {
                    break;
                }
                isFirstRow = false;
            } else {
                if (dueAmount > 0) {
                    duesRecords.push(recordObject);
                } else {
                    break;
                }
            }
        }

        return {
            parcelAddress,
            duesRecords
        };
    });

    return data;
}

async function populateTheObject(deededOwner, gridData) {
    const result = createPropertyObject();

    if (deededOwner) {
        result.owner_name.push(deededOwner);
    }
    result.property_address = gridData.parcelAddress ? gridData.parcelAddress : "N/A";

    for (const item of gridData.duesRecords) {
        // Installment 1
        const record1 = createTaxHistory();
        record1.year = item.taxYear;
        record1.payment_type = "Installment 1";
        record1.base_amount = item.bill1Total;
        record1.amount_due = item.bill1Balance;
        record1.due_date = `06/05/${item.taxYear}`;
        record1.delq_date = `06/06/${item.taxYear}`;
        if (record1.amount_due === "$0.00") {
            record1.amount_paid = record1.base_amount;
            record1.status = "Paid";
            record1.paid_date = "N/A";
        } else {
            record1.amount_paid = "$0.00";
            const today = new Date();
            const dueDateObj = new Date(record1.due_date);
            if (today <= dueDateObj) {
                record1.status = "Due";
            } else {
                record1.status = "Delinquent";
            }
        }

        // Installment 2
        const record2 = createTaxHistory();
        record2.year = item.taxYear;
        record2.payment_type = "Installment 2";
        record2.base_amount = item.bill2Total;
        record2.amount_due = item.bill2Balance;
        record2.due_date = `12/05/${item.taxYear}`;
        record2.delq_date = `12/06/${item.taxYear}`;
        if (record2.amount_due === "$0.00") {
            record2.amount_paid = record2.base_amount;
            record2.status = "Paid";
            record2.paid_date = "N/A";
        } else {
            record2.amount_paid = "$0.00";
            const today = new Date();
            const dueDateObj = new Date(record2.due_date);
            if (today <= dueDateObj) {
                record2.status = "Due";
            } else {
                record2.status = "Delinquent";
            }
        }

        result.tax_history.push(record1, record2);
    }

    result.tax_history.sort((a, b) => {
        const yearA = parseInt(a.year, 10) || 0;
        const yearB = parseInt(b.year, 10) || 0;
        if (yearA !== yearB) {
            return yearA - yearB;
        }
        if (a.status === "Paid" && b.status !== "Paid") return -1;
        if (a.status !== "Paid" && b.status === "Paid") return 1;
        return 0;
    });

    if (result.tax_history.length > 0) {
        const hasDelinquent = result.tax_history.some(
            (t) => t.status === "Delinquent",
        );
        result.delinquent = hasDelinquent
            ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
            : "NONE";

        const latestTax = result.tax_history[result.tax_history.length - 1];
        const latestYearRecords = result.tax_history.filter(t => String(t.year) === String(latestTax.year));
        const inst1 = latestYearRecords.find(t => t.payment_type === "Installment 1");
        const inst2 = latestYearRecords.find(t => t.payment_type === "Installment 2");

        const status1 = inst1 ? inst1.status : "UNKNOWN";
        const status2 = inst2 ? inst2.status : "UNKNOWN";

        const hasPriorDelinquent = result.tax_history.some(
            (t) => t.status === "Delinquent" && String(t.year) !== String(latestTax.year)
        );

        const keys = hasPriorDelinquent ? 0 : 1;
        result.notes = generate_notes(latestTax.year, keys, status1, status2);
    }

    return result;
}

async function run(mapID) {
    let browserContext;
    try {
        const { browser, page } = await launchBrowser();
        browserContext = browser;

        await page.goto(
            "https://charlotte-revmgt.secure.openrda.net/portal/#/dashboard/",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await handleDisclaimer(page);
        await searchAccountNumber(mapID, page);

        // Locates row matching mapID, returns deeded owner, and clicks "Select"
        const deededOwner = await selectRowByMapID(page, mapID);

        const gridData = await getDetails(page);
        const result = await populateTheObject(deededOwner, gridData);

        console.log("Final Extracted Record:", JSON.stringify(result, null, 2));

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    }
}

run("065- - A- - - 30");