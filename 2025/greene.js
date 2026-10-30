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

async function searchAccountNumber(accountNumber, page) {
    await page.waitForSelector("#Number", { waitUntil: "domcontentloaded", visible: true });
    await page.type("#Number", accountNumber);

    await page.waitForSelector("button[type='submit']", { waitUntil: "domcontentloaded", visible: true });
    await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", ...timeout_option }),
        page.click("button[type='submit']")
    ]);
}

async function getDetails(page) {
    const propertyDetails = await page.evaluate(() => {
        const getText = (selector) => {
            const el = document.querySelector(selector);
            return el ? el.textContent.replace(/[\s\xa0]+/g, ' ').trim() : '';
        };

        const ownerName = getText('#OwnerName + div');
        const address = getText('#HeaderLocation + div');
        const taxableValue = getText('td[aria-labelledby="ValueTaxable ValueAppraised"]');
        return { ownerName, address, taxableValue };
    });

    const { taxInstallments, paymentHistoryUrl } = await page.evaluate(() => {
        const getVal = (selector) => {
            const el = document.querySelector(selector);
            return el ? el.textContent.replace(/[\s,]+/g, '').trim() : '0.00';
        };

        let taxYear = '';
        const chargeTableElement = document.getElementById('ChargeTax');

        if (chargeTableElement) {
            const parentCard = chargeTableElement.closest('.card');
            if (parentCard) {
                const headerText = parentCard.querySelector('.card-header')?.textContent || '';
                const yearMatch = headerText.match(/\d{4}/);
                if (yearMatch) {
                    taxYear = yearMatch[0];
                }
            }
        }

        const taxInstallments = {
            taxYear: taxYear,
            firstInstallment: {
                taxAmount: getVal('td[aria-labelledby="ChargeTax ChargeFirst"]'),
                totalBilled: getVal('td[aria-labelledby="ChargeTotalRow ChargeFirst"]'),
                amountPaid: getVal('td[aria-labelledby="ChargePaid ChargeFirst"]'),
                amountDue: getVal('td[aria-labelledby="ChargeDue ChargeFirst"]')
            },
            secondInstallment: {
                taxAmount: getVal('td[aria-labelledby="ChargeTax ChargeSecond"]'),
                totalBilled: getVal('td[aria-labelledby="ChargeTotalRow ChargeSecond"]'),
                amountPaid: getVal('td[aria-labelledby="ChargePaid ChargeSecond"]'),
                amountDue: getVal('td[aria-labelledby="ChargeDue ChargeSecond"]')
            },
            priorDelinquent: {
                taxAmount: getVal('td[aria-labelledby="ChargeTax ChargePrior"]'),
                totalBilled: getVal('td[aria-labelledby="ChargeTotalRow ChargePrior"]'),
                amountPaid: getVal('td[aria-labelledby="ChargePaid ChargePrior"]'),
                amountDue: getVal('td[aria-labelledby="ChargeDue ChargePrior"]')
            }
        };

        // Extract the Payment History link from the sidebar
        const links = Array.from(document.querySelectorAll('nav#sidebarMenu a.nav-link'));
        const paymentLink = links.find(a => a.textContent.includes('Payment History'));
        const paymentHistoryUrl = paymentLink ? paymentLink.getAttribute('href') : null;

        return { taxInstallments, paymentHistoryUrl };
    });

    return { propertyDetails, taxInstallments, paymentHistoryUrl };
}

async function getPaymentHistoryDates(page, paymentHistoryUrl, taxInstallments) {
    if (!paymentHistoryUrl) {
        console.log("No Payment History URL found.");
        return taxInstallments;
    }

    // Convert relative URL to absolute URL and navigate
    const absoluteUrl = new URL(paymentHistoryUrl, page.url()).href;
    await page.goto(absoluteUrl, { waitUntil: "networkidle2", ...timeout_option });

    // Wait for the payment history table to load
    await page.waitForSelector('.table-responsive table tbody tr', { waitUntil: "domcontentloaded" });

    const paymentRecords = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('.table-responsive table tbody tr'));
        return rows.map(tr => {
            const tds = tr.querySelectorAll('td');
            if (tds.length >= 2) {
                return {
                    date: tds[0].textContent.trim(),
                    amount: tds[1].textContent.replace(/[\s,]+/g, '').trim() // Strip commas for easy comparison
                };
            }
            return null;
        }).filter(record => record !== null);
    });

    // Helper to find the matching date for a given paid amount
    const matchDateForAmount = (amountPaid) => {
        if (!amountPaid || amountPaid === '0.00' || amountPaid === '0') return null;
        // Since the table is inherently sorted newest to oldest, .find() grabs the most recent match
        const record = paymentRecords.find(p => p.amount === amountPaid);
        return record ? record.date : null;
    };

    // Map the dates back to our installments
    taxInstallments.firstInstallment.paidDate = matchDateForAmount(taxInstallments.firstInstallment.amountPaid);
    taxInstallments.secondInstallment.paidDate = matchDateForAmount(taxInstallments.secondInstallment.amountPaid);
    taxInstallments.priorDelinquent.paidDate = matchDateForAmount(taxInstallments.priorDelinquent.amountPaid);

    return taxInstallments;
}

