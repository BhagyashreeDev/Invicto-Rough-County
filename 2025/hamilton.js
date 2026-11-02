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
        taxing_authority: "Hamilton County Treasurer, 138 E. Court St., Cincinnati, OH 45202",
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
        notes += ` ${year} 1ST INSTALLMENT IS ${(status1).toUpperCase()}, 2ND INSTALLMENT IS ${(status2).toUpperCase()},`;
        notes += ` NORMALLY TAXES ARE PAID SEMI-ANNUALLY,`;
        notes += ` NORMAL DUE DATES ARE 02/10 AND 07/10`;
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

async function searchAccountNumber(accountNumber, page) {
    await page.waitForSelector("#tab-search-parcel-id", timeout_option);
    await page.click("#tab-search-parcel-id");

    await page.waitForSelector("#partial-number", timeout_option);
    await page.type("#partial-number", accountNumber);

    const submitBtnSelector = "#search-parcel-id button[type='submit']";

    await page.waitForSelector(submitBtnSelector, { visible: true, ...timeout_option });

    await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", ...timeout_option }),
        page.click(submitBtnSelector)
    ]);
}

async function getDetails(page) {
    const propertyData = await page.evaluate(() => {
        const getHeaderValue = (labelName) => {
            const dtElements = Array.from(document.querySelectorAll('#property-page dl dt'));
            const targetDt = dtElements.find(dt => dt.textContent.trim() === labelName);
            return targetDt ? targetDt.nextElementSibling.textContent.trim() : null;
        };

        const getTableValue = (labelName) => {
            const boldDivs = Array.from(document.querySelectorAll('#property-content div.font-bold'));
            const targetDiv = boldDivs.find(div => div.textContent.trim() === labelName);
            return targetDiv ? targetDiv.nextElementSibling.textContent.trim() : null;
        };

        const rawOwnerBlock = getTableValue('Owner Name and Address');
        const ownerName = rawOwnerBlock ? rawOwnerBlock.split('\n')[0].trim() : null;

        const rawTaxYear = getHeaderValue('Tax Year');
        const taxYear = rawTaxYear ? rawTaxYear.split('Payable')[0].trim() : null;

        return {
            ownerName: ownerName,
            propertyAddress: getHeaderValue('Address'),
            totalAssessedValue: getTableValue('Assessed Value'),
            taxYear: taxYear
        };
    });
    
    return propertyData;
}

async function getPaymentDetails(page) {
    const paymentData = await page.evaluate(() => {
        const getTableByCaption = (captionText) => {
            return Array.from(document.querySelectorAll('table')).find(t => {
                const cap = t.querySelector('caption');
                return cap && cap.textContent.trim().includes(captionText);
            });
        };

        let paymentInfo = {
            landValue: null,
            improvements: null,
            totalTaxableValue: null,
            firstHalfSubtotal: null,
            secondHalfSubtotal: null,
            totalPaidFirstHalf: null,
            totalPaidSecondHalf: null,
            totalOwedFirstHalf: null,
            totalOwedSecondHalf: null,
            firstHalfPaymentDate: null,
            secondHalfPaymentDate: null
        };

        // Extract Taxable Value (Land, Improvements, Total)
        const taxableTable = getTableByCaption('Taxable Value');
        if (taxableTable) {
            const rows = Array.from(taxableTable.querySelectorAll('tbody tr'));
            rows.forEach(r => {
                const th = r.querySelector('th');
                const td = r.querySelector('td');
                if (th && td) {
                    const text = th.textContent.trim();
                    if (text === 'Land') paymentInfo.landValue = td.textContent.trim();
                    if (text === 'Improvements') paymentInfo.improvements = td.textContent.trim();
                    if (text === 'Total') paymentInfo.totalTaxableValue = td.textContent.trim();
                }
            });
        }

        // Extract Tax Detail (Subtotals, Paid, Owed)
        const taxTable = getTableByCaption('Current Year Tax Detail');
        if (taxTable) {
            const rows = Array.from(taxTable.querySelectorAll('tbody tr'));
            
            // Subtotal
            const subtotalRows = rows.filter(r => r.querySelector('th') && r.querySelector('th').textContent.trim() === 'Subtotal');
            if (subtotalRows.length > 0) {
                const targetSubRow = subtotalRows[subtotalRows.length - 1]; 
                const tds = targetSubRow.querySelectorAll('td');
                if (tds.length >= 5) {
                    paymentInfo.firstHalfSubtotal = tds[2].textContent.trim();
                    paymentInfo.secondHalfSubtotal = tds[4].textContent.trim();
                }
            }

            // Total Paid
            const totalPaidRow = rows.find(r => r.querySelector('th') && r.querySelector('th').textContent.trim() === 'Total Paid');
            if (totalPaidRow) {
                const tds = totalPaidRow.querySelectorAll('td');
                paymentInfo.totalPaidFirstHalf = tds[2].textContent.trim();
                paymentInfo.totalPaidSecondHalf = tds[4].textContent.trim();
            }

            // Total Owed
            const totalOwedRow = rows.find(r => r.querySelector('th') && r.querySelector('th').textContent.trim() === 'Total Owed');
            if (totalOwedRow) {
                const tds = totalOwedRow.querySelectorAll('td');
                paymentInfo.totalOwedFirstHalf = tds[2].textContent.trim();
                paymentInfo.totalOwedSecondHalf = tds[4].textContent.trim();
            }
        }

        // Extract Payment Dates
        const historyTable = getTableByCaption('Payment Information for Current And Prior Year');
        if (historyTable) {
            const rows = Array.from(historyTable.querySelectorAll('tbody tr'));
            
            for (const row of rows) {
                const tds = row.querySelectorAll('td');
                if (tds.length >= 5) {
                    const date = tds[0].textContent.trim();
                    const p1stHalf = tds[3].textContent.trim();
                    const p2ndHalf = tds[4].textContent.trim();

                    if (paymentInfo.totalPaidFirstHalf && paymentInfo.totalPaidFirstHalf !== '$0.00' && 
                        p1stHalf === paymentInfo.totalPaidFirstHalf && !paymentInfo.firstHalfPaymentDate) {
                        paymentInfo.firstHalfPaymentDate = date;
                    }

                    if (paymentInfo.totalPaidSecondHalf && paymentInfo.totalPaidSecondHalf !== '$0.00' && 
                        p2ndHalf === paymentInfo.totalPaidSecondHalf && !paymentInfo.secondHalfPaymentDate) {
                        paymentInfo.secondHalfPaymentDate = date;
                    }
                }
            }
        }

        return paymentInfo;
    });

    return paymentData;
}

