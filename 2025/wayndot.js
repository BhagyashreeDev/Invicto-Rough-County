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
        taxing_authority: "Wyandot County Treasurer, 109 S Sandusky Avenue, Room 22, Upper Sandusky, OH 43351",
        notes: "",
        delinquent: "NONE",
        tax_history: [],
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

const generate_notes = (year, keys, status1, status2) => {
    let notes = "";
    try {
        notes =
            keys === 1
                ? `ALL PRIORS ARE PAID,`
                : `PRIORS ARE DELINQUENT,`;
        notes += ` ${year} 1ST INSTALLMENT IS ${(status1).toUpperCase()}, 2ND INSTALLMENT IS ${(status2).toUpperCase()},`;
        notes += ` NORMALLY TAXES ARE PAID SEMI-ANNUALLY,`;
        notes += ` NORMAL DUE DATES ARE 02/20 AND 07/17`;
    } catch (error) {
        console.log(error);
    } finally {
        return notes;
    }
};

const formatCurrency = (val) => {
    if (val === null || val === undefined || val === '') return '$0.00';
    const num = parseFloat(String(val).replace(/[^0-9.-]/g, ''));
    if (isNaN(num)) return '$0.00';
    return `$${num.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
};

const parseCurrency = (str) => {
    if (!str) return 0;
    return parseFloat(String(str).replace(/[^0-9.-]/g, '')) || 0;
};

const formatDate = (dateStr) => {
    if (!dateStr || dateStr === "N/A" || dateStr === "-") return "";
    const clean = dateStr.trim();
    const parts = clean.split('/');
    if (parts.length === 3) {
        const mm = parts[0].padStart(2, '0');
        const dd = parts[1].padStart(2, '0');
        let yyyy = parts[2];
        if (yyyy.length === 2) yyyy = `20${yyyy}`;
        return `${mm}/${dd}/${yyyy}`;
    }
    const d = new Date(dateStr);
    if (!isNaN(d.getTime())) {
        const mm = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${mm}/${dd}/${d.getFullYear()}`;
    }
    return dateStr;
};

function setRecordStatus(record) {
    if (record.amount_due === "$0.00") {
        record.status = "Paid";
    } else {
        const today = new Date();
        const dueDateObj = new Date(record.due_date);
        if (today <= dueDateObj) {
            record.status = "Due";
        } else {
            record.status = "Delinquent";
        }
    }
}

