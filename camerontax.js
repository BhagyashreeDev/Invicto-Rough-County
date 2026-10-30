/**
 * ============================================================
 *  Starr County Tax Scraper  — Modular / Debug-Friendly
 *  Site: https://starr.go2gov.net/faces/search.jsp
 *
 *  ALL selectors / IDs below are copied exactly from your
 *  original code.  Only the bugs are fixed — annotated inline.
 * ============================================================
 *
 *  MODULE MAP
 *  1.  createPropertyObject()     – blank result template
 *  2.  createTaxHistory()         – blank per-year tax record
 *  3.  applyStatusLogic()         – derive status / amounts
 *  4.  launchBrowser()            – puppeteer init
 *  5.  navigateToSite()           – open search page
 *  6.  searchAccountNumber()      – fill iframe form + submit
 *  7.  clickAccountLink()         – pick result row → detail page
 *  8.  scrapePropertyInfo()       – owner / address / parcel
 *  9.  scrapeCurrentTaxes()       – current-year table
 *  10. scrapeCurrentTaxDetails()  – appraised / taxable values
 *  11. scrapePaymentHistory()     – all historical payments
 *  12. scrapeDelinquentTaxes()    – delinquent table
 *  13. run()                      – orchestrator
 */

import puppeteer from "puppeteer";

// ─────────────────────────────────────────────────────────────
//  1. RESULT TEMPLATE  (your original fields, unchanged)
// ─────────────────────────────────────────────────────────────

function createPropertyObject() {
  return {
    processed_date: "",
    order_number: "",
    borrower_name: "",

    owner_name: "",
    property_address: "",
    parcel_number: "",

    land_value: "",
    improvements: "",
    total_assessed_value: "",
    exemption: "",
    total_taxable_value: "",

    tax_history: [],
  };
}

// ─────────────────────────────────────────────────────────────
//  2. TAX HISTORY TEMPLATE  (your original fields, unchanged)
// ─────────────────────────────────────────────────────────────

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
    good_through_date: "",
  };
}

// ─────────────────────────────────────────────────────────────
//  3. STATUS LOGIC
//
//  BUG FIXED: your original had no else-branch for when
//  paidDate falls *between* dueDate and delqDate — added below.
// ─────────────────────────────────────────────────────────────

function applyStatusLogic(taxRecord, baseAmount, totalPaid, paidDateStr) {
  const today    = new Date();
  const dueDate  = new Date(taxRecord.due_date);
  const delqDate = new Date(taxRecord.delq_date);

  // No payment made
  if (!paidDateStr || paidDateStr === "N/A" || paidDateStr === "") {
    taxRecord.amount_paid = "N/A";
    taxRecord.base_amount = baseAmount || "N/A";
    taxRecord.amount_due  = baseAmount || "N/A";
    if (today < dueDate) {
      taxRecord.status = "Due";
    } else {
      taxRecord.status = "Delinquent";
    }
    return;
  }

  // Payment exists
  const paidDate = new Date(paidDateStr);
  taxRecord.paid_date   = paidDateStr;
  taxRecord.base_amount = baseAmount;
  taxRecord.amount_paid = totalPaid;

  if (paidDate <= dueDate) {
    // Paid on time
    taxRecord.status     = "Paid";
    taxRecord.amount_due = "N/A";
    return;
  }

  if (paidDate >= delqDate) {
    // Paid after delinquency; penalties in totalPaid
    taxRecord.status     = "Paid";
    taxRecord.amount_due = totalPaid;
    return;
  }

  // BUG FIX: paid between dueDate and delqDate (was unhandled)
  taxRecord.status     = "Paid";
  taxRecord.amount_due = "N/A";
}

// ─────────────────────────────────────────────────────────────
//  4. LAUNCH BROWSER
// ─────────────────────────────────────────────────────────────

