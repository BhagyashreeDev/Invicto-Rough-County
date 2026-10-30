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
        taxing_authority: "Hawkins County Trustee, 110 E Main St, Rogersville, TN 37857",
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
        notes += ` NORMAL DUE DATE IS 10/01`;
    } catch (error) {
        console.log(error);
    } finally {
        return notes;
    }
};

function formatBaseAmount(usdString) {
    if (!usdString) return "";
    const num = usdString.replace(/^USD/, "");
    return `$${num}`;
}

function getFirstMondayOfOctober(year) {
    const d = new Date(year, 9, 1);
    const day = d.getDay();
    const diff = day === 0 ? 1 : (day === 1 ? 0 : 8 - day);
    d.setDate(d.getDate() + diff);

    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
}

function getDelqDate(dueDate) {
    let delqDate;
    if (dueDate) {
        const [mm, dd, yyyy] = dueDate.split("/").map(Number);
        const nextDay = new Date(yyyy, mm - 1, dd + 1);

        const newMM = String(nextDay.getMonth() + 1).padStart(2, "0");
        const newDD = String(nextDay.getDate()).padStart(2, "0");
        delqDate = `${newMM}/${newDD}/${nextDay.getFullYear()}`;
    }
    return delqDate;
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

async function searchAccountNumber(accountNumber, page) {
    const searchSelector = "#searchField";
    await page.waitForSelector(searchSelector, { visible: true });
    await page.type(searchSelector, accountNumber);
    await page.keyboard.press("Enter");
}

async function resultCard(page, accountNumber) {
    await page.waitForSelector('svg[data-testid="HomeIcon"]', {
        visible: true,
        ...timeout_option
    });

    await page.click('svg[data-testid="HomeIcon"]');
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

                const joinedText = data.join("");
                const amountMatches = joinedText.match(/USD[\d,]+\.\d{2}/g);
                const baseTaxValue = amountMatches ? amountMatches[0] : null;

                console.log(baseTaxValue);
                resolve(baseTaxValue);
            } catch (error) {
                console.log(error);
                resolve(null);
            }
        });
        pdfParser.loadPDF(filePath);
    });
}