async function launchBrowser() {
    const browser = await puppeteer.launch({
        headless: false,
        args: [
            '--disable-gpu',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--lang="en-US"',
            "--disable-features=HttpsFirstBalancedModeAutoEnable"
        ],
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60_000);
    page.setDefaultTimeout(30_000);
    return { browser, page };
}

async function searchAccountNumber(accountNumber, page) {
    const cleanAccount = accountNumber.replace(/[-.]/g, '');
    const url = `http://realestate.co.wyandot.oh.us/re/re-chg.php?account=${cleanAccount}&rec=&detail=Y`;
    try {
        await page.goto(url, { waitUntil: "networkidle2", ...timeout_option });
    } catch (err) {
        console.log("Navigation note:", err?.message || err);
    }
}

async function getDetails(page) {

    const data = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("#maintable tbody tr"));

        const getCleanText = (row, selector = 'td:first-child') => {
            const cell = row?.querySelector(selector);
            return cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '';
        };

        const ownerLine1 = getCleanText(rows[1]);
        const addressLine1 = getCleanText(rows[3]);
        const addressLine2 = getCleanText(rows[4]);
        const assessedValue = getCleanText(rows[3], 'td:last-child');

        const lastRow = rows[rows.length - 1];
        const firstDue = getCleanText(lastRow, 'td:nth-child(3)');
        const secondDue = getCleanText(lastRow, 'td:nth-child(4)');

        return {
            ownerName: `${ownerLine1}`.trim(),
            propertyAddress: `${addressLine1}, ${addressLine2}`.trim(),
            assessedValue,
            firstDue,
            secondDue
        };
    });

    const taxData = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#maintable2 tbody tr'));

        const getCleanText = (row, selector) => {
            const cell = row?.querySelector(selector);
            return cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '0.00';
        };

        return {
            firstInstallment: {
                charge: getCleanText(rows[1], 'td:nth-child(4)'),
                credit: getCleanText(rows[2], 'td:nth-child(4)'),
                remitter: getCleanText(rows[3], 'td:nth-child(4)')
            },
            secondInstallment: {
                charge: getCleanText(rows[1], 'td:nth-child(6)'),
                credit: getCleanText(rows[2], 'td:nth-child(6)'),
                remitter: getCleanText(rows[3], 'td:nth-child(6)')
            }
        };
    });

    const paymentData = await page.evaluate(() => {
        const getCleanText = (row, selector) => {
            const cell = row?.querySelector(selector);
            return cell ? cell.textContent.replace(/\s+/g, ' ').trim() : '';
        };

        const paymentTable = Array.from(document.querySelectorAll('table#maintable2'))
            .find(table => table.textContent.includes('Payment Information'));

        if (!paymentTable) return [];

        const dataRows = Array.from(paymentTable.querySelectorAll('tbody tr'))
            .filter(row => row.querySelectorAll('td').length >= 2);

        return dataRows.map(row => ({
            date: getCleanText(row, 'td:nth-child(1)'),
            amount: getCleanText(row, 'td:nth-child(2)')
        }));
    });

    let taxYear = '';
    try {
        await page.waitForSelector('#history a', { timeout: 10000 });
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.click('#history a')
        ]);

        const taxYearEl = await page.$('#maintable tbody tr:nth-child(2) td:first-child');
        if (taxYearEl) {
            taxYear = await page.evaluate(el => el.textContent.replace(/\s+/g, ' ').trim(), taxYearEl);
        }
    }
    catch (err) {
        // Silently catch the timeout/navigation error and proceed with taxYear = ''
    }

    // Always return the data, regardless of try/catch outcomes
    return {
        ...data,
        ...taxData,
        paymentData: paymentData,
        taxYear: taxYear || ''
    };
}



