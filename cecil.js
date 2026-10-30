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
    taxing_authority: "Cecil County Government, 200 Chesapeake Boulevard, Suite 1100 Elkton, MD 21921",
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
  return "Paid"; 
}

async function launchBrowser() {
  const browser = await puppeteer.launch({ headless: false, defaultViewport: null, args: ["--start-maximized"] });
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

async function goToSearchResultsGrid(page) {
  const searchResultsSelector = '#primarynav a[href*="ParcelBrowse.aspx"]';
  await page.waitForSelector(searchResultsSelector, { visible: true });
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {}),
    page.evaluate((sel) => {
      document.querySelector(sel).click();
    }, searchResultsSelector)
  ]);
  const gridSelector = "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_BillsGridView";
  await page.waitForSelector(gridSelector, { visible: true });
}
async function getAvailableBillsMetadata(page) {
  const tableSelector = "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_BillsGridView";
  await page.waitForSelector(tableSelector);

  return await page.evaluate((selector) => {
    const rows = Array.from(document.querySelectorAll(`${selector} tr`)).slice(1);
    return rows.map((row) => {
      const cells = row.querySelectorAll("td");
      if (cells.length < 7) return null;

      const yearText = cells[4].textContent.trim();
      const billType = cells[5].textContent.trim();
      const linkId = cells[6].querySelector("a")?.id || "";

      return {
        year: parseInt(yearText, 10),
        billType: billType,
        linkSelector: `#${linkId}`
      };
    }).filter(b => b !== null);
  }, tableSelector);
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
  let paymentRows = [];
  try {
    await page.waitForSelector(".datatable.nomargin tbody tr", { timeout: 5000 });
    paymentRows = await page.evaluate(() => {
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
            payments.push({ postedDate: postedDate, amountPaid: amount });
          }
        }
      }
      return payments;
    });
    paymentRows.reverse();
  } catch (error) {
    console.log("No payment table found. Proceeding with unpaid installment logic.");
  }

  if (paymentRows.length === 0) {
    const mappedTaxHistory = installments.map((installment) => {
      const taxHistoryItem = createTaxHistory();
      taxHistoryItem.year = taxYear;
      const typeLower = billType.toLowerCase();
      taxHistoryItem.payment_type = typeLower.includes("semi") ? "Semi-Annual" : "Annual";
      taxHistoryItem.base_amount = `$${installment.baseAmount.toFixed(2)}`;
      taxHistoryItem.due_date = installment.dueDate;
      taxHistoryItem.delq_date = installment.delinquentDate;
      taxHistoryItem.amount_paid = "$0.00";
      taxHistoryItem.paid_date = "N/A";

      const parsedDue = typeof installment.dueAmount === 'string'
        ? parseFloat(installment.dueAmount.replace(/[\$,]/g, "")) || 0
        : installment.dueAmount;

      let finalDueAmount = 0;
      if (parsedDue !== 0) {
        finalDueAmount = parsedDue;
      } else {
        finalDueAmount = installment.balance !== 0 ? installment.balance : installment.baseAmount;
      }

      taxHistoryItem.amount_due = `$${finalDueAmount.toFixed(2)}`;
      taxHistoryItem.status = statusCalculator(taxHistoryItem);
      return taxHistoryItem;
    });
    return mappedTaxHistory;
  }

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

  return installments.map((installment, index) => {
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
}

async function processIsolatedBill(page, billMeta) {
  await page.waitForSelector(billMeta.linkSelector);
  await page.click(billMeta.linkSelector);
  const billData = await scrapeBillYear(page);
  // check whether that year is ghost year (all records are 0) or not
  const isGhostYear = billData.installments.length === 0 || billData.installments.every(inst => {
    const base = inst.baseAmount || 0;
    const balance = inst.balance || 0;
    const due = typeof inst.dueAmount === 'string' ? parseFloat(inst.dueAmount.replace(/[\$,]/g, "")) || 0 : inst.dueAmount || 0;
    return base === 0 && balance === 0 && due === 0;
  });
  // if yes then we dont parse that year data
  if (isGhostYear) {
    console.log(`[!] Year ${billMeta.year} (${billMeta.billType}) contains zero balances. Identified as a ghost record. Skipping...`);
    return { ownerName: billData.ownerName, history: [], isGhostYear: true };
  }
  // if no then parse that year data
  await goToPaymentsOrAdjustments(page);
  let parsedHistory = await scrapePaymentsAndMap(
    page,
    billData.installments,
    billMeta.year.toString(),
    billMeta.billType
  );
  parsedHistory = parsedHistory.filter((item) => {
    const base = parseFloat(item.base_amount.replace(/[\$,]/g, "")) || 0;
    const paid = parseFloat(item.amount_paid.replace(/[\$,]/g, "")) || 0;
    const due = parseFloat(item.amount_due.replace(/[\$,]/g, "")) || 0;
    return base > 0 || paid > 0 || due > 0;
  });
  return { ownerName: billData.ownerName, history: parsedHistory, isGhostYear: false };
}

async function gotToCharges(page) {
  const chargeSelector = '#primarynav a[href*="TaxCharges.aspx"]';
  await page.waitForSelector(chargeSelector);
  await page.evaluate((sel) => document.querySelector(sel).click(), chargeSelector);

  const tableSelector = "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_TaxChargesTable";
  await page.waitForSelector(tableSelector);

  return await page.evaluate((selector) => {
    const table = document.querySelector(selector);
    if (!table) return "";
    const rows = Array.from(table.querySelectorAll("tr"));
    for (const row of rows) {
      const headerCell = row.querySelector("th.leftheader");
      if (headerCell && headerCell.textContent.toUpperCase().includes("COUNTY")) {
        const numericCells = row.querySelectorAll("td.numericdata");
        if (numericCells.length > 0) return numericCells[0].textContent.trim();
      }
    }
    return "";
  }, tableSelector);
}

async function goToPropertyDetail(page) {
  const propertySelector = '#primarynav a[href*="ParcelDetail.aspx"]';
  await page.waitForSelector(propertySelector);
  await page.click(propertySelector);

  const locationSelector = "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_LocationLabel";
  await page.waitForSelector(locationSelector);
  const address = await page.$eval(locationSelector, el => el.textContent.replace(/\s+/g, ' ').trim());

  const assessedSelector = "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_AssessedValueLabel";
  await page.waitForSelector(assessedSelector);
  const assessed = await page.$eval(assessedSelector, el => el.textContent.trim());
  return { address, assessed };
}

async function run(accountNumber) {
  const { browser, page } = await launchBrowser();
  try {
    await page.goto("https://alleganymd.munisselfservice.com/citizens/RealEstate/Default.aspx?mode=new", { waitUntil: "networkidle2" });
    await searchAccountNumber(page, accountNumber);
    const allBillsMeta = await getAvailableBillsMetadata(page);
    if (allBillsMeta.length === 0) {
      console.log("No bills found for this account.");
      return;
    }
    allBillsMeta.sort((a, b) => b.year - a.year);
    const uniqueYears = [...new Set(allBillsMeta.map(b => b.year))];

    let actualLatestYear = null;
    let finalTaxHistory = [];
    let discoveredOwnerName = "N/A";
    let latestYearRequiresFallback = false;
    let isFirstIteration = true;

    for (const targetYear of uniqueYears) {
      const yearRows = allBillsMeta.filter(b => b.year === targetYear);
      let yearHistory = [];
      let yearIsGhost = true;
      for (const rowMeta of yearRows) {
        if (!isFirstIteration) {
          await goToSearchResultsGrid(page);
        }
        isFirstIteration = false;
        const { ownerName, history, isGhostYear } = await processIsolatedBill(page, rowMeta);
        if (ownerName && ownerName !== "N/A") {
            discoveredOwnerName = ownerName;
        }
        if (!isGhostYear) {
          yearIsGhost = false;
          yearHistory.push(...history);
        }
      }
      if (!yearIsGhost) {
        actualLatestYear = targetYear;
        finalTaxHistory.push(...yearHistory);
        const hasUnpaidOrDelq = yearHistory.some(item => item.status === "Due" || item.status === "Delinquent");
        if (hasUnpaidOrDelq) {
          latestYearRequiresFallback = true;
        }
        break; 
      }
    }
    if (latestYearRequiresFallback && actualLatestYear !== null) {
      const historicalYears = uniqueYears.filter(y => y < actualLatestYear).slice(0, 5);
      const targetedPastRows = allBillsMeta.filter(b => historicalYears.includes(b.year));

      for (const pastBill of targetedPastRows) {
        await goToSearchResultsGrid(page);
        const { history, isGhostYear } = await processIsolatedBill(page, pastBill);
        
        if (!isGhostYear) {
            const delinquentHistory = history.filter(item => item.status === "Delinquent");
            finalTaxHistory.push(...delinquentHistory);
        }
      }
    }
    const propertyObj = createPropertyObject();
    const taxableValue = await gotToCharges(page);
    const data = await goToPropertyDetail(page);

    propertyObj.owner_name = discoveredOwnerName !== "N/A" ? [discoveredOwnerName] : ["N/A"];
    propertyObj.property_address = data.address;
    propertyObj.total_assessed_value = data.assessed ? data.assessed : "N/A";
    propertyObj.total_taxable_value = taxableValue ? taxableValue : "N/A";
    propertyObj.tax_history = finalTaxHistory;

    const formatMMDD = (dateStr) => {
      if (!dateStr || dateStr === "N/A" || dateStr === "-") return "N/A";
      const parts = dateStr.split("/");
      if (parts.length >= 2) return `${parts[0].padStart(2, "0")}/${parts[1].padStart(2, "0")}`;
      return dateStr;
    };
    const history = propertyObj.tax_history;
    const hasDelinquency = history.some((t) => t.status === "Delinquent");
    propertyObj.delinquent = hasDelinquency ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF" : "NONE";
    const priorText = hasDelinquency ? "PRIOR TAXES ARE DELINQUENT" : "ALL PRIORS ARE PAID";

    if (history.length === 0 || !actualLatestYear) {
      propertyObj.notes = "NO VALID TAX RECORDS FOUND.";
    } else {
      const currentYearItems = history.filter(t => t.year === actualLatestYear.toString());
      let currentYearNote = "";

      if (currentYearItems.length === 2) {
        const d1 = formatMMDD(currentYearItems[0].due_date);
        const d2 = formatMMDD(currentYearItems[1].due_date);
        currentYearNote = `${actualLatestYear} 1ST INSTALLMENT IS ${currentYearItems[0].status.toUpperCase()}, 2ND INSTALLMENT IS ${currentYearItems[1].status.toUpperCase()}, NORMALLY TAXES ARE PAID SEMI-ANNUALLY, NORMAL DUE DATES ARE ${d1} AND ${d2}`;
      } else if (currentYearItems.length === 1) {
        const d1 = formatMMDD(currentYearItems[0].due_date);
        currentYearNote = `${actualLatestYear} TAXES ARE ${currentYearItems[0].status.toUpperCase()}, NORMALLY TAXES ARE PAID ANNUALLY, NORMAL DUE DATE IS ${d1}`;
      } else {
        currentYearNote = `${actualLatestYear} TAX STATUS UPDATED`;
      }
      const olderDelinquentItems = history.filter(t => t.year !== actualLatestYear.toString() && t.status === "Delinquent");
      if (olderDelinquentItems.length > 0) {
        const backYears = [...new Set(olderDelinquentItems.map(t => t.year))];
        propertyObj.notes = `${priorText}, ${currentYearNote}. DELINQUENT BALANCES NOTED FOR PAST YEAR(S): ${backYears.join(', ')}.`;
      } else {
        propertyObj.notes = `${priorText}, ${currentYearNote}`;
      }
    }

    console.log(JSON.stringify(propertyObj, null, 2));
  } catch (err) {
    console.log(err);
  } finally {
    // await browser.close();
  }
}

run("03007928");