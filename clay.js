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
        total_assessed_value: "",
        exemption: "",
        total_taxable_value: "",
        delinquent: "NONE",
        taxing_authority: "",
        notes: "",
        tax_history: []
    };
}

function createTaxHistory() {
    return {
        jurisdiction: "County",
        year: "",
        payment_type: "Annual",
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

const generate_notes = (year, keys, status) => {
    let notes = "";
    try {
        const dueDate =
            new Date(year, 2, 0).getDate() === 29 ? "02/29" : "02/28";
        notes =
            keys === 1
                ? `ALL PRIORS ARE PAID, ${year} `
                : `PRIORS ARE DELINQUENT, ${year} `;
        notes += `TAXES ARE ${status.toUpperCase()},`;
        notes += ` NORMALLY TAXES ARE PAID ANNUALLY,`;
        notes += ` NORMAL DUE DATE IS ${dueDate}`;
    } catch (error) {
        console.log(error);
    } finally {
        return notes;
    }
};

async function getDuteDate(year) {
    const targetYear = Number(year) + 1;
    const lastDayOfFeb = new Date(targetYear, 2, 0).getDate();
    return `02/${String(lastDayOfFeb).padStart(2, '0')}/${targetYear}`;
}

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

async function searchMapNumber(propertyId, page) {
    const dropDownSelector = "#searchType";
    await page.waitForSelector(dropDownSelector, timeout_option);

    await page.select(dropDownSelector, "mapfields");
    await page.waitForSelector("#mapfields", { visible: true });

    const parts = propertyId.trim().split(/\s+/);
    let controlMap = "";
    let group = "";
    let parcel = "";
    let piSi = "";
    if (parts.length === 3) {
        controlMap = parts[0];
        parcel = parts[1].replace(/\D/g, '');
    } else if (parts.length === 4) {
        controlMap = parts[0];
        group = parts[1];
        parcel = parts[2].replace(/\D/g, '');
    }

    await page.waitForSelector("#map", timeout_option);
    await page.type("#map", controlMap);

    await page.waitForSelector("#group", timeout_option);
    await page.type("#group", group);

    await page.waitForSelector("#parcel", timeout_option);
    await page.type("#parcel", parcel);

    try {
        await page.waitForSelector("#submitbutton", timeout_option);
        await page.click("#submitbutton");
    } catch (error) {
        await page.keyboard.press("Enter");
    }
}

async function resultGrid(page) {
    await page.waitForSelector("#example", { visible: true });

    const viewButtonSelector = '#example tbody tr:first-of-type img[src*="images/view.png"]';

    await page.waitForSelector(viewButtonSelector, { attached: true });

    const isClicked = await page.evaluate((selector) => {
        const firstRowViewButton = document.querySelector(selector);
        if (firstRowViewButton) {
            firstRowViewButton.click();
            return true;
        }
        return false;
    }, viewButtonSelector);

    if (!isClicked) {
        throw new Error("View button not found in the first row.");
    }

    await page.waitForSelector("#tax-card-panel", { visible: true });
}

async function clickTaxHistoryTab(page) {
    await page.waitForSelector("#tax-card-tabs", { visible: true });
    const clicked = await page.evaluate(() => {
        const tabLinks = Array.from(document.querySelectorAll("#tax-card-tabs a"));
        const historyLink = tabLinks.find(el => el.innerText.includes("View Tax History"));
        if (historyLink) {
            historyLink.click();
            return true;
        }
        return false;
    });

    return clicked; // <-- Fixed: Added return statement so isClicked evaluates correctly
}

async function getRecordDetails(page) {
    const tableSelector = "#main #example";
    await page.waitForSelector(`${tableSelector} tbody tr`, { visible: true });

    const taxData = await page.evaluate((selector) => {
        const rows = document.querySelectorAll(`${selector} tbody tr`);
        let records = [];

        for (let row of rows) {

            const cells = row.querySelectorAll("td");
            // Make sure the row has enough columns
            if (cells.length < 5) continue;

            let details = {
                taxYear: cells[0].innerText.trim(),
                taxAmt: cells[2].innerText.trim(),
                paidAmt: cells[3].innerText.trim(),
                paidDate: cells[4].innerText.trim()
            };

            // Stop collecting if the Date Last Paid is a valid date (not "Unpaid" or empty)
            let isUnpaid = details.paidDate && details.paidDate.toLowerCase() === "unpaid";

            if (!isUnpaid) {
                // If the record IS PAID (has a date)...
                if (records.length === 0) {
                    // If we haven't found any unpaid records (meaning the property is fully paid up),
                    // add this very first paid record so the array isn't empty.
                    records.push(details);
                }
                // Then immediately break the loop so we don't look at older paid years.
                break;
            } else {
                // If the record is UNPAID, always add it.
                records.push(details);
            }

        }

        return records;
    }, tableSelector);

    console.log("Tax Data:", taxData);
    return taxData;
}

async function parseThePopUpGrid(page) {
    const tableSelector = "table.cardInfo";
    await page.waitForSelector(tableSelector, { visible: true });

    const propertyDetails = await page.evaluate((selector) => {
        const rows = document.querySelectorAll(`${selector} tr`);

        let details = {
            owner: "",
            propertyAddress: "",
            status: "",
            taxAmount: "",
            assessedValue: ""
        };

        rows.forEach(row => {
            const cells = row.querySelectorAll("td");
            if (cells.length >= 2) {
                const label = cells[0].innerText.trim().replace(/:$/, '');
                const value = cells[1].innerText.trim();

                if (label === "Owner") details.owner = value;
                if (label === "Property Address") details.propertyAddress = value;
                if (label === "Status") details.status = value;
                if (label === "Tax Amount") details.taxAmount = value;
                if (label === "Assessed Value") details.assessedValue = value;
            }
        });

        return details;
    }, tableSelector);

    const isClicked = await clickTaxHistoryTab(page);
    let taxData;
    if (isClicked) {
        taxData = await getRecordDetails(page);
    }

    const result = await populateTheObjects(propertyDetails, taxData);
    return result;
}

async function populateTheObjects(propertyDetails, taxData) {
    const result = new createPropertyObject();
    result.owner_name = propertyDetails.owner ? propertyDetails.owner : "N/A";
    result.property_address = propertyDetails.propertyAddress ? propertyDetails.propertyAddress : "N/A";
    result.total_assessed_value = propertyDetails.assessedValue ? propertyDetails.assessedValue : "N/A";
    result.total_taxable_value = result.total_assessed_value;

    for (const item of taxData) {
        const record = new createTaxHistory();
        record.year = item.taxYear;
        record.due_date = await getDuteDate(record.year);
        record.delq_date = `03/01/${parseInt(record.year, 10) + 1}`;

        if (propertyDetails.status === "PAID") {
            record.status = "Paid";
            record.base_amount = propertyDetails.taxAmount ? propertyDetails.taxAmount : item.paidAmt;
            record.amount_paid = item.paidAmt;
            record.paid_date = item.paidDate;
            record.amount_due = "$0.00";
        } else {
            const today = new Date();
            const dueDateObj = new Date(record.due_date);

            if (today <= dueDateObj) {
                record.status = "Due";
            } else {
                record.status = "Delinquent";
            }
            record.base_amount = propertyDetails.taxAmount ? propertyDetails.taxAmount : item.taxAmt;
            record.amount_due = item.taxAmt;
            record.amount_paid = item.paidAmt;
        }

        result.tax_history.push(record);
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
        // Check if ANY tax is delinquent for the main delinquency flag
        const hasDelinquent = result.tax_history.some(
            (t) => t.status === "Delinquent",
        );
        result.delinquent = hasDelinquent
            ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
            : "NONE";

        // Get the latest tax record (the array is sorted ascending by year)
        const latestTax = result.tax_history[result.tax_history.length - 1];

        // Check if any PRIOR year is delinquent (exclude the latest year)
        const hasPriorDelinquent = result.tax_history.some(
            (t) => t.status === "Delinquent" && String(t.year) !== String(latestTax.year)
        );

        // If priors are delinquent, keys = 0. If priors are paid, keys = 1.
        const keys = hasPriorDelinquent ? 0 : 1;
        result.notes = generate_notes(latestTax.year, keys, latestTax.status);
    }
    return result;
}

async function run(propertyId) {
    try {
        const { browser, page } = await launchBrowser();

        await page.goto(
            "https://tennesseetrustee.org/index.php?entity=FENTRESS&state=TN",
            { waitUntil: "domcontentloaded", ...timeout_option }
        );

        await searchMapNumber(propertyId, page);
        await resultGrid(page);
        const result = await parseThePopUpGrid(page);
        result.parcel_number = propertyId;
        console.log(result);
        return result;
    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    }
}

run("053P A 01001P 002");