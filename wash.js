import puppeteer from "puppeteer";

const timeout_option = {
  timeout: 90000,
};

function isRecordEmpty(historyArray) {
  // If the array is empty or every item has "0.00" as the amount, it's empty
  return historyArray.length === 0 || historyArray.every(item => 
    parseFloat(item.amount_due.replace(/[\$,]/g, "")) === 0 && 
    parseFloat(item.base_amount.replace(/[\$,]/g, "")) === 0
  );
}

function createresultect() {
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
  const searchIdSelector =
    "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_Control_ParcelIdSearchFieldLayout_ctl01_ParcelIDTextBox";
  await page.waitForSelector(searchIdSelector);
  await page.type(searchIdSelector, accountNumber);

  const searchButtonSelector =
    "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_Control_FormLayoutItem7_ctl01_Button1";
  await page.waitForSelector(searchButtonSelector);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click(searchButtonSelector),
  ]);
}

async function chooseRecentBill(page) {
  // If the search lands on a single parcel, we may need to click "All Bills" from the side menu first
  const allBillsLink = "ul#primarynav a[href*='AllBills.aspx']";
  const isAllBillsAvailable = await page.$(allBillsLink);
  if (isAllBillsAvailable) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click(allBillsLink),
    ]);
  }

  const tableSelector =
    "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_BillsGridView";
  await page.waitForSelector(tableSelector);

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.evaluate((selector) => {
      const rows = Array.from(document.querySelectorAll(`${selector} tr`));

      let highestYear = 0;
      let targetLink = null;

      rows.forEach((row) => {
        const cells = row.querySelectorAll("td");
        if (cells.length > 6) {
          const year = parseInt(cells[4].innerText.trim(), 10);
          if (!isNaN(year) && year > highestYear) {
            highestYear = year;
            targetLink = cells[6].querySelector("a.functionlink");
          }
        }
      });

      if (targetLink) {
        targetLink.click();
      } else {
        throw new Error("Could not find a valid link to click.");
      }
    }, tableSelector),
  ]);
}

async function parseTaxRecord(page) {
  const panelSelector =
    "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_ViewBill1_BillDetailsUpdatePanel";
  await page.waitForSelector(panelSelector);

  // Perform all extraction synchronously inside the browser
  const data = await page.evaluate(() => {
    const cleanMoney = (str) =>
      parseFloat((str || "0").replace(/[\$,]/g, "").trim());

    // 1. Get Owner Name (Synchronous DOM query)
    const ownerSelector =
      "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_ViewBill1_OwnerLabel";
    const ownerEl = document.querySelector(ownerSelector);
    const ownerName = ownerEl ? ownerEl.textContent.trim() : "";

    // 2. Get Bill Year
    let billYear = "";
    const yearLabel = document.querySelector(
      "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_ViewBill1_FiscalYearLabel",
    );
    if (yearLabel) billYear = yearLabel.innerText.trim();

    // 3. Get Installment Rows
    const rows = Array.from(
      document.querySelectorAll(
        "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_ViewBill1_BillDetailsUpdatePanel .datatable tbody tr",
      ),
    );
    const validRows = rows.filter((row) => {
      const firstCell = row.querySelector("td");
      return firstCell && !isNaN(parseInt(firstCell.innerText.trim()));
    });

    const rowLength = validRows.length;
    const paymentType = rowLength >= 2 ? "Semi-Annual" : "Annual";
    const historyArray = [];

    validRows.forEach((row, index) => {
      const cells = row.querySelectorAll("td");
      if (cells.length >= 7) {
        const dueDate = cells[1].innerText.trim();
        const baseAmountNum = cleanMoney(cells[2].innerText);
        const amountPaidNum = cleanMoney(cells[3].innerText);
        const dueNum = cleanMoney(cells[6].innerText);

        let delDate = "";
        if (index === 0) {
          delDate = `10/01/${billYear - 1}`;
        } else if (index === 1) {
          delDate = `01/01/${billYear}`;
        }

        const today = new Date();
        let status = "";
        if (baseAmountNum === 0 && dueNum === 0) {
          status = "Exempt";
        } else if (dueNum === 0) {
          status = "Paid";
        } else if (today >= new Date(delDate)) {
          status = "Delinquent";
        } else {
          status = "Due";
        }

        historyArray.push({
          jurisdiction: "County",
          year: billYear,
          payment_type: paymentType,
          status: status,
          base_amount: `$${baseAmountNum.toFixed(2)}`,
          amount_paid: `$${amountPaidNum.toFixed(2)}`,
          amount_due: `$${dueNum.toFixed(2)}`,
          mailing_date: "N/A",
          due_date: dueDate,
          delq_date: delDate,
          paid_date: "N/A",
          good_through_date: "-",
        });
      }
    });

    return { ownerName, historyArray };
  });

  return data;
}

