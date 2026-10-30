import puppeteer from "puppeteer";

const timeout_option = {
    timeout: 90000,
};

function createPropertyObject() {
    return {
        processed_date: new Date().toLocaleDateString("en-US", { padding: "2-digit" }),
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
        paid_date: "N/A",
        good_through_date: "-",
    };
}

function formatToUSADate(dateInput) {
    const strInput = String(dateInput || "");
    if (!strInput || strInput.toUpperCase() === "N/A") return "N/A";
    const d = new Date(strInput);
    if (isNaN(d.getTime())) return strInput;
    const month = (d.getMonth() + 1).toString().padStart(2, '0');
    const day = d.getDate().toString().padStart(2, '0');
    const year = d.getFullYear();
    return `${month}/${day}/${year}`;
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
    const searchIdSelector = "#mParcelID2";
    await page.waitForSelector(searchIdSelector);
    await page.type(searchIdSelector, accountNumber);

    const searchButtonSelector = "#mSubmit";
    await page.waitForSelector(searchButtonSelector);
    await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2" }),
        page.click(searchButtonSelector)
    ]);
}

async function searchOwnerName(page) {
    const addressSelector = "#mSitusAddress";
    await page.waitForSelector(addressSelector);
    
    const address = await page.$eval(addressSelector, el => 
        el.textContent.replace(/\s+/g, ' ').replace(/\s+,\s*/g, ', ').trim()
    );

    const parts = address.split(",").map(part => part.trim());
    const [street, city, stateZip] = parts;
    const stateZipMatch = stateZip ? stateZip.match(/([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/) : null;

    await page.goto("https://public.co.wasco.or.us/webtax/(S(hlozrpl1phz0kiqhkr5tvizw))/default.aspx", { waitUntil: "networkidle2" });

    const streetSelector = "#mStreetAddress";
    await page.waitForSelector(streetSelector);
    await page.type(streetSelector, street);

    const citySelector = "#mCity";
    await page.waitForSelector(citySelector);
    await page.type(citySelector, city);

    const stateSelector = "#mStateProvince";
    await page.waitForSelector(stateSelector);
    await page.type(stateSelector, stateZipMatch ? stateZipMatch[1] : "");

    const zipSelector = "#mPostalCode";
    await page.waitForSelector(zipSelector);
    await page.type(zipSelector, stateZipMatch ? stateZipMatch[2] : "");

    const searchButtonSelector = "#mSubmit";
    await page.waitForSelector(searchButtonSelector);
    await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2" }),
        page.click(searchButtonSelector)
    ]);

    const nameSelector = "#mGrid tr:nth-child(2) td:nth-child(2)";
    await page.waitForSelector(nameSelector);
    const ownerName = await page.$eval(nameSelector, el => el.textContent.trim());

    const linkSelector = "#mGrid tr:nth-child(2) td:nth-child(1) a";
    await page.waitForSelector(linkSelector);
    await Promise.all([
        page.waitForNavigation({ waitUntil: "networkidle2" }),
        page.click(linkSelector)
    ]);

    return { ownerName, address };
}

