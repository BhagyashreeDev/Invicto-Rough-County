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
        taxing_authority: "Cass County Finance Office, 211 9th Street South, Fargo, ND 58103",
        notes: "",
        tax_history: []
    };
}

function createTaxHistory() {
    return {
        jurisdiction: "County",
        year: "",
        payment_type: "Semi-Annual",
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

async function getPropertyDetails(page) {
    await page.waitForSelector("#propertyDetailParcelTemplateDiv", { visible: true });
    const tableSelector = "#propertyDetailParcelTemplateDiv > table > tr";
    const data = await page.evaluate((selector) => {
        const rows = Array.from(document.querySelectorAll('table.propertyDetails tr'));
        let owner = '';
        let address = '';

        rows.forEach(row => {
            const thText = row.querySelector('th')?.innerText.trim();
            const tdElement = row.querySelector('td');

            if (thText === 'Owner:') owner = tdElement ? tdElement.innerText.trim() : '';
            else if (thText === 'Address:') address = tdElement ? tdElement.innerText.trim() : '';
        });
        return { owner, address };
    }, tableSelector);
    return data;
}

async function getAssessedValue(page) {
    await page.waitForSelector("#propertyDetailParcelTemplateDiv, #InactiveMessageDiv", { visible: true });
    const isInactive = await page.evaluate(() => {
        const inactiveMsg = document.querySelector("#InactiveMessageDiv");
        return inactiveMsg && inactiveMsg.style.display === "block";
    });

    if (isInactive) return "Inactive";

    await page.waitForSelector("#propertyDetailAssessmentsTemplateDiv", { visible: true });
    const value = await page.evaluate((containerSelector) => {
        const container = document.querySelector(containerSelector);
        if (!container) return null;

        const firstRow = container.querySelector("table tbody tr.odd");
        if (!firstRow) return null;

        const cells = Array.from(firstRow.querySelectorAll('td'));
        return cells[9] ? cells[9].innerText.trim() : null;
    }, "#propertyDetailAssessmentsTemplateDiv");

    return value;
}

async function getRecord(page) {
    await page.waitForSelector("#propertyDetailStatementsTemplateDiv", { visible: true });

    // Extract all relevant columns from the main statement row
    const paidRecord = await page.evaluate((containerSelector) => {
        const container = document.querySelector(containerSelector);
        const firstRow = container.querySelector("table tbody tr.odd");
        if (!firstRow) return null;

        const cells = Array.from(firstRow.querySelectorAll("td"));
        const year = cells[0]?.innerText.trim();
        const baseTax = cells[3]?.innerText.trim();
        const penalty = cells[4]?.innerText.trim();
        const interest = cells[5]?.innerText.trim();
        const discount = cells[6]?.innerText.trim();
        const paidTax = cells[7]?.innerText.trim();
        const balanceDue = cells[8]?.innerText.trim();

        if (baseTax === "$0.00" && paidTax === "$0.00") {
            return { year, baseTax, paidTax, balanceDue, history: [] };
        }

        const paidLink = cells[7]?.querySelector('a');
        if (paidLink) paidLink.click();

        return { year, baseTax, penalty, interest, discount, paidTax, balanceDue };
    }, "#propertyDetailStatementsTemplateDiv");

    if (!paidRecord) return null;
    if (paidRecord.history) return paidRecord;

    await page.waitForFunction(() => {
        const wrappers = document.querySelectorAll("#paymentHistoryWrapperDiv");
        for (const wrapper of wrappers) {
            if (wrapper.offsetParent !== null) {
                const dataRows = wrapper.querySelectorAll("table tbody tr.odd, table tbody tr.even");
                if (dataRows.length > 0) return true;
            }
        }
        return false;
    }, { timeout: 30000 });

    const history = await page.evaluate(() => {
        const wrappers = document.querySelectorAll("#paymentHistoryWrapperDiv");
        let results = [];

        for (const wrapper of wrappers) {
            if (wrapper.offsetParent === null) continue;

            const rows = wrapper.querySelectorAll("table tbody tr");
            for (const row of rows) {
                const cells = row.querySelectorAll("td");
                // Remove parenthesis for negative values in history if any, or just grab the exact string
                if (cells.length >= 3 && cells[0].innerText.trim() !== "Date") {
                    results.push({
                        date: cells[0].innerText.trim(),
                        amount: cells[2].innerText.trim()
                    });
                }
            }
        }
        return results;
    });

    return { ...paidRecord, history };
}

// Helpers for Math
const toCurrency = (num) => "$" + num.toFixed(2).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const parseCurrency = (val) => val ? parseFloat(val.replace(/[^0-9.-]+/g, "")) : 0;

async function populateTheObject(data, assessedValue, taxDetails, accountNumber) {
    const result = createPropertyObject();

    result.parcel_number = accountNumber;
    if (data.owner) result.owner_name.push(data.owner);
    result.property_address = data.address;
    result.total_assessed_value = assessedValue;
    result.total_taxable_value = assessedValue;

    if (!taxDetails) return result;

    const year = parseInt(taxDetails.year);
    const baseTax = parseCurrency(taxDetails.baseTax);
    const paidTax = parseCurrency(taxDetails.paidTax);
    const balanceDue = parseCurrency(taxDetails.balanceDue);
    const history = taxDetails.history || [];

    // Finds the exact date from the history array matching the target amount
    const getExactDateForAmount = (targetAmount) => {
        const exactMatch = history.find(h => Math.abs(parseCurrency(h.amount)) === Math.abs(targetAmount));
        return exactMatch ? exactMatch.date : "";
    };

    if (baseTax === 0 && paidTax === 0) {
        const record = createTaxHistory();
        record.year = year.toString();
        record.status = "Paid";
        record.base_amount = "$0.00";
        record.amount_paid = "$0.00";
        record.amount_due = "$0.00";
        record.due_date = `03/01/${year + 1}`;
        record.delq_date = `03/02/${year + 1}`;
        record.paid_date = "";
        result.tax_history.push(record);
    }
    else {
        // Construct the two standard installments
        let inst1 = createTaxHistory();
        inst1.year = year.toString();
        inst1.due_date = `03/01/${year + 1}`;
        inst1.delq_date = `03/02/${year + 1}`;

        let inst2 = createTaxHistory();
        inst2.year = year.toString();
        inst2.due_date = `10/15/${year + 1}`;
        inst2.delq_date = `10/16/${year + 1}`;

        if (balanceDue > 0) {
            // Partial payment scenario (Typically the 1st installment is paid, 2nd is the balance)
            // The paidTax goes to Inst 1, and the balanceDue goes to Inst 2.

            const halfBase = Math.round((baseTax / 2) * 100) / 100;

            inst1.base_amount = toCurrency(halfBase);
            inst1.amount_paid = toCurrency(paidTax);
            inst1.amount_due = "$0.00";
            inst1.status = "Paid";
            inst1.paid_date = getExactDateForAmount(paidTax); // Exact match from history

            inst2.base_amount = toCurrency(halfBase);
            inst2.amount_paid = "$0.00";
            inst2.amount_due = toCurrency(balanceDue);
            const today = new Date();
            const dueDateObj = new Date(inst2.due_date);

            if (today <= dueDateObj) {
                inst2.status = "Due";
            } else {
                inst2.status = "Delinquent";
            }
            inst2.paid_date = "";

        } else {
            // Fully paid scenario (Balance is 0)
            // They might have paid it in one lump sum or two separate payments.

            // Check if there is one giant lump sum payment matching the total paid amount
            const lumpSumDate = getExactDateForAmount(paidTax);

            if (lumpSumDate) {
                // Paid all at once
                const halfPaid = Math.round((paidTax / 2) * 100) / 100;
                const halfBase = Math.round((baseTax / 2) * 100) / 100;

                inst1.base_amount = toCurrency(halfBase);
                inst1.amount_paid = toCurrency(halfPaid);
                inst1.amount_due = "$0.00";
                inst1.status = "Paid";
                inst1.paid_date = lumpSumDate;

                // Subtracting from the total for the second installment ensures no 1-cent rounding errors
                inst2.base_amount = toCurrency(baseTax - halfBase);
                inst2.amount_paid = toCurrency(paidTax - halfPaid);
                inst2.amount_due = "$0.00";
                inst2.status = "Paid";
                inst2.paid_date = lumpSumDate;
            } else {
                // Handle scenario where it was paid in multiple chunks here if needed
            }
        }
        result.tax_history.push(inst1, inst2);
    }

    console.dir(result, { depth: null });
    return result;
}

async function run(accountNumber) {
    let browser, page;
    try {
        const setup = await launchBrowser();
        browser = setup.browser;
        page = setup.page;

        await page.goto(
            `https://proptax.casscountynd.gov/#Property=${accountNumber}`,
            { waitUntil: "networkidle2", ...timeout_option }
        );

        const data = await getPropertyDetails(page);
        const assessedValue = await getAssessedValue(page);

        if (assessedValue === "Inactive") {
            console.log("Parcel is inactive.");
            return;
        }

        const taxDetails = await getRecord(page);

        await populateTheObject(data, assessedValue, taxDetails, accountNumber);

    } catch (err) {
        console.log("Error during execution: ", err);
    } finally {
    }
}

run("72-0100-00080-000");