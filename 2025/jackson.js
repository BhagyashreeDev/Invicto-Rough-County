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

const generate_notes = (year, keys, status1, status2) => {
    let notes = "";
    try {
        notes =
            keys === 1
                ? `ALL PRIORS ARE PAID,`
                : `PRIORS ARE DELINQUENT,`;
        notes += ` ${year} 1ST INSTALLMENT IS ${status1.toUpperCase()}, 2ND INSTALLMENT IS ${status2.toUpperCase()},`;
        notes += ` NORMALLY TAXES ARE PAID SEMI-ANNUALLY,`;
        notes += ` NORMAL DUE DATES ARE 02/25 AND 08/26`;
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

    console.log(details);

    await page.waitForSelector('table[title="Valuation"]', { timeout: 30000 });

    const valuationData = await page.evaluate(() => {
        const rows = document.querySelectorAll('table[title="Valuation"] tbody tr');
        const results = [];

        rows.forEach(row => {
            const cols = row.querySelectorAll('td');
            if (cols.length >= 7) {
                results.push({
                    year: cols[0].innerText.trim(),
                    assessedTotal: cols[6].innerText.trim()
                });
            }
        });

        return results;
    });

    console.log(valuationData);

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

    console.log(pivotedTaxData);

    const paymentData = await page.evaluate(() => {
        const rows = document.querySelectorAll('table#DataTables_Table_6 tbody tr');
        const results = [];

        rows.forEach(row => {
            const cols = row.querySelectorAll('td');
            if (cols.length >= 3) {
                results.push({
                    paymentDate: cols[0].innerText.trim(),
                    cycle: cols[1].innerText.trim(),
                    firstHalfPaid: cols[3].innerText.trim(),
                    secondHalfPaid: cols[4].innerText.trim(),
                });
            }
        });

        return results;
    });

    console.log(paymentData);

    return { details, valuationData, pivotedTaxData, paymentData };
}

async function populateTheObject(page, accountNumber) {
    const scrapedData = await getDetails(page);
    const propertyObj = createPropertyObject();

    propertyObj.parcel_number = accountNumber;

    if (scrapedData.details["Owner"]) {
        propertyObj.owner_name = [scrapedData.details["Owner"]];
    }
    propertyObj.property_address = scrapedData.details["Address"] || "N/A";

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
        const shortYear = taxYearClean.slice(-2); // e.g., "25" for 2025
        const details = scrapedData.pivotedTaxData.details;
        const payableYear = parseInt(taxYearClean, 10) + 1;

        // Helper to clean and remove negative signs from payment amounts
        const cleanAmount = (val) => (val ? val.replace('-', '').trim() : "$0.00");
        const parseCurrency = (str) => parseFloat(str.replace(/[^0-9.-]+/g, "")) || 0;


        // Helper to find matching payment date
        const findPaymentDate = (installmentNum, expectedAmountStr) => {
            if (!scrapedData.paymentData) return "";
            const expectedAmount = parseCurrency(expectedAmountStr);
            if (expectedAmount === 0) return ""; // No payment was made

            const expectedCycle = `${installmentNum}-${shortYear}`; // e.g. "1-25" or "2-25"

            const match = scrapedData.paymentData.find(p => {
                const paidKey = installmentNum === 1 ? p.firstHalfPaid : p.secondHalfPaid;
                const paidAmt = parseCurrency(paidKey);
                return p.cycle === expectedCycle && paidAmt === expectedAmount;
            });
            return match ? match.paymentDate : "";
        };

        // Helper to calculate status
        const getStatus = (record) => {
            if (parseCurrency(record.amount_due) === 0) {
                return "Paid";
            } else {
                const today = new Date();
                const delqDateObj = new Date(record.delq_date);
                return (today <= delqDateObj) ? "Due" : "Delinquent";
            }
        };

        

        // First Half Installment
        const firstHalfObj = createTaxHistory();
        firstHalfObj.year = taxYearClean;
        firstHalfObj.payment_type = "Installment 1";
        firstHalfObj.base_amount = details.firstHalf["NET TAX"] || "$0.00";
        firstHalfObj.amount_paid = cleanAmount(details.firstHalf["NET PAID"]);
        firstHalfObj.amount_due = details.firstHalf["NET DUE"] || "$0.00";
        firstHalfObj.due_date = `02/25/${payableYear}`;
        firstHalfObj.delq_date = `02/26/${payableYear}`;
        firstHalfObj.paid_date = findPaymentDate(1, firstHalfObj.amount_paid);
        firstHalfObj.status = getStatus(firstHalfObj);
        propertyObj.tax_history.push(firstHalfObj);

        // Second Half Installment
        const secondHalfObj = createTaxHistory();
        secondHalfObj.year = taxYearClean;
        secondHalfObj.payment_type = "Installment 2";
        secondHalfObj.base_amount = details.secondHalf["NET TAX"] || "$0.00";
        secondHalfObj.amount_paid = cleanAmount(details.secondHalf["NET PAID"]);
        secondHalfObj.amount_due = details.secondHalf["NET DUE"] || "$0.00";
        secondHalfObj.due_date = `08/26/${payableYear}`;
        secondHalfObj.delq_date = `08/27/${payableYear}`;
        secondHalfObj.paid_date = findPaymentDate(2, secondHalfObj.amount_paid);
        secondHalfObj.status = getStatus(secondHalfObj);
        propertyObj.tax_history.push(secondHalfObj);

        propertyObj.tax_history.sort((a, b) => {
            const yearA = parseInt(a.year, 10) || 0;
            const yearB = parseInt(b.year, 10) || 0;
            if (yearA !== yearB) {
                return yearA - yearB;
            }
            if (a.status === "Paid" && b.status !== "Paid") return -1;
            if (a.status !== "Paid" && b.status === "Paid") return 1;
            return 0;
        });

        if (propertyObj.tax_history.length > 0) {
            // Check if ANY tax is delinquent for the main delinquency flag
            const hasDelinquent = propertyObj.tax_history.some(
                (t) => t.status === "DELINQUENT",
            );
            propertyObj.delinquent = hasDelinquent
                ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
                : "NONE";

            // Get the latest tax record (the array is sorted ascending by year)
            const latestTax = propertyObj.tax_history[propertyObj.tax_history.length - 1];

            // Find individual statuses for the 1st and 2nd installments of the latest year
            const latestYearRecords = propertyObj.tax_history.filter(t => String(t.year) === String(latestTax.year));
            const inst1 = latestYearRecords.find(t => t.payment_type === "Installment 1");
            const inst2 = latestYearRecords.find(t => t.payment_type === "Installment 2");

            const status1 = inst1 ? inst1.status : "UNKNOWN";
            const status2 = inst2 ? inst2.status : "UNKNOWN";

            // Check if any PRIOR year is delinquent (exclude the latest year)
            const hasPriorDelinquent = propertyObj.tax_history.some(
                (t) => t.status === "DELINQUENT" && String(t.year) !== String(latestTax.year)
            );

            // If priors are delinquent, keys = 0. If priors are paid, keys = 1.
            const keys = hasPriorDelinquent ? 0 : 1;
            propertyObj.notes = generate_notes(latestTax.year, keys, status1, status2);
        }
    }

    console.log("Populated Property Object:\n", JSON.stringify(propertyObj, null, 2));
    return propertyObj;
}

async function run(accountNumber) {
    try {
        const { browser, page } = await launchBrowser();

        await page.goto(
            `https://auditor.ashlandcountyoh.us/Parcel?Parcel=${accountNumber}`,
            { waitUntil: "networkidle2", ...timeout_option }
        );


        await populateTheObject(page, accountNumber);

        // await browser.close();
    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    }
}

run("B06-007-0-0011-06");
// https://jacksoncountyauditor.org/Parcel?Parcel=${accountNumber}
// https://auditorrealestate.fairfieldcountyohio.gov/Parcel?Parcel=${accountNumber}