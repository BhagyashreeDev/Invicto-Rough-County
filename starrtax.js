import puppeteer from "puppeteer";

function getTaxDates(year) {
  const nextYear = Number(year) + 1;
  return {
    due_date: `01/31/${nextYear}`,
    delq_date: `02/01/${nextYear}`,
  };
}

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

function applyStatusLogic(taxRecord, baseAmount, totalPaid, paidDateStr) {
  const today = new Date();
  const dueDate = new Date(taxRecord.due_date);
  const delqDate = new Date(taxRecord.delq_date);

  if (!paidDateStr || paidDateStr === "N/A" || paidDateStr === "") {
    taxRecord.amount_paid = "N/A";
    taxRecord.base_amount = baseAmount || "N/A";
    taxRecord.amount_due = baseAmount || "N/A";
    taxRecord.status = today < dueDate ? "Due" : "Delinquent";
    return;
  }

  const paidDate = new Date(paidDateStr);
  taxRecord.paid_date = paidDateStr;
  taxRecord.base_amount = baseAmount;
  taxRecord.amount_paid = totalPaid;

  if (paidDate <= dueDate) {
    taxRecord.status = "Paid";
    taxRecord.amount_due = "N/A";
    return;
  }

  if (paidDate >= delqDate) {
    taxRecord.status = "Paid";
    taxRecord.amount_due = totalPaid;
    return;
  }

  taxRecord.status = "Paid";
  taxRecord.amount_due = "N/A";
}

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

async function navigateToSite(page) {
  console.log("[nav] Opening search page...");
  await page.goto("https://starr.go2gov.net/faces/search.jsp", {
    waitUntil: "networkidle2",
  });
}

async function searchAccountNumber(page, accountNumber) {
  console.log(`[search] Searching for account: ${accountNumber}`);
  const iframeElement = await page.waitForSelector("iframe");
  const frame = await iframeElement.contentFrame();
  if (!frame) throw new Error("[search] Could not access iframe content frame");

  const inputSelector =
    "body > div.container > form:nth-child(5) > div > input.nine.columns.searchVis";
  await frame.waitForSelector(inputSelector, { visible: true });
  await frame.type(inputSelector, accountNumber);

  console.log("[search] Typed account number, clicking Search...");
  const searchSelector =
    "body > div.container > form:nth-child(5) > div > input.button.button-primary.two.columns.searchVis";
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    frame.click(searchSelector),
  ]);
  console.log("[search] Results page loaded.");
}

async function clickAccountLink(page) {
  console.log("[results] Waiting for account link...");
  const accountNumberSelector = "span.boldresult a[href*='doShowAccountPage']";
  await page.waitForSelector(accountNumberSelector, { visible: true });

  console.log("[results] Clicking account link...");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click(accountNumberSelector),
  ]);
  console.log("[results] Detail page loaded.");
}

async function scrapePropertyInfo(page) {
  console.log("[property] Scraping owner / address / parcel...");
  await page.waitForSelector("#etaxTemplateForm\\:text3");
  const info = await page.evaluate(() => {
    return {
      accountNo:
        document
          .querySelector("#etaxTemplateForm\\:text3")
          ?.textContent?.trim() || "",
      ownerName:
        document
          .querySelector("#etaxTemplateForm\\:text4")
          ?.textContent?.trim() || "",
      mailingAddress:
        document
          .querySelector("#etaxTemplateForm\\:text5")
          ?.textContent?.trim() || "",
      legalDescription:
        document
          .querySelector("#etaxTemplateForm\\:text6")
          ?.textContent?.trim() || "",
    };
  });
  console.log("[property]", info);
  return info;
}

async function scrapeCurrentTaxes(page) {
  console.log("[current] Checking current taxes table...");
  const currentTable1 = await page
    .$("#etaxTemplateForm\\:current1")
    .catch(() => null);
  if (!currentTable1) {
    console.log("[current] No current taxes table — skipping.");
    return { rows: [], totalAssessedValue: "N/A", totalTaxableValue: "N/A" };
  }

  const rows = await page.evaluate(() => {
    const trs = document.querySelectorAll(
      "#etaxTemplateForm\\:current1 tbody tr",
    );
    return [...trs].map((row) => ({
      year: row.querySelector('[id$="year1"]')?.textContent?.trim() || "",
      base: row.querySelector('[id$="taxesDue1"]')?.textContent?.trim() || "",
      total: row.querySelector('[id$="totalDue1"]')?.textContent?.trim() || "",
    }));
  });

  console.log("[current] Rows parsed:", rows);
  let details = { totalAssessedValue: "N/A", totalTaxableValue: "N/A" };

  if (rows.length > 0) {
    try {
      details = await scrapeCurrentTaxDetails(page);
    } catch (error) {
      console.error("[current] Error fetching detailed tax values:", error);
    }
  }

  return { rows, ...details };
}

