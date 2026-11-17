import puppeteer from "puppeteer";

const timeout_option = {
    timeout: 90000,
};

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper: Clean string values
const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

// Helper: Format dollar amounts
const formatDollar = (value) => {
  if (!value || value === "") return "$0.00";
  const num = parseFloat(value.toString().replace(/[$ ,]/g, ""));
  return Number.isFinite(num)
    ? `$${num.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
    : "$0.00";
};

// Helper: Calculate tax status based on due dates
const calculateTaxStatus = (taxHistory, now = new Date()) => {
  return taxHistory.map((item) => {
    if (item.status === "Paid") return { ...item, delinquent: "NONE" };

    const [mmD, ddD, yyyyD] = item.due_date.split("/").map(Number);
    const [mmQ, ddQ, yyyyQ] = item.delq_date.split("/").map(Number);

    const dueDate = new Date(yyyyD, mmD - 1, ddD);
    const delqDate = new Date(yyyyQ, mmQ - 1, ddQ);

    if (now < delqDate) {
      return { ...item, status: "Due", delinquent: "NONE" };
    } else {
      return { ...item, status: "Delinquent", delinquent: "YES" };
    }
  });
};

// Step 0: Direct navigation and data extraction
const dc_1 = async (page, account) => {
  return new Promise(async (resolve, reject) => {
    try {
      const cleanAccount = account.replace(/[^0-9]/g, "");
      if (!cleanAccount) return reject(new Error("Enter a valid Parcel Number"));

      // 1. Fetch Owner and Site Address directly from the County GIS REST API (< 1 sec)
      const gisUrl = `https://gisportal-pro.daviscountyutah.gov/server/rest/services/Operational/Parcels/MapServer/0/query?where=ParcelTaxID%3D'${cleanAccount}'&outFields=ParcelOwnerName,ParcelFullSitusAddress&f=json`;
      const res = await fetch(gisUrl);
      const json = await res.json();
      const attrs = json.features?.[0]?.attributes;

      if (!attrs) {
        return reject(new Error("No Record Found"));
      }

      const popupData = {
        owner_name: attrs.ParcelOwnerName ? [clean(attrs.ParcelOwnerName)] : [],
        property_address: clean(attrs.ParcelFullSitusAddress) || ""
      };

      // 2. Direct navigation to the Parcel Dashboard (Avoids map tiles and 60s networkidle2 timeout)
      const dashboardUrl = `https://webportal.daviscountyutah.gov/App/PropertySearch/dashboard/parcel/${cleanAccount}`;
      await page.goto(dashboardUrl, { waitUntil: "domcontentloaded", timeout: 60000 });

      // Wait for Angular data to render
      await page.waitForFunction(() => {
        const el = document.querySelector('.parcel-id-value, #parcel-info');
        return el && el.textContent.trim().length > 0;
      }, { timeout: 30000 });

      resolve(popupData);
    } catch (err) {
      console.error("Direct navigation failed:", err);
      reject(err);
    }
  });
};

// Helper: Generate notes for tax summary
const generateNotes = (taxHistory) => {
  if (!taxHistory?.length) return "NO TAX PAYMENT HISTORY AVAILABLE.";

  const sorted = [...taxHistory].sort((a, b) => parseInt(a.year) - parseInt(b.year));
  const latest = sorted[sorted.length - 1];
  const currentYear = latest.year;

  let curNote = "";
  if (latest.delinquent === "YES") {
    curNote = `${currentYear} ANNUAL TAXES ARE DELINQUENT`;
  } else if (latest.status === "Due") {
    curNote = `${currentYear} ANNUAL TAXES ARE DUE`;
  } else {
    curNote = `${currentYear} TAXES ARE PAID IN FULL`;
  }

  const hasDelinquentPrior = sorted.slice(0, -1).some(t => t.delinquent === "YES");
  let priorNote = hasDelinquentPrior 
    ? "PRIOR YEAR(S) TAXES ARE DELINQUENT" 
    : "PRIOR YEAR(S) TAXES ARE PAID";

  const hasInstallments = taxHistory.some(t => t.payment_type === "Installment");
  const suffix = `, NORMALLY TAXES ARE PAID ANNUALLY${
    hasInstallments ? ", SOME INSTALLMENT PAYMENTS DETECTED" : ""
  }, NORMAL DUE DATE IS 11/30.`;

  return `${priorNote}, ${curNote}${suffix}`;
};