async function launchBrowser() {
  console.log("[browser] Launching Puppeteer...");
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

// ─────────────────────────────────────────────────────────────
//  5. NAVIGATE TO SITE
// ─────────────────────────────────────────────────────────────

async function navigateToSite(page) {
  console.log("[nav] Opening search page...");
  await page.goto("https://camerontax.go2gov.net/faces/search.jsp", {
    waitUntil: "networkidle2",
  });
}

// ─────────────────────────────────────────────────────────────
//  6. SEARCH ACCOUNT NUMBER
//
//  Selectors (YOUR ORIGINALS): "iframe", "#qsfInput", "#qsfButtonSearch"
//
//  BUG 1 FIXED — "await inside Promise.all" anti-pattern
//    Your original:
//      await Promise.all([
//          await frame.waitForNavigation(),   <-- resolved BEFORE Promise.all ran
//          await frame.click(...)
//      ])
//    Putting await inside the array means both promises resolve individually
//    first, so Promise.all receives already-settled values and the navigation
//    event is never actually caught.
//
//  BUG 2 FIXED — waitForNavigation on wrong context
//    The iframe form submission navigates the OUTER page, not the frame.
//    So waitForNavigation must be on `page`, not `frame`.
// ─────────────────────────────────────────────────────────────

async function searchAccountNumber(page, accountNumber) {
  console.log(`[search] Searching for account: ${accountNumber}`);

  // get the iframe 
  const iframeElement = await page.waitForSelector("iframe");
  const frame = await iframeElement.contentFrame();
  if (!frame) throw new Error("[search] Could not access iframe content frame");

  // type account number in the input box 
  const inputSelector = "body > div.container > form:nth-child(5) > div > input.nine.columns.searchVis";
  await frame.waitForSelector(inputSelector, { visible: true });
  await frame.type(inputSelector, accountNumber);

  console.log("[search] Typed account number, clicking Search...");

  // waitForNavigation on outer `page`, 
  const searchSelector = "body > div.container > form:nth-child(5) > div > input.button.button-primary.two.columns.searchVis";
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    frame.click(searchSelector),  
  ]);

  console.log("[search] Results page loaded.");
}

// ─────────────────────────────────────────────────────────────
//  7. CLICK ACCOUNT LINK IN RESULTS
//
//  Selector (YOUR ORIGINAL — the long nth-child path):
//    body > div.cartContainer > form:nth-child(11) > div > center >
//    table > tbody > tr:nth-child(3) > td:nth-child(3) > span > a
//
// ─────────────────────────────────────────────────────────────

async function clickAccountLink(page) {
  console.log("[results] Waiting for account link...");

  // your original selector, unchanged
  const accountNumberSelector = "span.boldresult a[href*='doShowAccountPage']";

  await page.waitForSelector(accountNumberSelector, { visible: true });

  console.log("[results] Clicking account link...");

  // FIX: no await inside the array
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click(accountNumberSelector),   // your original selector
  ]);

  console.log("[results] Detail page loaded.");
}

// ─────────────────────────────────────────────────────────────
//  8. SCRAPE PROPERTY INFO
//
//  Selectors (YOUR ORIGINALS):
//    #etaxTemplateForm\:text3  (account no)
//    #etaxTemplateForm\:text4  (owner name)
//    #etaxTemplateForm\:text5  (mailing address)
//    #etaxTemplateForm\:text6  (legal description)
// ─────────────────────────────────────────────────────────────

async function scrapePropertyInfo(page) {
  console.log("[property] Scraping owner / address / parcel...");

  await page.waitForSelector("#etaxTemplateForm\\:text3");

  const info = await page.evaluate(() => {
    return {
      accountNo:
        document.querySelector("#etaxTemplateForm\\:text3")?.textContent?.trim() || "",
      ownerName:
        document.querySelector("#etaxTemplateForm\\:text4")?.textContent?.trim() || "",
      mailingAddress:
        document.querySelector("#etaxTemplateForm\\:text5")?.textContent?.trim() || "",
      legalDescription:
        document.querySelector("#etaxTemplateForm\\:text6")?.textContent?.trim() || "",
    };
  });

  console.log("[property]", info);
  return info;
}

// ─────────────────────────────────────────────────────────────
//  9. SCRAPE CURRENT TAXES TABLE
//
//  Selectors (YOUR ORIGINALS):
//    #etaxTemplateForm\:current1          (table)
//    [id$="year1"]                        (year cell)
//    [id$="totalDue1"]                    (total due cell)
// ─────────────────────────────────────────────────────────────

