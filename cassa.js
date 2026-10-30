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
        delinquent: "NONE",
        notes: ""
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

// Formatting helpers
const formatCurrency = (amount) => {
    if (!amount || amount === "N/A" || amount === "-") return "$0.00";
    let num = String(amount).replace(/[$,]/g, "").trim();
    if (isNaN(num) || num === "") return "$0.00";
    let formatted = parseFloat(num).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    return "$" + formatted;
};

const formatDate = (dateStr) => {
    if (!dateStr || dateStr === "N/A" || dateStr === "-") return "N/A";
    let d = new Date(dateStr);
    if (isNaN(d.getTime())) return dateStr;
    let month = ("0" + (d.getMonth() + 1)).slice(-2);
    let day = ("0" + d.getDate()).slice(-2);
    let year = d.getFullYear();
    return `${month}/${day}/${year}`;
};

// Notes logic builder
const generate_notes = (year, status, dueDate, hasDelinquent) => {
    let notes = hasDelinquent
        ? `PRIOR TAXES ARE DELINQUENT, ${year} `
        : `ALL PRIORS ARE PAID, ${year} `;

    notes += `TAXES ARE ${status.toUpperCase()}, `;
    notes += `NORMALLY TAXES ARE PAID ANNUALLY, NORMAL DUE DATE IS ${dueDate.substring(0, 5)}`;

    return notes;
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

async function searchAccountNumber(page, accountNumber) {
   
    await page.waitForSelector('mat-select');
    let selects = await page.$$('mat-select');
    if (selects.length < 2) {
        throw new Error("Expected form dropdown elements (mat-select) were not found on the page.");
    }
    await page.evaluate((el) => el.click(), selects[0]);
    await new Promise(r => setTimeout(r, 800));
    await page.waitForSelector('.mat-mdc-option, .mat-option', { timeout: 10000 });
    await page.evaluate(() => {
        const options = Array.from(document.querySelectorAll('.mat-mdc-option, .mat-option'));
        const targetOption = options.find(el => el.textContent.trim().includes('Real Estate'));
        if (targetOption) {
            targetOption.click();
        } else if (options.length > 0) {
            options[0].click(); 
        }
    });
    await new Promise(r => setTimeout(r, 800)); 

    const refreshedSelects = await page.$$('mat-select');
    await page.evaluate((el) => el.click(), refreshedSelects[1]);
    await new Promise(r => setTimeout(r, 800));
    await page.waitForSelector('.mat-mdc-option, .mat-option', { timeout: 10000 });
    await page.evaluate(() => {
        const options = Array.from(document.querySelectorAll('.mat-mdc-option, .mat-option'));
        if (options.length > 0) {
            options[0].click(); 
        }
    });
    
    // Collapse overlays and trigger initial Search to load the next view layout stage
    await page.keyboard.press('Escape');
    await new Promise(r => setTimeout(r, 500));

    await page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"]') || 
                    document.querySelector('button.mat-mdc-raised-button') || 
                    document.querySelector('button.mat-raised-button');
        if (btn) btn.click();
    });

    // Wait for the URL change and the new view state layout to load completely
    await new Promise(r => setTimeout(r, 3000));

   
    // Explicitly check for a visible input element on the updated layout page
    const searchInputFound = await page.evaluate(() => {
        const inputs = Array.from(document.querySelectorAll('input'));
        const activeInput = inputs.find(i => {
            const style = window.getComputedStyle(i);
            return !['checkbox', 'radio', 'submit', 'button', 'hidden', 'file'].includes(i.type) && 
                   style.display !== 'none' && 
                   style.visibility !== 'hidden';
        });

        if (activeInput) {
            activeInput.focus();
            activeInput.value = ''; 
            activeInput.dispatchEvent(new Event('input', { bubbles: true }));
            return true;
        }
        return false;
    });

    if (!searchInputFound) {
        throw new Error("Could not find a valid visible search account input field after performing the initial dropdown submission.");
    }
    await page.keyboard.type(accountNumber, { delay: 50 });
    await new Promise(r => setTimeout(r, 500));

    await page.evaluate(() => {
        const btn = document.querySelector('button[type="submit"]') || 
                    document.querySelector('button.mat-mdc-raised-button') || 
                    document.querySelector('button.mat-raised-button');
        if (btn) btn.click();
    });
}

