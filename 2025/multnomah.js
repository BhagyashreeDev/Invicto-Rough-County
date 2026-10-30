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
        taxing_authority: "Multnomah County Tax Collector, 501 SE Hawthorne Blvd, Portland, OR 97214",
        notes: "",
        delinquent: "NONE",
        tax_history: [],
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

const generate_notes = (year, keys, status) => {
    let notes = "";
    try {
        notes =
            keys === 1
                ? `ALL PRIORS ARE PAID, ${year} `
                : `PRIORS ARE DELINQUENT, ${year} `;
        notes += `TAXES ARE ${status.toUpperCase()},`;
        notes += ` NORMALLY TAXES ARE PAID TRIMESTERLY,`;
        notes += ` NORMAL DUE DATES ARE 11/16, 02/16 AND 05/17`
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

async function searchAccountNumber(page) {
    const rowSelector = '#grid tbody tr.k-master-row';
    await page.waitForSelector(rowSelector, { visible: true });

    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.click(rowSelector)
    ]);
}

async function getDetails(page) {
    await page.waitForSelector("#dnn_ctr380_View_divOwnersLabel", timeout_option);

    // 1. Extract Header & Assessed Values from Details view
    const generalData = await page.evaluate(() => {
        const cleanText = (el) => el ? el.textContent.replace(/\s+/g, ' ').trim() : "";
        const ownerName = cleanText(document.querySelector("#dnn_ctr380_View_divOwnersLabel"));
        const address = cleanText(document.querySelector("#dnn_ctr380_View_tdPropertyAddress")).replace(/^Property Address:\s*/i, '');
        const assessedValue = cleanText(document.querySelector("#dnn_ctr380_View_tdTotalAssessedValue")).replace(/^.*Assessed Value:\s*/i, '');
        return { ownerName, address, assessedValue };
    });

    // 2. Switch to Bills Tab
    await page.waitForSelector("#tdBillsTab", timeout_option);
    await page.click("#tdBillsTab");

    // 3. Click Details button to expand installment rows
    await page.waitForSelector(".billDetails", timeout_option);
    await page.evaluate(() => {
        const detailsBtn = document.querySelector(".billDetails");
        if (detailsBtn && detailsBtn.getAttribute("aria-expanded") !== "true") {
            detailsBtn.click();
        }
    });
    // Wait briefly for installments to expand
    await new Promise(r => setTimeout(r, 600));

    // 4. Extract Tax History with Year & Installment logic
    const taxHistory = await page.evaluate(() => {
        const cleanText = (el) => el ? el.textContent.replace(/\s+/g, ' ').trim() : "";
        const parseCurrency = (str) => parseFloat(str.replace(/[^0-9.-]/g, '')) || 0;

        // Group rows by tax year
        const yearGroups = [];
        let currentYear = null;

        const rows = document.querySelectorAll("#tblBillsData tbody tr");
        rows.forEach((row) => {
            const tds = row.querySelectorAll("td");

            if (row.classList.contains("billsTaxYearRow") && tds.length >= 8) {
                const yearText = cleanText(tds[0]).replace(/^TAXYEAR:\s*/i, '');
                const totalBilled = cleanText(tds[1]).replace(/^TOTAL BILLED:\s*/i, '');
                const totalOwed = cleanText(tds[tds.length - 1]).replace(/^TOTAL OWED:\s*/i, '');

                currentYear = {
                    year: yearText,
                    totalBilled,
                    totalOwed,
                    owedAmount: parseCurrency(totalOwed),
                    installments: []
                };
                yearGroups.push(currentYear);
            } else if (row.classList.contains("installmentRow") && currentYear && tds.length >= 8) {
                currentYear.installments.push({
                    name: cleanText(tds[0]),
                    billed: cleanText(tds[1]),
                    paidDateRaw: cleanText(tds[6]),
                    owed: cleanText(tds[7])
                });
            }
        });

        // Collect years according to owed status
        const selectedYears = [];
        if (yearGroups.length > 0) {
            const firstYear = yearGroups[0];

            if (firstYear.owedAmount === 0) {
                // If the most recent year itself is paid, take ONLY that year
                selectedYears.push({ ...firstYear, isPaidYear: true });
            } else {
                // Collect consecutive owed years until the first non-owed year
                for (const yr of yearGroups) {
                    if (yr.owedAmount > 0) {
                        selectedYears.push({ ...yr, isPaidYear: false });
                    } else {
                        break;
                    }
                }
            }
        }

        // Build Tax History Records
        const records = [];
        selectedYears.forEach((yr) => {
            const y = parseInt(yr.year, 10);

            yr.installments.forEach((inst) => {
                const isFirst = /1/.test(inst.name);
                const isSecond = /2/.test(inst.name);
                const payment_type = isFirst ? "Trimester 1" : isSecond ? "Trimester 2" : "Trimester 3";

                // Due & Delinquent dates
                let due_date = "";
                let delq_date = "";

                if (isFirst) {
                    due_date = `11/16/${y}`;
                    delq_date = `11/17/${y}`;
                } else if (isSecond) {
                    due_date = `02/16/${y + 1}`;
                    delq_date = `02/17/${y + 1}`;
                } else {
                    due_date = `05/17/${y + 1}`;
                    delq_date = `05/18/${y + 1}`;
                }

                const base_amount = inst.billed;
                const paid_date = inst.paidDateRaw && inst.paidDateRaw !== "-"
                    ? inst.paidDateRaw.replace(/-/g, "/")
                    : "";

                // --- AMOUNTS LOGIC ---
                const owedNum = parseCurrency(inst.owed);
                let amount_due = "$0.00";
                let amount_paid = "$0.00";

                if (owedNum === 0) {
                    amount_due = "$0.00";
                    amount_paid = base_amount; // Paid in full
                } else {
                    amount_due = inst.owed;     // Still owed
                    amount_paid = "$0.00";     // Unpaid
                }

                // Status decision logic
                let status = "";
                if (amount_due === "$0.00") {
                    status = "Paid";
                } else {
                    const today = new Date();
                    const dueDateObj = new Date(due_date);
                    if (today <= dueDateObj) {
                        status = "Due";
                    } else {
                        status = "Delinquent";
                    }
                }

                records.push({
                    jurisdiction: "County",
                    year: yr.year,
                    payment_type,
                    status,
                    base_amount,
                    amount_paid,
                    amount_due,
                    mailing_date: "N/A",
                    due_date,
                    delq_date,
                    paid_date,
                    good_through_date: "-",
                });
            });
        });

        return records;
    });

    return {
        ...generalData,
        taxHistory
    };
}

