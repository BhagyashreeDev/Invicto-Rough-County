import puppeteer from "puppeteer";

const timeout_option = {
  timeout: 90000,
};

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
    paid_date: "N/A",
    good_through_date: "-",
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

async function searchAccountNumber(page, accountNumber) {
  const searchIdSelector = "#P3_SERIAL";
  await page.waitForSelector(searchIdSelector);
  await page.type(searchIdSelector, accountNumber);

  const searchButtonSelector = "#B58332429791730314";
  await page.waitForSelector(searchButtonSelector);
  await page.click(searchButtonSelector);
}

async function clickFirstResultRow(page) {
  // wait until we get response from the server that fills the table
  await page.waitForNetworkIdle({ idleTime: 1000 });
  const linkSelector = "tbody tr td:nth-child(4) a";
  await page.waitForSelector(linkSelector, { timeout: 15000, visible: true });
  // Extract the href
  const relativeUrl = await page.$eval(linkSelector, (el) =>
    el.getAttribute("href"),
  );
  const baseUrl = "https://apps.uintah.utah.gov/";
  const fullUrl = new URL(relativeUrl, baseUrl).toString();
  await page.goto(fullUrl, { waitUntil: "networkidle2" });
}

async function parseThePage(page) {
  await page.waitForNetworkIdle({ idleTime: 1000 });

  const result = createPropertyObject();

  const ownerSelector = "#P4_OWNER_DISPLAY";
  const ownerName = await page.$(ownerSelector);
  result.owner_name = ownerName
    ? (await ownerName.evaluate((el) => el.textContent.trim())) || "N/A"
    : "N/A";

  const propertSelector = "#P4_ADDRESS_DISPLAY";
  const propertyName = await page.$(propertSelector);
  result.property_address = propertyName
    ? (await propertyName.evaluate((el) => el.textContent.trim())) || "N/A"
    : "N/A";

  const taxableSelector = "#P4_ASSESSED_DISPLAY";
  const taxableValue = await page.$(taxableSelector);
  result.total_taxable_value = taxableValue
    ? (await taxableValue.evaluate((el) => el.textContent.trim())) || "N/A"
    : "N/A";
  result.total_assessed_value = result.total_taxable_value;

  return result;
}

async function parseTaxHistory(page) {
  const record = createTaxHistory();

  const yearSelector = "#P4_YEAR_T_DISPLAY";
  const yearValue = await page.$(yearSelector);
  record.year = yearValue
    ? (await yearValue.evaluate((el) => el.textContent.trim())) || "N/A"
    : "N/A";

  const taxesSelector = "#P4_TAXES_DISPLAY";
  const taxesValue = await page.$(taxesSelector);
  record.base_amount = taxesValue
    ? (await taxesValue.evaluate((e1) => e1.textContent.trim())) || "N/A"
    : "N/A";

  const paidNum = await getCurrencyValue(page, "#P4_PAYMENTS_DISPLAY");
  record.amount_paid = paidNum > 0 ? `$${paidNum.toFixed(2)}` : "$0.00";

  const dueNum = await getCurrencyValue(page, "#P4_BALANCE_DISPLAY");
  record.amount_due = dueNum > 0 ? `$${dueNum.toFixed(2)}` : "$0.00";

  record.due_date = `11/30/${record.year}`;
  record.delq_date = `12/01/${record.year}`;

  const today = new Date();
  const dueDate = new Date(record.due_date);
  const delqDate = new Date(record.delq_date);

  if(dueNum === 0) {
    record.status = "Paid";
  } else if(today<=dueDate) {
    record.status = "Due";
  } else if(today>=delqDate) {
    record.status = "Delinquent";
  }

  return record;
}

async function getCurrencyValue(page, selector) {
  const el = await page.$(selector);
  if (!el) return 0; 
  const text = await el.evaluate((el) => el.textContent.trim());
  const numericValue = parseFloat(text.replace(/[$,]/g, ""));
  return isNaN(numericValue) ? 0 : numericValue;
}

async function run(accountNumber) {
  const { browser, page } = await launchBrowser();
  try {
    await page.goto(
      "https://apps.uintah.utah.gov/ords/ucdev/r/public-searches/property-search",
      {
        waitUntil: "networkidle2",
        ...timeout_option,
      },
    );

    await page.waitForSelector("body", { visible: true });
    await searchAccountNumber(page, accountNumber);
    await clickFirstResultRow(page);
    const result = await parseThePage(page);
    result.parcel_number = accountNumber;

    const record = await parseTaxHistory(page);
    result.tax_history.push(record);
    console.log(result);
  } catch (err) {
    console.log("Error during running: ", err);
  }
}

run("050130041");
