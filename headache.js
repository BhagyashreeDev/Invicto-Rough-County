import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import PDFParser from "pdf2json";
import console from "console";

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

// for generating notes
const generate_notes = (year, keys, status) => {
    let notes = "";
    try {
        notes =
            keys === 1
                ? `ALL PRIORS ARE PAID, ${year} `
                : `PRIORS ARE DELINQUENT, ${year} `;
        notes += `TAXES ARE ${status.toUpperCase()},`;
        notes += ` NORMALLY TAXES ARE PAID ANNUALLY,`;
        notes += ` NORMAL DUE DATE IS 10/01`;
    } catch (error) {
        console.log(error);
    } finally {
        return notes;
    }
};

// formatting the date
function formatUSDate(dateString) {
    if (!dateString || dateString.trim() === "" || dateString === "N/A") return "";

    const parsedDate = new Date(dateString);
    if (isNaN(parsedDate.getTime())) return dateString;

    const month = String(parsedDate.getMonth() + 1).padStart(2, '0');
    const day = String(parsedDate.getDate()).padStart(2, '0');
    const year = parsedDate.getFullYear();

    return `${month}/${day}/${year}`;
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
    // for getting owner name and address
    await page.waitForSelector(".content-pane .info .data-field .content", timeout_option);
    await page.waitForFunction('document.querySelector(".content-pane .info .data-field").lastElementChild.childElementCount == 0', timeout_option);
    let text = await page.evaluate(() => {
        let text = [];
        let divs = document.querySelectorAll(".content-pane .info .data-field .content");
        divs.forEach((div) => {
            text.push(div.textContent.trim());
        });
        return text;
    });


    // check the existence of unpaid records
    const hasUnpaidTable = await page.evaluate(() => {
        return !!document.querySelector("table.styled.bills tbody");
    });

    let extractedRows = [];
    let printButtonSelector = "";

    if (hasUnpaidTable) {
        const extractionData = await page.evaluate(() => {
            let results = [];
            let rows = document.querySelectorAll("table.styled.bills tbody tr");

            let highestYear = -1;
            let highestYearRowIndex = 1; // 1-based index for nth-child selector

            // Convert to array and loop
            Array.from(rows).forEach((tr, index) => {

                // 2. Map cells dynamically based on colSpan
                let cells = [];
                let colIndex = 0;

                tr.querySelectorAll("td").forEach((td) => {
                    cells[colIndex] = td;
                    // If the td has a colspan of 2, the next td will be placed 2 indexes away
                    colIndex += td.colSpan || 1;
                });

                // 3. Now it is completely safe to use the visual column indexes!
                // Visual column 6 (index 5) is ALWAYS Status
                let statusText = cells[5]?.textContent.trim().toLowerCase() || "";

                if (statusText.includes("unpaid") || statusText.includes("delinquent")) {
                    // Visual column 1 (index 0) is ALWAYS Year
                    let yearText = cells[0]?.textContent.trim() || "";
                    let yearStr = yearText.split('-')[0];
                    let yearNum = parseInt(yearStr, 10) || 0;

                    // Visual column 3 (index 2) is ALWAYS Due
                    let due = cells[2]?.textContent.trim();
                    let paid_date = "";

                    // Visual column 7 (index 6) is ALWAYS Paid
                    let paid = cells[6]?.textContent.trim();

                    let formattedStatus = statusText.includes("unpaid") ? "Unpaid" : "Delinquent";

                    results.push({ year: yearStr, due, paid_date, status: formattedStatus, paid });

                    if (yearNum > highestYear) {
                        highestYear = yearNum;
                        highestYearRowIndex = index + 1; // nth-child is 1-based
                    }
                }
            });

            return { results, highestYearRowIndex };
        });

        extractedRows = extractionData.results;
        if (extractedRows.length > 0) {
            printButtonSelector = `table.styled.bills tbody tr:nth-child(${extractionData.highestYearRowIndex}) span[title="Print Bill"] button`;
        } else {
            printButtonSelector = "";
        }
    }
    else {
        await page.waitForSelector("#mat-tab-label-0-1", timeout_option);
        await page.locator("#mat-tab-label-0-1").click();
        await page.waitForSelector(".history table tbody tr td", timeout_option);
        await page.waitForFunction('!document.querySelector(".history table tbody tr td .placeholders")', timeout_option);

        // Get the most recent paid/bill row (comparing first and last)
        let targetRow = await page.evaluate(() => {
            let rows = document.querySelectorAll(".history table tbody tr");
            // Filter out any expanded payment rows just in case
            let billRows = Array.from(rows).filter(tr => !tr.classList.contains("payment"));

            if (billRows.length === 0) return null;

            let firstTr = billRows[0];
            let lastTr = billRows[billRows.length - 1];

            // Helper to extract the year as an integer
            let getYear = (tr) => {
                let tds = tr.querySelectorAll("td");
                let yearText = tds[0]?.textContent.trim().split("-")[0] || "0";
                return parseInt(yearText, 10) || 0;
            };

            let firstYear = getYear(firstTr);
            let lastYear = getYear(lastTr);

            // Determine if the first row is the most recent
            let isFirstRowNewest = firstYear >= lastYear;

            // Select the row with the highest year
            let targetTr = isFirstRowNewest ? firstTr : lastTr;

            // Extract the data from the chosen row
            // 2. Map cells dynamically based on colSpan
            let cells = [];
            let colIndex = 0;

            targetTr.querySelectorAll("td").forEach((td) => {
                cells[colIndex] = td;
                // If the td has a colspan of 2, the next td will be placed 2 indexes away
                colIndex += td.colSpan || 1;
            });

            let year = cells[0]?.textContent.trim().split("-")[0] || "";
            let due = cells[2]?.textContent.trim() || "";
            let paid_date = cells[4]?.textContent.trim() || "";
            let status = cells[5]?.textContent.trim() || "";
            let paid = cells[6]?.textContent.trim() || "";

            // Check if this row contains "Show payments"
            let showPaymentsButton = Array.from(targetTr.querySelectorAll("button")).find((button) =>
                button.textContent
                    .trim()
                    .toLowerCase()
                    .includes("show payments")
            );

            return {
                year, due, paid_date, status, paid,
                hasPayments: !!showPaymentsButton,
                isFirstRowNewest
            };
        });
    
        if (targetRow) {
            // Destructure to remove the 'isFirstRowNewest' flag before pushing to your results
            const { isFirstRowNewest, ...cleanRowData } = targetRow;
            extractedRows.push(cleanRowData);

            // Dynamically target the print button for the correct row
            if (isFirstRowNewest) {
                printButtonSelector = '.history table tbody tr:not(.payment):first-child span[title="Print Bill"] button';
            } else {
                printButtonSelector = '.history table tbody tr:not(.payment):last-child span[title="Print Bill"] button';
            }
        }
    }

    let assessedValue = null;
    let printButtonExists = false;

    // Verify if the print button actually exists on the page
    if (printButtonSelector) {
        const btnElement = await page.$(printButtonSelector);
        if (btnElement) {
            printButtonExists = true;
        }
    }

    // Only attempt to download and parse PDF if the button exists
    if (printButtonExists) {
        // Generate a unique download path per request to avoid cross-request contamination
        const uniqueSessionId = Date.now().toString() + Math.floor(Math.random() * 10000);
        const downloadPath = path.resolve(`./pdfs/${uniqueSessionId}`);
        if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath, { recursive: true });

        try {
            const client = await page.target().createCDPSession();
            await client.send('Page.setDownloadBehavior', {
                behavior: 'allow',
                downloadPath: downloadPath,
            });

            // Start waiting for the download BEFORE clicking to prevent race condition
            const downloadPromise = waitForDownload(downloadPath);

            // Click the button
            await page.click(printButtonSelector);

            // Await the completion of the download
            const downloadedFilePath = await downloadPromise;

            assessedValue = await extractDataWithPdf2Json(downloadedFilePath);

            // Clean up downloaded file
            if (fs.existsSync(downloadedFilePath)) fs.unlinkSync(downloadedFilePath);

        } catch (error) {
            // Catch the timeout or parsing error, log it, and continue!
            console.log(`PDF processing skipped: ${error.message}. Continuing execution...`);
            // assessedValue remains null, script proceeds normally
        } finally {
            // Always attempt to clean up the temporary folder
            try {
                if (fs.existsSync(downloadPath)) {
                    // FIX: Use fs.rmSync instead of fs.rmdirSync to resolve the Node.js deprecation warning
                    fs.rmSync(downloadPath, { recursive: true, force: true });
                }
            } catch (err) {
                console.log("Cleanup error:", err);
            }
        }
        console.log("Assessed Value: ", assessedValue);
    }

    // the final return statement
    return { text, extractedRows, assessedValue };
}


