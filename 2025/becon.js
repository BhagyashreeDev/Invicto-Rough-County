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
        taxing_authority: "",
        notes: "",
        delinquent: "NONE",
        tax_history: [],
    };
}

function createTaxHistory() {
    return {
        jurisdiction: "County",
        year: "",
        payment_type: "",
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

// for notes generation
const generate_notes = (year, keys, status1, status2) => {
    let notes = "";
    try {
        const s1 = (status1 || "PAID").toUpperCase();
        const s2 = (status2 || "PAID").toUpperCase();
        notes =
            keys === 1
                ? `ALL PRIORS ARE PAID,`
                : `PRIORS ARE DELINQUENT,`;
        notes += ` ${year} 1ST INSTALLMENT IS ${s1}, 2ND INSTALLMENT IS ${s2},`;
        notes += ` NORMALLY TAXES ARE PAID SEMI-ANNUALLY,`;
        notes += ` NORMAL DUE DATES ARE 02/13 AND 08/26`;
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
    const inputSelector = 'input[id*="txtParcelID"]';
    await page.waitForSelector(inputSelector, timeout_option);
    await page.type(inputSelector, accountNumber);

    const btnSelector = 'input[id*="btnSearch"], a[id*="btnSearch"], button[id*="btnSearch"]';
    await page.waitForSelector(btnSelector, timeout_option);
    await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", ...timeout_option }),
        page.click(btnSelector),
    ]);
}

async function getDetails(page) {
    await page.waitForSelector('span[editkey*="ParcelID"], [id*="sprOwnerName1"]', { ...timeout_option });

    // Expand the first tax year row dynamically
    const firstExpandBtn = await page.$('table[id*="gvwTaxHistory"] a[id^="btndiv"], a[id^="btndiv"]');
    if (firstExpandBtn) {
        await page.evaluate((el) => el.click(), firstExpandBtn);
        await new Promise((r) => setTimeout(r, 500));
    }

    const scrapedData = await page.evaluate(() => {
        const clean = (str) => (str || "").replace(/\s+/g, " ").trim();
        const parseCurrency = (str) => {
            if (!str) return 0;
            const num = parseFloat(str.replace(/[^0-9.-]/g, ""));
            return isNaN(num) ? 0 : Math.abs(num);
        };
        const formatCurrency = (num) => `$${num.toLocaleString("en-US", { minimumFractionDigits: 2 })}`;

        // 1. Owner Name
        const ownerEl = document.querySelector('[id*="sprOwnerName1"]');
        const ownerName = ownerEl ? clean(ownerEl.innerText) : "N/A";

        // 2. Property Address
        const addrEl = document.querySelector('span[editkey*="PropertyAddress"]');
        let propertyAddress = "N/A";
        if (addrEl) {
            propertyAddress = addrEl.innerHTML
                .split(/<br\s*[\/]?>/i)
                .map((s) => clean(s.replace(/<[^>]*>/g, "")))
                .filter(Boolean)
                .join(", ");
        }

        // 3. Assessed Value (35%)
        let assessedValue = "";
        const valRows = document.querySelectorAll('table[id*="grdValuation_grdYearData"] tr');
        valRows.forEach((row) => {
            const th = row.querySelector("th");
            const td = row.querySelector("td.value-column, td");
            if (th && td && th.innerText.includes("Total Value (Assessed 35%)")) {
                assessedValue = clean(td.innerText);
            }
        });

        // 4. Tax Year & Amounts
        const firstYearLink = document.querySelector('table[id*="gvwTaxHistory"] a[id^="btndiv"], a[id^="btndiv"]');
        const rawTaxYear = firstYearLink ? clean(firstYearLink.innerText) : "";
        const yearMatch = rawTaxYear.match(/\b\d{4}\b/);
        const baseTaxYear = yearMatch ? yearMatch[0] : "";

        const detailTable = document.querySelector('table[id*="fvTaxHistory_Detail"]');
        const fhDue = parseCurrency(detailTable?.querySelector('[id$="FirstHalfDueLabel"]')?.innerText);
        const fhColl = parseCurrency(detailTable?.querySelector('[id$="FirstHalfCollectedLabel"]')?.innerText);
        const fhBal = parseCurrency(detailTable?.querySelector('[id$="FirstHalfBalanceLabel"]')?.innerText);

        const shDue = parseCurrency(detailTable?.querySelector('[id$="SecondHalfDueLabel"]')?.innerText);
        const shColl = parseCurrency(detailTable?.querySelector('[id$="SecondHalfCollectedLabel"]')?.innerText);
        const shBal = parseCurrency(detailTable?.querySelector('[id$="SecondHalfBalanceLabel"]')?.innerText);

        // --- 5. Logical Paid Date Extraction (Net Payments by Date) ---
        let firstHalfPaidDate = "";
        let secondHalfPaidDate = "";

        // Helper to parse positive and negative amounts like ($0.46) -> -0.46
        const parseSignedCurrency = (str) => {
            if (!str) return 0;
            const isNegative = str.includes("(") && str.includes(")");
            const num = parseFloat(str.replace(/[^0-9.]/g, ""));
            if (isNaN(num)) return 0;
            return isNegative ? -num : num;
        };

        const paymentRows = document.querySelectorAll('table[id*="grdPayments"] tbody tr');
        const dateMap = new Map();

        // 1. Sum net payments for each date in the target base tax year
        paymentRows.forEach((row) => {
            const th = row.querySelector("th");
            const cells = row.querySelectorAll("td");
            if (!th || cells.length < 3) return;

            const yearText = th.innerText.trim();
            const rowBaseYear = yearText.match(/\b\d{4}\b/)?.[0] || "";
            if (rowBaseYear !== baseTaxYear) return;

            const date = cells[0]?.innerText.trim() || "";
            const amt = parseSignedCurrency(cells[2]?.innerText);

            if (date) {
                const currentTotal = dateMap.get(date) || 0;
                dateMap.set(date, currentTotal + amt);
            }
        });

        // 2. Keep only dates with real payments (ignore net $0 / penny adjustments)
        const validPayments = [];
        dateMap.forEach((netAmt, date) => {
            const cleanAmt = Math.round(netAmt * 100) / 100;
            if (cleanAmt > 1.0) { // Ignores bookkeeping offset adjustments like +/-$0.46
                validPayments.push({
                    date: date,
                    amount: cleanAmt,
                    timestamp: new Date(date).getTime(),
                });
            }
        });

        // 3. Sort chronologically (earlier = 1st Half, later = 2nd Half)
        validPayments.sort((a, b) => a.timestamp - b.timestamp);

        if (validPayments.length === 1) {
            firstHalfPaidDate = validPayments[0].date;
            if (shBal === 0) secondHalfPaidDate = validPayments[0].date;
        } else if (validPayments.length >= 2) {
            firstHalfPaidDate = validPayments[0].date; // -> 3/5/2026
            secondHalfPaidDate = validPayments[1].date; // -> 7/16/2026
        }
    
        return {
            ownerName,
            propertyAddress,
            assessedValue,
            rawTaxYear,
            taxYear: baseTaxYear,
            firstHalf: {
                amount: formatCurrency(fhDue),
                balDue: formatCurrency(fhBal),
                amountPaid: formatCurrency(fhColl),
                paidDate: firstHalfPaidDate,
            },
            secondHalf: {
                amount: formatCurrency(shDue),
                balDue: formatCurrency(shBal),
                amountPaid: formatCurrency(shColl),
                paidDate: secondHalfPaidDate,
            },
        };
    });

    // Console logs in Node.js terminal
    console.log("-----------------------------------------");
    console.log("Owner Name:        ", scrapedData.ownerName);
    console.log("Property Address:  ", scrapedData.propertyAddress);
    console.log("Assessed Value:    ", scrapedData.assessedValue);
    console.log("Tax Year:          ", scrapedData.taxYear);
    console.log("1st Half Paid Date:", scrapedData.firstHalf.paidDate);
    console.log("2nd Half Paid Date:", scrapedData.secondHalf.paidDate);
    console.log("-----------------------------------------");

    return scrapedData;
}

async function populateTheObject(accountNumber, scrapedData) {
    const property = createPropertyObject();

    const taxYear = scrapedData.taxYear; // e.g. "2025"

    property.parcel_number = accountNumber;
    property.owner_name = [scrapedData.ownerName];
    property.property_address = scrapedData.propertyAddress;
    property.total_assessed_value = scrapedData.assessedValue;
    property.total_taxable_value = scrapedData.assessedValue;

    // Determine collection year for due dates (e.g. from "2025 Payable 2026" -> 2026)
    let collectionYear = parseInt(taxYear, 10) + 1;
    if (scrapedData.rawTaxYear) {
        const payMatch = scrapedData.rawTaxYear.match(/Pay(?:able)?\s+(\d{4})/i);
        if (payMatch) {
            collectionYear = parseInt(payMatch[1], 10);
        }
    }

    // Helper: format "3/5/2026" -> "03/05/2026"
    function formatToDate(dateStr) {
        if (!dateStr || dateStr === "N/A" || dateStr === "-") return "";
        const d = new Date(dateStr);
        if (isNaN(d.getTime())) return dateStr;
        const mm = String(d.getMonth() + 1).padStart(2, "0");
        const dd = String(d.getDate()).padStart(2, "0");
        const yyyy = d.getFullYear();
        return `${mm}/${dd}/${yyyy}`;
    }

    // Helper: calculate installment status based on amount due and delinquent date
    function getStatus(amountDueStr, delqDateStr) {
        const bal = parseFloat(amountDueStr.replace(/[$,]/g, "")) || 0;
        if (bal === 0) return "Paid";
        const today = new Date();
        const delqDateObj = new Date(delqDateStr);
        return today >= delqDateObj ? "Delinquent" : "Due";
    }

    // --- Installment 1 (1st Half) ---
    const inst1 = createTaxHistory();
    inst1.year = taxYear;
    inst1.payment_type = "Installment 1";
    inst1.due_date = `02/13/${collectionYear}`;
    inst1.delq_date = `02/14/${collectionYear}`;
    inst1.base_amount = scrapedData.firstHalf.amount;
    inst1.amount_paid = scrapedData.firstHalf.amountPaid !== "$0.00" ? scrapedData.firstHalf.amountPaid : scrapedData.firstHalf.amount;
    inst1.amount_due = scrapedData.firstHalf.balDue;
    inst1.status = getStatus(inst1.amount_due, inst1.delq_date);
    inst1.paid_date = formatToDate(scrapedData.firstHalf.paidDate);

    // --- Installment 2 (2nd Half) ---
    const inst2 = createTaxHistory();
    inst2.year = taxYear;
    inst2.payment_type = "Installment 2";
    inst2.due_date = `08/26/${collectionYear}`;
    inst2.delq_date = `08/27/${collectionYear}`;
    inst2.base_amount = scrapedData.secondHalf.amount;
    inst2.amount_paid = scrapedData.secondHalf.amountPaid !== "$0.00" ? scrapedData.secondHalf.amountPaid : scrapedData.secondHalf.amount;
    inst2.amount_due = scrapedData.secondHalf.balDue;
    inst2.status = getStatus(inst2.amount_due, inst2.delq_date);
    inst2.paid_date = formatToDate(scrapedData.secondHalf.paidDate);

    // Push installments to tax_history array
    property.tax_history.push(inst1, inst2);

    // Sort the records
    property.tax_history.sort((a, b) => {
        const yearA = parseInt(a.year, 10) || 0;
        const yearB = parseInt(b.year, 10) || 0;
        if (yearA !== yearB) return yearA - yearB;
        if (a.status === "Paid" && b.status !== "Paid") return -1;
        if (a.status !== "Paid" && b.status === "Paid") return 1;
        return 0;
    });

    // Decide delinquency and notes
    if (property.tax_history.length > 0) {
        const hasDelinquent = property.tax_history.some((t) => t.status === "Delinquent");
        property.delinquent = hasDelinquent
            ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
            : "NONE";

        const hasPriorDelinquent = property.tax_history.some(
            (t) => t.status === "Delinquent" && String(t.year) !== String(taxYear)
        );

        const keys = hasPriorDelinquent ? 0 : 1;
        property.notes = generate_notes(taxYear, keys, inst1.status, inst2.status);
    }

    console.log("=========================================");
    console.log("FINAL POPULATED OBJECT:");
    console.log(JSON.stringify(property, null, 2));

    return property;
}

async function run(accountNumber) {
    try {
        const { browser, page } = await launchBrowser();

        await page.goto(
            `https://beacon.schneidercorp.com/Application.aspx?AppID=1178&LayerID=34847&PageTypeID=4&PageID=13177&KeyValue=${accountNumber}`,
            { waitUntil: "domcontentloaded", ...timeout_option }
        );

        // Click Agree button on the Terms and Conditions popup
        await page.waitForSelector("a.btn-primary.button-1", timeout_option);
        await page.click("a.btn-primary.button-1");

        // Search by account number
        // await searchAccountNumber(accountNumber, page);

        // Scrape details from the report page
        const scrapedData = await getDetails(page);

        // Populate and output the standard property object
        await populateTheObject(accountNumber, scrapedData);

        // await browser.close();
    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    }
}

run("1100042000");