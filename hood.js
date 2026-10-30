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
        taxing_authority: "DuPage County Treasurer, 421 N. County Farm Road Wheaton, IL 60187",
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

// Formatting helpers
const formatCurrency = (amount) => {
    if (!amount || amount === "N/A" || amount === "-") return "$0.00";
    let num = String(amount).replace(/[$,]/g, "").trim();
    if (isNaN(num) || num === "") return "$0.00";
    let formatted = parseFloat(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return "$" + formatted;
};

const formatDate = (dateStr) => {
    if (!dateStr || dateStr === "N/A" || dateStr === "-") return "N/A";
    let d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    let month = ("0" + (d.getMonth() + 1)).slice(-2);
    let day = ("0" + d.getDate()).slice(-2);
    let year = d.getFullYear();
    return `${month}/${day}/${year}`;
};

// Notes generation helper
const generate_notes = (year, keys, status) => {
    let notes = "";
    try {
        notes =
            keys === 1
                ? `ALL PRIORS ARE PAID, ${year} `
                : `PRIORS ARE DELINQUENT, ${year} `;
        notes += `TAXES ARE ${status.toUpperCase()},`;
        notes += ` NORMALLY TAXES ARE PAID ANNUALLY,`;
        notes += ` NORMAL DUE DATE IS 01/31`;
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
    const propertyIdSelector = "#searchHeaderX_linkid";
    await page.waitForSelector(propertyIdSelector);
    await page.click(propertyIdSelector);

    const inputSelector = "#ucSearchID_searchid";
    await page.waitForSelector(inputSelector);
    await page.type(inputSelector, accountNumber);

    const searchButtonSelector = "#ucSearchID_ButtonSearch";
    await page.waitForSelector(searchButtonSelector);
    await Promise.all([
        page.waitForNavigation(),
        page.click(searchButtonSelector)
    ]);
}

async function goToTheMainPage(page) {
    const firstRowLinkSelector = 'a[id^="ucResultsGrid_"]';
    await page.waitForSelector(firstRowLinkSelector);
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click(firstRowLinkSelector)
    ]);
}

async function extractPropertyDetails(page) {
    await page.waitForSelector("#webprop_name");
    const details = await page.evaluate(() => {
        const cleanText = (id) => {
            const el = document.getElementById(id);
            return el ? el.innerText.replace(/\s+/g, ' ').trim() : '';
        };

        const ownerName = cleanText("webprop_name") || "N/A";
        let situsAddress = cleanText("webprop_situs").replace(/^Situs:\s*/i, '').trim();

        if (!situsAddress || situsAddress.toLowerCase() === "not applicable") {
            situsAddress = "N/A";
        }
        return { ownerName, situsAddress };
    });
    return details;
}

async function extractAssessedValue(page) {
    const assessedValueSelector = "#histassd0_yr";
    const tableCellExists = await page.$(assessedValueSelector);
    if (!tableCellExists) {
        return "N/A";
    }
    const assessedValue = await page.evaluate((selector) => {
        const el = document.querySelector(selector);
        if (!el) return "N/A";
        const valueText = el.innerText.trim();
        return valueText === "" ? "N/A" : valueText;
    }, assessedValueSelector);
    return assessedValue;
}

async function navigateToTaxSummary(page) {
    const taxSummarySelector = "#ucTabs_lbPropertyTaxes";
    const taxTabExists = await page.$(taxSummarySelector);
    if (taxTabExists) {
        await Promise.all([
            page.waitForNavigation({ waitUntil: "networkidle2" }),
            page.click(taxSummarySelector)
        ]);
    }
    return taxTabExists;
}

