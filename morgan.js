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

// Utility to convert strings like "$322.52" into raw numbers
function parseCurrency(val) {
    if (!val) return 0;
    return parseFloat(val.toString().replace(/[\$,]/g, '')) || 0;
}

function populatePropertyData(extractedData) {
    const property = createPropertyObject();
    const tax = createTaxHistory();

    property.parcel_number = extractedData["Parcel Number"] || "";
    property.owner_name = extractedData["Owner Name"] || "";
    property.property_address = extractedData["Property Address"] || "";
    
    const taxableValue = extractedData["Total Taxable Value"] || "";
    property.total_assessed_value = taxableValue;
    property.total_taxable_value = taxableValue;

    tax.year = extractedData["TaxYear_Dropdown"] || new Date().getFullYear().toString();
    tax.base_amount = extractedData["Taxes Charged"] || "$0.00";
    tax.amount_due = extractedData["Taxes Balance Due"] || "$0.00";
    tax.amount_paid = extractedData["Tax Prepayments"] || "$0.00";

    const yearNum = parseInt(tax.year, 10);
    const delqDate = new Date(yearNum, 11, 1); 
    const today = new Date();

    tax.due_date = `11/30/${yearNum}`;
    tax.delq_date = `12/01/${yearNum}`;

    const numericAmountDue = parseCurrency(tax.amount_due);

    if (numericAmountDue > 0) {
        if (today >= delqDate) {
            tax.status = "Delinquent";
        } else {
            tax.status = "Due";
        }
        tax.paid_date = "N/A";
    } else {
        tax.status = "Paid";
        tax.paid_date = "N/A"; 
    }

    property.tax_history.push(tax);
    return property;
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

async function autoScrollToElement(page, selector) {
    await page.evaluate(async (targetSelector) => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;

                const element = document.querySelector(targetSelector);
                if (element || totalHeight >= document.body.scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    }, selector);
}

async function searchAccountNumber(page, accountNumber) {
    const parcelInputSelector = 'input[name="fParcel"]';
    await page.waitForSelector(parcelInputSelector);

    await page.click(parcelInputSelector);
    await page.type(parcelInputSelector, accountNumber, { delay: 100 });

    const searchBtnHandle = await page.waitForFunction(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(b => b.textContent.trim() === 'Search');
    });

    await searchBtnHandle.click();
    await new Promise(r => setTimeout(r, 3000));
    console.log("Search completed.");
}

async function clickFirstResultRow(page) {
    const rowSelector = '.dt-scroll-body table tbody tr:not(.dt-empty)';
    await page.waitForSelector(rowSelector);
    
    await page.click(rowSelector, { clickCount: 2 });
    console.log("Double-clicked row. Waiting for Xojo container to load...");

    const xojoContainerSelector = 'div.XojoContainer';
    await page.waitForSelector(xojoContainerSelector, { visible: true, timeout: 30000 });

    await new Promise(r => setTimeout(r, 5000)); 
    console.log("Layout loaded and data painted.");
}

async function extractXojoData(page) {
    return await page.evaluate(() => {
        const labels = [];
        const values = [];
        const result = {};

        const activeYearEl = document.querySelector('.dropdown-item.active span') || document.querySelector('button.dropdown-toggle span');
        if (activeYearEl) {
            result["TaxYear_Dropdown"] = activeYearEl.innerText.trim();
        }

        const elements = document.querySelectorAll('div.XojoContainer .XojoLabel');

        elements.forEach(el => {
            const text = el.innerText.trim();
            if (!text) return; 

            const topStyle = el.style.top;
            if(!topStyle) return;

            const topVal = parseInt(topStyle.replace('px', ''), 10);
            const leftVal = parseInt(el.style.left.replace('px', ''), 10);

            if (text.endsWith(':') || leftVal < 400) {
                labels.push({ text: text.replace(':', '').trim(), top: topVal });
            } else {
                values.push({ text: text, top: topVal });
            }
        });

        labels.forEach(label => {
            const matchingValue = values.find(val => Math.abs(val.top - label.top) <= 5);
            result[label.text] = matchingValue ? matchingValue.text : "N/A";
        });

        return result;
    });
}

