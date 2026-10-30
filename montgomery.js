import puppeteer from "puppeteer";

const timeout_option = {
  timeout: 90000,
};

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
    paid_date: "",
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
    const propertyLinkId = "#PTCInfo";
    await page.waitForSelector(propertyLinkId);
    await page.click(propertyLinkId);
    const iframeSelector = "#Iframe1";
    await page.waitForSelector(iframeSelector);
    // Give the iframe a brief moment to inject its .aspx source code
    await new Promise(resolve => setTimeout(resolve, 2000));
    const iframeHandle = await page.$(iframeSelector);
    const frame = await iframeHandle.contentFrame();
    if (!frame) {
        throw new Error("Could not access the content inside #Iframe1.");
    }
    const searchByParcelId = "#SearchByParcel";
    await frame.waitForSelector(searchByParcelId, timeout_option);
    await frame.click(searchByParcelId);
    const searchInputId = "#SearchText";
    await frame.waitForSelector(searchInputId);
    await frame.click(searchInputId, { clickCount: 3 });
    await frame.type(searchInputId, accountNumber, { delay: 50 });
    const searchButtonId = "#Search";
    await frame.waitForSelector(searchButtonId);
    await Promise.all([
        frame.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => console.log("Navigation wait finished.")),
        frame.click(searchButtonId)
    ]);

    const selectedTaxYear = await frame.evaluate(() => {
        // 1. Target the dropdown by its unique ID
        const taxYearDropdown = document.querySelector('#TaxYear');
        // 2. Return its current value (or null if not found)
        return taxYearDropdown ? taxYearDropdown.value : null;
    });
    const totalDue = await frame.evaluate(() => {
        const cells = Array.from(document.querySelectorAll('td'));
        const targetCell = cells.find(td => td.textContent.includes('TOTAL DUE:'));
        if (targetCell) {
        const valueCell = targetCell.nextElementSibling;
        return valueCell ? valueCell.textContent.trim() : null;
        }
        return null;
    });
    const pracelIdSelector = "#BodyTable > tbody > tr > td > fieldset > legend > span";
    await frame.waitForSelector(pracelIdSelector, timeout_option);
    await frame.click(pracelIdSelector);
    return {frame, selectedTaxYear, totalDue};
}

async function decidingTaxYear(frame, selectedTaxYear, totalDue) {
    const childIframeHandle1 = await frame.waitForSelector('#Iframe2');
    const childFrame1 = await childIframeHandle1.contentFrame();
    if (!childFrame1) {
        throw new Error("Could not access the content inside #Iframe2.");
    }
    const extractPropertyData = async () => {
        return await childFrame1.evaluate(() => {
            const getNextColumnValue = (labelText) => {
                const allTds = Array.from(document.querySelectorAll('td'));
                const labelTd = allTds.find(td => td.textContent.trim() === labelText);
                if (labelTd && labelTd.nextElementSibling) {
                    return labelTd.nextElementSibling.textContent.replace(/\s+/g, ' ').trim();
                }
                return N/A;
            };

            return {
                parcelID: getNextColumnValue("PARCEL #:"),
                owner: getNextColumnValue("OWNER:"),
                location: getNextColumnValue("LOCATION:")
            };
        });
    };

    // 2. Check if totalDue from the parent frame search was empty or "NA"
    if (totalDue === null || totalDue === "NA") {
        // Read the currently selected option value from #YearDDL (e.g., "2025")
        let currentDropdownYear = await childFrame1.evaluate(() => {
            const select = document.querySelector("#YearDDL");
            return select ? select.value : null;
        });

        if (currentDropdownYear) {
            const targetYear = String(parseInt(currentDropdownYear, 10) - 1); // e.g., "2025" -> "2024"
            console.log(`Total Due is missing. Selecting ${targetYear} from #YearDDL dropdown...`);

            try {
                // Select the option and wait for the ASP.NET __doPostBack network request to complete
                await Promise.all([
                    childFrame1.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(() => console.log("Postback navigation finished.")),
                    childFrame1.select('#YearDDL', targetYear)
                ]);
                console.log(`Successfully switched #YearDDL to ${targetYear}`);
            } catch (dropdownError) {
                console.log(`Failed to switch dropdown to ${targetYear}:`, dropdownError);
            }
        }
    }

    return{frame, extractPropertyData};
}

