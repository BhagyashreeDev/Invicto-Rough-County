import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import PDFParser from "pdf2json";

const timeout_option = { timeout: 90000 };

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
    const parcelToggleSelector = 'forge-button-toggle[value="Parcels"]';
    await page.waitForSelector(parcelToggleSelector, { visible: true });
    await page.click(parcelToggleSelector);

    const inputSelector = 'input#ParcelNumber';
    await page.waitForSelector(inputSelector, { visible: true });

    await page.evaluate((sel) => {
        const input = document.querySelector(sel);
        if (input) input.value = '';
    }, inputSelector);

    await page.type(inputSelector, accountNumber, { delay: 50 });

    const searchBtnSelector = '#Parcel forge-button[type="submit"]';
    await page.waitForSelector(searchBtnSelector, { visible: true });

    await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", ...timeout_option }),
        page.click(searchBtnSelector)
    ]);
}

// ---------- Download helpers ----------

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

async function downloadStatementPdf(page, receiptNumber, year) {
    const statementUrl = `https://caldwellcountymo.municipalonlinepayments.com/caldwellcountymo/tax/search/statement?receiptNumber=${receiptNumber}&year=${year}`;

    const downloadPath = path.resolve('./pdfs');
    if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath, { recursive: true });
    const filePath = path.join(downloadPath, `statement_${receiptNumber}_${year}.pdf`);

    // Fetch inside the page context so the browser's session cookies are sent
    // automatically (credentials: 'include'), and Chrome's PDF viewer never
    // gets a chance to intercept/render anything — we get raw bytes back.
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

    // Sanity check: real PDFs start with "%PDF-". Fail loudly here instead of
    // getting a cryptic "Invalid XRef stream header" from pdf2json later.
    if (buffer.slice(0, 5).toString('latin1') !== '%PDF-') {
        throw new Error('Downloaded content is not a valid PDF (missing %PDF- header)');
    }

    fs.writeFileSync(filePath, buffer);
    return filePath;
}

// ---------- PDF parsing ----------

/**
 * Reconstructs readable lines from pdf2json's raw text runs.
 * Some PDF generators (like this county's) emit one character per text run,
 * so naive token-joining breaks words apart. We group runs by y-position
 * (a "line"), sort by x, and only insert a space when there's a real gap
 * between runs (vs. adjacent letters of the same word).
 */
function reconstructLines(pdfData) {
    const rowMap = new Map(); // key: rounded y -> [{x, text}]

    pdfData.Pages.forEach((page) => {
        page.Texts.forEach((t) => {
            const rawText = decodeURIComponent(t.R.map(r => r.T).join(''));
            if (!rawText || !rawText.trim()) return;
            const y = Math.round(t.y * 20) / 20;
            if (!rowMap.has(y)) rowMap.set(y, []);
            rowMap.get(y).push({ x: t.x, text: rawText });
        });
    });

    const sortedYs = [...rowMap.keys()].sort((a, b) => a - b);
    const lines = [];

    sortedYs.forEach((y) => {
        const tokens = rowMap.get(y).sort((a, b) => a.x - b.x);
        let segments = [''];
        let lastEndX = null;

        tokens.forEach(({ x, text }) => {
            if (lastEndX !== null) {
                const gap = x - lastEndX;
                if (gap > 3) {
                    // Big jump = separate column on the same visual row -> new line
                    segments.push('');
                } else if (gap > 0.55) {
                    segments[segments.length - 1] += ' ';
                }
            }
            segments[segments.length - 1] += text;
            lastEndX = x + text.length * 0.5;
        });

        segments.forEach((seg) => {
            const cleaned = seg.replace(/\s+/g, ' ').trim();
            if (cleaned) lines.push(cleaned);
        });
    });

    return lines;
}