// Step 2: Extract basic property information
const dc_2 = async (page, account) => {
  return new Promise(async (resolve, reject) => {
    try {
      const propertyData = await page.evaluate((parcel) => {
        const clean = (s) => (s || "").replace(/\s+/g, " ").trim();

        const data = {
          processed_date: new Date().toISOString().slice(0, 10),
          order_number: "",
          borrower_name: "",
          owner_name: [""],
          property_address: "",
          parcel_number: parcel,
          land_value: "-",
          improvements: "-",
          total_assessed_value: "",
          exemption: "-",
          total_taxable_value: "",
          taxing_authority: "Davis County Treasurer, 28 S State St, Farmington, UT 84025, Ph: 801-451-3372",
          notes: "",
          delinquent: "NONE",
          tax_history: [],
          property_details: {},
        };

        // Get parcel number
        const parcelEl = document.querySelector('.parcel-id-value, #parcel-info');
        if (parcelEl) data.parcel_number = clean(parcelEl.textContent);

        return data;
      }, account);

      resolve(propertyData);
    } catch (error) {
      console.error("Property extraction failed:", error);
      reject(new Error(`Failed to extract property data: ${error.message}`));
    }
  });
};

// Step 3: Extract valuation data
const dc_3 = async (page, mainData) => {
  return new Promise(async (resolve, reject) => {
    try {
      // Click Valuation section
      await page.evaluate(() => {
        const sections = Array.from(document.querySelectorAll('.action-section'));
        const valuationBtn = sections.find(el => el.textContent.includes('Valuation'));
        if (valuationBtn) valuationBtn.click();
      });

      await delay(2000);
      await page.waitForSelector('.drawer-content', { visible: true, timeout: 50000 });

      const valuationData = await page.evaluate(() => {
        const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
        
        const valuation = {
          market_value: "",
          taxable_value: "",
          valuation_history: []
        };

        // Find the valuation table
        const tables = document.querySelectorAll('table');
        
        for (const table of tables) {
          const rows = table.querySelectorAll('tbody tr');
          
          rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 3) {
              const year = clean(cells[0].textContent);
              const market = clean(cells[1].textContent);
              const taxable = clean(cells[2].textContent);
              
              if (year && !isNaN(parseInt(year)) && market.includes('$')) {
                valuation.valuation_history.push({
                  year: year,
                  market_value: market,
                  taxable_value: taxable
                });
              }
            }
          });
          
          if (valuation.valuation_history.length > 0) break;
        }

        if (valuation.valuation_history.length > 0) {
          valuation.market_value = valuation.valuation_history[0].market_value;
          valuation.taxable_value = valuation.valuation_history[0].taxable_value;
        }

        return valuation;
      });

      mainData.land_value = valuationData.market_value;
      mainData.total_assessed_value = valuationData.market_value;
      mainData.total_taxable_value = valuationData.taxable_value;
      mainData.valuation_history = valuationData.valuation_history;
      resolve(mainData);
    } catch (error) {
      console.error("Valuation extraction failed:", error);
      reject(new Error(`Failed to extract valuation: ${error.message}`));
    }
  });
};

