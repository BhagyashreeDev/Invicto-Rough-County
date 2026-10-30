import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import PDFParser from "pdf2json";

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
        taxing_authority: "Vernon County Collector, 100 W Cherry St, Nevada, MO 64772",
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

const formatCurrency = (value) => {
    if (!value) return "$0.00";
    const num = parseFloat(value.toString().replace(/[^\d.-]/g, ''));
    if (isNaN(num)) return "$0.00";
    return new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
        minimumFractionDigits: 2,
        maximumFractionDigits: 2
    }).format(num);
};

// Sums up "$x.xx"-style strings, used to reconstruct the full amount that
// was originally owed (tax + penalties/interest + fees) for a paid year.
const sumCurrency = (...values) => {
    return values.reduce((sum, v) => {
        const num = parseFloat((v || "0").toString().replace(/[^\d.-]/g, ''));
        return sum + (isNaN(num) ? 0 : num);
    }, 0);
};

const generate_notes = (year, keys, status) => {
    let notes = "";
    try {
        notes = keys === 1
            ? `ALL PRIORS ARE PAID, ${year} `
            : `PRIORS ARE DELINQUENT, ${year} `;
        notes += `TAXES ARE ${status.toUpperCase()},`;
        notes += ` NORMALLY TAXES ARE PAID ANNUALLY,`;
        notes += ` NORMAL DUE DATE IS 12/31`;
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
    const inputSelector = "#MainContent_ParcelId";
    await page.waitForSelector(inputSelector);
    await page.type(inputSelector, accountNumber);

    const btnSelector = "#MainContent_SearchButton";
    await page.waitForSelector(btnSelector);
    await page.click(btnSelector);

    await page.waitForSelector("#MainContent_gvSearch2", { visible: true, ...timeout_option });
}

async function parseTable(page) {
    const propertyDetails = await page.evaluate(() => {
        const table = document.querySelector('#MainContent_gvSearch2');
        const rows = table.querySelectorAll('tr');
        const lastRow = rows[rows.length - 1];

        const owner = lastRow.cells[4]?.innerText.trim() || "N/A";
        const address = lastRow.cells[5]?.innerText.trim() || "N/A";
        const linkElement = lastRow.cells[2].querySelector('a');
        const link = linkElement ? linkElement.href : null;

        return { owner, address, link };
    });

    if (propertyDetails.link) {
        await page.goto(propertyDetails.link, { waitUntil: "networkidle2", ...timeout_option });
    }

    return propertyDetails;
}

/**
 * Walks every row of the tax-year table, newest year first.
 *
 * Rule:
 *  - due ($lblAmountDue) === 0  -> that year is PAID.
 *      Record it from the table data alone (no PDF parse needed) and STOP —
 *      no further (older) rows are examined.
 *  - due !== 0 -> that year is UNPAID.
 *      Record it, download+parse its statement PDF but only keep the
 *      valuation out of it, then CONTINUE to the next (older) row.
 *  - If every row is unpaid, we simply run out of rows (no paid record).
 */
async function parseTheTaxYear(page, accountNumber) {
    await page.waitForSelector('#MainContent_gvTaxes', { visible: true, ...timeout_option });

    const rowsData = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#MainContent_gvTaxes tbody tr'));
        return rows.map((row) => ({
            taxYear: row.querySelector('[id*="_lblTaxYear_"]')?.innerText.trim() || null,
            taxAmountDue: row.querySelector('[id*="_lblTax_"]')?.innerText.trim() || null,
            penaltiesInterest: row.querySelector('[id*="_lblPenaltiesInterest_"]')?.innerText.trim() || null,
            feesDue: row.querySelector('[id*="_lblFeesDue_"]')?.innerText.trim() || null,
            totalAmountDue: row.querySelector('[id*="_lblAmountDue_"]')?.innerText.trim() || null,
            datePaid: row.querySelector('[id*="_lblPayLine_"]')?.innerText.trim() || null,
        }));
    });

    if (!rowsData.length || !rowsData[0].taxYear) {
        console.log("No tax details found to parse.");
        return [];
    }

    const results = [];

    let isFirstRow = true;
    for (const row of rowsData) {

        const dueNum = parseFloat((row.totalAmountDue || "0").replace(/[^\d.-]/g, '')) || 0;
        const isPaid = dueNum === 0;

        if (isPaid) {
            if (isFirstRow) {
                const pdfData = await downloadAndParseStatement(page, accountNumber, row.taxYear, isPaid);
                results.push({ ...row, valuation: pdfData?.valuation || null, isPaid: true, ...pdfData });
            }
            isFirstRow = false;
            break;
        }

        else {
            if (isFirstRow) {
                const pdfData = await downloadAndParseStatement(page, accountNumber, row.taxYear, isPaid);
                results.push({ ...row, valuation: pdfData || null, isPaid: false });
                isFirstRow = false;
                continue;
            }
            results.push({ ...row, valuation: null, isPaid: false });
            isFirstRow = false;
        }
    }


    console.log("Results:", results);
    return results;
}