async function parseData(frame) {
    const childIframeHandle2 = await frame.waitForSelector('#Iframe1');
    const childFrame2 = await childIframeHandle2.contentFrame();
    if (!childFrame2) {
        throw new Error("Could not access the content inside #Iframe2.");
    }

    const taxInfoData = await childFrame2.evaluate(() => {
    // 1. Locate the header or label inside the specific fieldset to ensure we are in TAX INFO
    const legends = Array.from(document.querySelectorAll('legend'));
    const taxInfoLegend = legends.find(legend => legend.textContent.trim() === 'TAX INFO');
    
    if (!taxInfoLegend) return { assessedValue: null, grandTotal: null };
    
    // Find the table inside this fieldset container
    const fieldset = taxInfoLegend.closest('fieldset');
    const rows = Array.from(fieldset.querySelectorAll('table tbody tr'));
    
    // 2. The last row contains both values: "ASSD. VALUE:  $42,360.00" and "GRAND TOTAL:  $1,774.12"
    const finalSummaryRow = rows[rows.length - 1];
    
    if (finalSummaryRow) {
        const cells = finalSummaryRow.querySelectorAll('td');
        
        // Extract from the first cell: "ASSD. VALUE:  $42,360.00"
        const assdText = cells[0] ? cells[0].textContent.trim() : '';
        const assessedValue = assdText.includes(':') 
            ? assdText.split(':')[1].trim() 
            : null;
            
        // Extract from the last cell: "GRAND TOTAL:  $1,774.12"
        const grandText = cells[2] ? cells[2].textContent.trim() : '';
        const grandTotal = grandText.includes(':') 
            ? grandText.split(':')[1].trim() 
            : null;

        return {
            assessedValue, // Returns "$42,360.00"
            grandTotal     // Returns "$1,774.12"
        };
    }
    
    return { assessedValue: "N/A", grandTotal: "N/A" };
});

console.log("Assessed Value:", taxInfoData.assessedValue);
console.log("Grand Total:", taxInfoData.grandTotal);

    const paidInfo = await childFrame2.evaluate(() => {
        const legends = Array.from(document.querySelectorAll("legend"));
        const paymentInfoLegend = legends.find(legend=>legend.textContent.trim()==="PAYMENT INFO");
        const fieldset = paymentInfoLegend.closest("fieldset");
        const rows = Array.from(fieldset.querySelectorAll("table tbody tr"));
        const firstRow = rows[1];
        if(firstRow) {
            const cells = firstRow.querySelectorAll("td");
            const paidDate = cells[0] ? cells[0].textContent.trim() : "N/A";
            const taxYear = cells[1] ? cells[1].textContent.trim() : "N/A";
            const paidAmount = cells[3] ? cells[3].textContent.trim() : "$0.00";
            return {
                paidDate,
                taxYear,
                paidAmount
            };
        }
    });
    console.log(paidInfo.paidDate);
    console.log(paidInfo.taxYear);
    console.log(paidInfo.paidAmount);

    return {taxInfoData, paidInfo};
}

async function run(accountNumber) {
  const { browser, page } = await launchBrowser();
  try {
    await page.goto(
      "https://montgomery.capturecama.com/",
      {
        waitUntil: "networkidle2",
        ...timeout_option,
      },
    );

    const {frame, selectedTaxYear, totalDue} = await searchAccountNumber(page, accountNumber);
    const {frame, propertyDetails} = await decidingTaxYear(frame, selectedTaxYear, totalDue);
    const {taxInfoData, paidInfo} = await parseData(frame);

    const result = createPropertyObject();
    result.parcel_number = propertyDetails.parcelID;
    result.owner_name = propertyDetails.owner ? [propertyDetails.owner] : "N/A";
    result.property_address = propertyDetails.location ;
    result.total_assessed_value = taxInfoData.assessedValue;
    result.total_taxable_value = taxInfoData.assessedValue;

    const record = createTaxHistory();
    record.year = paidInfo.taxYear;
    record.due_date = `10/1/${record.year}`;
    const nextYear = parseInt(record.year, 10) + 1;
    record.delq_date = `01/01/${nextYear}`;
    record.base_amount = taxInfoData.grandTotal;
    record.amount_paid = paidInfo.paidAmount;
    record.paid_date = paidInfo.paidDate;
    if (paidInfo.paidAmount && paidInfo.paidAmount !== "$0.00") {
        record.status = "Paid";
        record.amount_due = "$0.00";
    } else {
        const today = new Date();
        const dueDateObj = new Date(record.due_date);

        if (today <= dueDateObj) {
            record.status = "Due"; 
        } else {
            record.status = "Delinquent";
        }
        record.amount_due = record.base_amount;
    }
    result.tax_history.push(record);
    console.log(result);

  } catch (err) {
    console.log("Error during running: ", err);
  }
}

run("10 01 02 2 006 008.000");