async function run(accountNumber) {
    const { browser, page } = await launchBrowser();
    try {
        await page.goto(
            "https://casscountycollector.com/search",
            {
                waitUntil: "networkidle2",
                ...timeout_option,
            },
        );

        // 1. Perform Multi-step Search Sequence Workflow
        await searchAccountNumber(page, accountNumber);

        // 2. Resiliently locate and click target row inside results table contextually
        await page.waitForSelector('mat-row', { timeout: 20000 });
        const targetRowFound = await page.evaluate((accNum) => {
            const rows = document.querySelectorAll('mat-row');
            for (const row of rows) {
                const accountCell = row.querySelector('[class*="column-account"], .cdk-column-account');
                if (accountCell && accountCell.textContent.replace(/\s+/g, '').includes(accNum)) {
                    row.click(); // Click the row container directly 
                    return true;
                }
                if (row.textContent.replace(/\s+/g, '').includes(accNum)) {
                    row.click();
                    return true;
                }
            }
            return false;
        }, accountNumber);

        if (!targetRowFound) {
            throw new Error(`Target account row containing value "${accountNumber}" not found in search results.`);
        }

        await page.waitForSelector('app-address .name', { timeout: 20000 });

        // 4. Scrape data elements from details DOM layout structure
        const rawScrapedData = await page.evaluate(() => {
            const labels = Array.from(document.querySelectorAll('mat-label'));
            const findValueByLabel = (labelTxt) => {
                const labelElement = labels.find(el => el.textContent.trim() === labelTxt);
                return labelElement ? labelElement.nextElementSibling?.textContent.trim() : "";
            };

            const ownerName = document.querySelector('app-address .name')?.textContent.trim() || "";
            const taxYear = findValueByLabel('Tax Year');
            const totalDueStr = findValueByLabel('Total Due');
            const totalPaidStr = findValueByLabel('Total Paid');
            const paidOnStr = findValueByLabel('Paid On');
           

            // Extract pure Situs Address
            const situsLabel = labels.find(el => el.textContent.trim() === 'Situs Address');
            let propertyLocation = "";
            if (situsLabel && situsLabel.nextElementSibling) {
                const containerHtml = situsLabel.nextElementSibling.innerHTML;
                const matchParts = containerHtml.split(/<br\s*\/?>/i);
                if (matchParts.length >= 2) {
                    propertyLocation = `${matchParts[0].trim()}, ${matchParts[1].trim()}`;
                } else {
                    propertyLocation = situsLabel.nextElementSibling.textContent.trim().split("SEC:")[0].trim();
                }
            }

            // Extract values out of custom responsive inner summary tables
            const tds = Array.from(document.querySelectorAll('td'));
            const totalAssessedCell = tds.find(el => el.textContent.trim() === 'Total Assessed:');
            const totalAssessedValue = totalAssessedCell ? totalAssessedCell.nextElementSibling?.textContent.trim() : "";

            const taxAmtCell = tds.find(el => el.textContent.trim() === 'Tax Amount:');
            let baseTaxAmount = "";
            if (taxAmtCell) {
                const parentRowCells = taxAmtCell.parentElement.querySelectorAll('td');
                if (parentRowCells.length >= 3) {
                    baseTaxAmount = parentRowCells[2].textContent.trim();
                }
            }

            return {
                ownerName,
                taxYear,
                totalDueStr,
                totalPaidStr,
                paidOnStr,
                propertyLocation,
                totalAssessedValue,
                baseTaxAmount
            };
        });

        // 5. Build up target object entity mapping and process calculations securely
        const result = createPropertyObject();
        if (rawScrapedData.ownerName) result.owner_name.push(rawScrapedData.ownerName);
        result.property_address = rawScrapedData.propertyLocation;
        result.parcel_number = rawScrapedData.mapNumber;
        result.total_assessed_value = rawScrapedData.totalAssessedValue.replace(/,/g, '').trim();
        result.total_taxable_value = result.total_assessed_value; 

        // 6. Build History Row Calculations
        const historyRow = createTaxHistory();
        historyRow.year = rawScrapedData.taxYear || new Date().getFullYear().toString();
        
        const due_date_raw = `12/31/${historyRow.year}`;
        const delq_date_raw = `01/01/${parseInt(historyRow.year) + 1}`;
        historyRow.due_date = formatDate(due_date_raw);
        historyRow.delq_date = formatDate(delq_date_raw);

        const paymentDateStr = rawScrapedData.paidOnStr ? rawScrapedData.paidOnStr.trim() : "";
        const isPaid = (paymentDateStr !== "" && paymentDateStr.toUpperCase() !== "NOT PAID");

        if (isPaid) {
            historyRow.status = "Paid";
            historyRow.paid_date = formatDate(paymentDateStr);
            historyRow.amount_paid = formatCurrency(rawScrapedData.totalPaidStr);
            historyRow.amount_due = "$0.00"; 
        } else {
            const today = new Date();
            today.setHours(0,0,0,0);
            const standardDueDateObj = new Date(due_date_raw);
            standardDueDateObj.setHours(0,0,0,0);

            if (today.getTime() <= standardDueDateObj.getTime()) {
                historyRow.status = "Due";
            } else {
                historyRow.status = "Delinquent";
            }
            historyRow.paid_date = "N/A";
            historyRow.amount_paid = "$0.00";
            historyRow.amount_due = formatCurrency(rawScrapedData.totalDueStr);
        }

        historyRow.base_amount = formatCurrency(rawScrapedData.baseTaxAmount);
        result.tax_history.push(historyRow);

        // 7. Core custom notes processing logic block integration execution
        if (result.tax_history.length > 0) {
            const hasDelinquent = result.tax_history.some((t) => t.status === "Delinquent");
            result.delinquent = hasDelinquent 
                ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF" 
                : "NONE";

            const latestTax = result.tax_history[result.tax_history.length - 1];
            result.notes = generate_notes(
                latestTax.year,
                latestTax.status,
                latestTax.due_date,
                hasDelinquent
            );
        }

        console.log("Final Scraped Result Object Structure:", JSON.stringify(result, null, 2));
      
    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {
        
    }
}

// Execute Script run sequence targeting specified sample account
run("1765500");