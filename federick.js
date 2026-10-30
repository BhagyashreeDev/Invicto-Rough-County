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

function statusCalculator(taxHistoryItem) {
  const today = new Date();
  const dueDate = new Date(taxHistoryItem.due_date);
  const delqDate = new Date(taxHistoryItem.delq_date);
  if (today <= dueDate) {
    return "Due";
  } else if (today >= delqDate) {
    return "Delinquent";
  }
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
  await page.click(searchButtonSelector);
}

async function chooseBillYear(page) {
  const tableSelector = "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_BillsGridView";
  await page.waitForSelector(tableSelector);
  const rows = await page.$$(`${tableSelector} tr`);
  let latestYear = -Infinity;
  let latestRow;
  for (const row of rows.slice(1)) {
    const cells = await row.$$("td");
    if (cells.length < 7) continue;
    const yearText = await page.evaluate(
      (el) => el.textContent.trim(),
      cells[4],
    );
    const year = parseInt(yearText, 10);
    if (year > latestYear) {
      latestYear = year;
      latestRow = row;
    }
  }
  let taxYear = "";
  let billType = "";
  if (latestRow) {
    const cells = await latestRow.$$("td");
    taxYear = await page.evaluate((el) => el.textContent.trim(), cells[4]);
    billType = await page.evaluate((el) => el.textContent.trim(), cells[5]);
    const viewBillLink = await cells[6].$("a");
    await viewBillLink.click();
  }
  return { taxYear, billType };
}

async function scrapeBillYear(page) {
  const ownerSelector = "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_ViewBill1_OwnerLabel";
  await page.waitForSelector(ownerSelector);
  const ownerName = await page.$eval(ownerSelector, (el) => el.textContent.trim());
  const extractedData = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".datatable tbody tr"));
    const validInstallmentRows = rows.filter((row) => {
      const firstCell = row.querySelector("td");
      if (!firstCell) return false;
      const cellText = firstCell.innerText.trim();
      return !isNaN(parseInt(cellText, 10));
    });
    const parseCurrency = (str) => {
      if (!str || str.trim() === "") return 0;
      return parseFloat(str.replace(/[\$,]/g, ""));
    };
    const installments = validInstallmentRows.map((row) => {
      const cells = row.querySelectorAll("td");
      const payByDateText = cells[1].innerText.trim();
      const amount = parseCurrency(cells[2].innerText);
      const paymentsCredits = parseCurrency(cells[3].innerText);
      const dueDateObj = new Date(payByDateText);
      dueDateObj.setDate(dueDateObj.getDate() + 1);
      const delinquentDateStr = `${dueDateObj.getMonth() + 1}/${dueDateObj.getDate()}/${dueDateObj.getFullYear()}`;
      let rowData = {
        installment: cells[0].innerText.trim(),
        dueDate: payByDateText,
        delinquentDate: delinquentDateStr,
        baseAmount: amount,
        balance: 0,
        dueAmount: "$0.00",
      };
      if (amount !== paymentsCredits) {
        rowData.balance = parseCurrency(cells[4].innerText);
        rowData.dueAmount = parseCurrency(cells[6].innerText);
      }
      return rowData;
    });
    return installments;
  });
  return { ownerName, installments: extractedData };
}

async function goToPaymentsOrAdjustments(page) {
  const paymentSelector = "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_ViewBill1_ViewPaymentsLinkButton";
  await page.waitForSelector(paymentSelector);
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click(paymentSelector),
  ]);
}

async function scrapePaymentsAndMap(page, installments, taxYear, billType) {
  await page.waitForSelector(".datatable.nomargin tbody tr");
  const paymentRows = await page.evaluate(() => {
    const rows = Array.from(document.querySelectorAll(".datatable.nomargin tbody tr"));
    const payments = [];
    for (let i = 1; i < rows.length; i++) {
      const cells = rows[i].querySelectorAll("td");
      if (cells.length > 0) {
        const activity = cells[0].innerText.trim();
        if (activity === "Payment") {
          const postedDate = cells[1].innerText.trim();
          const amountRaw = cells[5].innerText.trim();
          const amount = parseFloat(amountRaw.replace(/[\$,()]/g, ""));
          payments.push({
            postedDate: postedDate,
            amountPaid: amount,
          });
        }
      }
    }
    return payments;
  });
  paymentRows.reverse();

  if (installments.length > 1 && paymentRows.length === 1) {
    const singlePayment = paymentRows[0];
    let totalBase = 0;
    let totalDue = 0;
    for (const inst of installments) {
      totalBase += inst.baseAmount;
      const dueStr = typeof inst.dueAmount === 'string' ? inst.dueAmount : "$0.00";
      totalDue += parseFloat(dueStr.replace(/[\$,]/g, "")) || 0;
    }
    const taxHistoryItem = createTaxHistory();
    taxHistoryItem.year = taxYear;
    taxHistoryItem.payment_type = "Annual"; 
    taxHistoryItem.base_amount = `$${totalBase.toFixed(2)}`;
    taxHistoryItem.amount_due = `$${totalDue.toFixed(2)}`;
    taxHistoryItem.due_date = installments[0].dueDate;
    taxHistoryItem.delq_date = installments[0].delinquentDate;
    taxHistoryItem.amount_paid = `$${singlePayment.amountPaid.toFixed(2)}`;
    taxHistoryItem.paid_date = singlePayment.postedDate;
    if (totalDue === 0 || taxHistoryItem.amount_due === "$0.00") {
      taxHistoryItem.status = "Paid";
    } else {
      taxHistoryItem.status = statusCalculator(taxHistoryItem);
    }
    return [taxHistoryItem];
  }

  const mappedTaxHistory = installments.map((installment, index) => {
    const taxHistoryItem = createTaxHistory();
    const matchedPayment = paymentRows[index];
    taxHistoryItem.year = taxYear;
    const typeLower = billType.toLowerCase();
    taxHistoryItem.payment_type = typeLower.includes("semi") ? "Semi-Annual" : "Annual";
    taxHistoryItem.base_amount = `$${installment.baseAmount.toFixed(2)}`;
    taxHistoryItem.amount_due = installment.dueAmount;
    taxHistoryItem.due_date = installment.dueDate;
    taxHistoryItem.delq_date = installment.delinquentDate;
    if (matchedPayment) {
      taxHistoryItem.amount_paid = `$${matchedPayment.amountPaid.toFixed(2)}`;
      taxHistoryItem.paid_date = matchedPayment.postedDate;
      if (taxHistoryItem.amount_due === "$0.00") {
        taxHistoryItem.status = "Paid";
      } else {
        taxHistoryItem.status = statusCalculator(taxHistoryItem);
      }
    } else {
      taxHistoryItem.amount_paid = "$0.00";
      taxHistoryItem.status = statusCalculator(taxHistoryItem);
    }
    return taxHistoryItem;
  });
  return mappedTaxHistory;
}

