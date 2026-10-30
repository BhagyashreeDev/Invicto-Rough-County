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
        taxing_authority: "",
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

async function getDetails(page) {
    const details = await page.evaluate(() => {
        const data = {};
        const rows = document.querySelectorAll('#Location table tr');

        rows.forEach(row => {
            const key = row.querySelector('th')?.innerText.trim();
            const value = row.querySelector('td')?.innerText.trim();
            if (key && value) {
                data[key] = value.replace(/\s+/g, ' ');
            }
        });

        return data;
    });

    await page.waitForSelector('table[title="Valuation"]', { timeout: 30000 });

    const valuationData = await page.evaluate(() => {
        const rows = document.querySelectorAll('table[title="Valuation"] tbody tr');
        const results = [];

        rows.forEach(row => {
            const cols = row.querySelectorAll('td');
            if (cols.length >= 7) {
                results.push({
                    year: cols[0].innerText.trim(),
                    appraisedLand: cols[1].innerText.trim(),
                    appraisedImprovements: cols[2].innerText.trim(),
                    appraisedTotal: cols[3].innerText.trim(),
                    assessedLand: cols[4].innerText.trim(),
                    assessedImprovements: cols[5].innerText.trim(),
                    assessedTotal: cols[6].innerText.trim(),
                    isPreliminary: cols[0].innerText.includes('*')
                });
            }
        });

        return results;
    });

    const pivotedTaxData = await page.evaluate(() => {
        const firstTab = document.querySelector('#taxBill-tabs .nav-link');
        if (!firstTab) return null;

        const yearLabel = firstTab.innerText.trim();
        const targetSelector = firstTab.getAttribute('data-target');
        const pane = document.querySelector(targetSelector);

        if (!pane) return null;

        const rows = pane.querySelectorAll('table tbody tr');
        const pivoted = {
            delinquent: {},
            firstHalf: {},
            secondHalf: {},
            total: {}
        };

        rows.forEach(row => {
            const cols = row.querySelectorAll('td, th');
            if (cols.length >= 4) {
                const label = cols[0].innerText.trim();

                if (label && !label.includes("GROSS TAX RATE") && !label.includes("EFFECTIVE TAX RATE")) {
                    const delinquentVal = cols[1]?.innerText.trim();
                    const firstHalfVal = cols[2]?.innerText.trim();
                    const secondHalfVal = cols[3]?.innerText.trim();
                    const totalVal = cols[4]?.innerText.trim();

                    if (delinquentVal) pivoted.delinquent[label] = delinquentVal;
                    if (firstHalfVal) pivoted.firstHalf[label] = firstHalfVal;
                    if (secondHalfVal) pivoted.secondHalf[label] = secondHalfVal;
                    if (totalVal) pivoted.total[label] = totalVal;
                }
            }
        });

        return { year: yearLabel, details: pivoted };
    });

    const paymentData = await page.evaluate(() => {
        const rows = document.querySelectorAll('table#taxPayments tbody tr');
        const results = [];

        rows.forEach(row => {
            const cols = row.querySelectorAll('td');
            if (cols.length >= 3) {
                results.push({
                    paymentDate: cols[0].innerText.trim(),
                    paymentDateSort: cols[0].getAttribute('data-sort') || '',
                    taxYear: cols[1].innerText.trim(),
                    amount: cols[2].innerText.trim()
                });
            }
        });

        return results;
    });

    return { details, valuationData, pivotedTaxData, paymentData };
}

async function populateTheObject(page, accountNumber) {
    const scrapedData = await getDetails(page);
    const propertyObj = createPropertyObject();

    propertyObj.parcel_number = accountNumber;
    
    if (scrapedData.details["Owner"]) {
        propertyObj.owner_name = [scrapedData.details["Owner"]];
    }
    propertyObj.property_address = scrapedData.details["Address"] || "";

    // Map valuation data (using the most recent entry index 0)
    if (scrapedData.valuationData && scrapedData.valuationData.length > 0) {
        const latestVal = scrapedData.valuationData[0];
        propertyObj.total_assessed_value = latestVal.assessedTotal;
        propertyObj.total_taxable_value = latestVal.assessedTotal;
    }

    // Process Tax History & Installments
    if (scrapedData.pivotedTaxData) {
        const taxYearFull = scrapedData.pivotedTaxData.year; // e.g., "2025 Payable 2026"
        const taxYearClean = taxYearFull.split(" ")[0]; // Extracts "2025"
        const details = scrapedData.pivotedTaxData.details;

        // Helper to clean and remove negative signs from payment amounts
        const cleanAmount = (val) => (val ? val.replace('-', '').trim() : "$0.00");
        const parseCurrency = (str) => parseFloat(str.replace(/[^0-9.-]+/g, "")) || 0;

        // Find all payments matching this specific tax year and sort them chronologically (oldest to newest)
        const yearPayments = scrapedData.paymentData
            .filter(p => p.taxYear === taxYearClean)
            .sort((a, b) => new Date(a.paymentDate) - new Date(b.paymentDate));

        // First Half Installment
        const firstHalfObj = createTaxHistory();
        firstHalfObj.year = taxYearClean;
        firstHalfObj.payment_type = "Installment 1";
        firstHalfObj.base_amount = details.firstHalf["Net General"] || "$0.00";
        firstHalfObj.amount_paid = cleanAmount(details.firstHalf["Payments Made"]);
        firstHalfObj.amount_due = details.firstHalf["Due"] || "$0.00";
        firstHalfObj.status = parseCurrency(firstHalfObj.amount_due) === 0 ? "Paid" : "Unpaid";

        // Second Half Installment
        const secondHalfObj = createTaxHistory();
        secondHalfObj.year = taxYearClean;
        secondHalfObj.payment_type = "Installment 2";
        secondHalfObj.base_amount = details.secondHalf["Net General"] || "$0.00";
        secondHalfObj.amount_paid = cleanAmount(details.secondHalf["Payments Made"]);
        secondHalfObj.amount_due = details.secondHalf["Due"] || "$0.00";
        secondHalfObj.status = parseCurrency(secondHalfObj.amount_due) === 0 ? "Paid" : "Unpaid";

        // Assign payment dates chronologically
        if (yearPayments.length === 1) {
            // Only 1 payment record found, apply to both installments
            firstHalfObj.paid_date = yearPayments[0].paymentDate;
            secondHalfObj.paid_date = yearPayments[0].paymentDate;
        } else if (yearPayments.length >= 2) {
            // Assign the earlier date to Installment 1 and the later date to Installment 2
            firstHalfObj.paid_date = yearPayments[0].paymentDate;
            secondHalfObj.paid_date = yearPayments[1].paymentDate;
        }

        propertyObj.tax_history.push(firstHalfObj, secondHalfObj);

        // Check overall delinquency status
        const totalDelinquentDue = details.delinquent["Due"] || "$0.00";
        if (parseCurrency(totalDelinquentDue) > 0) {
            propertyObj.delinquent = "YES";
        }
    }

    console.log("Populated Property Object:\n", JSON.stringify(propertyObj, null, 2));
    return propertyObj;
}

async function run(accountNumber) {
    try {
        const { browser, page } = await launchBrowser();

        await page.goto(
            `https://auditorrealestate.fairfieldcountyohio.gov/Parcel?Parcel=${accountNumber}`,
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await populateTheObject(page, accountNumber);

        // await browser.close();
    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    }
}

run("0360572900");
// https://jacksoncountyauditor.org/Parcel?Parcel=${accountNumber}