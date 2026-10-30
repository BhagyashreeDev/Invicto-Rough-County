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
      const balance = parseCurrency(cells[4].innerText);
      let dueAmount = parseCurrency(cells[6].innerText);
      
      // 🔥 FIX: If credits are 0 but due is also 0, fallback to balance or amount
      if (paymentsCredits === 0 && dueAmount === 0) {
        dueAmount = balance || amount;
      }
      
      const dueDateObj = new Date(payByDateText);
      dueDateObj.setDate(dueDateObj.getDate() + 1);
      const delinquentDateStr = `${dueDateObj.getMonth() + 1}/${dueDateObj.getDate()}/${dueDateObj.getFullYear()}`;
      
      return {
        installment: cells[0].innerText.trim(),
        dueDate: payByDateText,
        delinquentDate: delinquentDateStr,
        baseAmount: amount,
        paymentsCredits: paymentsCredits,
        balance: balance,
        dueAmount: dueAmount,
      };
    });
    return installments;
  });
  return { ownerName, installments: extractedData };
}

async function goToPaymentsOrAdjustments(page) {
  const paymentSelector = "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_ViewBill1_ViewPaymentsLinkButton";
  const exists = await page.$(paymentSelector);
  if (exists) {
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click(paymentSelector),
    ]);
  }
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
  } catch (error) {
    console.log("No payment table found or unable to fetch. Proceeding with mapping.");
  }

  const isSemiAnnual = billType.toLowerCase().includes("semi") || installments.length === 2;

  if (isSemiAnnual && installments.length === 2 && paymentRows.length === 1) {
    const totalInstallmentBase = installments[0].baseAmount + installments[1].baseAmount;
    const totalPaymentsCredits = installments[0].paymentsCredits + installments[1].paymentsCredits;
    const singlePayment = paymentRows[0].amountPaid;

    if (Math.abs(totalInstallmentBase - singlePayment) < 0.02 || Math.abs(totalPaymentsCredits - singlePayment) < 0.02) {
      const taxHistoryItem = createTaxHistory();
      taxHistoryItem.year = taxYear;
      taxHistoryItem.payment_type = "Annual"; 
      taxHistoryItem.base_amount = `$${totalInstallmentBase.toFixed(2)}`;
      taxHistoryItem.amount_paid = `$${singlePayment.toFixed(2)}`;
      taxHistoryItem.amount_due = `$${(installments[0].dueAmount + installments[1].dueAmount).toFixed(2)}`;
      taxHistoryItem.due_date = installments[0].dueDate;
      taxHistoryItem.delq_date = installments[1].delinquentDate || installments[0].delinquentDate;
      taxHistoryItem.paid_date = paymentRows[0].postedDate;
      taxHistoryItem.status = (installments[0].balance + installments[1].balance === 0) ? "Paid" : statusCalculator(taxHistoryItem);
      return [taxHistoryItem];
    }
  }

  let availablePayments = [...paymentRows];

  return installments.map((installment) => {
    const taxHistoryItem = createTaxHistory();
    taxHistoryItem.year = taxYear;
    taxHistoryItem.payment_type = isSemiAnnual ? "Semi-Annual" : "Annual";
    taxHistoryItem.base_amount = `$${installment.baseAmount.toFixed(2)}`;
    taxHistoryItem.amount_due = `$${installment.dueAmount.toFixed(2)}`;
    taxHistoryItem.due_date = installment.dueDate;
    taxHistoryItem.delq_date = installment.delinquentDate;

    let matchedPayment = null;

    if (availablePayments.length > 0) {
      const candidates = availablePayments.map((p, idx) => {
        const diffs = [
          Math.abs(p.amountPaid - installment.paymentsCredits),
          Math.abs(p.amountPaid - installment.baseAmount),
          Math.abs(p.amountPaid - installment.balance),
          Math.abs(p.amountPaid - installment.dueAmount)
        ];
        return { payment: p, originalIndex: idx, minDiff: Math.min(...diffs) };
      });

      let bestCandidates = candidates.filter(c => c.minDiff < 0.02);

      if (bestCandidates.length === 0) {
        const absoluteMinDiff = Math.min(...candidates.map(c => c.minDiff));
        bestCandidates = candidates.filter(c => c.minDiff === absoluteMinDiff);
      }

      if (bestCandidates.length > 0) {
        bestCandidates.sort((a, b) => new Date(a.payment.postedDate) - new Date(b.payment.postedDate));
        matchedPayment = bestCandidates[0].payment;

        const matchIdx = availablePayments.indexOf(matchedPayment);
        if (matchIdx !== -1) availablePayments.splice(matchIdx, 1);
      }
    }

    if (matchedPayment) {
      taxHistoryItem.amount_paid = `$${matchedPayment.amountPaid.toFixed(2)}`;
      taxHistoryItem.paid_date = matchedPayment.postedDate;
    } else {
      taxHistoryItem.amount_paid = `$${installment.paymentsCredits.toFixed(2)}`;
      taxHistoryItem.paid_date = "N/A";
    }

    if (installment.balance === 0 && installment.dueAmount === 0 && installment.baseAmount === installment.paymentsCredits) {
      taxHistoryItem.status = "Paid";
    } else {
      taxHistoryItem.status = statusCalculator(taxHistoryItem);
    }

    return taxHistoryItem;
  });
}

