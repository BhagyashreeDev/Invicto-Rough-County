const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const PDFParser = require("pdf2json");

(async () => {
    // Configuration
    const targetUrl = 'YOUR_INITIAL_SEARCH_URL_HERE'; // Replace with the actual URL
    const parcelToSearch = '45B-H-14.00--0'; // Test with your cases: '65--12.9--0', '26--25.00-M-1'

    const browser = await puppeteer.launch({ headless: false }); // Set to true in production
    const page = await browser.newPage();

    try {
        await page.goto(targetUrl, { waitUntil: 'networkidle2' });

        // 1. Select 'Parcel Information' from dropdown
        await page.select('select[name="selectMenu"]', 'parcelinfo');

        // Wait for the parcel table to become visible
        await page.waitForSelector('#parcelinfo', { visible: true });

        // 2. Parse the parcel string and fill the structure
        // Using string split on '-' perfectly maps to the 5 potential fields
        const parcelParts = parcelToSearch.split('-');
        
        if (parcelParts[0]) await page.type('#control_map', parcelParts[0]);
        if (parcelParts[1]) await page.type('#parcel_group', parcelParts[1]);
        if (parcelParts[2]) await page.type('#parcel_number', parcelParts[2]);
        if (parcelParts[3]) await page.type('#identifier', parcelParts[3]);
        if (parcelParts[4]) await page.type('#special_interest', parcelParts[4]);

        // 3. Click search and wait for results
        await Promise.all([
            page.waitForNavigation({ waitUntil: 'networkidle2' }),
            page.click('#submit_btn')
        ]);

        // 4. Find the "View Bill" link and navigate
        const viewBillUrl = await page.evaluate(() => {
            const link = document.querySelector('a[href*="mode=public_view"]');
            return link ? link.href : null;
        });

        if (!viewBillUrl) throw new Error("View Bill link not found on the results page.");

        await page.goto(viewBillUrl, { waitUntil: 'networkidle2' });

        // 5. Extract General Information and Assessed Value
        const propertyDetails = await page.evaluate(() => {
            const extractByLabel = (labelText) => {
                const tds = Array.from(document.querySelectorAll('td'));
                const targetTd = tds.find(td => td.textContent.trim() === labelText);
                return targetTd && targetTd.nextElementSibling ? targetTd.nextElementSibling.textContent.trim() : null;
            };

            return {
                propertyAddress: extractByLabel('Property:'),
                ownerName: extractByLabel('Owner:'),
                assessedTaxableValue: extractByLabel('Assessed Taxable Value:')
            };
        });

        console.log('--- Property Details Extracted ---');
        console.log(propertyDetails);

        // 6. Find the Parcel History PDF link
        const historyPdfUrl = await page.evaluate(() => {
            const link = document.querySelector('a[href*="mode=public_history_print"]');
            return link ? link.href : null;
        });

        if (!historyPdfUrl) throw new Error("Parcel History link not found.");

        console.log('--- Downloading and Parsing Parcel History ---');
        
        // 7. Download and parse the PDF
        const pdfData = await downloadAndParseStatement(page, historyPdfUrl, parcelToSearch);
        
        console.log('--- Parsed PDF Records ---');
        console.log(pdfData);

    } catch (err) {
        console.error("Error during execution:", err);
    } finally {
        await browser.close();
    }
})();

// --- Adapted PDF Functions ---

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
        const pdfData = await extractDataFromHistoryPdf(downloadedFilePath);
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

function extractDataFromHistoryPdf(filePath) {
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
                        text = decodeURIComponent(text).trim();
                        if (text != null && text !== "") {
                            textData.push(text);
                        }
                    });
                });

                // Filter logic to capture table records based on expected tax history format
                const records = [];
                let isRecording = false;

                for (let i = 0; i < textData.length; i++) {
                    const line = textData[i];
                    
                    // The ParcelHistory.pdf indicates the table begins with years like 2025
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