function populateTheObject(accountNumber, propertyDetails, installments) {
    const propertyObj = createPropertyObject();

    // Set high-level property details
    propertyObj.parcel_number = accountNumber;
    propertyObj.owner_name = propertyDetails.ownerName ? [propertyDetails.ownerName] : ["N/A"];
    propertyObj.property_address = propertyDetails.address || "N/A";
    propertyObj.total_taxable_value = propertyDetails.taxableValue || "N/A";

    // Check for delinquency based on prior delinquent due amount
    const priorDue = parseFloat(installments.priorDelinquent.amountDue) || 0;
    if (priorDue > 0) {
        propertyObj.delinquent = "YES";
    }

    const buildTaxHistory = (installmentData, paymentType, isPrior = false) => {
        const taxHist = createTaxHistory();

        taxHist.year = isPrior ? "N/A" : installments.taxYear;
        taxHist.payment_type = paymentType;
        taxHist.base_amount = installmentData.taxAmount || "0.00";
        taxHist.amount_paid = installmentData.amountPaid || "0.00";
        taxHist.amount_due = installmentData.amountDue || "0.00";
        taxHist.paid_date = installmentData.paidDate || "";

        const dueFloat = parseFloat(taxHist.amount_due);
        const paidFloat = parseFloat(taxHist.amount_paid);

        // Determine simple status
        if (dueFloat > 0) {
            // const today = new Date();
            // const dueDateObj = new Date(record.due_date);

            // if (today <= dueDateObj) {
            //     taxHist.status = "Due";
            // } else {
            //     taxHist.status = "Delinquent";
            // }
        } else if (paidFloat > 0 && dueFloat === 0) {
            taxHist.status = "Paid";
        } else {
            taxHist.status = "PAID/ZERO DUE"; // Catch-all for when both are 0.00
        }

        return taxHist;
    };

    // Populate Tax History for First and Second halves
    propertyObj.tax_history.push(buildTaxHistory(installments.firstInstallment, "Installment 1"));
    propertyObj.tax_history.push(buildTaxHistory(installments.secondInstallment, "Installment 2"));

    // Check if Prior Delinquent has any billed, paid, or due amounts to warrant inclusion
    const priorBilled = parseFloat(installments.priorDelinquent.totalBilled) || 0;
    const priorPaid = parseFloat(installments.priorDelinquent.amountPaid) || 0;

    if (priorBilled > 0 || priorDue > 0 || priorPaid > 0) {
        propertyObj.tax_history.push(buildTaxHistory(installments.priorDelinquent, "Semi-Annual", true));
    }

    return propertyObj;
}

async function run(accountNumber) {
    let browser, page;
    try {
        ({ browser, page } = await launchBrowser());

        await page.goto(
            "https://auditor.greenecountyohio.gov/Search/Number",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);

        // 1. Get initial details and the link to Payment History
        const { propertyDetails, taxInstallments, paymentHistoryUrl } = await getDetails(page);

        // 2. Check if any payments have been made by evaluating amountPaid
        const isFirstPaid = parseFloat(taxInstallments.firstInstallment.amountPaid) > 0;
        const isSecondPaid = parseFloat(taxInstallments.secondInstallment.amountPaid) > 0;
        const isPriorPaid = parseFloat(taxInstallments.priorDelinquent.amountPaid) > 0;

        let finalInstallments = taxInstallments;

        // 3. Only navigate if an installment is actually paid
        if (isFirstPaid || isSecondPaid || isPriorPaid) {
            console.log("Payments detected. Navigating to Payment History...");
            finalInstallments = await getPaymentHistoryDates(page, paymentHistoryUrl, taxInstallments);
        } else {
            console.log("No payments made. Skipping Payment History page.");
        }

        // 4. Populate the final output object
        const finalPropertyData = populateTheObject(accountNumber, propertyDetails, finalInstallments);
        console.log("Final Output Object: ", JSON.stringify(finalPropertyData, null, 2));

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {
        // if (browser) {
        //     await browser.close();
        // }
    }
}

run("A01-0001-0003-0-0021-00");