async function downloadAndParseStatement(page, accountNumber, year, isPaid) {
    const statementUrl = `https://mo1458.cichosting.com/MTASWebportal/Statements/${year}-${accountNumber}.pdf?_nocacheId=89c7b401-6fcc-4e7e-a5f6-48707b154cac`;
    let downloadedFilePath;

    try {
        downloadedFilePath = await downloadStatementPdf(page, statementUrl, accountNumber, year);
    } catch (err) {
        console.log("Failed to capture PDF:", err.message);
        return null;
    }

    try {
        const pdfData = await extractDataFromPdf(downloadedFilePath, accountNumber, isPaid);
        console.log(pdfData);
        return pdfData;
    } catch (err) {
        console.log("Failed to parse PDF:", err.message);
        return null;
    } finally {
        if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
            fs.unlink(downloadedFilePath, (err) => {
                if (err) console.log(`Error deleting PDF: ${err.message}`);
            });
        }
    }
}

function extractDataFromPdf(filePath, accountNumber, isPaid) {
    return new Promise((resolve, reject) => {
        const pdfParser = new PDFParser();
        pdfParser.on("pdfParser_dataError", (e) => reject(e.parserError));

        pdfParser.on("pdfParser_dataReady", (pdfData) => {
            try {
                let data = [];
                pdfData['Pages'].forEach((p) => {
                    p['Texts'].forEach((t) => {
                        let text = t["R"][0]["T"];
                        text = decodeURIComponent(text).trim();
                        if (text != null && text !== "") {
                            data.push(text);
                        }
                    });
                });

                // 1. Initialize variables OUTSIDE the loop
                let result = null;
                let extracted = { valuation: null, baseTax: null, amountPaid: null };

                // 2. Loop through everything first
                for (let i = 0; i < data.length; i++) {
                    let d = data[i];

                    if (isPaid) {
                        if (d === "TOTAL VALUATION") {
                            if (data[0].includes("Personal Property")) {
                                extracted.valuation = data[i + 12] || null;
                            }
                            if (data[0].includes("Real Estate")) {
                                extracted.valuation = data[i + 11] || null;
                            }
                        }
                        if (d === "Base" && data[i + 1] === "Tax") {
                            extracted.baseTax = data[i - 1] || null;
                        }
                        if (d === "Amount Paid:") {
                            for (let j = 1; j <= 10; j++) {
                                if (data[i + j] && /^[0-9]{1,3}(,[0-9]{3})*\.[0-9]{2}$/.test(data[i + j])) {
                                    extracted.amountPaid = data[i + j];
                                    break;
                                }
                            }
                        }
                        result = extracted;
                    } else {
                        if (d === "TOTAL VALUATION") {
                            result = data[i + 23] || null;
                        }
                    }
                }

                // 3. Resolve ONCE after the loop completes
                resolve(result);

            } catch (error) {
                console.log("Error extracting text data:", error);
                reject(error);
            }
        });

        pdfParser.loadPDF(filePath);
    });
}

async function downloadStatementPdf(page, statementUrl, accountNumber, year) {
    const downloadPath = path.resolve('./downloads');
    if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath, { recursive: true });

    const filePath = path.join(downloadPath, `statement_${accountNumber}_${year}.pdf`);

    const base64 = await page.evaluate(async (url) => {
        const res = await fetch(url, { credentials: 'include' });
        if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }, statementUrl);

    const buffer = Buffer.from(base64, 'base64');

    if (buffer.slice(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error('Downloaded content is not a valid PDF (missing %PDF- header)');
    }

    fs.writeFileSync(filePath, buffer);
    return filePath;
}