function findValueAfterLabel(lines, labelRegex, maxLookahead = 3) {
    for (let i = 0; i < lines.length; i++) {
        const match = lines[i].match(labelRegex);
        if (!match) continue;

        // Same-line value (e.g. "TotalAssessedValue 18,720")
        const rest = lines[i].slice(match.index + match[0].length).trim();
        if (rest && /\d/.test(rest)) return rest;

        // Value fell onto the next line(s) (e.g. "TAXDUE" / "1,168.20")
        for (let j = i + 1; j <= i + maxLookahead && j < lines.length; j++) {
            const candidate = lines[j].trim();
            if (/^[\d,]+\.?\d*$/.test(candidate)) return candidate;
        }
    }
    return null;
}

function extractDataFromPdf(filePath, receiptNumber, isPaid) {
    return new Promise((resolve, reject) => {
        const pdfParser = new PDFParser();
        pdfParser.on("pdfParser_dataError", (e) => reject(e.parserError));

        pdfParser.on("pdfParser_dataReady", (pdfData) => {
            try {
                // 1. Reconstruct the fragmented text into readable lines
                const data = reconstructLines(pdfData);

                let extracted = { valuation: null, baseTax: null, amountPaid: null, amountDue: null };

                for (let i = 0; i < data.length; i++) {
                    let d = data[i];

                    if (data[0] && data[0].includes("TEXAS")) {
                        if (d.includes("TotalAssessedValue")) {
                            extracted.valuation = d.replace(/[^\d.,]/g, "").trim();
                        }
                        if (isPaid) {
                            if (d === "TOTALTAX") {
                                // Look ahead on the 'data' array, not the string 'd'
                                extracted.baseTax = data[i + 1] ? data[i + 1].trim() : null;
                            }

                            if (d === "TOTALPAID") {
                                const nextLine = data[i + 2] || data[i + 1] || "";
                                const parts = nextLine.trim().split(/\s+/);
                                extracted.amountPaid = parts[parts.length - 1] || null;
                            }
                        } else {
                            if (d === "BASETAX") {
                                extracted.baseTax = data[i + 1] ? data[i + 1].trim() : null;
                            }

                            if (d === "TOTALTAX") {
                                extracted.amountDue = data[i + 1] ? data[i + 1].trim() : null;
                            }
                        }
                    } else {
                        if (d.includes("TotalAssessedValue")) {
                            extracted.valuation = d.replace(/[^\d.,]/g, "").trim();
                        }
                        if (isPaid) {
                            if (d === "TAXDUE") {
                                extracted.baseTax = data[i + 1] ? data[i + 1].trim() : null;
                            }
                            if (d === "TOTALPAID") {
                                const nextLine = data[i + 2] || data[i + 1] || "";
                                const parts = nextLine.trim().split(/\s+/);
                                extracted.amountPaid = parts[parts.length - 1] || null;
                            }
                        }
                    }
                }

                console.log(extracted);
                resolve(pdfData); // or resolve(extracted) depending on your needs
            } catch (error) {
                console.log("Error extracting text data:", error);
                reject(error);
            }
        });

        pdfParser.loadPDF(filePath);
    });
}

async function downloadAndParseStatement(page, receiptNumber, year, isPaid) {
    let downloadedFilePath;
    try {
        downloadedFilePath = await downloadStatementPdf(page, receiptNumber, year);
    } catch (err) {
        console.log("Failed to capture PDF:", err.message);
        return null;
    }
    try {
        const pdfData = await extractDataFromPdf(downloadedFilePath, receiptNumber, isPaid);
        return pdfData;
    } catch (err) {
        console.log("Failed to parse PDF:", err.message);
        return null;
    } finally {
        fs.unlink(downloadedFilePath, (err) => {
            if (err) console.log(`Error deleting PDF: ${err.message}`);
        });
    }
}

// ---------- Results table parsing ----------

