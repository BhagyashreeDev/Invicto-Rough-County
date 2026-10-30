import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import PDFParser from "pdf2json";

const timeout_option = {
    timeout: 90000,
};

// ==========================================
// STEP 1: SCHEMA HELPER FUNCTIONS
// ==========================================

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
        taxing_authority: "Cedar County Collector of Revenue, 113 South Street in Stockton, MO 65785",
        delinquent: "NONE",
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
    const propertyTypeAllSelector = "input[name='propertyTypeRadio'][value='']";
    await page.waitForSelector(propertyTypeAllSelector);
    await page.click(propertyTypeAllSelector);

    const acctStatusAllSelector = 'input[name="acctStatusRadio"][value=""]';
    await page.waitForSelector(acctStatusAllSelector);
    await page.click(acctStatusAllSelector);

    const inputSelector = 'input[name="searchString"]';
    await page.waitForSelector(inputSelector);

    await page.click(inputSelector, { clickCount: 3 });
    await page.type(inputSelector, accountNumber.trim());

    const searchBtnSelector = 'button[name="searchButton"]';
    await page.waitForSelector(searchBtnSelector);

    await page.waitForFunction(
        (selector) => !document.querySelector(selector).disabled,
        {},
        searchBtnSelector
    );
    await page.click(searchBtnSelector);
}

async function waitForDownload(downloadPath) {
    console.log(`Waiting for PDF to download into ${downloadPath}...`);
    return new Promise((resolve, reject) => {
        let watcher;
        const timeout = setTimeout(() => {
            if (watcher) watcher.close();
            reject(new Error('Download timeout'));
        }, 30000);

        watcher = fs.watch(downloadPath, (eventType, filename) => {
            if (filename && filename.endsWith('.pdf') && !filename.endsWith('.crdownload')) {
                clearTimeout(timeout);
                watcher.close();
                setTimeout(() => resolve(path.join(downloadPath, filename)), 1500);
            }
        });
    });
}

function extractDataWithPdf2Json(filePath) {
    return new Promise((resolve, reject) => {
        const pdfParser = new PDFParser();

        pdfParser.on("pdfParser_dataError", errData => {
            console.error(errData.parserError);
            reject(errData.parserError);
        });

        pdfParser.on("pdfParser_dataReady", async (pdfData) => {
            try {
                let data = [];
                pdfData['Pages'].forEach((p, i) => {
                    p['Texts'].forEach((t, j) => {
                        let text = t["R"][0]["T"];
                        text = decodeURIComponent(text).trim();
                        if (text != null && text != "" && text != " ") {
                            data.push(text);
                        }
                    });
                });

                let extracted = {
                    assessed: null,
                    subtotal: null,
                    totalPaid: null,
                    paidDate: null
                };

                for (let i = 0; i < data.length; i++) {
                    let d = data[i];

                    if (d === "TOTAL VALUATION") {
                        extracted.assessed = data[i + 1] ? data[i + 1] : null;
                    }
                    if (d === "Subtotal") {
                        extracted.subtotal = data[i + 1] ? data[i + 1].replace("$", "") : null;
                    }
                    if (d.includes("TRANSACTION")) {
                        const dateMatchCurrent = d.match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
                        if (dateMatchCurrent) {
                            extracted.paidDate = dateMatchCurrent[1];
                        }
                        else if (data[i - 1]) {
                            const dateMatchPrevious = data[i - 1].match(/(\d{1,2}\/\d{1,2}\/\d{4})/);
                            if (dateMatchPrevious) {
                                extracted.paidDate = dateMatchPrevious[1];
                            }
                        }
                    }
                    if (d.includes("TOTAL PAID:")) {
                        for (let step = 1; step <= 3; step++) {
                            if (data[i + step] && data[i + step].includes("$")) {
                                extracted.totalPaid = data[i + step].replace("$", "");
                                break;
                            }
                        }
                    }
                }
                pdfData = null;
                data = null;
                resolve(extracted);
            } catch (error) {
                console.log(error);
                resolve(null);
            }
        });
        pdfParser.loadPDF(filePath);
    });
}