async function parsePropertyDetails(page, accountNumber) {
    const result = createPropertyObject();

    await page.waitForFunction(() => {
        return (
            document.querySelector('svg[data-testid="CheckCircleOutlineIcon"]') ||
            document.querySelector('svg[data-testid="AddShoppingCartOutlinedIcon"]')
        );
    });

    const status = await page.evaluate(() => {
        if (document.querySelector('svg[data-testid="CheckCircleOutlineIcon"]')) return "Paid";
        if (document.querySelector('svg[data-testid="AddShoppingCartOutlinedIcon"]')) return "Unpaid";
        return "Unknown";
    });

    const ownerName = await page.evaluate(() => {
        const labels = [...document.querySelectorAll("p")];
        const ownerLabel = labels.find(p => p.textContent.trim() === "Owner:");
        return ownerLabel?.nextElementSibling?.textContent.trim() || null;
    });

    const propertyAddress = await page.evaluate(() => {
        const labels = [...document.querySelectorAll("p")];
        const addressLabel = labels.find(p => p.textContent.trim() === "Address:");
        return addressLabel?.nextElementSibling?.textContent.trim() || null;
    });

    // --- Safe Year Selection Logic ---
    await page.waitForSelector('[role="combobox"]', { visible: true });

    const currentYear = await page.evaluate(() => {
        const cb = document.querySelector('[role="combobox"]');
        return cb ? cb.textContent.trim() : "";
    });

    // Only attempt dropdown interaction if 2025 is not already selected
    if (currentYear !== "2025") {
        await page.click('[role="combobox"]');
        
        try {
            await page.waitForFunction(() => {
                const elements = [...document.querySelectorAll('li, [role="option"]')];
                return elements.some(el => el.textContent.trim() === "2025");
            }, { timeout: 5000 });

            await page.evaluate(() => {
                const elements = [...document.querySelectorAll('li, [role="option"]')];
                const option = elements.find(el => el.textContent.trim() === "2025");
                if (option) option.click();
            });
        } catch (err) {
            console.log("2025 dropdown option not found or already selected, continuing...");
        }
    }

    await page.waitForFunction(() => {
        return !document.body.innerText.includes("Tax data not yet available");
    }, { timeout: 30000 });

    // --- Calculate Assessed & Taxable Value ---
    const formulaData = await page.evaluate(() => {
        const paragraphs = [...document.querySelectorAll("p")];
        const formulaPara = paragraphs.find(p => p.textContent.includes("x") && p.textContent.includes("%") && p.textContent.includes("="));
        if (!formulaPara) return null;

        const text = formulaPara.textContent.trim();
        const match = text.match(/\$([\d,]+(?:\.\d+)?)\s*x\s*([\d.]+)%/i);
        if (match) {
            return {
                propertyValueStr: match[1],
                assessmentPercentStr: match[2]
            };
        }
        return null;
    });

    if (formulaData) {
        const propertyValue = parseFloat(formulaData.propertyValueStr.replace(/,/g, ""));
        const assessmentPercent = parseFloat(formulaData.assessmentPercentStr);

        if (!isNaN(propertyValue) && !isNaN(assessmentPercent)) {
            const calculatedAssessedValue = (propertyValue * assessmentPercent) / 100;
            
            const formattedValue = `$${calculatedAssessedValue.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
            
            result.total_assessed_value = formattedValue;
            result.total_taxable_value = formattedValue;
            
            console.log(`Calculated Assessed Value: ${formattedValue}`);
        }
    }

    result.owner_name = ownerName ? ownerName : "N/A";
    result.parcel_number = accountNumber;
    result.property_address = propertyAddress ? propertyAddress : "N/A";

    if (status === "Paid") {
        await page.waitForFunction(() => {
            return [...document.querySelectorAll("p")].some(
                p => p.textContent.trim() === "Amount Paid:"
            );
        }, { timeout: 30000 });

        const taxDetails = await page.evaluate(() => {
            function getValue(label) {
                const labels = [...document.querySelectorAll("p")];
                const element = labels.find(
                    p => p.textContent.trim() === label
                );
                return element?.nextElementSibling?.textContent.trim() || null;
            }

            return {
                year: getValue("Taxable Year"),
                outstandingDue: getValue("Outstanding Due"),
                amountPaid: getValue("Amount Paid:"),
                paidDate: getValue("Payment Date:")
            };
        });

        await page.waitForSelector('svg[data-testid="ReceiptLongIcon"]', { visible: true, ...timeout_option });
        const downloadPath = path.resolve('./downloads');
        if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath);

        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadPath,
        });

        await page.click('svg[data-testid="ReceiptLongIcon"]');
        const downloadedFilePath = await waitForDownload(downloadPath);
        const baseTax = await extractDataWithPdf2Json(downloadedFilePath);

        const record = createTaxHistory();
        record.year = taxDetails.year;
        record.base_amount = formatBaseAmount(baseTax) ? formatBaseAmount(baseTax) : taxDetails.amountPaid;
        record.amount_paid = taxDetails.amountPaid;
        record.amount_due = taxDetails.outstandingDue;

        if (taxDetails.paidDate && taxDetails.paidDate.includes("-")) {
            const datePart = taxDetails.paidDate.split(" ")[0];
            const [yyyy, mm, dd] = datePart.split("-");
            record.paid_date = `${mm}/${dd}/${yyyy}`;
        } else {
            record.paid_date = taxDetails.paidDate || "N/A";
        }

        const yearInt = parseInt(taxDetails.year, 10);
        if (!isNaN(yearInt)) {
            record.due_date = getFirstMondayOfOctober(yearInt);
            record.delq_date = getDelqDate(record.due_date);
        }

        if (record.amount_due === "$0.00" || record.amount_due === "$0") {
            record.status = "Paid";
        } else {
            const today = new Date();
            const dueDateObj = new Date(record.due_date);
            if (today <= dueDateObj) {
                record.status = "Due";
            } else {
                record.status = "Delinquent";
            }
        }

        result.tax_history.push(record);

    } else {
        await page.waitForFunction(() => {
            return [...document.querySelectorAll("p")].some(
                p => p.textContent.trim() === "Amount Due:"
            );
        }, { timeout: 30000 });
        await page.$('svg[data-testid="CalendarTodayTwoToneIcon"]');

        const taxDetails = await page.evaluate(() => {
            function getValue(label) {
                const labels = [...document.querySelectorAll("p")];
                const element = labels.find(p => p.textContent.trim() === label);
                return element?.nextElementSibling?.textContent.trim() || null;
            }

            return {
                year: getValue("Taxable Year"),
                outstandingDue: getValue("Outstanding Due"),
                amountDue: getValue("Amount Due:"),
                dueDate: getValue("Due Date:")
            };
        });

        await page.waitForSelector('svg[data-testid="ReceiptLongIcon"]', { visible: true, ...timeout_option });
        const downloadPath = path.resolve('./downloads');
        if (!fs.existsSync(downloadPath)) fs.mkdirSync(downloadPath);

        const client = await page.target().createCDPSession();
        await client.send('Page.setDownloadBehavior', {
            behavior: 'allow',
            downloadPath: downloadPath,
        });

        await page.click('svg[data-testid="ReceiptLongIcon"]');
        const downloadedFilePath = await waitForDownload(downloadPath);
        const baseTax = await extractDataWithPdf2Json(downloadedFilePath);

        const record = createTaxHistory();
        record.year = taxDetails.year;
        record.base_amount = formatBaseAmount(baseTax);
        record.amount_due = taxDetails.outstandingDue;
        record.due_date = taxDetails.dueDate;
        record.amount_paid = "$0.00";
        record.delq_date = getDelqDate(record.due_date);

        if (record.amount_due === "$0.00" || record.amount_due === "$0") {
            record.status = "Paid";
        } else {
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const dueDateObj = new Date(record.due_date);

            if (today <= dueDateObj) {
                record.status = "Due";
            } else {
                record.status = "Delinquent";
            }
        }

        result.tax_history.push(record);
    }

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
    try {
        const { browser, page } = await launchBrowser();

        await page.goto(
            "https://hawkins.renewgov.com/",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);
        await resultCard(page, accountNumber);

        const result = await parsePropertyDetails(page, accountNumber);

        console.log(JSON.stringify(result, null, 2));
    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    }
}

run("141-2922P");