function mapHistoryDirectly(installments, taxYear, billType) {
  return installments.map((inst) => {
    const historyItem = createTaxHistory();
    historyItem.year = taxYear;
    const typeLower = billType.toLowerCase();
    historyItem.payment_type = typeLower.includes("semi") ? "Semi-Annual" : "Annual";
    historyItem.base_amount = `$${inst.baseAmount.toFixed(2)}`;
    historyItem.amount_due = `$${inst.dueAmount.toFixed(2)}`;
    historyItem.due_date = inst.dueDate;
    historyItem.delq_date = inst.delinquentDate;
    historyItem.amount_paid = `$${inst.paymentsCredits.toFixed(2)}`;
    historyItem.paid_date = "N/A";

    if (inst.balance === 0 && inst.dueAmount === 0 && inst.baseAmount > 0 && inst.baseAmount === inst.paymentsCredits) {
      historyItem.status = "Paid";
    } else {
      historyItem.status = statusCalculator(historyItem);
    }
    return historyItem;
  });
}

async function gotToCharges(page) {
  try {
    const chargeSelector = '#primarynav a[href*="TaxCharges.aspx"]';
    await page.waitForSelector(chargeSelector, { timeout: 5000 });
    await page.evaluate((sel) => document.querySelector(sel).click(), chargeSelector);

    const tableSelector = "#ctl00_ctl00_PrimaryPlaceHolder_ContentPlaceHolderMain_TaxChargesTable";
    await page.waitForSelector(tableSelector, { timeout: 5000 });

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
  } catch (error) {
    return "";
  }
}