async function scrapeCurrentTaxDetails(page) {
  console.log("[details] Clicking first year link for assessed values...");
  await page.waitForSelector("#etaxTemplateForm\\:current1\\:0\\:year1");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }).catch(() => null),
    page.click("#etaxTemplateForm\\:current1\\:0\\:year1"),
  ]);

  await page.waitForSelector("#etaxTemplateForm\\:entities1");
  const values = await page.evaluate(() => {
    let appraised = document
      .querySelector("#etaxTemplateForm\\:entities1\\:0\\:appraisedValue1")
      ?.textContent?.trim();
    let taxable = document
      .querySelector("#etaxTemplateForm\\:entities1\\:0\\:netTaxableValue1")
      ?.textContent?.trim();

    if (!appraised) {
      appraised = document
        .querySelector('[id*="appraisedValue"]')
        ?.textContent?.trim();
    }
    if (!taxable) {
      taxable = document
        .querySelector('[id*="netTaxableValue"]')
        ?.textContent?.trim();
    }
    return {
      totalAssessedValue: appraised || "N/A",
      totalTaxableValue: taxable || "N/A",
    };
  });

  console.log("[details]", values);
  await page.goBack({ waitUntil: "networkidle2" });
  return values;
}

async function scrapePaymentHistory(page, tax, result) {
  console.log("[payments] Navigating to payment history...");

  // 1. CHECK FOR THE DELINQUENT TABLE WHILE WE ARE STILL ON THE DASHBOARD
  const delinquentTable = await page
    .$("#etaxTemplateForm\\:delinquent1")
    .catch(() => null);
  const hasDelinquentTable = delinquentTable !== null;

  // 2. NOW WE CAN SAFELY NAVIGATE TO PAYMENT HISTORY
  await page.waitForSelector("#etaxTemplateForm\\:text71paymenth");
  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click("#etaxTemplateForm\\:text71paymenth"),
  ]);
  await page.waitForSelector("#etaxTemplateForm\\:tableEx1");

  const firstRow = await page.evaluate(() => {
    const row = document.querySelector("#etaxTemplateForm\\:tableEx1 tbody tr");
    if (!row) return null;
    return {
      year: row.querySelector('[id$="text6"]')?.textContent?.trim() || "",
      base_amount:
        row.querySelector('[id$="text7"]')?.textContent?.trim() || "",
      total_paid:
        row.querySelector('[id$="text10"]')?.textContent?.trim() || "",
    };
  });

  // 3. APPLY YOUR LOGIC
  // Is it a perfect match? Or is it a mismatch but we have no delinquent table?
  const isExactMatch = firstRow && firstRow.year === tax.year;
  const isFallbackMatch = firstRow && !isExactMatch && !hasDelinquentTable;

  if (isExactMatch || isFallbackMatch) {
    // Just logging what decision the bot made
    if (isExactMatch) {
      console.log(`[payments] Exact match found for year ${tax.year}.`);
    } else {
      console.log(
        `[payments] Year mismatch (${firstRow.year} vs ${tax.year}), but no delinquent table. Using ${firstRow.year} as the recent paid record.`,
      );
    }

    const record = createTaxHistory();
    // Use the actual year from the history table, just in case it differs from tax.year
    record.year = firstRow.year;
    record.base_amount = firstRow.base_amount;
    record.amount_paid = firstRow.total_paid;
    record.status = "Paid";
    record.amount_due = "N/A";

    const dates = getTaxDates(firstRow.year);
    record.due_date = dates.due_date;
    record.delq_date = dates.delq_date;

    // Dive into the details link
    await Promise.all([
      page.waitForNavigation({ waitUntil: "networkidle2" }),
      page.click(`#etaxTemplateForm\\:tableEx1\\:0\\:link1`),
    ]);
    await page.waitForSelector("#etaxTemplateForm\\:tableEx1");

    const rowCount = await page.$$eval(
      "#etaxTemplateForm\\:tableEx1 tbody tr",
      (rows) => rows.length,
    );

    let paymentType = "N/A";
    if (rowCount === 1) paymentType = "Annual";
    else if (rowCount === 2) paymentType = "Semi Annual";
    else if (rowCount === 4) paymentType = "Quarterly";

    const paidDate = await page.$$eval(
      "#etaxTemplateForm\\:tableEx1 tbody tr",
      (rows) => {
        const dates = rows
          .map((row) =>
            row.querySelector('[id$="text11"]')?.textContent?.trim(),
          )
          .filter(Boolean);
        if (dates.length === 0) return "N/A";
        return dates.reduce((max, current) =>
          new Date(current) > new Date(max) ? current : max,
        );
      },
    );

    record.paid_date = paidDate;
    record.payment_type = paymentType;
    result.tax_history.push(record);

    // Back out of details AND history to return to main dashboard
    await page.goBack({ waitUntil: "networkidle2" });
    await page.goBack({ waitUntil: "networkidle2" });
  } else {
    // This triggers if years don't match AND a delinquent table exists.
    // It safely skips the row and returns to the dashboard so the delinquent parser can take over.
    console.log(
      "[payments] Year mismatch and delinquent table exists. Deferring to delinquent parser.",
    );
    await page.goBack({ waitUntil: "networkidle2" });
  }
}

