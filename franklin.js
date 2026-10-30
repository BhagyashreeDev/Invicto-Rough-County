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

async function searchAccountNumber(accountNumber, page) {
    // const realEstateSelector = 'input[type="radio"][value="RealEstate"]';
    // await page.waitForSelector(realEstateSelector,{visible: true});
    // await page.click(realEstateSelector);

    // const accountNumberSelector = 'input[type="radio"][value="AccountNumber"]';
    // await page.waitForSelector(accountNumberSelector, {visible: true});
    // await page.click(accountNumberSelector);

    // const searchBtnSelector = "#AccountNumberSearchCriteria";
    // await page.type(searchBtnSelector, accountNumber);

    // const submitBtnSelector = 'button[type="submit"].btn-primary';
    // await page.waitForSelector(submitBtnSelector, {visible: true});
    // await Promise.all([
    //     page.waitForNavigation({waitUntil: 'networkidle2'}),
    //     page.click(submitBtnSelector)
    // ]);

    await page.waitForSelector("#pid", { visible: true });
    await page.type("#pid", accountNumber);

    const btnSelector = 'button[type="submit"]';
    await page.waitForSelector(btnSelector, { visible: true });
    await page.click(btnSelector);

}

async function waitForDownload(downloadPath, timeout = 30000) {
    return new Promise((resolve, reject) => {
        const watcher = fs.watch(downloadPath, (eventType, filename) => {
            if (eventType === 'rename' && filename.endsWith('.pdf')) {
                watcher.close();
                resolve(path.join(downloadPath, filename));
            }
        });

        setTimeout(() => {
            watcher.close();
            reject(new Error("Download timed out"));
        }, timeout);
    });
}
function extractDataFromPdf(filePath) {
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
                    "./pdfs/file1.content.txt",
                    fileContent, // <-- Write your processed data, not getRawTextContent()
                    (err) => {
                        if (err) {
                            console.error("Failed to write file:", err);
                        } else {
                            console.log("Done saving data to file.");
                        }
                    }
                );

                resolve(pdfData);

            } catch (err) {
                reject(err);
            }
        });

        pdfParser.loadPDF(filePath);
    });
}

async function run(accountNumber) {

    try {
        const { browser, page } = await launchBrowser();


        await page.goto(
            "https://fcpay.franklinmo.gov/search",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);


        const downloadPath = path.resolve('./pdfs');

        // Ensure download directory exists
        if (!fs.existsSync(downloadPath)) {
            fs.mkdirSync(downloadPath);
        }
        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadPath
        });

        await page.waitForSelector('table tbody tr');

        console.log('Clicking the "Paid - Receipt" button for the most recent record...');
        // Targets the first button with the class .btn-receipt in the table body (the 2025 record)
        await page.click('table tbody tr:first-child .btn-receipt');

        console.log('Waiting for the PDF to download...');
        // Wait for the file to appear in our designated folder
        const downloadedFilePath = await waitForDownload(downloadPath);
        console.log(`File downloaded successfully to: ${downloadedFilePath}`);

        // Wait a brief moment to ensure the file is completely written to disk
        await new Promise(r => setTimeout(r, 1000));

        console.log('Parsing the PDF...');
        // Once downloaded, parse the PDF (e.g., REAL_PROPERTY_2025_1660944.pdf)
        const pdfDataArray = await extractDataFromPdf(downloadedFilePath);

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("18-6-14.0-0-002-010.000");