async function parseResultsTable(page) {
    try {
        await page.waitForSelector("mat-table mat-row", { timeout: 10000 });
    } catch (e) {
        console.log("No rows found in the table.");
        return [];
    }

    const results = [];
    const rows = await page.$$("mat-table mat-row");

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        // Extract common table data first so we have it for the schema!
        const statusText = await row.$eval(".mat-column-status", el => el.textContent.trim());
        const taxYear = await row.$eval(".mat-column-taxYear", el => el.textContent.trim());
        const taxpayer = await row.$eval(".mat-column-taxpayer", el => el.textContent.trim());
        const address = await row.$eval(".mat-column-address", el => el.textContent.trim());
        const totalDue = await row.$eval(".mat-column-totalDue", el => el.textContent.trim());
        const parcelNo = await row.$eval(".mat-column-parcelNo", el => el.textContent.trim());

        if (statusText.includes("Paid")) {
            if (i === 0) {
                console.log("First row is 'Paid'. Initiating download...");
                const downloadPath = path.resolve('./downloads');
                if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath);

                const client = await page.target().createCDPSession();
                await client.send('Page.setDownloadBehavior', {
                    behavior: 'allow',
                    downloadPath: downloadPath,
                });

                await row.$eval('button', btn => btn.click());
                const downloadedFilePath = await waitForDownload(downloadPath);
                console.log(`PDF downloaded to: ${downloadedFilePath}`);

                const pdfData = await extractDataWithPdf2Json(downloadedFilePath);

                // Save both the Table data AND the PDF data
                results.push({
                    taxYear, taxpayer, address, parcelNo, totalDue, status: "Paid", pdfData: pdfData
                });

                console.log("Paid Data: ", results);

                fs.unlink(downloadedFilePath, err => {
                    if (err) console.log(`An error occurred deleting PDF: ${err.message}`);
                });
            }
            break;
        }

        if (statusText.includes("Unpaid")) {
            await row.$eval('mat-checkbox input[type="checkbox"]', el => {
                if (!el.checked) el.click();
            });

            results.push({
                taxYear, taxpayer, address, parcelNo, totalDue, status: "Unpaid"
            });

            console.log("Unpaid Data: ", results);
        }
    }
    return results;
}

function buildCedarSchema(scrapedData, searchAccount) {
    if (!scrapedData || scrapedData.length === 0) return null;

    const result = createPropertyObject();
    const primaryRecord = scrapedData[0]; // The most recent year

    // Populate top-level Property details
    result.owner_name = [primaryRecord.taxpayer];
    result.property_address = primaryRecord.address;
    result.parcel_number = primaryRecord.parcelNo || searchAccount;

    // Assessed value comes from PDF if it was paid, otherwise "N/A"
    if (primaryRecord.pdfData && primaryRecord.pdfData.assessed) {
        result.total_assessed_value = formatCurrency(primaryRecord.pdfData.assessed);
        result.total_taxable_value = result.total_assessed_value;
    } else {
        result.total_assessed_value = "N/A";
        result.total_taxable_value = "N/A";
    }

    // Populate Tax History
    const history = [];
    for (let i = 0; i < scrapedData.length; i++) {
        const item = scrapedData[i];
        const record = createTaxHistory();

        record.year = item.taxYear;
        // Due date and Delinquent date formatting based on your rules
        const nextYear = parseInt(item.taxYear) + 1;
        record.due_date = `12/31/${item.taxYear}`;
        record.delq_date = `01/01/${nextYear}`;

        if (item.status === "Paid") {
            record.status = "Paid";
            record.base_amount = formatCurrency(item.pdfData?.subtotal || item.totalDue);
            record.amount_paid = formatCurrency(item.pdfData?.totalPaid || item.totalDue);
            record.amount_due = "$0.00";
            record.paid_date = item.pdfData?.paidDate || "";
        } else {
            record.base_amount = formatCurrency(item.totalDue);
            record.amount_paid = "$0.00";
            record.amount_due = formatCurrency(item.totalDue);

            // Calculate if it's currently due or delinquent based on today's date
            const today = new Date();
            const delqDateObj = new Date(record.delq_date);
            if (today >= delqDateObj) {
                record.status = "Delinquent";
            } else {
                record.status = "Due";
            }
        }
        history.push(record);
    }

    result.tax_history = history;
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

    // Generate Delinquent String & Notes based on history
    if (result.tax_history.length > 0) {
        const hasDelinquent = result.tax_history.some(t => t.status === "Delinquent");
        result.delinquent = hasDelinquent
            ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
            : "NONE";

        const latestTax = result.tax_history[result.tax_history.length - 1]; // Since the first item is the most recent
        const hasPriorDelinquent = result.tax_history.some(
            (t, index) => t.status === "Delinquent" && index !== 0
        );

        const keys = hasPriorDelinquent ? 0 : 1;
        result.notes = generate_notes(latestTax.year, keys, latestTax.status);
    }

    return result;
}

async function run(accountNumber) {
    let browserContext;
    try {
        const { browser, page } = await launchBrowser();
        browserContext = browser;

        await page.goto(
            "http://cedarpay.clearbasinsystems.com/pay-taxes",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);

        // 1. Scrape the raw table and PDF data
        const rawScrapedData = await parseResultsTable(page);

        // 2. Format it into the strict Schema
        const finalSchema = buildCedarSchema(rawScrapedData, accountNumber);

        console.log("\n--- Final Standardized Output ---");
        console.log(JSON.stringify(finalSchema, null, 2));

    } catch (err) {
        console.log("Error during script execution: ", err);
    } finally {
        
    }
}

run("1000180660");