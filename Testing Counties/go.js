import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import PDFParser from "pdf2json"; // You need to run: npm install pdf2json

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
        total_assessed_value: "N/A",
        exemption: "",
        total_taxable_value: "N/A",
        delinquent: "NONE",
        taxing_authority: "Polk County Collector, 102 E Broadway #6, Bolivar, MO 65613",
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

const generate_notes = (year, keys, status) => {
    let notes = "";
    try {
        notes =
            keys === 1
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
    const [bookNo, idNo, splitNo] = accountNumber.split("-");
    await page.waitForSelector('input[name="book_no[]"]');

    await page.evaluate((b, i, s) => {
        document.querySelector('input[name="book_no[]"]').value = b;
        document.querySelector('input[name="id_no[]"]').value = i;
        document.querySelector('input[name="split_no[]"]').value = s;
    }, bookNo, idNo, splitNo);

    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.click('input[value="Search Record(s)"]')
    ]);
}

async function doPDFParsing(targetPage) {
    // 🔥 Grab the URL directly from the newly opened PDF tab
    const pdfUrl = targetPage.url();
    console.log("Downloading PDF from new tab URL:", pdfUrl);

    // Download the PDF using the new tab/page context
    const downloadedFilePath = await downloadStatementPdf(targetPage, pdfUrl, "2.pdf");

    // Ensure the output directory exists before writing to it
    const outputTextPath = path.resolve("./pdfs/2.content.txt");
    const outputDir = path.dirname(outputTextPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    // Parse the PDF and output to the .txt file
    const data = await extractDataFromPdf(downloadedFilePath, outputTextPath);

    // Clean up the downloaded PDF synchronously to avoid race conditions
    if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
        try {
            fs.unlinkSync(downloadedFilePath);
            console.log(`Deleted temporary PDF file: ${downloadedFilePath}`);
        } catch (err) {
            console.log(`Error deleting PDF: ${err.message}`);
        }
    }
    return data;
}

async function downloadStatementPdf(page, statementUrl, fileName) {
    const downloadPath = path.resolve('./pdfs');
    if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath, { recursive: true });

    const filePath = path.join(downloadPath, fileName);

    const base64 = await page.evaluate(async (url) => {
        // Fetch the PDF binary data directly in the browser context with same-origin
        const res = await fetch(url, { credentials: 'same-origin' });
        if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);

        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = '';
        for (let i = 0; i < bytes.byteLength; i++) {
            binary += String.fromCharCode(bytes[i]);
        }
        return btoa(binary);
    }, statementUrl);

    const buffer = Buffer.from(base64, 'base64');

    if (buffer.slice(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error('Downloaded content is not a valid PDF (missing %PDF- header). The session might be expired.');
    }

    fs.writeFileSync(filePath, buffer);
    return filePath;
}

function extractDataFromPdf(filePath, outputTextPath) {
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

                const fileContent = data.join('\n');

                // If you prefer to save it as a JSON array instead, use this:
                // const fileContent = JSON.stringify(data, null, 2);

                fs.writeFile(
                    "./downloads/1.content.txt",
                    fileContent, // <-- Write your processed data, not getRawTextContent()
                    (err) => {
                        if (err) {
                            console.error("Failed to write file:", err);
                        } else {
                            console.log("Done saving data to file.");
                        }
                    }
                );



                // Extract data based on hardcoded index parsing from PDF text output
                const ownerName = data[20];
                const address = data[21];
                const parcelId = data[10];
                const baseTax = data[53];
                const paidDate = data[81];
                const amountPaid = data[82];
                const text = "2025 REAL ESTATE";
                const yearMatch = text.match(/\d{4}/);
                const year = yearMatch ? yearMatch[0] : null;

                resolve({ ownerName, address, parcelId, baseTax, paidDate, amountPaid, year });
            } catch (error) {
                console.log("Error extracting text data:", error);
                reject(error);
            }
        });

        pdfParser.loadPDF(filePath);
    });
}

async function populateTheObject(page, data) {
    const result = createPropertyObject();
    result.owner_name.push(data.ownerName);
    result.property_address = data.address;
    result.parcel_number = data.parcelId;

    const record = createTaxHistory();
    record.year = data.year;
    record.base_amount = data.baseTax;
    record.amount_paid = data.amountPaid;
    record.paid_date = data.paidDate;
    record.amount_due = "$0.00";
    record.status = "Paid";
    record.due_date = `12/31/${record.year}`;
    record.delq_date = `01/01/${Number(record.year) + 1}`;
    result.tax_history.push(record);

    // sort the record
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
        const hasDelinquent = result.tax_history.some(
            (t) => t.status === "Delinquent",
        );
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

async function run(accountNumber) {
    let browserInstance = null;

    try {
        const { browser, page } = await launchBrowser();
        browserInstance = browser;

        await page.goto(
            "https://polkcountycollector.com/",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        // getting Paid Status - Real link
        const targetHref = await page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a'));
            const realStatusLink = links.find(a => a.innerText.trim() === 'Paid Status - Real');
            return realStatusLink ? realStatusLink.getAttribute('href') : null;
        });

        if (!targetHref) throw new Error("Could not find 'Paid Status - Real' link");

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.click(`a[href="${targetHref}"]`)
        ]);

        // click on continue
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.click("input[value='Continue']")
        ]);

        await searchAccountNumber(accountNumber, page);

        // 🔥 THE FIX: Setup a listener for the new tab/target created by clicking the print button
        const newPagePromise = new Promise(resolve => browser.once('targetcreated', async target => {
            const newPage = await target.page();
            resolve(newPage);
        }));


        const recordData = await page.evaluate(() => {
            // Select all data rows inside the body (skipping header tables)
            const rows = document.querySelectorAll('table cellspacing="3" cellpadding="2" tr, table tbody tr');

            // Filter rows that contain table data cells (td) rather than header cells (th)
            const dataRows = Array.from(document.querySelectorAll('table')).filter(table => {
                return table.querySelector('td.row1, td.row2');
            });

            if (dataRows.length === 0) return null;

            // Get the last data table
            const lastTable = dataRows[dataRows.length - 1];
            const cells = lastTable.querySelectorAll('td');

            // Column indices (0-based):
            // 3rd column -> index 2 (Name)
            // 4th column -> index 3 (Address)
            // 6th column -> index 5 (Base)
            return {
                ownerName: cells[2] ? cells[2].innerText.trim() : '',
                address: cells[3] ? cells[3].innerText.trim() : '',
                baseTax: cells[5] ? cells[5].innerText.trim() : ''
            };
        });

        console.log(recordData);


        // Click the print button (which opens the new tab)
        await page.evaluate(() => {
            const rows = document.querySelectorAll('table tr');
            const dataRows = Array.from(rows).filter(row => row.querySelector('input[name="p2"]'));

            if (dataRows.length > 0) {
                const lastRow = dataRows[dataRows.length - 1];
                const printBtn = lastRow.querySelector('input[name="p2"]');
                if (printBtn) printBtn.click();
            }
        });

        // Wait for the new tab to open and load
        const pdfPage = await newPagePromise;
        await pdfPage.waitForNetworkIdle();

        // Pass the new page object to parse the PDF
        const data = await doPDFParsing(pdfPage);

        const result = await populateTheObject(pdfPage, data);
        console.log(result);

        // Close the PDF tab when done
        await pdfPage.close();

        return result;

    } catch (err) {
        console.error("Error during running sequence execution pipeline: ", err);
    } finally {
        if (browserInstance) {
            // console.log("Closing browser...");
            // await browserInstance.close();
        }
    }
}

run("1-11003-0");