async function goToPropertyDetail(page) {
  const propertySelector = '#primarynav a[href*="ParcelDetail.aspx"]';
  await page.waitForSelector(propertySelector);
  await page.evaluate(el => document.querySelector(el).click(), propertySelector);

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
    await page.goto("https://selfservice.co.worcester.md.us/css/citizens/RealEstate/Default.aspx?mode=new", { waitUntil: "networkidle2" });
    await searchAccountNumber(page, accountNumber);
    const allBillsMeta = await getAvailableBillsMetadata(page);
    
    if (allBillsMeta.length === 0) {
      console.log("No bills found for this account.");
      return;
    }
    
    allBillsMeta.sort((a, b) => b.year - a.year);
    
    const uniqueYears = [...new Set(allBillsMeta.map(b => b.year))].slice(0, 5);

    let actualLatestYear = null;
    let finalTaxHistory = [];
    let discoveredOwnerName = "N/A";
    let latestAddress = "N/A";
    let latestAssessed = "N/A";
    let latestTaxable = "";

    let isFirstIteration = true;
    
    let propertyDetailsLevel = 0; 

    for (const targetYear of uniqueYears) {
      const yearRows = allBillsMeta.filter(b => b.year === targetYear);
      let yearHadValidData = false;
      
      for (const rowMeta of yearRows) {
        if (!isFirstIteration) {
          await goToSearchResultsGrid(page);
        }
        isFirstIteration = false;

        const isMostRecentYear = (actualLatestYear === null);

        await page.waitForSelector(rowMeta.linkSelector);
        await page.click(rowMeta.linkSelector);
        const billData = await scrapeBillYear(page);
        
        if (billData.ownerName && billData.ownerName !== "N/A") {
            discoveredOwnerName = billData.ownerName;
        }

        const isGhostYear = billData.installments.length === 0 || billData.installments.every(inst => {
          return inst.baseAmount === 0 && inst.paymentsCredits === 0 && inst.balance === 0 && inst.dueAmount === 0;
        });

        if (isGhostYear) {
          console.log(`[!] Year ${targetYear} (${rowMeta.billType}) is a ghost record. Skipping tax history...`);
          
          if (propertyDetailsLevel < 1) {
            const currentTaxable = await gotToCharges(page);
            if (currentTaxable) latestTaxable = currentTaxable;
            
            const propData = await goToPropertyDetail(page);
            if (propData.address) latestAddress = propData.address;
            if (propData.assessed) latestAssessed = propData.assessed;
            
            propertyDetailsLevel = 1;
          }
          continue; 
        }

        yearHadValidData = true;

        const isFullyPaid = billData.installments.every(inst => 
          inst.baseAmount === inst.paymentsCredits && inst.balance === 0 && inst.dueAmount === 0
        );

        let parsedHistory = [];
        let upgradePropertyDetails = false;

        if (isMostRecentYear) {
          upgradePropertyDetails = true;
          if (isFullyPaid) {
            await goToPaymentsOrAdjustments(page);
            parsedHistory = await scrapePaymentsAndMap(page, billData.installments, targetYear.toString(), rowMeta.billType);
          } else {
            parsedHistory = mapHistoryDirectly(billData.installments, targetYear.toString(), rowMeta.billType);
          }
        } 
        else {
          if (isFullyPaid) {
            console.log(`[i] Year ${targetYear} (${rowMeta.billType}) is fully paid. Skipping as requested...`);
            continue; 
          } else {
            upgradePropertyDetails = true;
            await goToPaymentsOrAdjustments(page);
            parsedHistory = await scrapePaymentsAndMap(page, billData.installments, targetYear.toString(), rowMeta.billType);
          }
        }

        if (parsedHistory.length > 0) {
           finalTaxHistory.push(...parsedHistory);
        }

        if (upgradePropertyDetails && propertyDetailsLevel < 2) {
          const currentTaxable = await gotToCharges(page);
          if (currentTaxable) latestTaxable = currentTaxable;

          const propData = await goToPropertyDetail(page);
          if (propData.address) latestAddress = propData.address;
          if (propData.assessed) latestAssessed = propData.assessed;
          
          propertyDetailsLevel = 2; 
        }
      }

      if (yearHadValidData && actualLatestYear === null) {
        actualLatestYear = targetYear;
      }
    }

    const propertyObj = createPropertyObject();
    
    let taxableValue = latestTaxable;
    if (!taxableValue || taxableValue.trim() === "") {
        taxableValue = latestAssessed;
    }

    propertyObj.parcel_number = accountNumber; 
    propertyObj.owner_name = discoveredOwnerName !== "N/A" ? [discoveredOwnerName] : ["N/A"];
    propertyObj.property_address = latestAddress;
    propertyObj.total_assessed_value = latestAssessed ? latestAssessed : "N/A";
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
run("08000956");