import puppeteer from "puppeteer";

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
    taxing_authority: "Frederick County Treasury Department, 30 N Market St #3 Frederick, MD 21701",
    notes: "",
    delinquent: "",
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
  const browser = await puppeteer.launch({headless: false,defaultViewport: null,args: ["--start-maximized"]});
  const page = await browser.newPage();
  page.setDefaultNavigationTimeout(60_000);
  page.setDefaultTimeout(30_000);
  return { browser, page };
}

async function searchAccountNumber(page, accountNumber) {
  const searchIdSelector = "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_Control_ParcelIdSearchFieldLayout_ctl01_ParcelIDTextBox";
  await page.waitForSelector(searchIdSelector);
  await page.type(searchIdSelector, accountNumber);

  const searchButtonSelector = "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_Control_FormLayoutItem7_ctl01_Button1";
  await page.waitForSelector(searchButtonSelector);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click(searchButtonSelector)
  ]);
}

async function chooseBillYear(page) {
  const tableSelector = "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_BillsGridView";
  
  // 1. Wait for the table to appear on the screen
  await page.waitForSelector(tableSelector);

  // 2. Process the table entirely inside the browser context
  const targetData = await page.evaluate((selector) => {
    const table = document.querySelector(selector);
    if (!table) return null;

    const rows = Array.from(table.querySelectorAll("tr"));
    let latestYear = -Infinity;
    let targetRowIndex = -1;

    // Loop through all rows to find the highest year
    for (let i = 0; i < rows.length; i++) {
      const cells = rows[i].querySelectorAll("td");
      if (cells.length < 7) continue; // Skip header or invalid rows

      const yearText = cells[4].textContent.trim();
      const year = parseInt(yearText, 10);

      if (!isNaN(year) && year > latestYear) {
        latestYear = year;
        targetRowIndex = i;
      }
    }

    if (targetRowIndex === -1) return null;

    const targetCells = rows[targetRowIndex].querySelectorAll("td");
    const viewBillLink = targetCells[6].querySelector("a");

    // Return the text data and the unique ID of the link to click
    return {
      taxYear: targetCells[4].textContent.trim(),
      billType: targetCells[5].textContent.trim(),
      linkId: viewBillLink ? viewBillLink.id : null
    };
  }, tableSelector);

  if (!targetData) {
    throw new Error("Could not read property tax years from the table.");
  }

  // 3. Click the target link safely from the Node context
  if (targetData.linkId) {
    // Because ASP.NET postbacks trigger a page load/update, 
    // we use Promise.all to ensure the action registers before moving on.
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => {
        // Fallback catch just in case the site uses an update panel (AJAX) instead of full navigation
      }),
      page.click(`#${targetData.linkId}`)
    ]);
  }

  return { taxYear: targetData.taxYear, billType: targetData.billType };
}

async function run(accountNumber) {
  const { browser, page } = await launchBrowser();
  try {
    await page.goto("https://alleganymd.munisselfservice.com/citizens/RealEstate/Default.aspx?mode=new",{ waitUntil: "networkidle2" });
    // 1. Search Account
    await searchAccountNumber(page, accountNumber);
    // 2. Select Latest Bill Year
    const { taxYear, billType } = await chooseBillYear(page);
   console.log(taxYear);
   console.log(billType);
  } catch (err) {
    console.log(err);
  } finally {
  }
}

run("04039033");