function determineStatus(record) {
    if (record.amount_due === "$0.00" || !record.amount_due) {
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

function populateObject(summary, payment, accountNumber) {
    const result = createPropertyObject();

    // Base info
    result.processed_date = new Date().toLocaleDateString("en-US");
    result.owner_name = summary.ownerName ? [summary.ownerName] : [];
    result.property_address = summary.propertyAddress || "";
    result.parcel_number = accountNumber;
    
    // Value info
    result.land_value = payment.landValue || "";
    result.improvements = payment.improvements || "";
    result.total_assessed_value = summary.totalAssessedValue || "";
    result.total_taxable_value = payment.totalTaxableValue || "";

    const taxYearStr = summary.taxYear || "2025";
    const payableYear = parseInt(taxYearStr, 10) + 1; // e.g. 2025 payable in 2026

    // Installment 1
    const inst1 = createTaxHistory();
    inst1.year = taxYearStr;
    inst1.payment_type = "Installment 1";
    inst1.base_amount = payment.firstHalfSubtotal || "$0.00";
    inst1.amount_paid = payment.totalPaidFirstHalf || "$0.00";
    inst1.amount_due = payment.totalOwedFirstHalf || "$0.00";
    inst1.paid_date = payment.firstHalfPaymentDate || "";
    inst1.due_date = `02/10/${payableYear}`;
    inst1.delq_date = `02/11/${payableYear}`;
    determineStatus(inst1);
    result.tax_history.push(inst1);

    // Installment 2
    const inst2 = createTaxHistory();
    inst2.year = taxYearStr;
    inst2.payment_type = "Installment 2";
    inst2.base_amount = payment.secondHalfSubtotal || "$0.00";
    inst2.amount_paid = payment.totalPaidSecondHalf || "$0.00";
    inst2.amount_due = payment.totalOwedSecondHalf || "$0.00";
    inst2.paid_date = payment.secondHalfPaymentDate || "";
    inst2.due_date = `07/24/${payableYear}`;
    inst2.delq_date = `07/25/${payableYear}`;
    determineStatus(inst2);
    result.tax_history.push(inst2);

    // Sort the tax history
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

    // Notes and Delinquent Logic
    if (result.tax_history.length > 0) {
        const hasDelinquent = result.tax_history.some(
            (t) => t.status.toUpperCase() === "DELINQUENT"
        );
        
        result.delinquent = hasDelinquent
            ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
            : "NONE";

        const latestTax = result.tax_history[result.tax_history.length - 1];
        const latestYearRecords = result.tax_history.filter(t => String(t.year) === String(latestTax.year));
        
        const i1 = latestYearRecords.find(t => t.payment_type === "Installment 1");
        const i2 = latestYearRecords.find(t => t.payment_type === "Installment 2");

        const status1 = i1 ? i1.status : "UNKNOWN";
        const status2 = i2 ? i2.status : "UNKNOWN";

        const hasPriorDelinquent = result.tax_history.some(
            (t) => t.status.toUpperCase() === "DELINQUENT" && String(t.year) !== String(latestTax.year)
        );

        const keys = hasPriorDelinquent ? 0 : 1;
        result.notes = generate_notes(latestTax.year, keys, status1, status2);
    }

    return result;
}

async function run(accountNumber) {
    let browser, page;
    try {
        ({ browser, page } = await launchBrowser());

        await page.goto(
            "https://wedge3.hcauditor.org/",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        // 1. Search and get summary page details
        await searchAccountNumber(accountNumber, page);
        const propertySummary = await getDetails(page);

        let finalOutput = {};

        if (propertySummary.taxYear) {
            // 2. Format account number and construct URL
            const cleanAccountNumber = accountNumber.replace(/-/g, '');
            const paymentUrl = `https://wedge3.hcauditor.org/view/re/${cleanAccountNumber}/${propertySummary.taxYear}/payment_details`;
            
            // 3. Navigate to Payment Details and extract table records
            await page.goto(paymentUrl, { waitUntil: "networkidle2", ...timeout_option });
            const paymentDetails = await getPaymentDetails(page);
            
            // 4. Populate Object
            finalOutput = populateObject(propertySummary, paymentDetails, accountNumber);
            console.log(JSON.stringify(finalOutput, null, 2));
        }

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

run("045-0002-0021-00");