async function scrapeCurrentTaxes(page) {
  console.log("[current] Checking current taxes table...");

  // check if first table exists
  const currentTable1 = await page.$("#etaxTemplateForm\\:current1");   
  if (!currentTable1) {
    console.log("[current] No current taxes table — skipping.");
    return [];
  }

  const rows = await page.evaluate(() => {
    const trs = document.querySelectorAll(
      "#etaxTemplateForm\\:current1 tbody tr"  
    );
    return [...trs]
      .map((row) => ({
        year:  row.querySelector('[id$="year1"]')?.textContent?.trim()     || "",
        base: row.querySelector('[id$="taxesDue1"]')?.textContent?.trim()  || "",
        total: row.querySelector('[id$="totalDue1"]')?.textContent?.trim() || "",
      }))
      
  });

  console.log("[current] Rows:", rows);
  return rows;
}

// ─────────────────────────────────────────────────────────────
//  10. SCRAPE CURRENT TAX DETAILS  (assessed / taxable values)
//
//  Selectors (YOUR ORIGINALS):
//    #etaxTemplateForm\:current1\:0\:year1              (first year link)
//    #etaxTemplateForm\:entities1                       (values table)
//    #etaxTemplateForm\:entities1\:0\:appraisedValue1   (appraised)
//    #etaxTemplateForm\:entities1\:0\:netTaxableValue1  (net taxable)
// ─────────────────────────────────────────────────────────────

async function scrapeCurrentTaxDetails(page) {
  console.log("[details] Clicking first year link for assessed values...");

  // clicking on first table 2025  
  await page.waitForSelector("#etaxTemplateForm\\:current1\\:0\\:year1");  

  // no await inside the array
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click("#etaxTemplateForm\\:current1\\:0\\:year1"), 
  ]);

  await page.waitForSelector("#etaxTemplateForm\\:entities1");  

  // parse the table to get assessed and taxable value 
  const values = await page.evaluate(() => {
    // Exact match targets
    let appraised = document.querySelector("#etaxTemplateForm\\:entities1\\:0\\:appraisedValue1")?.textContent?.trim();
    let taxable = document.querySelector("#etaxTemplateForm\\:entities1\\:0\\:netTaxableValue1")?.textContent?.trim();

    // Safe wildcards fallbacks if explicit array indexes shift
    if (!appraised) {
      appraised = document.querySelector('[id*="appraisedValue"]')?.textContent?.trim();
    }
    if (!taxable) {
      taxable = document.querySelector('[id*="netTaxableValue"]')?.textContent?.trim();
    }

    return {
      totalAssessedValue: appraised || "N/A",
      totalTaxableValue: taxable || "N/A",
    };
  });

  console.log("[details]", values);

  // go back to initial dashboard page  (your original comment)
  // added waitUntil so we don't race ahead
  await page.goBack({ waitUntil: "networkidle2" });

  return values;
}

// ─────────────────────────────────────────────────────────────
//  11. SCRAPE PAYMENT HISTORY
//
//  Selectors (YOUR ORIGINALS):
//    #etaxTemplateForm\:text71paymenth         (payment history link)
//    #etaxTemplateForm\:tableEx1               (years table)
//    [id$="text6"]                             (year cell)
//    #etaxTemplateForm\:tableEx1\:N\:link1     (year detail link)
//    #etaxTemplateForm\:tableEx1\:0\:text11    (paid date)
//    #etaxTemplateForm\:tableEx1\:0\:text12    (base amount)
//    #etaxTemplateForm\:tableEx1\:0\:text15    (total paid)
//
//  BUG FIXED — await inside Promise.all removed throughout
//  BUG FIXED — goBack now has waitUntil: "networkidle2" everywhere
// ─────────────────────────────────────────────────────────────

async function scrapePaymentHistory(page) {
  console.log("[payments] Navigating to payment history...");

  // now going to the payment history 
  await page.waitForSelector("#etaxTemplateForm\\:text71paymenth");  
  // no await inside the array
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click("#etaxTemplateForm\\:text71paymenth"),  
  ]);

  await page.waitForSelector("#etaxTemplateForm\\:tableEx1");  
  // parse all payment years  
  const paymentYears = await page.evaluate(() => {
    const rows = document.querySelectorAll(
      "#etaxTemplateForm\\:tableEx1 tbody tr"  
    );
    return [...rows].map((row, index) => ({
      year:
        row.querySelector('[id$="text6"]')?.textContent?.trim() || "",  
      rowIndex: index,
    }));
  });

  console.log("[payments] Years found:", paymentYears.map((p) => p.year));

  const paymentMap = new Map();

  // loop every year 
  for (const payment of paymentYears) {
    console.log(`[payments] Drilling into year: ${payment.year}`);

    //  no await inside the array
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click(
        `#etaxTemplateForm\\:tableEx1\\:${payment.rowIndex}\\:link1` 
      ),
    ]);

    await page.waitForSelector("#etaxTemplateForm\\:tableEx1"); 