async function extractUnpaidTaxes(page) {
    const tableBillsSelector = '#tableBills';
    const tableExists = await page.$(tableBillsSelector);

    if (!tableExists) return [];

    // Pull raw row data from the Unpaid Taxes table
    const rawRecords = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#tableBills tr'));
        const data = [];

        for (const row of rows) {
            const cells = row.querySelectorAll('td');
            if (cells.length < 8) continue;

            const yearText = cells[0].innerText.trim();
            if (!yearText || isNaN(yearText)) continue; // Skip summary rows

            data.push({
                year: yearText,
                baseTax: cells[2].innerText.trim(),
                paidTax: cells[3].innerText.trim(),
                amountDue: cells[7].innerText.trim()
            });
        }
        return data;
    });

    // Process and format records according to your logic rules
    const processedRecords = rawRecords.map(raw => {
        const record = createTaxHistory();
        record.year = raw.year;

        // Setup Date Requirements
        const nextYear = parseInt(raw.year) + 1;
        record.due_date = `01/31/${nextYear}`;
        record.delq_date = `02/01/${nextYear}`;

        // Base Amounts
        record.base_amount = formatCurrency(raw.baseTax);
        record.amount_due = formatCurrency(raw.amountDue);

        // Paid Logic
        const rawPaidAmount = parseFloat(raw.paidTax.replace(/[$,]/g, '')) || 0;
        if (rawPaidAmount > 0) {
            record.amount_paid = formatCurrency(raw.paidTax);
        } else {
            record.amount_paid = "$0.00";
        }

        // Status Logic
        if (record.amount_due === "$0.00") {
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

        return record;
    });

    // Sort by year DESC (Most recent year first)
    processedRecords.sort((a, b) => parseInt(b.year) - parseInt(a.year));

    // Apply filtering rule based on payment contiguity
    const finalHistory = [];

    for (let i = 0; i < processedRecords.length; i++) {
        const record = processedRecords[i];

        // 1. Add the record IF it is the most recent year (i === 0) 
        //    OR IF it is an unpaid older year.
        if (i === 0 || record.status !== "Paid") {
            finalHistory.push(record);
        }

        // 2. If we encounter a "Paid" status at ANY point (including the first year), 
        //    stop parsing immediately.
        if (record.status === "Paid") {
            break;
        }
    }

    return finalHistory;
}

async function run(accountNumber) {
    let browserContext;
    try {
        const { browser, page } = await launchBrowser();
        browserContext = browser;

        await page.goto(
            "https://azurefrontdoor-gwbqhvc2fyhaghgf.z01.azurefd.net/webindex.aspx?dbkey=HOODCAD&time=202607122349013",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);
        await goToTheMainPage(page);

        // Construct base property object
        const result = createPropertyObject();
        result.parcel_number = accountNumber;

        const details = await extractPropertyDetails(page);
        result.owner_name = [details.ownerName];
        result.property_address = details.situsAddress;

        const assessedValue = await extractAssessedValue(page);
        result.total_assessed_value = assessedValue;

        const taxTableExists = await navigateToTaxSummary(page);


        // Execute conditional tax history scraping
        if (taxTableExists) {
            if (result.tax_history.length > 0) {
                // Check if ANY tax is delinquent for the main delinquency flag
                const hasDelinquent = result.tax_history.some(
                    (t) => t.status === "Delinquent",
                );
                result.delinquent = hasDelinquent
                    ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
                    : "NONE";

                // Get the latest tax record (the array is sorted ascending by year)
                const latestTax = result.tax_history[result.tax_history.length - 1];

                // Check if any PRIOR year is delinquent (exclude the latest year)
                const hasPriorDelinquent = result.tax_history.some(
                    (t) => t.status === "Delinquent" && String(t.year) !== String(latestTax.year)
                );

                // If priors are delinquent, keys = 0. If priors are paid, keys = 1.
                const keys = hasPriorDelinquent ? 0 : 1;
                result.notes = generate_notes(latestTax.year, keys, latestTax.status);
            }

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

        console.log(JSON.stringify(result, null, 2));

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

// Execute Script run sequence targeting specified sample account
run("R000023874");