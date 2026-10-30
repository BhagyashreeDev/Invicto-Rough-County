import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import PDFParser from "pdf2json";
const timeout_option = {
    timeout: 90000,
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

async function searchAccountNumber(parcelToSearch, page) {
    await page.select('select[name="selectMenu"]', 'parcelinfo');
    await page.waitForSelector('#parcelinfo', { visible: true });
    const parcelParts = parcelToSearch.split('-');

    if (parcelParts[0]) await page.type('#control_map', parcelParts[0]);
    if (parcelParts[1]) await page.type('#parcel_group', parcelParts[1]);
    if (parcelParts[2]) await page.type('#parcel_number', parcelParts[2]);
    if (parcelParts[3]) await page.type('#identifier', parcelParts[3]);
    if (parcelParts[4]) await page.type('#special_interest', parcelParts[4]);

    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('#submit_btn')
    ]);

    const viewBillUrl = await page.evaluate(() => {
        const link = document.querySelector('a[href*="mode=public_view"]');
        return link ? link.href : null;
    });

    if (!viewBillUrl) throw new Error("View Bill link not found on the results page.");

    await page.goto(viewBillUrl, { waitUntil: 'networkidle2' });
}

async function getPropertyInfo(page, parcelToSearch) {
    const propertyDetails = await page.evaluate(() => {
        const extractByLabel = (labelText) => {
            const tds = Array.from(document.querySelectorAll('td'));
            const targetTd = tds.find(td => td.textContent.trim() === labelText);
            return targetTd && targetTd.nextElementSibling ? targetTd.nextElementSibling.textContent.trim() : null;
        };

        return {
            propertyAddress: extractByLabel('Property:'),
            ownerName: extractByLabel('Owner:'),
            assessedValue: extractByLabel('Assessed Taxable Value:')
        };
    });

    console.log(propertyDetails);

    const historyPdfUrl = await page.evaluate(() => {
        const link = document.querySelector('a[href*="mode=public_history_print"]');
        return link ? link.href : null;
    });

    if (!historyPdfUrl) throw new Error("Parcel History link not found.");
    const pdfData = await downloadAndParseStatement(page, historyPdfUrl, parcelToSearch);
}

async function downloadAndParseStatement(page, statementUrl, identifier) {
    let downloadedFilePath;
    const downloadPath = path.resolve('./downloads');
    if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath, { recursive: true });

    const filePath = path.join(downloadPath, `ParcelHistory_${identifier}.pdf`);

    try {
        // Evaluate fetch within the browser context to handle session cookies
        const base64 = await page.evaluate(async (url) => {
            const res = await fetch(url, { credentials: 'include' });
            if (!res.ok) throw new Error(`Fetch failed: ${res.status}`);
            const buf = await res.arrayBuffer();
            const bytes = new Uint8Array(buf);
            let binary = '';
            for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
            return btoa(binary);
        }, statementUrl);

        const buffer = Buffer.from(base64, 'base64');
        if (buffer.slice(0, 5).toString('latin1') !== '%PDF-') {
            throw new Error('Downloaded content is not a valid PDF');
        }

        fs.writeFileSync(filePath, buffer);
        downloadedFilePath = filePath;

        // Extract using pdf2json
        const pdfData = await extractDataFromHistoryPdf(downloadedFilePath, identifier);
        return pdfData;

    } catch (err) {
        console.error("Failed to capture or parse PDF:", err.message);
        return null;
    } finally {
        if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
            fs.unlink(downloadedFilePath, (err) => {
                if (err) console.log(`Error deleting temporary PDF: ${err.message}`);
            });
        }
    }
}

function extractDataFromHistoryPdf(filePath, identifier) {
    return new Promise((resolve, reject) => {
        const pdfParser = new PDFParser();
        pdfParser.on("pdfParser_dataError", (e) => reject(e.parserError));

        pdfParser.on("pdfParser_dataReady", (pdfData) => {
            try {
                let textData = [];
                // Extract all decoded text blocks
                pdfData['Pages'].forEach((p) => {
                    p['Texts'].forEach((t) => {
                        let text = t["R"][0]["T"];

                        // FIX 1: Safely decode the URI to prevent "URI malformed" errors
                        try {
                            text = decodeURIComponent(text).trim();
                        } catch (e) {
                            // Fallback for improperly encoded strings (like standalone % signs)
                            text = unescape(text).trim();
                        }

                        if (text != null && text !== "") {
                            textData.push(text);
                        }
                    });
                });

                // FIX 2: Changed 'data' to 'textData' to resolve the ReferenceError
                const fileContent = textData.join('\n');
                const textFilePath = `./downloads/${identifier}_content.txt`;
                fs.writeFile(
                    textFilePath,
                    fileContent,
                    (err) => {
                        if (err) {
                            console.error(`Failed to write file ${textFilePath}:`, err);
                        } else {
                            console.log(`Done saving data to ${textFilePath}`);
                        }
                    }
                );

                // Filter logic to capture table records based on expected tax history format
                const records = [];
                let isRecording = false;

                for (let i = 0; i < textData.length; i++) {
                    const line = textData[i];

                    // The PDF indicates the table begins with years like 2025
                    if (/^(201[5-9]|202[0-9])$/.test(line)) {
                        isRecording = true;
                    }

                    if (isRecording) {
                        records.push(line);
                    }
                }

                resolve(records);

            } catch (error) {
                reject(error);
            }
        });

        pdfParser.loadPDF(filePath);
    });
}

async function run(parcelToSearch) {

    try {
        const { browser, page } = await launchBrowser();


        await page.goto(
            "https://hancock-tn.mygovonline.com/mod.php?mod=propertytax&mode=public_lookup",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(parcelToSearch, page);

        await getPropertyInfo(page, parcelToSearch);

        // console.log(JSON.stringify(result, null, 2));

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("26--9.00-M-1");