async function parseResultsTable(page, receiptNumber) {
    try {
        await page.waitForSelector('.search_results .card-list', { timeout: 15000 });
    } catch (e) {
        console.log("No parcel rows found.");
        return [];
    }

    const rows = await page.$$('.search_results .card-list');
    const results = [];

    for (let i = 0; i < rows.length; i++) {
        const row = rows[i];

        const rowData = await row.evaluate((el) => {
            const owner = el.querySelector('.forge-typography--heading2')?.textContent.trim() || null;
            const parcelNo = el.querySelector('.forge-typography--subheading1')?.textContent.trim() || null;
            const labelValues = {};

            el.querySelectorAll('forge-label-value').forEach((lv) => {
                const label = lv.querySelector('[slot="label"]')?.textContent.trim();
                const valueEl = lv.querySelector('[slot="value"]');
                let value = null;
                let extra = null;
                if (valueEl) {
                    const small = valueEl.querySelector('small');
                    if (small) {
                        extra = small.textContent.trim();
                        const clone = valueEl.cloneNode(true);
                        clone.querySelector('small')?.remove();
                        value = clone.textContent.trim();
                    } else {
                        value = valueEl.textContent.trim();
                    }
                }
                if (label) labelValues[label] = { value, extra };
            });

            const btn = el.querySelector('forge-icon-button');
            const onclick = btn ? btn.getAttribute('onclick') : null;
            return { owner, parcelNo, labelValues, onclick };
        });

        const isPaid = !!rowData.labelValues['Paid'];
        const address = rowData.labelValues['Address']?.value || null;
        const taxYear = rowData.labelValues['Year']?.value || null;
        const taxableValue = rowData.labelValues['Taxable value']?.value || null;

        let receiptNumber = null, urlYear = null;
        if (rowData.onclick) {
            const match = rowData.onclick.match(/receiptNumber=([^&']+)&(?:amp;)?year=([^&']+)/);
            if (match) {
                receiptNumber = match[1];
                urlYear = match[2];
            }
        }

        if (isPaid) {
            // Only recent year paid record we need
            if (i === 0) {
                // If the TaxYear is Paid
                const paidAmount = rowData.labelValues['Paid'].value;
                const paidDate = rowData.labelValues['Paid'].extra
                    ? rowData.labelValues['Paid'].extra.replace(/^on\s*/i, '')
                    : null;

                // PDF parsing starts from here...
                const pdfData = await downloadAndParseStatement(page, receiptNumber, urlYear, isPaid);

                // results.push({
                //     owner: rowData.owner,
                //     parcelNo: rowData.parcelNo,
                //     taxYear,
                //     address,
                //     taxableValue,
                //     assessedValue: pdfData?.assessedValue || "N/A",
                //     totalDue: pdfData?.taxDue || null,
                //     paidAmount,
                //     paidDate,
                //     status: "Paid",
                // });
            }
            break; // current year is paid -- no need to look at prior years at all
        } else {

            // If the TaxYear is Unpaid
            const dueAmount = rowData.labelValues['Due']?.value || null;
            const pdfData = await downloadAndParseStatement(page, receiptNumber, urlYear, isPaid);

            // results.push({
            //     owner: rowData.owner,
            //     parcelNo: rowData.parcelNo,
            //     taxYear,
            //     address,
            //     taxableValue,
            //     assessedValue: pdfData?.assessedValue || "N/A",
            //     totalDue: dueAmount || pdfData?.taxDue,
            //     baseTax: pdfData?.baseTax || "$0.00",
            //     paidAmount: "",
            //     paidDate: "",
            //     status: "Unpaid",
            // });
        }
    }
    return results;
}

// ---------- Main run ----------

async function run(accountNumber) {
    let browserContext;
    try {
        const { browser, page } = await launchBrowser();
        browserContext = browser;

        await page.goto(
            "https://caldwellcountymo.municipalonlinepayments.com/caldwellcountymo/tax/search",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);
        await parseResultsTable(page, accountNumber);

        // console.log("Final results:", JSON.stringify(results, null, 2));
        // return results;
    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("09-4-18----2.00-");