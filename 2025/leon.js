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
        taxing_authority: "",
        notes: "",
        delinquent: "NONE",
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

async function searchAccountNumber(accountNumber, page) {
    const inputSelector = 'input[id$="txtAccount"]';
    const searchBtnSelector = 'input[id$="btnSearch"]';

    await page.waitForSelector(inputSelector, timeout_option);
    await page.type(inputSelector, accountNumber);

    await page.waitForSelector(searchBtnSelector, timeout_option);

    await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2", ...timeout_option }).catch(() => { }),
        page.click(searchBtnSelector)
    ]);
}

async function getDetails(page) {
    const ownerSelector = 'span[id$="lblItem2"]';

    await page.waitForSelector(ownerSelector, timeout_option);

    const propertyDetails = await page.evaluate(() => {
        const getText = (selector) => {
            const el = document.querySelector(selector);
            return el ? el.textContent.replace(/\s+/g, ' ').trim() : '';
        };

        const ownerName = getText('span[id$="lblItem2"]');
        const address = getText('span[id$="lblItem4"]');

        let status = '';
        const bTags = Array.from(document.querySelectorAll('b'));
        const statusBTag = bTags.find(b => b.textContent.trim() === 'Status');

        if (statusBTag) {
            const parentTd = statusBTag.closest('td');

            if (parentTd && parentTd.nextElementSibling) {
                // The status container has a nested table. We only want the text from the FIRST nested <td>
                const statusTd = parentTd.nextElementSibling.querySelector('td');

                if (statusTd) {
                    // Extracts just "CER SOLD" from the first nested cell
                    status = statusTd.textContent.replace(/\s+/g, ' ').trim();
                } else {
                    // Fallback just in case the HTML structure changes and there is no nested table
                    status = parentTd.nextElementSibling.textContent.replace(/\s+/g, ' ').trim();
                }
            }
        }

        return { ownerName, address, status };
    });

    console.log('Extracted Property Details:', propertyDetails);

    const accountLinkSelector = 'a[id$="lnkDetails1"]';
    const linkExists = await page.$(accountLinkSelector);
    let status = propertyDetails.status.toLowerCase();

    // Add a flag to let the main script know if we successfully navigated
    let navigated = false;

    if (linkExists) {
        if (status == "paid" || status == "cer sold") {
            await Promise.all([
                page.waitForNavigation({ waitUntil: 'networkidle2', ...timeout_option }),
                page.click(accountLinkSelector)
            ]);
            console.log('Successfully navigated to property summary page.');
            navigated = true;
        }
    } else {
        console.log('Detail link not found on search page.');
    }

    // Return the details along with our navigation flag
    return { ...propertyDetails, navigated };
}

async function getRecentYearTaxBill(page) {
    const tableSelector = 'table[id$="tblSummary"]';
    await page.waitForSelector(tableSelector, timeout_option);

    const { recentData, taxBillUrl } = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('table[id$="tblSummary"] tr.text'));
        if (rows.length === 0) return { recentData: null, taxBillUrl: null };

        // 1. Identify highest/most recent tax year
        let maxYear = -1;
        rows.forEach(row => {
            const cells = row.querySelectorAll('td');
            if (cells.length >= 4) {
                const yearNum = parseInt(cells[0].textContent.trim(), 10);
                if (!isNaN(yearNum) && yearNum > maxYear) {
                    maxYear = yearNum;
                }
            }
        });

        // 2. Collect all rows matching the most recent year
        const recentYearRows = rows.filter(row => {
            const yearNum = parseInt(row.querySelectorAll('td')[0]?.textContent.trim(), 10);
            return yearNum === maxYear;
        });

        if (recentYearRows.length === 0) return { recentData: null, taxBillUrl: null };

        // 3. Find regular roll row and certificate roll row (if CER SOLD)
        const regularRow = recentYearRows.find(row => row.querySelectorAll('td')[1]?.textContent.trim() === 'R') || recentYearRows[0];
        const certRow = recentYearRows.find(row => row.querySelectorAll('td')[1]?.textContent.trim() === 'CER');

        const regCells = regularRow.querySelectorAll('td');
        const statusText = regCells[3]?.textContent.trim() || '';
        const isCerSold = statusText.toUpperCase() === 'CER SOLD';

        let certDetails = null;
        if (certRow) {
            const cCells = certRow.querySelectorAll('td');
            certDetails = {
                certAccount: cCells[2]?.textContent.trim(),
                certStatus: cCells[3]?.textContent.trim(),
                datePaid: cCells[4]?.textContent.trim(),
                amountPaid: cCells[5]?.textContent.trim(),
                balanceDue: cCells[6]?.textContent.trim()
            };
        }

        const recentData = {
            year: maxYear,
            roll: regCells[1]?.textContent.trim(),
            accountNumber: regCells[2]?.textContent.trim(),
            status: statusText,
            isCerSold: isCerSold,
            datePaid: regCells[4]?.textContent.trim(),
            amountPaid: regCells[5]?.textContent.trim(),
            balanceDue: regCells[6]?.textContent.trim(),
            certificateInfo: certDetails
        };

        // 4. Safely extract bill link URL targeting the PropertyAcctBill anchor tag
        const billAnchor = regularRow.querySelector('a[href*="PropertyAcctBill.aspx"]') || regularRow.querySelector('a.label');
        const taxBillUrl = billAnchor ? billAnchor.href : null;

        return { recentData, taxBillUrl };
    });

    console.log('Most Recent Year Data:', recentData);

    if (recentData?.isCerSold) {
        console.warn(`[NOTICE] Status is CER SOLD for tax year ${recentData.year}.`);
        if (recentData.certificateInfo) {
            console.log(`[CERTIFICATE DETAILS] Status: ${recentData.certificateInfo.certStatus} | Balance Due: ${recentData.certificateInfo.balanceDue}`);
        }
    }

    if (taxBillUrl) {
        console.log('Navigating to Tax Bill page:', taxBillUrl);
        await page.goto(taxBillUrl, { waitUntil: 'networkidle2', ...timeout_option });
        console.log('Successfully opened the Tax Bill.');
    } else {
        console.log('Tax Bill link not found for the recent year.');
    }

    return recentData;
}