// Step 4: Extract tax history
const dc_4 = async (page, mainData) => {
  return new Promise(async (resolve, reject) => {
    try {
      // Click Tax History section
      await page.evaluate(() => {
        const sections = Array.from(document.querySelectorAll('.action-section'));
        const taxBtn = sections.find(el => el.textContent.includes('Tax History'));
        if (taxBtn) taxBtn.click();
      });

      await delay(2000);
      await page.waitForSelector('.tax-history-table', { visible: true, timeout: 50000 });

      const taxHistory = await page.evaluate(() => {
        const clean = (s) => (s || "").replace(/\s+/g, " ").trim();
        const fmt = (v) => {
          if (!v) return "$0.00";
          const n = parseFloat(v.replace(/[$ ,]/g, ""));
          return Number.isFinite(n)
            ? `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`
            : "$0.00";
        };

        const history = [];
        const taxRows = document.querySelectorAll('.tax-history-table tbody tr');
        
        taxRows.forEach(row => {
          const cells = row.querySelectorAll('td');
          if (cells.length >= 5) {
            const year = clean(cells[0].textContent);
            const taxes = clean(cells[1].textContent);
            const adjustments = clean(cells[2].textContent);
            const paid = clean(cells[3].textContent);
            const due = clean(cells[4].textContent);

            const dueNum = parseFloat(due.replace(/[$ ,]/g, ""));
            const isPaid = dueNum <= 0;

            history.push({
              jurisdiction: "County",
              year: year,
              payment_type: "Annual",
              status: isPaid ? "Paid" : "Due",
              base_amount: fmt(taxes),
              amount_paid: fmt(paid),
              amount_due: fmt(due),
              adjustments: fmt(adjustments),
              mailing_date: "N/A",
              due_date: `11/30/${year}`,
              delq_date: `12/01/${year}`,
              paid_date: isPaid ? "N/A" : "-",
              good_through_date: ""
            });
          }
        });

        return history;
      });

      mainData.tax_history = taxHistory;
      resolve(mainData);
    } catch (error) {
      console.error("Tax history extraction failed:", error);
      reject(new Error(`Failed to extract tax history: ${error.message}`));
    }
  });
};

// Step 5: Finalize data
const dc_5 = async (page, mainData) => {
  return new Promise(async (resolve, reject) => {
    try {
      const fullHistoryWithStatus = calculateTaxStatus(mainData.tax_history);
      fullHistoryWithStatus.sort((a, b) => parseInt(a.year) - parseInt(b.year));

      if (fullHistoryWithStatus.length === 0) {
        mainData.tax_history = [];
        mainData.delinquent = "NONE";
        mainData.notes = "NO TAX PAYMENT HISTORY AVAILABLE.";
        resolve(mainData);
        return;
      }

      const latestEntry = fullHistoryWithStatus[fullHistoryWithStatus.length - 1];
      const delinquentPriorYears = fullHistoryWithStatus
        .slice(0, -1)
        .filter(t => t.delinquent === "YES");

      const displayedTaxHistory = [...delinquentPriorYears, latestEntry];
      mainData.tax_history = displayedTaxHistory;

      const hasAnyDelinquent = fullHistoryWithStatus.some(t => t.delinquent === "YES");
      mainData.delinquent = hasAnyDelinquent
        ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
        : "NONE";

      mainData.notes = generateNotes(fullHistoryWithStatus);

      resolve(mainData);
    } catch (error) {
      console.error("Finalization failed:", error);
      reject(new Error(`Failed to finalize: ${error.message}`));
    }
  });
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

async function searchAccountNumber(page, account) {
    try {
        // Step 1: Direct navigation + GIS data
        dc_1(page, account)
            .then((popupData) => {
                // Step 2: Property data
                dc_2(page, account)
                    .then((data) => {
                        // merge popup data
                        if (popupData?.owner_name?.length) {
                            data.owner_name = popupData.owner_name;
                        }
                        if (popupData?.property_address) {
                            data.property_address = popupData.property_address;
                        }
                        // Step 3: Valuation
                        dc_3(page, data)
                            .then((data1) => {
                                // Step 4: Tax history
                                dc_4(page, data1)
                                    .then((data2) => {
                                        // Step 5: Finalize
                                        dc_5(page, data2)
                                            .then((finalData) => {
                                                resolve(finalData);
                                            })
                                            .catch(err => reject(err));
                                    })
                                    .catch(err => reject(err));
                            })
                            .catch(err => reject(err));
                    })
                    .catch(err => reject(err));
            })
            .catch(err => reject(err));
    } catch (error) {
        console.error(error);
        reject(error);
    }
}

async function run(accountNumber) {

    try {
        const { browser, page } = await launchBrowser();

        await searchAccountNumber(page, accountNumber);


    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("R000023874");