async function gotToCharges(page) {
  const chargeSelector = "#primarynav > li.primarynavselected.submenu.mol-side-submenu > ul > li:nth-child(2) > a";
  await page.waitForSelector(chargeSelector);
  await page.click(chargeSelector);
  const taxableValue = await page.$eval("#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_TaxChargesTable tr:nth-child(2) td.numericdata", (el) => el.textContent.trim());
  return taxableValue;
}

async function goToPropertyDetail(page) {
  const propertySelector = "#primarynav > li.primarynavselected.submenu.mol-side-submenu > ul > li:nth-child(3) > a";
  await page.waitForSelector(propertySelector);
  await page.click(propertySelector);

  const locationSelector = "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_LocationLabel";
  await page.waitForSelector(locationSelector);
  const address = await page.$eval(locationSelector, el => el.textContent.replace(/\s+/g, ' ').trim());

  const assessedSelector = "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_AssessedValueLabel";
  await page.waitForSelector(assessedSelector);
  const assessed = await page.$eval(assessedSelector, el => el.textContent.trim());
  return {address, assessed};
}

async function run(accountNumber) {
  const { browser, page } = await launchBrowser();
  try {
    await page.goto("https://frederickcountymd.munisselfservice.com/citizens/RealEstate/Default.aspx?mode=new",{ waitUntil: "networkidle2" });

    // 1. Search Account
    await searchAccountNumber(page, accountNumber);

    // 2. Select Latest Bill Year
    const { taxYear, billType } = await chooseBillYear(page);

    // 3. Extract Initial Installment Data
    const billData = await scrapeBillYear(page);

    // 4. Navigate to Payments Page
    await goToPaymentsOrAdjustments(page);

    // 5. Extract Payments and Map them to the initial Installment data
    const finalTaxHistory = await scrapePaymentsAndMap(
      page,
      billData.installments,
      taxYear,
      billType,
    );

    // 6. Build the final Property Object
    const propertyObj = createPropertyObject();
    const taxableValue = await gotToCharges(page);
    const data = await goToPropertyDetail(page);
    propertyObj.owner_name = billData.ownerName ? [billData.ownerName] : ["N/A"];
    propertyObj.property_address = data.address;
    propertyObj.total_assessed_value = data.assessed ? data.assessed : "N/A";
    propertyObj.total_taxable_value = taxableValue ? taxableValue : "N/A";
    propertyObj.tax_history = finalTaxHistory;

    const formatMMDD = (dateStr) => {
      if (!dateStr || dateStr === "N/A" || dateStr === "-") return "N/A";
      const parts = dateStr.split("/");
      if (parts.length >= 2) {
        return `${parts[0].padStart(2, "0")}/${parts[1].padStart(2, "0")}`;
      }
      return dateStr;
    };

    const history = propertyObj.tax_history;
    const hasDelinquency = history.some((t) => t.status === "Delinquent");
    propertyObj.delinquent = hasDelinquency ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF" : "NONE";
    const priorText = hasDelinquency ? "PRIOR TAXES ARE DELINQUENT" : "ALL PRIORS ARE PAID";
    if (history.length === 2) {
      // Semi-Annual formatting
      const th_1 = history[0];
      const th_2 = history[1];
      const d1 = formatMMDD(th_1.due_date);
      const d2 = formatMMDD(th_2.due_date);
      propertyObj.notes = `${priorText}, ${taxYear} 1ST INSTALLMENT IS ${th_1.status.toUpperCase()}, 2ND INSTALLMENT IS ${th_2.status.toUpperCase()}, NORMALLY TAXES ARE PAID SEMI-ANNUALLY, NORMAL DUE DATES ARE ${d1} AND ${d2}`;
    } else if (history.length === 1) {
      // Annual formatting
      const th_1 = history[0];
      const d1 = formatMMDD(th_1.due_date);
      propertyObj.notes = `${priorText}, ${taxYear} TAXES ARE ${th_1.status.toUpperCase()}, NORMALLY TAXES ARE PAID ANNUALLY, NORMAL DUE DATE IS ${d1}`;
    } else {
      propertyObj.notes = "NO TAX HISTORY RECORDS FOUND TO GENERATE NOTES.";
    }
  } catch (err) {
    console.log(err);
  } finally {
  }
}

run("01017195");