async function parseTaxBillPage(page) {
    await page.waitForSelector('span[id$="lblTAssessedValue"]', timeout_option);

    const extractedData = await page.evaluate(() => {
        const cleanText = (str) => (str ? str.replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim() : '');

        // Extract Assessed Value and Taxable Value
        const assessedValueEl = document.querySelector('span[id$="lblTAssessedValue"]');
        const taxableValueEl = document.querySelector('span[id$="lblTTaxableValue"]');

        const assessedValue = cleanText(assessedValueEl?.textContent);
        const taxableValue = cleanText(taxableValueEl?.textContent);

        // Extract Base Tax from Table3
        let baseTax = '';
        const table3 = document.querySelector('table[id$="Table3"]');

        if (table3) {
            const tableText = table3.innerText || table3.textContent;
            const combinedMatch = tableText.match(/COMBINED\s+TAXES\s+&\s+ASSESSMENTS\s+TOTAL:\s*([\d,.]+)/i);

            if (combinedMatch) {
                baseTax = combinedMatch[1];
            } else {
                const adValoremMatch = tableText.match(/\d+\.\d{5}\s+([\d,.]+)/);
                if (adValoremMatch) {
                    baseTax = adValoremMatch[1];
                }
            }
        }

        let paidDate = null;
        const cells = document.querySelectorAll('#Table8 .PropBillText');
        const dateRegex = /\b(\d{2}\/\d{2}\/\d{2})\b/;
        for (const cell of cells) {
            const text = cell.textContent;
            const match = text.match(dateRegex);

            // If a match is found and it includes the "PERIOD" context (optional, but makes it safer)
            if (match && text.includes('PERIOD')) {
                paidDate = match[1]; // Return the captured date string
            }
        }

        return { assessedValue, taxableValue, baseTax, paidDate };
    });

    console.log("Extracted Tax Bill Values:", extractedData);
    return extractedData;
}

async function populateTheObject(data, page) {
    const result = createPropertyObject();
    result.owner_name.push(data.ownerName);
    result.property_address = data.address;
    result.total_taxable_value = `$${data.taxableValue}.00`;
    result.total_assessed_value = `$${data.assessedValue}.00`;

    const record = createTaxHistory();
    record.year = data.year;
    record.due_date = `03/31/${record.year}`;
    record.delq_date = `04/01/${record.year}`;
    if (data.isCerSold === true) {
        record.base_amount = `$${data.baseTax}`;
        record.amount_due = `$${data.certificateInfo["balanceDue"]}`;
        record.amount_paid = "$0.00";
        const today = new Date();
        const dueDateObj = new Date(record.due_date);
        if (today <= dueDateObj) {
            record.status = "Due";
        } else {
            record.status = "Delinquent";
        }
    } else {
        record.base_amount = `$${data.baseTax}`;
        record.amount_paid = `$${data.amountPaid}`;
        record.paid_date = data.paidDate;
        record.status = "Paid";
    }

    result.tax_history.push(record);
    console.log("Result: ", result);
    return result;
}

async function run(accountNumber) {
    let browser;
    try {
        const instance = await launchBrowser();
        browser = instance.browser;
        const page = instance.page;

        await page.goto(
            "https://www.mariontax.com/itm/PropertySearchAccount.aspx",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        // Accept agreement terms if present
        const agreeBtn = await page.$('#btnAgree');
        if (agreeBtn) {
            await Promise.all([
                page.waitForNavigation({ waitUntil: "networkidle2", ...timeout_option }).catch(() => { }),
                page.click('#btnAgree')
            ]);
        }

        await searchAccountNumber(accountNumber, page);
        const searchError = await page.evaluate(() => {
            const msgEl = document.querySelector('span[id$="lblMessage"]');
            return msgEl ? msgEl.textContent : '';
        });

        if (searchError && searchError.includes('NOT MATCHED EXACTLY')) {
            console.log(`No data for this account number (${accountNumber}) is available.`);
            return null;
        }

        const propertyDetails = await getDetails(page);

        // Handle scenario where status is not "paid" or "cer sold"
        if (!propertyDetails.navigated) {
            console.log(`Status is "${propertyDetails.status}". Returning partial result early.`);
            const partialResult = createPropertyObject();
            if (propertyDetails.ownerName) partialResult.owner_name.push(propertyDetails.ownerName);
            partialResult.property_address = propertyDetails.address || "";

            console.log("Final Partial Result: ", partialResult);
            // return partialResult; // Early exit mapping only owner and address
        }

        const recentSummary = await getRecentYearTaxBill(page);
        const billDetails = await parseTaxBillPage(page);

        const finalOutput = {
            ...propertyDetails,
            ...recentSummary,
            ...billDetails
        };

        console.log("The final combined output: ", finalOutput);
        const finalPopulatedObj = await populateTheObject(finalOutput, page);
        console.log("Full result: ", finalPopulatedObj);
        // return finalPopulatedObj;

    } catch (err) {
        console.error("Error during execution pipeline: ", err);
    } finally {
        if (browser) await browser.close();
    }
}

run("P35369-00-259");