async function populateTheObject(data) {
    const result = createPropertyObject();
    result.owner_name.push(data.ownerName);
    result.property_address = data.propertyAddress;
    result.total_assessed_value = formatCurrency(data.assessedValue);
    result.total_taxable_value = result.total_assessed_value;

    // Check if installment data actually exists before populating tax_history
    const hasInstallmentData =
        data.firstInstallment &&
        data.secondInstallment &&
        (parseCurrency(data.firstInstallment.charge) > 0 ||
            parseCurrency(data.secondInstallment.charge) > 0 ||
            parseCurrency(data.firstInstallment.credit) > 0 ||
            parseCurrency(data.secondInstallment.credit) > 0);

    if (!hasInstallmentData || !data.taxYear) {
        // Keep tax_history empty when no installment data exists
        result.tax_history = [];
        return result;
    }

    const nxtYear = parseInt(data.taxYear, 10) + 1;

    const record1 = createTaxHistory();
    record1.payment_type = "Installment 1";
    record1.year = data.taxYear;
    record1.base_amount = formatCurrency(data.firstInstallment.charge);
    record1.amount_paid = formatCurrency(data.firstInstallment.credit);
    record1.amount_due = data.firstDue === "$.00" ? "$0.00" : formatCurrency(data.firstDue);
    record1.due_date = `02/20/${nxtYear}`;
    record1.delq_date = `02/21/${nxtYear}`;
    setRecordStatus(record1);

    const record2 = createTaxHistory();
    record2.payment_type = "Installment 2";
    record2.year = data.taxYear;
    record2.base_amount = formatCurrency(data.secondInstallment.charge);
    record2.amount_paid = formatCurrency(data.secondInstallment.credit);
    record2.amount_due = data.secondDue === "$.00" ? "$0.00" : formatCurrency(data.secondDue);
    record2.due_date = `07/17/${nxtYear}`;
    record2.delq_date = `07/18/${nxtYear}`;
    setRecordStatus(record2);

    const paid1 = parseCurrency(record1.amount_paid);
    const paid2 = parseCurrency(record2.amount_paid);
    const sumOfPaidAmount = +(paid1 + paid2).toFixed(2);
    const isPaid1 = paid1 > 0;
    const isPaid2 = paid2 > 0;
    // Filter valid payments (exclude 'remitter' text, zero amounts, and invalid dates)
    // and sort chronologically (earliest to latest)
    const validPayments = (data.paymentData || [])
        .filter(p => p && p.date && /\d/.test(p.date) && parseCurrency(p.amount) > 0)
        .sort((a, b) => new Date(a.date) - new Date(b.date));
    let paidDate1 = "";
    let paidDate2 = "";

    const combinedPayment = isPaid1 && isPaid2 && validPayments.find(p =>
        Math.abs(parseCurrency(p.amount) - sumOfPaidAmount) < 0.01
    );
    if (combinedPayment) {
        // Both installments were paid together in this single combined payment
        const singleDate = formatDate(combinedPayment.date);
        paidDate1 = singleDate;
        paidDate2 = singleDate;
    } else {
        // 2. PAID ON DIFFERENT DATES (Image 1) OR ONLY ONE INSTALLMENT PAID
        // Match each installment by its exact amount paid
        const match1 = validPayments.find(p => Math.abs(parseCurrency(p.amount) - paid1) < 0.01);
        const match2 = validPayments.find(p => p !== match1 && Math.abs(parseCurrency(p.amount) - paid2) < 0.01);
        if (match1 && match2) {
            paidDate1 = formatDate(match1.date);
            paidDate2 = formatDate(match2.date);
        }
    }

    record1.paid_date = isPaid1 ? paidDate1 : "";
    record2.paid_date = isPaid2 ? paidDate2 : "";

    result.tax_history.push(record1, record2);

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
            (t) => t.status === "DELINQUENT",
        );
        result.delinquent = hasDelinquent
            ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
            : "NONE";

        // Get the latest tax record (the array is sorted ascending by year)
        const latestTax = result.tax_history[result.tax_history.length - 1];

        // Find individual statuses for the 1st and 2nd installments of the latest year
        const latestYearRecords = result.tax_history.filter(t => String(t.year) === String(latestTax.year));
        const inst1 = latestYearRecords.find(t => t.payment_type === "Installment 1");
        const inst2 = latestYearRecords.find(t => t.payment_type === "Installment 2");

        const status1 = inst1 ? inst1.status : "UNKNOWN";
        const status2 = inst2 ? inst2.status : "UNKNOWN";

        // Check if any PRIOR year is delinquent (exclude the latest year)
        const hasPriorDelinquent = result.tax_history.some(
            (t) => t.status === "DELINQUENT" && String(t.year) !== String(latestTax.year)
        );

        // If priors are delinquent, keys = 0. If priors are paid, keys = 1.
        const keys = hasPriorDelinquent ? 0 : 1;
        result.notes = generate_notes(latestTax.year, keys, status1, status2);
    }
    return result;
}


async function run(accountNumber) {
    let browser;
    try {
        const launched = await launchBrowser();
        browser = launched.browser;
        const page = launched.page;

        await searchAccountNumber(accountNumber, page);
        const data = await getDetails(page);
        const result = await populateTheObject(data);
        if (result) {
            result.parcel_number = accountNumber;
        }
        console.log(JSON.stringify(result, null, 2));
        return result;

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {
        // if (browser) await browser.close();
    }
}

run("12-017002.0000");  