async function parsePaidRecord(page, taxHistory) {
  // Navigate to payments
  const paymentsLink =
    "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_ViewBill1_ViewPaymentsLinkButton";

  // Check if the link exists before clicking
  const linkExists = await page.$(paymentsLink);
  if (!linkExists) return taxHistory;

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click(paymentsLink),
  ]);

  // Extract payment data
  const payments = await page.evaluate(() => {
    const rows = Array.from(
      document.querySelectorAll("table.datatable tbody tr"),
    );
    const data = [];

    rows.forEach((row) => {
      const cells = row.querySelectorAll("td");
      // Assuming: [0] Activity, [1] Posted, [5] Amount
      if (cells.length > 5) {
        const activity = cells[0].innerText.trim();
        const postedDate = cells[1].innerText.trim();
        const amount = parseFloat(
          cells[5].innerText.replace(/[\$,]/g, "").trim(),
        );

        if (activity.toLowerCase() === "payment" && postedDate) {
          data.push({ date: postedDate, amount });
        }
      }
    });
    // Sort oldest to newest
    return data.sort((a, b) => new Date(a.date) - new Date(b.date));
  });

  // Map payments to installments
  let lastUsedDate = "N/A";
  let paymentIndex = 0;

  taxHistory.forEach((installment) => {
    if (installment.status === "Paid") {
      // Case 1: We have a specific payment record
      if (payments[paymentIndex]) {
        installment.paid_date = payments[paymentIndex].date;
        lastUsedDate = payments[paymentIndex].date;
        paymentIndex++;
      }
      // Case 2: Bulk payment scenario (no more payment records, but installment is paid)
      else if (lastUsedDate !== "N/A") {
        installment.paid_date = lastUsedDate;
      }
    }
  });

  return taxHistory;
}

async function parsePropertyDetails(page, resultect) {
  // Navigate to Property Detail using the side menu
  const propertyDetailLink = "ul#primarynav a[href*='ParcelDetail.aspx']";
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click(propertyDetailLink),
  ]);

  await page.waitForSelector("#ParcelTable");

  const details = await page.evaluate(() => {
    const getText = (id) => {
      const el = document.getElementById(id);
      return el ? el.innerText.trim() : "";
    };

    return {
      parcel_number: getText(
        "ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_ParcelIdLabel",
      ),
      property_address: getText(
        "ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_LocationLabel",
      ),
      total_assessed_value: getText(
        "ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_AssessedValueLabel",
      ),
      exemption: getText(
        "ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_ExemptionAmountLabel",
      ),
    };
  });

  const parseMoney = (str) =>
    parseFloat((str || "0").replace(/[\$,]/g, "").trim());
  const assessed = parseMoney(details.total_assessed_value);
  const exempt = parseMoney(details.exemption);
  const taxable = assessed - exempt;
  // Map to Object
  resultect.parcel_number = details.parcel_number;
  resultect.property_address = details.property_address;
  resultect.total_assessed_value = details.total_assessed_value;
  resultect.total_taxable_value = `$${taxable.toFixed(2)}`;

  return resultect;
}

async function run(accountNumber) {
  let browserInstance;
  try {
    const { browser, page } = await launchBrowser();
    browserInstance = browser;

    await page.goto(
      "https://washingtoncountymd.munisselfservice.com/css/citizens/RealEstate/Default.aspx?mode=new",
      { waitUntil: "networkidle2", ...timeout_option },
    );

    await page.waitForSelector("body", { visible: true });
    await searchAccountNumber(page, accountNumber);

    // 1. Navigate to All Bills
    const allBillsLink = "ul#primarynav a[href*='AllBills.aspx']";
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click(allBillsLink),
    ]);

    // 2. Extract available bill years
    const billList = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll("#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_BillsGridView tr"));
      const bills = [];
      // Skip header row
      for (let i = 1; i < rows.length; i++) {
        const cells = rows[i].querySelectorAll("td");
        if (cells.length > 6) {
          bills.push({
            year: parseInt(cells[4].innerText.trim(), 10),
            rowIndex: i // We use this to click the row or link later
          });
        }
      }
      return bills.sort((a, b) => b.year - a.year); // Sort descending
    });

    let finalResult = null;

    // 3. Iterate through bills
    for (const bill of billList) {
      console.log(`Checking year: ${bill.year}`);

      // Go to the specific bill page
      // We re-click the link based on the index/row logic
      await page.evaluate((index) => {
        const row = document.querySelectorAll("#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_BillsGridView tr")[index];
        row.querySelector("a.functionlink").click();
      }, bill.rowIndex);

      await page.waitForNavigation({ waitUntil: "networkidle2" });

      // Parse data
      const { ownerName, historyArray, taxableValue } = await parseTaxRecord(page);

      // Check if data is valid
      if (!isRecordEmpty(historyArray)) {
        console.log(`Found valid data for year: ${bill.year}`);
        
        // Build result
        let result = createresultect();
        result.owner_name = ownerName;
        result.total_taxable_value = taxableValue.startsWith('$') ? taxableValue : `$${taxableValue}`;

        // Get payments and details
        const mappedHistory = await parsePaidRecord(page, historyArray);
        result.tax_history = mappedHistory;
        result = await parsePropertyDetails(page, result);

        finalResult = result;
        break; // STOP iteration
      } else {
        console.log(`Year ${bill.year} is empty. Moving to next.`);
        // Navigate back to All Bills page to continue the loop
        await Promise.all([
          page.waitForNavigation({ waitUntil: "networkidle2" }),
          page.click(allBillsLink),
        ]);
      }
    }

    if (finalResult) {
      console.log(JSON.stringify(finalResult, null, 2));
    } else {
      console.log("No valid tax records found for any year.");
    }

  } catch (err) {
    console.log("Error while running:", err.message);
  } finally {
    if (browserInstance) {
      await browserInstance.close();
    }
  }
}

run("26030021");