async function populateObject(accountNumber, data) {
    const property = createPropertyObject();

    property.parcel_number = accountNumber;
    property.owner_name = data.ownerName ? [data.ownerName] : [];
    property.property_address = data.address || "";
    property.total_assessed_value = data.assessedValue || "";
    property.total_taxable_value = data.assessedValue || "";
    property.tax_history = data.taxHistory || [];

    property.tax_history.sort((a, b) => {
        const yearA = parseInt(a.year, 10) || 0;
        const yearB = parseInt(b.year, 10) || 0;
        if (yearA !== yearB) {
            return yearA - yearB;
        }
        if (a.status === "Paid" && b.status !== "Paid") return -1;
        if (a.status !== "Paid" && b.status === "Paid") return 1;
        return 0;
    });

    // Generate Delinquent String & Notes based on history
    if (property.tax_history.length > 0) {
        const hasDelinquent = property.tax_history.some(t => t.status === "Delinquent");
        property.delinquent = hasDelinquent
            ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
            : "NONE";

        const latestTax = property.tax_history[property.tax_history.length - 1]; // Since the first item is the most recent
        const hasPriorDelinquent = property.tax_history.some(
            (t, index) => t.status === "Delinquent" && index !== 0
        );

        const keys = hasPriorDelinquent ? 0 : 1;
        property.notes = generate_notes(latestTax.year, keys, latestTax.status);
    }
    return property;
}

async function run(accountNumber) {
    try {
        const { browser, page } = await launchBrowser();

        await page.goto(
            `https://multcoproptax.com/Property-Search-Subscribed?searchtext=${accountNumber}`,
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(page);

        const data = await getDetails(page);

        const finalResult = await populateObject(accountNumber, data);

        console.log("\n================ FINAL RESULT ================");
        console.log(JSON.stringify(finalResult, null, 2));

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    }
}

run("R197426");