// populate the object with object data
async function populateTheObject(text, extractedRows, assessedValue) {
    const result = createPropertyObject();
    result.owner_name.push(text[2]);
    result.property_address = text[1];

    result.total_assessed_value = assessedValue || "N/A"; // Handle if assessedValue is null
    result.total_taxable_value = assessedValue || "N/A";


    for (const row of extractedRows) {
        const record = createTaxHistory();
        record.year = row.year;
        // due & delinquent year
        if (row.year) {
            const taxYear = parseInt(row.year.trim(), 10);
            if (!isNaN(taxYear)) {
                record.due_date = `10/01/${taxYear}`; // October 1
                record.delq_date = `03/01/${taxYear + 1}`; // March 1 of next year
            }
        }
        // status
        if (row.status === "Paid") {
            record.base_amount = row.paid;
            record.status = "Paid";
        } else {
            record.base_amount = row.due;
            const today = new Date();
            const dueDateObj = new Date(record.due_date);

            if (today <= dueDateObj) {
                record.status = "Due";
            } else {
                record.status = "Delinquent";
            }
        }

        record.amount_paid = row.paid;
        record.amount_due = row.due;
        record.paid_date = formatUSDate(row.paid_date);
        result.tax_history.push(record);
    }

    // sort the records
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

    // deciding notes and delinquency
    if (result.tax_history.length > 0) {
        const hasDelinquent = result.tax_history.some((t) => t.status === "Delinquent");
        result.delinquent = hasDelinquent
            ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
            : "NONE";

        const latestTax = result.tax_history[result.tax_history.length - 1];

        const hasPriorDelinquent = result.tax_history.some(
            (t) => t.status === "Delinquent" && String(t.year) !== String(latestTax.year)
        );

        const keys = hasPriorDelinquent ? 0 : 1;
        result.notes = generate_notes(latestTax.year, keys, latestTax.status);
    }

    return result;
}