// HUMAN-LIKE HISTORICAL DROPDOWN INTERACTION
async function processHistoricalTaxes(page, propertyRecord, currentYearStr) {
    const currentYear = parseInt(currentYearStr, 10);

    // Grab available text options from the DOM dropdown list
    const allYears = await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('.dropdown-menu .dropdown-item'));
        return items.map(item => item.innerText.trim()).filter(text => !isNaN(parseInt(text, 10)));
    });

    const olderYears = allYears
        .map(y => parseInt(y, 10))
        .filter(y => y < currentYear)
        .sort((a, b) => b - a)
        .map(String);

    if (olderYears.length === 0) {
        console.log("No previous years found in the dropdown.");
        return;
    }

    console.log(`Found older historical years to loop: ${olderYears.join(', ')}`);

    for (const year of olderYears) {
        console.log(`\n--- Simulating human interaction to choose year: ${year} ---`);

        // 1. Click dropdown button using Puppeteer's native execution
        const dropdownToggleSelector = 'button.dropdown-toggle';
        await page.waitForSelector(dropdownToggleSelector);
        await page.click(dropdownToggleSelector);
        await new Promise(r => setTimeout(r, 1200)); // Buffer time for dropdown menu visual transition

        // 2. Fetch the target list elements as Puppeteer ElementHandles
        const itemSelector = '.dropdown-menu .dropdown-item';
        const itemHandles = await page.$$(itemSelector);
        let yearMatchedAndClicked = false;

        for (const handle of itemHandles) {
            const innerText = await page.evaluate(el => el.innerText.trim(), handle);
            if (innerText === year) {
                // Hover over selection first, settle, then click like a real user
                await handle.hover();
                await new Promise(r => setTimeout(r, 600));
                await handle.click();
                yearMatchedAndClicked = true;
                break;
            }
        }

        if (!yearMatchedAndClicked) {
            console.log(`Warning: Couldn't target dropdown node for year ${year}`);
            continue;
        }

        console.log(`Fired trusted click event. Waiting for Xojo to sync year context...`);

        // 3. Track the dynamic switch inside the active dropdown button label text
        try {
            await page.waitForFunction((targetYear) => {
                const activeBtnSpan = document.querySelector('button.dropdown-toggle span');
                return activeBtnSpan && activeBtnSpan.innerText.trim() === targetYear;
            }, { timeout: 15000 }, year);
        } catch (e) {
            console.log(`Dropdown label tracking timed out for ${year}. Verifying state anyway...`);
        }

        // 4. Mimic clickFirstResultRow load delay. Gives Xojo engine time to paint new details
        await new Promise(r => setTimeout(r, 5000)); 

        // 5. Run extraction rules
        const historicalData = await extractXojoData(page);
        console.log(`Successfully extracted data labeled context year: ${historicalData["TaxYear_Dropdown"]}`);
        
        const balanceDueStr = historicalData["Taxes Balance Due"] || "$0.00";
        const balanceDueNum = parseCurrency(balanceDueStr);

        if (balanceDueNum > 0) {
            console.log(`[Back Tax Found] Year ${year} contains outstanding balance: ${balanceDueStr}`);
            
            const histTax = createTaxHistory();
            histTax.year = year;
            histTax.base_amount = historicalData["Taxes Charged"] || "$0.00";
            histTax.amount_due = balanceDueStr;
            
            histTax.amount_paid = "$0.00";
            histTax.payment_type = "Annual";
            histTax.status = "Delinquent";
            histTax.paid_date = "N/A";
            
            const yearNum = parseInt(year, 10);
            histTax.due_date = `11/30/${yearNum}`;
            histTax.delq_date = `12/01/${yearNum}`;

            propertyRecord.tax_history.push(histTax);
        } else {
            console.log(`Year ${year} balance clean (${balanceDueStr}). Dropping out of step.`);
        }
    }
}

async function run(accountNumber) {
    const { browser, page } = await launchBrowser();
    try {
        await page.goto("https://www.morgancountyutah.gov/", {
            waitUntil: "networkidle2",
            ...timeout_option,
        });

        const carouselWidgetSelector = '[id="1827084358"]';
        const taxRollSelector = 'a[href*="taxroll.cloudapput.com"]';
        await autoScrollToElement(page, carouselWidgetSelector);
        await page.waitForSelector(taxRollSelector); 
        await new Promise(r => setTimeout(r, 1500));
        
        const newTargetPromise = browser.waitForTarget(
            (target) => target.opener() === page.target()
        );
        
        await page.evaluate((selector) => {
            const links = Array.from(document.querySelectorAll(selector));
            const targetLink = links.find(el => el.textContent.toLowerCase().includes("view taxroll"));
            if (targetLink) targetLink.click();
            else if (links.length > 0) links[0].click(); 
        }, taxRollSelector);

        const newTarget = await newTargetPromise;
        const newPage = await newTarget.page();

        await newPage.bringToFront();
        await newPage.waitForNetworkIdle();
        
        const agreeBtnHandle = await newPage.waitForFunction(() => {
            const buttons = Array.from(document.querySelectorAll('button'));
            const targetBtn = buttons.find(btn => btn.textContent.trim() === 'I AGREE');
            return targetBtn || null;
        }, { timeout: 30000 });
        
        await newPage.evaluate(() => {
            const textarea = document.querySelector('textarea[name="wlDisclamerWords"]') || document.querySelector('textarea');
            if (textarea) {
                textarea.scrollTop = textarea.scrollHeight;
                textarea.dispatchEvent(new Event('scroll', { bubbles: true }));
            }
        });
        
        await new Promise(r => setTimeout(r, 1000));
        await agreeBtnHandle.click();

        await searchAccountNumber(newPage, accountNumber);
        await clickFirstResultRow(newPage);
        
        const extractedData = await extractXojoData(newPage);
        const finalPropertyRecord = populatePropertyData(extractedData);
        
        const backTaxFlag = extractedData["Back Tax Flag"] || "";
        if (backTaxFlag.includes("Back Taxes Owed")) {
            console.log("\n[!] 'Back Taxes Owed' flag triggered. Shifting to history processor...\n");
            const currentYearStr = finalPropertyRecord.tax_history[0].year;
            await processHistoricalTaxes(newPage, finalPropertyRecord, currentYearStr);
        }
        
        console.log("\n=== FINAL STRUCTURED DATA ===");
        console.log(JSON.stringify(finalPropertyRecord, null, 2));

    } catch (err) {
        console.log("Error during scraping execution: ", err);
    }
}

run("00-0003-3371");