async function parseMainPage(page, result, accountNumber) {
    
    const getValueByLabel = async (label) => {
        // td[1] is the label, td[2] is the first column of data
        const xpath = `//table[@id='mPropertyValues']//tr[td[contains(., '${label}')]]/td[2]`;
        const value = await page.evaluate((xpathStr) => {
            const res = document.evaluate(
                xpathStr, 
                document, 
                null, 
                XPathResult.FIRST_ORDERED_NODE_TYPE, 
                null
            );
            const element = res.singleNodeValue;
            return element ? element.textContent.trim() : null;
        }, xpath);
        return (value && value.length > 0) ? value : "N/A";
    };

    result.total_assessed_value = await getValueByLabel("Assessed Value Regular (AVR)");
    result.total_taxable_value = await getValueByLabel("Taxable Value Regular (TVR)");

    // 2. Parse Tax Balance
    let balanceYearStr = null;
    const taxBalanceExists = await page.$("#mTaxChargesBalancePayment");
    if (taxBalanceExists) {
        const balanceData = await page.$eval("#mTaxChargesBalancePayment tr:not(.DataGridTitle)", row => {
            const cells = row.querySelectorAll("td");
            if (cells.length >= 7) {
                return {
                    year: cells[0].textContent.trim(),
                    dueDate: cells[2].textContent.trim(),
                    principal: cells[3].textContent.trim(),
                    totalDue: cells[6].textContent.trim()
                };
            }
            return null;
        }).catch(() => null);

        if (balanceData && balanceData.year) {
            balanceYearStr = balanceData.year;
            const taxRecord = createTaxHistory();
            taxRecord.year = balanceData.year;
            taxRecord.payment_type = "Installment"; // Default for active balance
            taxRecord.due_date = formatToUSADate(balanceData.dueDate);
            taxRecord.base_amount = balanceData.principal;
            taxRecord.amount_due = balanceData.totalDue;
            taxRecord.amount_paid = "$0.00";
            taxRecord.paid_date = "N/A"; 
            
            if (balanceData.dueDate) {
                const d = new Date(balanceData.dueDate);
                if (!isNaN(d.getTime())) {
                    d.setDate(d.getDate() + 1);
                    taxRecord.delq_date = formatToUSADate(d);
                }
            }

            const today = new Date();
            today.setHours(0, 0, 0, 0);
            const targetDue = new Date(taxRecord.due_date);
            const targetDelq = new Date(taxRecord.delq_date);

            if (today >= targetDelq) {
                taxRecord.status = "Delinquent";
            } else if (today <= targetDue) {
                taxRecord.status = "Due";
            } else {
                taxRecord.status = "Due"; 
            }
            result.tax_history.push(taxRecord);
        }
    }

    // 3. Setup Receipts Parsing
    let rawReceipts = await page.$$eval("#mReceipts tr:not(.DataGridTitle)", rows => {
        return rows.map(row => {
            const cells = row.querySelectorAll("td");
            if (cells.length >= 3) {
                const linkEl = cells[1] ? cells[1].querySelector("a") : null;
                const rawDateText = cells[0] ? cells[0].textContent.trim() : "";
                const chargeText = cells[2] ? cells[2].textContent.trim() : "";
                
                let rowYear = "";
                const dateMatch = rawDateText.match(/\d{4}/);
                if (dateMatch) rowYear = dateMatch[0];

                return {
                    url: linkEl ? linkEl.href : null,
                    paidDateAndTime: rawDateText, 
                    chargeAmount: chargeText,
                    year: rowYear
                };
            }
            return null;
        }).filter(item => item && item.url);
    });

    let filteredReceipts = [];
    if (balanceYearStr) {
        filteredReceipts = rawReceipts.filter(item => item.year === balanceYearStr);
    } else {
        const validReceipts = rawReceipts.filter(item => item.chargeAmount !== "$0.00");
        if (validReceipts.length > 0) {
            // Sort to ensure we get the most recent valid year row
            validReceipts.sort((a, b) => parseInt(b.year || 0) - parseInt(a.year || 0));
            filteredReceipts = [validReceipts[0]]; 
        }
    }

    let dynamicPaymentType = "Installment";
    if (filteredReceipts.length > 0) {
        const targetYear = filteredReceipts[0].year;
        const totalReceiptsForYear = rawReceipts.filter(item => item.year === targetYear).length;
        dynamicPaymentType = totalReceiptsForYear > 1 ? "Installment" : "Annual";
    }

    for (const receiptItem of filteredReceipts) {
        try {
            await page.goto(receiptItem.url, { waitUntil: "networkidle2", ...timeout_option });
            
            const receiptData = await page.evaluate(() => {
                let parsed = { year: "", baseAmount: "", paidAmount: "", parcelNo: "" };
                
                // standard WebTax layout: td[0]=Account No, td[1]=Year, td[3]=Base Amount
                const gridRow = document.querySelector("#mGrid tr:nth-child(2)");
                if (gridRow) {
                    const cells = gridRow.querySelectorAll("td");
                    if (cells.length >= 4) {
                        parsed.parcelNo = cells[0] ? cells[0].textContent.trim() : "";
                        parsed.year = cells[1] ? cells[1].textContent.trim() : "";
                        parsed.baseAmount = cells[3] ? cells[3].textContent.trim() : "";
                    }
                }

                const payerRow = document.querySelector("#mReceiptPayers tr:nth-child(2)");
                if (payerRow) {
                    const cells = payerRow.querySelectorAll("td");
                    if (cells.length >= 3) {
                        parsed.paidAmount = cells[2].textContent.trim();
                    }
                }
                
                return parsed;
            });

            // Validation Checks - Using .includes() to safely catch standard formatting
            const isParcelMatch = receiptData.parcelNo === accountNumber || receiptData.parcelNo.includes(accountNumber);
            const isYearMatch = balanceYearStr ? (receiptData.year === balanceYearStr) : true;

            if (isParcelMatch && isYearMatch && (receiptData.year || receiptData.baseAmount || receiptData.paidAmount)) {
                const taxRecord = createTaxHistory();
                taxRecord.year = receiptData.year;
                taxRecord.payment_type = dynamicPaymentType;
                taxRecord.base_amount = receiptData.baseAmount;
                taxRecord.amount_paid = receiptData.paidAmount;
                taxRecord.amount_due = "$0.00"; 
                taxRecord.status = "Paid";
                taxRecord.paid_date = formatToUSADate(receiptItem.paidDateAndTime);
                
                if (taxRecord.year) {
                    taxRecord.due_date = `11/15/${taxRecord.year}`;
                    taxRecord.delq_date = `11/16/${taxRecord.year}`;
                }

                result.tax_history.push(taxRecord);
            }
        } catch (err) {
            console.log(`Failed to process receipt URL: ${receiptItem.url} - Error:`, err.message);
        }
    }
}

async function run(accountNumber) {
    const { browser, page } = await launchBrowser();
    const result = createPropertyObject();
    result.parcel_number = accountNumber;
    
    try {
        await page.goto(
            "https://public.co.wasco.or.us/webtax/(S(hlozrpl1phz0kiqhkr5tvizw))/default.aspx",
            {
                waitUntil: "networkidle2",
                ...timeout_option,
            },
        );

        await searchAccountNumber(page, accountNumber);
        const { ownerName, address } = await searchOwnerName(page);
        result.owner_name = ownerName;
        result.property_address = address;

        // Passed accountNumber here for the new receipt validations
        await parseMainPage(page, result, accountNumber);
        
        console.log(JSON.stringify(result, null, 2));

    } catch (err) {
        console.log("Error during running: ", err);
    } finally {
        await browser.close();
    }
}

run("18296");