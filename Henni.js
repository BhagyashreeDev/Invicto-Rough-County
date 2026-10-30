import puppeteer from "puppeteer";

function createPropertyObject() {
  return {
    processed_date: new Date().toLocaleDateString(),
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
    paid_date: "N/A",
    good_through_date: "",
  };
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

async function navigateToSite(page) {
  await page.goto("https://www16.co.hennepin.mn.us/pins/addrsrch.jsp", {
    waitUntil: "networkidle2",
  });
}

async function searchAccountNumber(page, accountNumber) {
  const propertyIdSelector = "body > div.page-wrapper > section > div > header > div > div:nth-child(4) > button:nth-child(2)";
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click(propertyIdSelector),
  ]);

  const inputSelector = "#tsd_form > div > input";
  await page.waitForSelector(inputSelector, { visible: true });
  await page.type(inputSelector, accountNumber);

  const searchSelector = "#tsd_form > button:nth-child(3)";
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click(searchSelector),
  ]);
}

async function scrapePropertyInfo(page) {
  return await page.evaluate(() => {
    const rows = [...document.querySelectorAll(".row")];
    const getValue = (label) => {
      const row = rows.find((r) => {
        const cols = r.querySelectorAll(".col");
        return cols.length >= 2 && cols[0].textContent.trim() === label;
      });
      return row ? row.querySelectorAll(".col")[1].textContent.replace(/\s+/g, " ").trim() : null;
    };
    return {
      propertyId: getValue("Property ID number:"),
      address: getValue("Address:"),
      ownerName: getValue("Owner name:"),
      taxableMarketValue: getValue("Taxable market value:") || "N/A",
    };
  });
}

async function scrapeYearTaxHistory(page) {
  const taxYear = await page.$eval("#year", (el) => el.value.trim());
  const currentYear = String(new Date().getFullYear());
  
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.select("#year", currentYear),
  ]);

  const taxDueUrl = await page.evaluate(() => {
    const link = [...document.querySelectorAll("a")].find((a) => a.textContent.trim() === "Current year taxes due");
    return link?.href || null;
  });

  if (taxDueUrl) {
    await page.goto(taxDueUrl, { waitUntil: "networkidle2" });
  }
  return taxYear;
}

// MODULARIZED FUNCTION: Handles both 1st and 2nd half installments safely
async function scrapeInstallment(page, config) {
  const data = await page.evaluate((cfg) => {
    // Helper to safely get text content
    const getText = (selector) => {
      const el = document.querySelector(selector);
      return el ? el.textContent.trim() : null;
    };

    const dueDateText = getText(cfg.dueDateSelector);
    if (!dueDateText) return null; // Row doesn't exist

    const match = dueDateText.match(/\d{2}\/\d{2}\/\d{4}/);
    const dueDateStr = match ? match[0] : null;

    const balanceValue = getText(cfg.balanceSelector) || "$0.00";
    const baseAmount = getText(cfg.baseAmountSelector) || "$0.00";
    
    // Check paid amount, fallback to base amount if empty
    let paidAmount = getText(cfg.paidAmountSelector);
    if (!paidAmount) paidAmount = baseAmount; 

    return { dueDateStr, balanceValue, baseAmount, paidAmount };
  }, config);

  if (!data || !data.dueDateStr) return null;

  const dueDate = new Date(data.dueDateStr);
  const currentDate = new Date();
  const delinquentDate = new Date(`01/01/${dueDate.getFullYear() + 1}`);

  let paymentStatus = "";
  let amountDue = "$0.00";
  let paidAmount = "$0.00";

  // Logical Evaluation
  if (data.balanceValue === "$0.00") {
    paymentStatus = "Paid";
    amountDue = "$0.00";
    paidAmount = data.paidAmount || "$0.00";
  } else {
    amountDue = data.balanceValue;
    paymentStatus = (currentDate >= delinquentDate) ? "Delinquent" : "Due";
  }

  return {
    dueDate,
    delinquentDate,
    paymentStatus,
    amountDue,
    paidAmount,
    baseAmount: data.baseAmount,
  };
}

async function run(accountNumber) {
  const { browser, page } = await launchBrowser();
  try {
    await navigateToSite(page);
    await searchAccountNumber(page, accountNumber);

    const propertyInfo = await scrapePropertyInfo(page);

    const result = createPropertyObject();
    result.owner_name = propertyInfo.ownerName;
    result.parcel_number = propertyInfo.propertyId;
    result.property_address = propertyInfo.address;
    result.total_assessed_value = propertyInfo.taxableMarketValue;
    result.total_taxable_value = propertyInfo.taxableMarketValue;
    
    const taxYear = await scrapeYearTaxHistory(page);

    // Configuration array for the installments
    const installments = [
      {
        type: "Semi Annual",
        dueDateSelector: "#TD20",
        baseAmountSelector: "#TD21",
        paidAmountSelector: "#TD23",
        balanceSelector: "#TABLE_SEL > tbody > tr:nth-child(1) > td:nth-child(4) > b"
      },
      {
        type: "Semi Annual",
        dueDateSelector: "#TD24",
        baseAmountSelector: "#TD25",
        paidAmountSelector: "#TD27",
        balanceSelector: "#TABLE_SEL > tbody > tr:nth-child(2) > td:nth-child(4) > b"
      }
    ];

    // Loop through configurations and push formatted records
    for (const config of installments) {
      const scrapedData = await scrapeInstallment(page, config);
      
      if (scrapedData) {
        const record = createTaxHistory(); // Create a NEW object for each iteration
        record.year = taxYear;
        record.payment_type = config.type;
        record.status = scrapedData.paymentStatus;
        record.base_amount = scrapedData.baseAmount;
        record.amount_paid = scrapedData.paidAmount;
        record.amount_due = scrapedData.amountDue;
        record.due_date = scrapedData.dueDate.toLocaleDateString();
        record.delq_date = scrapedData.delinquentDate.toLocaleDateString();
        
        result.tax_history.push(record); // Push the correctly formatted record
      }
    }

    console.log(JSON.stringify(result, null, 2));

  } catch (err) {
    console.error(err);
  } finally {
    await browser.close();
  }
}

run("13-117-24-22-0270");