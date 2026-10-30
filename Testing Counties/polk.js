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
    const pdfUrl = targetPage.url();
    console.log("Downloading PDF from new tab URL:", pdfUrl);

    const downloadedFilePath = await downloadStatementPdf(targetPage, pdfUrl, "1.pdf");

    const outputTextPath = path.resolve("./pdfs/2.content.txt");
    const outputDir = path.dirname(outputTextPath);
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
    }

    const data = await extractDataFromPdf(downloadedFilePath, outputTextPath);

    // if (downloadedFilePath && fs.existsSync(downloadedFilePath)) {
    //     try {
    //         fs.unlinkSync(downloadedFilePath);
    //         console.log(`Deleted temporary PDF file: ${downloadedFilePath}`);
    //     } catch (err) {
    //         console.log(`Error deleting PDF: ${err.message}`);
    //     }
    // }
    return data;
}

async function downloadStatementPdf(page, statementUrl, fileName) {
    const downloadPath = path.resolve('./pdfs');
    if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath, { recursive: true });

    const filePath = path.join(downloadPath, fileName);

    const base64 = await page.evaluate(async (url) => {
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

                fs.writeFile(outputTextPath, fileContent, (err) => {
                    if (err) console.error("Failed to write file:", err);
                    else console.log("Done saving data to file.");
                });

                // Find "TOTAL VALUATION" and get next index to get assessedValue
                const valIndex = data.findIndex(text => text.toUpperCase().includes("TOTAL VALUATION"));
                const assessedValue = valIndex !== -1 && (valIndex + 1 < data.length)
                    ? data[valIndex + 1]
                    : null;
                console.log("Assessed Value: ", assessedValue);    

                // Find "DATE:" and get index + 3
                const dateIndex = data.findIndex(text => text.toUpperCase().includes("DATE:"));
                const paidDate = dateIndex !== -1 && (dateIndex + 3 < data.length)
                    ? data[dateIndex + 3]
                    : null;

                // Find "AMOUNT PAID:" and get index + 3
                const amountIndex = data.findIndex(text => text.toUpperCase().includes("AMOUNT PAID:"));
                const amountPaid = amountIndex !== -1 && (amountIndex + 3 < data.length)
                    ? data[amountIndex + 3]
                    : null;

                const fullTextStr = data.join(" ");
                const yearMatch = fullTextStr.match(/(\d{4})\s+REAL\s+ESTATE/i);
                const year = yearMatch ? yearMatch[1] : null;

                const parcelIdMatch = data.find(item => item.match(/^\d+-\d+-\d+-\d+/));
                const parcelId = parcelIdMatch ? parcelIdMatch : data[10];

                resolve({ paidDate, amountPaid, year, parcelId, assessedValue });
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
    result.total_assessed_value = data.assessedValue ? `$${data.assessedValue}` : "N/A";
    result.total_taxable_value = result.total_assessed_value;

    const record = createTaxHistory();
    record.year = data.year;
    record.base_amount = data.baseTax;
    record.amount_paid = `$${data.amountPaid}`;
    record.paid_date = data.paidDate;
    record.amount_due = "$0.00";
    record.status = "Paid";
    record.due_date = `12/31/${record.year}`;
    record.delq_date = `01/01/${Number(record.year) + 1}`;
    result.tax_history.push(record);

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

        await Promise.all([
            page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
            page.click("input[value='Continue']")
        ]);

        await searchAccountNumber(accountNumber, page);

        const newPagePromise = new Promise(resolve => browser.once('targetcreated', async target => {
            const newPage = await target.page();
            resolve(newPage);
        }));

        // 🔥 FIX IS HERE: We got rid of the broken querySelectorAll and just found tables with td.row1 or td.row2
        const recordData = await page.evaluate(() => {
            const dataTables = Array.from(document.querySelectorAll('table')).filter(table => {
                return table.querySelector('td.row1, td.row2');
            });

            if (dataTables.length === 0) return null;

            // Get the last data table (latest year)
            const lastTable = dataTables[dataTables.length - 1];
            const cells = lastTable.querySelectorAll('td');

            return {
                ownerName: cells[2] ? cells[2].innerText.trim() : '',
                address: cells[3] ? cells[3].innerText.trim() : '',
                baseTax: cells[5] ? cells[5].innerText.trim() : ''
            };
        });

        console.log("Scraped Record Data:", recordData);

        // Click the print button (which opens the new tab)
        await page.evaluate(() => {
            // Find all print buttons and click the last one
            const buttons = document.querySelectorAll('input[name="p2"][value="Print"]');
            if (buttons.length > 0) {
                buttons[buttons.length - 1].click();
            }
        });

        const pdfPage = await newPagePromise;
        await pdfPage.waitForNetworkIdle();

        const pdfData = await doPDFParsing(pdfPage);

        const combinedData = {
            ownerName: recordData.ownerName,
            address: recordData.address,
            baseTax: recordData.baseTax,
            paidDate: pdfData.paidDate,
            amountPaid: pdfData.amountPaid,
            year: pdfData.year,
            parcelId: pdfData.parcelId,
            assessedValue: pdfData.assessedValue
        };

        const result = await populateTheObject(pdfPage, combinedData);
        console.log("Final Result: ", JSON.stringify(result, null, 2));

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

run("1-1852-0");