async function scrapeDelinquentTaxes(page) {
  console.log("[delinquent] Checking delinquent taxes table...");
  const currentTable2 = await page
    .$("#etaxTemplateForm\\:delinquent1")
    .catch(() => null);
  if (!currentTable2) {
    console.log("[delinquent] No delinquent table — skipping.");
    return [];
  }

  await Promise.all([
    page.waitForNavigation({ waitUntil: "networkidle2" }),
    page.click("#etaxTemplateForm\\:delinquent1\\:0\\:year2"),
  ]);

  const delinquentTable = await page.$("#etaxTemplateForm\\:delinquent1");
  let rows = [];
  if (delinquentTable) {
    rows = await page.evaluate(() => {
      const trs = document.querySelectorAll(
        "#etaxTemplateForm\\:delinquent1 tbody tr",
      );
      return [...trs].map((row) => ({
        year: row.querySelector('[id$="year1"]')?.textContent?.trim() || "",
        baseDue:
          row.querySelector('[id$="taxesDue1"]')?.textContent?.trim() || "",
        totalDue:
          row.querySelector('[id$="totalDue1"]')?.textContent?.trim() || "",
      }));
    });
  }

  console.log("[delinquent] Rows:", rows);
  await page.goBack({ waitUntil: "networkidle2" });
  return rows;
}

async function run(accountNumber) {
  const { browser, page } = await launchBrowser();

  try {
    await navigateToSite(page);
    await searchAccountNumber(page, accountNumber);
    await clickAccountLink(page);

    const propertyInfo = await scrapePropertyInfo(page);

    const result = createPropertyObject();
    result.owner_name = propertyInfo.ownerName;
    result.property_address = propertyInfo.mailingAddress;
    result.parcel_number = propertyInfo.accountNo;

    const taxData = await scrapeCurrentTaxes(page);
    result.total_assessed_value = taxData.totalAssessedValue;
    result.total_taxable_value = taxData.totalTaxableValue;

    // FIX: Iterate over taxData.rows instead of undefined "rows"
    for (const tax of taxData.rows) {
      const totalDue = parseFloat(String(tax.total).replace(/[$,]/g, "")) || 0;

      if (totalDue === 0) {
        console.log(
          `[current] ${tax.year} is paid. Fetching payment history...`,
        );
        await scrapePaymentHistory(page, tax, result);
      } else {
        console.log(
          `[current] ${tax.year} has balance due. Creating tax record...`,
        );
        const record = createTaxHistory();
        record.year = tax.year;
        const dates = getTaxDates(tax.year);
        record.due_date = dates.due_date;
        record.delq_date = dates.delq_date;
        record.base_amount = tax.base;
        record.amount_due = tax.total;
        record.status = "Delinquent";
        record.amount_paid = "N/A";
        record.payment_type = "N/A";
        record.paid_date = "N/A";

        result.tax_history.push(record);
      }
    }

    const delinquentRows = await scrapeDelinquentTaxes(page);

    for (const tax of delinquentRows) {
      let record = result.tax_history.find((t) => t.year === tax.year);
      if (!record) {
        record = createTaxHistory();
        record.year = tax.year;
        result.tax_history.push(record);
      }
      record.payment_type = "N/A";
      record.status = "Delinquent";
      record.base_amount = tax.baseDue;
      record.amount_paid = "N/A";
      record.amount_due = tax.totalDue;
      record.due_date = `01/31/${Number(tax.year) + 1}`;
      record.delq_date = `02/01/${Number(tax.year) + 1}`;
      record.paid_date = "N/A";
    }

    result.tax_history.sort((a, b) => Number(a.year) - Number(b.year));

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
    await new Promise((r) => setTimeout(r, 5_000));
    await browser.close();
  }
}

run("0060355");