async function handleDisclaimerPage(page) {
    const currentUrl = page.url();
    if (currentUrl.includes("Default")) {
        const agreeButtonSelector = "#MainContent_btnBeginSearch";
        try {
            await page.waitForSelector(agreeButtonSelector);
            await page.click(agreeButtonSelector);
            await page.waitForNavigation({ waitUntil: "networkidle2" });
        } catch (e) {
            console.log("Could not pass the DISCLAIMER page:", e);
        }
    }
}

/**
 * records: array produced by parseTheTaxYear, one entry per row we decided
 * to keep (newest-first, stopping at the first Paid year).
 */
// function buildSchema(propertyDetails, records, accountNumber) {
//     if (!propertyDetails || !records || records.length === 0) return null;

//     const result = createPropertyObject();
//     result.owner_name = [propertyDetails.owner];
//     result.parcel_number = accountNumber;
//     result.property_address = propertyDetails.address;

//     // Use the valuation from the most recent year that had a PDF parsed
//     // (i.e. the first unpaid row we encountered, since rows are newest-first)
//     const firstValuation = records.find(r => r.valuation)?.valuation || null;
//     result.total_assessed_value = formatCurrency(firstValuation);
//     result.total_taxable_value = formatCurrency(firstValuation);

//     records.forEach((row) => {
//         const record = createTaxHistory();
//         record.year = row.taxYear || "N/A";

//         if (record.year !== "N/A") {
//             const nextYear = parseInt(record.year, 10) + 1;
//             record.due_date = `12/31/${record.year}`;
//             record.delq_date = `01/01/${nextYear}`;
//         }

//         record.amount_due = formatCurrency(row.totalAmountDue);
//         record.base_amount = formatCurrency(row.baseTax || row.paidAmount);

//         // Paid rows have no PDF data — reconstruct what was paid from the
//         // row's own tax + penalties/interest + fees (since due is now $0).
//         // Unpaid rows haven't had anything paid.
//         record.amount_paid = row.isPaid
//             ? formatCurrency(row.paidAmount)
//             : "$0.00";
//         record.paid_date = row.isPaid ? (row.datePaid || "") : "";

//         // Status
//         if (record.amount_due === "$0.00") {
//             record.status = "Paid";
//         } else {
//             const today = new Date();
//             const dueDateObj = new Date(record.due_date);
//             record.status = today <= dueDateObj ? "Due" : "Delinquent";
//         }

//         result.tax_history.push(record);
//     });

//     result.tax_history.sort((a, b) => {
//         const yearA = parseInt(a.year, 10) || 0;
//         const yearB = parseInt(b.year, 10) || 0;
//         if (yearA !== yearB) return yearA - yearB;
//         if (a.status === "Paid" && b.status !== "Paid") return -1;
//         if (a.status !== "Paid" && b.status === "Paid") return 1;
//         return 0;
//     });

//     if (result.tax_history.length > 0) {
//         const hasDelinquent = result.tax_history.some((t) => t.status === "Delinquent");
//         result.delinquent = hasDelinquent
//             ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
//             : "NONE";

//         const latestTax = result.tax_history[result.tax_history.length - 1];
//         const hasPriorDelinquent = result.tax_history.some(
//             (t) => t.status === "Delinquent" && String(t.year) !== String(latestTax.year)
//         );

//         const keys = hasPriorDelinquent ? 0 : 1;
//         result.notes = generate_notes(latestTax.year, keys, latestTax.status);
//     }

//     return result;
// }

async function run(accountNumber) {
    let browserContext;
    try {
        const { browser, page } = await launchBrowser();
        browserContext = browser;

        await page.goto(
            "https://mo1458.cichosting.com/MTASWebportal/Search",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await handleDisclaimerPage(page);
        await searchAccountNumber(accountNumber, page);

        const propertyDetails = await parseTable(page);
        console.log("Property Details Scraped:", propertyDetails);

        const records = await parseTheTaxYear(page, accountNumber);
        // console.log("Tax Records Gathered:", records);

        // const result = buildSchema(propertyDetails, records, accountNumber);
        // console.log("\n--- FINAL POPULATED PROPERTY SCHEMA ---");
        // console.log(JSON.stringify(result, null, 2));

    } catch (err) {
        console.log("Error during sequence execution:", err);
    } finally {

    }
}

run("18-4.0-17-004-002-009.000");