async function run(year_billNumber) {

    try {
        const { browser, page } = await launchBrowser();

        const dimensions = await page.evaluate(() => {
            return {
                width: window.screen.availWidth || 1920,
                height: window.screen.availHeight || 1080
            };
        });
        await page.setViewport({ width: dimensions.width, height: dimensions.height });

        const url = "https://paymadisontaxes.com/lookup/property-tax";
        await page.goto(
            `${url}/${year_billNumber}`,
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await page.waitForSelector(".results tbody tr td", timeout_option);
        await page.waitForFunction('!document.querySelector(".results tbody tr td .placeholders")', timeout_option);
        let promise_1 = page.evaluate(() => { document.querySelector(".results tbody tr").click(); }).then(() => { return true });
        let promise_2 = page.waitForSelector(".content-pane .info .data-field .content", timeout_option).then(() => { return true });
        await Promise.all([promise_1, promise_2]);


        const { text, extractedRows, assessedValue } = await getPropertyDetails(page);
        // 4. Populate the object 
        const result = await populateTheObject(text, extractedRows, assessedValue);
        result.parcel_number = year_billNumber;

        console.log(result);

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("2025-24385");


// for downloading the pdf
async function waitForDownload(downloadPath) {
    return new Promise((resolve, reject) => {
        // Failsafe: Check if the file is already there (in case it downloaded instantly)
        try {
            const files = fs.readdirSync(downloadPath);
            const existingPdf = files.find(f => f.endsWith('.pdf') && !f.endsWith('.crdownload'));
            if (existingPdf) {
                return resolve(path.join(downloadPath, existingPdf));
            }
            console.log("Downloading the pdf");
        } catch (e) {
            // Folder might not be ready, that's fine, we will watch for it
        }

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


// core logic to extract the pdf
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

                        try {
                            text = decodeURIComponent(text).trim();
                        } catch (e) {
                            try {
                                text = unescape(text).trim();
                            } catch (e2) {
                                text = text.trim();
                            }
                        }

                        if (text != null && text != "" && text != " ") {
                            data.push(text);
                        }
                    });
                });

                // get the assessed value
                let assessedValue = null;
                const targetIndex = data.indexOf("Assessed Value");

                if (targetIndex !== -1 && targetIndex + 1 < data.length) {
                    assessedValue = data[targetIndex + 1];
                    assessedValue = assessedValue.replace(/\s+/g, '');
                }
                resolve(assessedValue);

            } catch (error) {
                console.log(error);
                resolve(null);
            }
        });
        pdfParser.loadPDF(filePath);
    });
}