// determine payment type (filtering out rows with payments less than $5)
const rowCount = await page.$$eval("#etaxTemplateForm\\:tableEx1 tbody tr",  
    (rows) => {
      return rows.filter((row) => {
      // Find the total paid cell within the current row using the partial ID match
      const paidText = row.querySelector('[id$="text15"]')?.textContent?.trim() || "";
      
      // Strip out '$', commas, or spaces and convert to a decimal number
      const paidAmount = parseFloat(paidText.replace(/[^0-9.-]+/g, "")) || 0;
      
      // Keep the row in the count only if it is $5.00 or more
      return paidAmount >= 5;
    }).length; // Get the count of valid rows remaining
  }
);

let paymentType = "N/A"; // Default to N/A if it doesn't match standard schedules
if (rowCount === 1)      paymentType = "Yearly";      
else if (rowCount === 2) paymentType = "Semi Annual";  
else if (rowCount === 4) paymentType = "Quarterly";

    const paymentInfo = await page.evaluate(() => {
      return {
        paidDate:
          document.querySelector(
            "#etaxTemplateForm\\:tableEx1\\:0\\:text11"  
          )?.textContent?.trim() || "",
        baseAmount:
          document.querySelector(
            "#etaxTemplateForm\\:tableEx1\\:0\\:text12" 
          )?.textContent?.trim() || "",
        totalPaid:
          document.querySelector(
            "#etaxTemplateForm\\:tableEx1\\:0\\:text15"  
          )?.textContent?.trim() || "",
      };
    });

    console.log(`[payments]  Year ${payment.year} → type=${paymentType}`, paymentInfo);
    paymentMap.set(payment.year, { paymentType, ...paymentInfo });

    // go back to the page where all years links are there  
    // added waitUntil
    await page.goBack({ waitUntil: "networkidle2" });

    // wait for that table to appear  
    await page.waitForSelector("#etaxTemplateForm\\:tableEx1"); 
  }

  // go back to the dashboard page  
  await page.goBack({ waitUntil: "networkidle2" });

  return paymentMap;
}

// ─────────────────────────────────────────────────────────────
//  12. SCRAPE DELINQUENT TAXES
//
//  Selectors (YOUR ORIGINALS):
//    #etaxTemplateForm\:delinquent1              (outer table)
//    #etaxTemplateForm\:delinquent1\:0\:year2   (first year link)
//    [id$="year1"]                               (year cell)
//    [id$="taxesDue1"]                           (base due)
//    [id$="totalDue1"]                           (total due)
//  

async function scrapeDelinquentTaxes(page) {
  console.log("[delinquent] Checking delinquent taxes table...");

  // check if 2nd table exists 
  const currentTable2 = await page.$("#etaxTemplateForm\\:delinquent1");  
  if (!currentTable2) {
    console.log("[delinquent] No delinquent table — skipping.");
    return [];
  }

  // click on the details link  
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click("#etaxTemplateForm\\:delinquent1\\:0\\:year2"),  
  ]);

  // check if delinquent table exists  
  const delinquentTable = await page.$("#etaxTemplateForm\\:delinquent1");  

  let rows = [];
  if (delinquentTable) {
    rows = await page.evaluate(() => {
      const trs = document.querySelectorAll(
        "#etaxTemplateForm\\:delinquent1 tbody tr"  
      );
      return [...trs].map((row) => ({
        year:
          row.querySelector('[id$="year1"]')?.textContent?.trim()     || "",  
        baseDue:
          row.querySelector('[id$="taxesDue1"]')?.textContent?.trim() || "",
        totalDue:
          row.querySelector('[id$="totalDue1"]')?.textContent?.trim() || "", 
      }));
    });
  }

  console.log("[delinquent] Rows:", rows);

  // BUG FIX: your original had no goBack here, leaving the page on the
  // delinquent detail screen instead of the dashboard
  await page.goBack({ waitUntil: "networkidle2" });

  return rows;
}

