import puppeteer from "puppeteer";

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
        taxing_authority: "Barton County Collector-Treasurer, 1004 Gulf Street, Lamar, MO 64759",
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

// Search Account Number
async function searchAccountNumber(accountNumber, page) {
    const inputSelector = "#searchIn";
    await page.waitForSelector(inputSelector);
    await page.type(inputSelector, accountNumber);

    const searchButtonSelector = "#searchSubmit";
    await page.waitForSelector(searchButtonSelector);
    await Promise.all([
        page.waitForNavigation(),
        page.click(searchButtonSelector)
    ]);
}


async function goToDiv(page) {
    const divSelector = '.parDtl[style*="display: block"]';
    const parsedData = await page.evaluate(() => {
        const container = document.querySelector('.parDtl[style*="display: block"]');
        if (!container) return null;
        const data = {
            ownerName: "",
            propertyAddress: "",
            assessedValue: "N/A",
            taxYear: "",
            baseAmount: "",
            amountDue: "",
            totalTaxesAndPenalties: "",
            paidDate: "",
            paidAmount: ""
        };
        const headerDivs = container.querySelectorAll('.parHdr .col-md-12');
        if (headerDivs.length >= 4) {
            const year = headerDivs[0].innerText.trim();
            const yearMatch = year.match(/\((\d{4})\)/);
            data.taxYear = yearMatch ? yearMatch[1] : '';
            data.ownerName = headerDivs[1].innerText.trim();
            const addressLine1 = headerDivs[2].innerText.trim();
            const addressLine2 = headerDivs[3].innerText.trim();
            data.propertyAddress = `${addressLine1}, ${addressLine2}`;
        }

        const allDivs = container.querySelectorAll('div');
        for (let j = 0; j < allDivs.length; j++) {
            const text = allDivs[j].innerText.trim();
            if (text === 'Valuation:') {
                data.assessedValue = allDivs[j + 1]?.innerText.trim();
            }
        }

        const rows = container.querySelectorAll(".row");
        for (const row of rows) {
            const text = row.innerText.trim();
            if (text.includes("Total Taxes:")) {
                const cols = row.querySelectorAll("div");
                data.baseTaxAmount = cols[cols.length - 1].innerText.trim();
            } else if (text.includes("Total Taxes, Interest and Penalties:")) {
                const cols = row.querySelectorAll("div");
                data.totalTaxesAndPenalties = cols[cols.length - 1].innerText.trim();
            } else if (text.includes("Total Due:")) {
                const cols = row.querySelectorAll("div");
                data.amountDue = cols[cols.length - 1].innerText.trim();
            } else if (text.includes("Payment (KM)")) {
                const cols = row.querySelectorAll("div");
                if (cols.length >= 3) {
                    data.paidDate = cols[1].innerText.trim();
                    const rawAmount = cols[cols.length - 1].innerText.trim();
                    data.paidAmount = rawAmount.replace(/[()]/g, '');
                }
            }
        }
        return data;
    });
    return parsedData;
}

async function scrapeResults(page) {
    // 1. Wait for the list of items to load
    await page.waitForSelector('#searchList .parClick', { timeout: 15000 });

    // 2. Determine how many clickable items exist
    const itemsCount = await page.evaluate(() => {
        return document.querySelectorAll('#searchList .parClick').length;
    });
    console.log(`Found ${itemsCount} items to parse.`);

    const allExtractedData = [];

    // 3. Iterate through each item
    for (let i = 0; i < itemsCount; i++) {
        console.log(`\nProcessing item ${i + 1} of ${itemsCount}...`);

        // We re-query the elements on every loop to avoid StaleElementReference errors
        const elements = await page.$$('#searchList .parClick');
        const currentElement = elements[i];
        await currentElement.click();

        // 4. Wait for the AJAX response to load into #divResults.
        // A simple timeout is used here. For production, you could use page.waitForResponse() 
        // or page.waitForFunction() to detect specific DOM changes inside #divResults.
        await new Promise(resolve => setTimeout(resolve, 2000));

        const data = await goToDiv(page);

        if (data) {
            const rawAmount = data.amountDue || "0";
            const amountDueNum = parseFloat(rawAmount.replace(/[^\d.-]/g, '')) || 0;
            const isPaid = amountDueNum === 0;

            if (i === 0) {
                allExtractedData.push(data);
                if (isPaid) break;
            } else {
                if (isPaid) break;
                else allExtractedData.push(data);
            }
        }
        console.log(`Successfully scraped data for item ${i + 1}.`);
    }

    return allExtractedData;
}

async function buildSchema(scrapedData, accountNumber) {
    if (!scrapedData || scrapedData.length === 0) return null;
    const result = createPropertyObject();
    const primaryRecord = scrapedData[0];

    result.owner_name = [primaryRecord.ownerName];
    result.property_address = primaryRecord.propertyAddress;
    result.parcel_number = accountNumber;
    result.total_assessed_value = formatCurrency(primaryRecord.assessedValue);
    result.total_taxable_value = result.total_assessed_value;

    const history = [];
    for (let i = 0; i < scrapedData.length; i++) {
        const item = scrapedData[i];
        const year = item.taxYear;
        const nextYear = parseInt(year) + 1;
        const dueDateStr = `12/31/${nextYear}`;
        const record = createTaxHistory();
        record.year = year;
        record.base_amount = formatCurrency(item.baseTaxAmount);
        record.amount_paid = formatCurrency(item.paidAmount);
        record.amount_due = formatCurrency(item.amountDue);
        record.due_date = `12/31/${nextYear}`;
        record.delq_date = `01/01/${nextYear}`;
        record.paid_date = item.paidDate;

        if (record.amount_due === "$0.00") {
            record.status = "Paid";
        } else {
            const today = new Date();
            const dueDateObj = new Date(nextYear);
            if (today <= dueDateObj) {
                record.status = "Due";
            } else {
                record.status = "Delinquent";
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
    if (result.tax_history.length > 0) {
        const hasDelinquent = result.tax_history.some(t => t.status === "Delinquent");
        result.delinquent = hasDelinquent
            ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
            : "NONE";

        const latestTax = result.tax_history[result.tax_history.length - 1];
        const hasPriorDelinquent = result.tax_history.some(
            t => t.status === "Delinquent" && String(t.year) !== String(latestTax.year)
        );

        const keys = hasPriorDelinquent ? 0 : 1;
        result.notes = generate_notes(latestTax.year, keys, latestTax.status);
    }
    return result;
}

async function run(accountNumber) {
    const { browser, page } = await launchBrowser();
    try {
        await page.goto(
            "https://bartoncountycollector.org/",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);
        const scrapedData = await scrapeResults(page);

        if (scrapedData.length > 0) {
            const finalizedData = await buildSchema(scrapedData, accountNumber);
            console.log(JSON.stringify(finalizedData, null, 2));
        }

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

// Execute Script run sequence targeting specified sample account
run("0312441");