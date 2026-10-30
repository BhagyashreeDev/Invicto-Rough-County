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
    await page.waitForSelector(".content-pane .info .data-field .content", timeout_option);
    await page.waitForFunction('document.querySelector(".content-pane .info .data-field").lastElementChild.childElementCount == 0', timeout_option);
    let text = await page.evaluate(() => {
        let text = [];
        let divs = document.querySelectorAll(".content-pane .info .data-field .content");
        divs.forEach((div) => {
            text.push(div.textContent.trim());
        });
        return text;
    })
    console.log(text);

    // TAX INFO
    await page.waitForSelector("#mat-tab-label-0-1", timeout_option);
    await page.locator("#mat-tab-label-0-1").click();

    await page.waitForSelector(".history table tbody tr td", timeout_option);
    await page.waitForFunction('!document.querySelector(".history table tbody tr td .placeholders")', timeout_option);
    
    let lastRowDetails = await page.evaluate(() => {
        // Target only the last row in the tbody directly
        let lastTr = document.querySelector(".history table tbody tr:last-child");

        // Return null if the table is empty
        if (!lastTr) return null;

        let tds = lastTr.querySelectorAll("td");

        let year = tds[0]?.textContent.split('-').at(0);
        let due = tds[2]?.textContent.trim();
        let paid_date = tds[4]?.textContent.trim();
        let status = tds[5]?.textContent.trim();
        let paid = tds[6]?.textContent.trim();

        return { year, due, paid_date, status, paid };
    });

    console.log("Last Row Data: ", lastRowDetails);

    const downloadPath = path.resolve('./pdfs');
    if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath);

    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadPath,
    });

    const printButtonSelector = 'table tbody tr:last-child span[title="Print Bill"] button';
    // 5. Wait for the button to be rendered and visible on the page
    await page.waitForSelector(printButtonSelector, { visible: true });

    // 6. Click the button to trigger the download
    await page.click(printButtonSelector);

    // Wait for a few seconds to ensure the download completes before closing the browser
    await new Promise(resolve => setTimeout(resolve, 5000));

    const downloadedFilePath = await waitForDownload(downloadPath);
    const assessedValue = await extractDataWithPdf2Json(downloadedFilePath);
    return {text, lastRow, assessedValue};
}

async function waitForDownload(downloadPath) {
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

                        // FIX: Add try/catch to handle Malformed URIs gracefully
                        try {
                            text = decodeURIComponent(text).trim();
                        } catch (e) {
                            try {
                                // Fallback for invalid URI sequences
                                text = unescape(text).trim();
                            } catch (e2) {
                                // Ultimate fallback to raw text if both fail
                                text = text.trim();
                            }
                        }

                        if (text != null && text != "" && text != " ") {
                            data.push(text);
                        }
                    });
                });

                // const fileContent = data.join('\n');

                // fs.writeFile(
                //     "./pdfs/print.content.txt",
                //     fileContent,
                //     (err) => {
                //         if (err) {
                //             console.error("Failed to write file:", err);
                //         } else {
                //             console.log("Done saving data to file.");
                //         }
                //     }
                // );

                let assessedValue = null;

                // Find the index of the text "Assessed Value" in our parsed data array
                const targetIndex = data.indexOf("Assessed Value");

                // If it exists, the actual dollar amount will be the very next element
                if (targetIndex !== -1 && targetIndex + 1 < data.length) {
                    assessedValue = data[targetIndex + 1];
                    // Clean up the extra spaces inside the string (e.g., "$       30,875.00" -> "$30,875.00")
                    assessedValue = assessedValue.replace(/\s+/g, '');
                }

                // Resolve the promise with ONLY the assessed value
                resolve(assessedValue);

            } catch (error) {
                console.log(error);
                resolve(null);
            }
        });
        pdfParser.loadPDF(filePath);
    });
}


async function populateTheObject(text, lastRow, assessedValue) {
    const result = createPropertyObject();
    result.owner_name.push(text[1]);
    result.property_address = text[2];
    
    const record = createTaxHistory();
    record.status = lastRow.status;
    record.base_amount = lastRow.paid;
    record.amount_paid = lastRow.paid;
    record.paid_date = lastRow.paid_date;
    record.amount_due = lastRow.due;
}

async function run(accountNumber) {
    let browser, page;
    try {
        ({ browser, page } = await launchBrowser());

        await page.goto(
            `https://loudon.paytntaxes.com/property-tax/bill/${accountNumber}`,
            { waitUntil: "networkidle2", ...timeout_option }
        );

       const {text, lastRow, assessedValue} = await getPropertyDetails(page);
       await populateTheObject(text, lastRow, assessedValue);

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {
        // Optional: Ensure browser closes when script is done
        // if (browser) await browser.close();
    }
}

run("9017");