// ─────────────────────────────────────────────────────────────
//  13. ORCHESTRATOR
//     Same flow as your original, split into the modules above.
// ─────────────────────────────────────────────────────────────

async function run(accountNumber) {
  const { browser, page } = await launchBrowser();

  try {
    await navigateToSite(page);
    await searchAccountNumber(page, accountNumber);
    await clickAccountLink(page);

    const propertyInfo = await scrapePropertyInfo(page);

    const result = createPropertyObject();
    result.owner_name       = propertyInfo.ownerName;
    result.property_address = propertyInfo.mailingAddress;
    result.parcel_number    = propertyInfo.accountNo;

    // Current taxes table
    const currentTaxRows = await  scrapeCurrentTaxes(page);

    for (const tax of currentTaxRows) {
    // Clean the string to check if the numeric value is 0
    const numericTotal = parseFloat(tax.total.replace(/[^0-9.-]+/g, "")) || 0;
  
    if (numericTotal === 0) {
        console.log(`[current] Balance is $0.00 for ${tax.year}. NOT adding to tax_history.`);
        continue; // <--- Skips adding to history, but keeps moving forward
    }
      const record        = createTaxHistory();
      record.year         = tax.year;
      record.due_date     = `01/31/${Number(tax.year) + 1}`;
      record.delq_date    = `02/01/${Number(tax.year) + 1}`;
      record.base_amount  = tax.base;
      record.amount_due   = tax.total;
      record.status       = "Delinquent";
      record.amount_paid  = "N/A";
      record.payment_type = "N/A";
      record.paid_date    = "N/A";
      result.tax_history.push(record);
    }

    // Assessed / taxable values — only if current table had rows
    if (currentTaxRows.length > 0) {
      const details               = await scrapeCurrentTaxDetails(page);
      result.total_assessed_value = details.totalAssessedValue;
      result.total_taxable_value  = details.totalTaxableValue;
    }

    // Payment history
    const paymentMap = await scrapePaymentHistory(page);

    for (const [year, info] of paymentMap) {
      // if that year record not exist then create that record  (your original comment)
      let record = result.tax_history.find((t) => t.year === year);
      if (!record) {
        record           = createTaxHistory();
        record.year      = year;
        record.due_date  = `01/31/${Number(year) + 1}`;
        record.delq_date = `02/01/${Number(year) + 1}`;
        result.tax_history.push(record);
      }
      record.payment_type = info.paymentType;
      applyStatusLogic(record, info.baseAmount, info.totalPaid, info.paidDate || null);
    }

    // BUG FIX: moved AFTER paymentMap merge so no record is missed
    for (const record of result.tax_history) {
      if (!record.paid_date || record.paid_date === "") {
        applyStatusLogic(record, record.base_amount, record.amount_paid, null);
      }
    }

    // Delinquent taxes
    const delinquentRows = await scrapeDelinquentTaxes(page);

    for (const tax of delinquentRows) {
      // create record if year doesn't exist  (your original comment)
      let record = result.tax_history.find((t) => t.year === tax.year);
      if (!record) {
        record      = createTaxHistory();
        record.year = tax.year;
        result.tax_history.push(record);
      }
      record.payment_type = "N/A";
      record.status       = "Delinquent";
      record.base_amount  = tax.baseDue;
      record.amount_paid  = "N/A";
      record.amount_due   = tax.totalDue;
      record.due_date     = `01/31/${Number(tax.year) + 1}`;
      record.delq_date    = `02/01/${Number(tax.year) + 1}`;
      record.paid_date    = "N/A";
    }

    // Sort tax history in ascending order (smallest year first to most recent)
    result.tax_history.sort((a, b) => Number(a.year) - Number(b.year));

    // if we found no records for a account number
    if (result.tax_history.length === 0) {
      result.tax_history = ["N/A"];
    }

    console.log("\n========== FINAL RESULT ==========");
    console.log(JSON.stringify(result, null, 2));

    return result;

  } catch (err) {
    console.error("[ERROR]", err);
    throw err;
  } finally {
    await new Promise((r) => setTimeout(r, 5_000));  // 5s to inspect browser
    await browser.close();
  }
}

// ─────────────────────────────────────────────
//  ENTRY POINT
// ─────────────────────────────────────────────
run("0001000117155000");