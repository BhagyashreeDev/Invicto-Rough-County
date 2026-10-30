
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
        total_assessed_value: "N/A",
        exemption: "",
        total_taxable_value: "N/A",
        delinquent: "NONE",
        taxing_authority: "Kootenai County Treasurer, 451 Government Way, Coeur d'Alene, ID 83814",
        notes: "",
        tax_history: []
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
        good_through_date: "-",
    };
}

const generate_notes = (year, keys, status1, status2) => {
    let notes = "";
    try {
        notes =
            keys === 1
                ? `ALL PRIORS ARE PAID,`
                : `PRIORS ARE DELINQUENT,`;
        notes += ` ${year} 1ST INSTALLMENT IS ${status1.toUpperCase()}, 2ND INSTALLMENT IS ${status2.toUpperCase()},`;
        notes += ` NORMALLY TAXES ARE PAID SEMI-ANNUALLY,`;
        notes += ` NORMAL DUE DATES ARE 12/20 AND 06/20`;
    } catch (error) {
        console.log(error);
    } finally {
        return notes;
    }
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

async function extractEighthRowAssessedValue(page) {
    const tableSelector = "table[aria-label*='view.group.data.table.label']";
    await page.waitForSelector(tableSelector, { visible: true });

    const taxableValue = await page.evaluate((selector) => {
        const table = document.querySelector(selector);
        if (!table) return null;

        // Get all rows in the tbody
        const rows = table.querySelectorAll("tbody tr");

        // Ensure the 8th row exists (index 7)
        if (rows.length > 8) {
            const eighthRow = rows[8];
            const cells = eighthRow.querySelectorAll("td");

            // Index 2 corresponds to "Taxable Value" based on the headers order
            if (cells.length >= 3) {
                return cells[2].textContent.trim();

            }
        }
        return null;
    }, tableSelector);
    return taxableValue;
}

async function searchAccountNumber(accountNumber, page) {
    await page.waitForSelector("#dnn_ctr449_ContentPane", { visible: true });
    const searchBtnSelector = "button[title='Search Options']";
    await page.waitForSelector(searchBtnSelector, { visible: true });
    await page.click(searchBtnSelector, { clickCount: 1 });

    const pinInputSelector = "input[name='ParcelID']";
    await page.waitForSelector(pinInputSelector, { visible: true });
    await page.click(pinInputSelector, { visible: true });
    await page.keyboard.press('Backspace');
    await page.type(pinInputSelector, accountNumber);

    const executeSearchBtnSelector = "button[title='Search']";
    await page.waitForSelector(`${executeSearchBtnSelector}:not([disabled])`, { visible: true });

    // 5. Click the search button to submit
    await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.click(executeSearchBtnSelector)
    ]);

    const resultLinkSelector = `a[title='View Account ${accountNumber}']`;
    await page.waitForSelector(resultLinkSelector, { visible: true }, timeout_option);
    const fetchedUrl = await page.evaluate((selector) => {
        return document.querySelector(selector).getAttribute('href');
    }, resultLinkSelector);

    const currentUrl = page.url();
    const splitUrl = currentUrl.split('/Treasurer')[0];

    const targetUrl = `${splitUrl}${fetchedUrl}`;
    await page.goto(targetUrl, { waitUntil: "networkidle2" });
}

async function fetchDetails(page) {
    await page.waitForSelector("#dnn_ctr584_ModuleContent", { visible: true });

    const details = await page.evaluate(() => {
        let owner = "";
        let address = "";
        const dlElements = document.querySelectorAll("div[aria-label='Account summary information'] dl");
        dlElements.forEach(dl => {
            const dt = dl.querySelector("dt");
            const dd = dl.querySelector("dd");
            if (dt && dd) {
                const label = dt.textContent.trim();
                const value = dd.textContent.trim();
                if (label.includes("Owner:")) {
                    owner = value;
                }
                if (label.includes("Property Address:")) {
                    address = value;
                }
            }
        });
        return { owner, address };
    });

    await page.waitForSelector("#dnn_ctr464_ModuleContent", { visible: true });
    const due = await page.evaluate(() => {
        const spanElement = document.querySelector(".grand-total-bill-amount");
        return spanElement ? spanElement.textContent.trim() : null;
    });

    let numericDue = 0;
    if (due) numericDue = parseFloat(due.replace(/[\$,]/g, ''));
    let installments = [];
    let rowsData = [];
    let assessedValue = null;

    // --- INTEGRATED LOGIC: If due is > 0, expand the specific card and extract table data ---
    if (numericDue > 0) {
        try {

            const buttonSelector = "button[aria-label='Taxing District Charge Breakdown']";

            // Wait for it to be visible and click it
            await page.waitForSelector(buttonSelector, { visible: true });
            await Promise.all([
                page.waitForNavigation({ waitUntil: "domcontentloaded" }),
                page.click(buttonSelector)
            ]);

            assessedValue = await extractEighthRowAssessedValue(page);

            await page.goBack();

            const expandBtnSelector = 'payment-bill-group button.card.red-expand';
            const expandBtn = await page.$(expandBtnSelector);

            if (expandBtn) {
                await expandBtn.click();
                await page.waitForSelector('payment-bill-grid table tbody tr', { visible: true, timeout: 5000 });

                // Replace it with this:
                await page.evaluate(() => {
                    const btns = document.querySelectorAll("payment-bill-grid table tbody button.expandable-header");
                    btns.forEach(btn => {
                        // Check aria-expanded to ensure we don't accidentally close an already open tab
                        if (btn.getAttribute('aria-expanded') !== 'true') {
                            btn.click();
                        }
                    });
                });

                // Give the DOM and Angular a moment to render all the inner tables simultaneously
                await new Promise(resolve => setTimeout(resolve, 1500));

                installments = await page.evaluate(() => {
                    try {
                        const rows = document.querySelectorAll("payment-bill-grid table tbody tr");
                        const results = [];

                        const titleYearEl = document.querySelector('payment-bill-group button.card.red-expand .tile-header__value');
                        const billYear = titleYearEl ? titleYearEl.textContent.trim() : "";

                        rows.forEach(row => {
                            const cells = row.querySelectorAll("td");
                            if (cells.length >= 6) {
                                let baseTax = "";
                                const totalCell = cells[3];

                                if (totalCell) {
                                    const totalValueElements = totalCell.querySelectorAll(".total-values");
                                    totalValueElements.forEach(el => {
                                        if (el.textContent.includes("Tax:")) {
                                            const currencySpan = el.querySelector(".total-values__currency");
                                            if (currencySpan) {
                                                baseTax = currencySpan.textContent.trim();
                                            }
                                        }
                                    });
                                }

                                results.push({
                                    year: billYear,
                                    status: cells[0].textContent.replace('●', '').trim(),
                                    installment: cells[1].textContent.trim(),
                                    dueDate: cells[2].textContent.trim(),
                                    baseTax: baseTax,
                                    paidAmount: cells[4].textContent.trim(),
                                    owed: cells[5].textContent.trim()
                                });
                            }
                        });
                        return results;
                    } catch (err) {
                        return [{ error: err.toString() }]; // Catch errors inside evaluate and return them
                    }
                });
            }


            if (installments.length === 1 && !installments[0].error) {
                rowsData = await page.evaluate(() => {
                    const rows = document.querySelectorAll("table[aria-label*='view.group.data.table.label'] tbody tr");
                    const results = [];
                    if (rows.length > 0) {
                        const cells = rows[0].querySelectorAll("td");
                        if (cells.length >= 6) {
                            results.push({
                                year: cells[0].textContent.trim(),
                                paidDate: cells[2].textContent.trim(),
                                paidAmount: cells[5].textContent.trim()
                            });
                        }
                    }
                    return results;
                });
            }

        } catch (e) {
            console.error("Error expanding delinquent tables:", e);
        }
    } else {
        await page.waitForSelector("#dnn_ctr607_ModuleContent", { visible: true });
        rowsData = await page.evaluate(() => {
            const rows = document.querySelectorAll("table[aria-label*='view.group.data.table.label'] tbody tr");
            const results = [];
            const limit = Math.min(rows.length, 2);
            for (let i = 0; i < limit; i++) {
                const cells = rows[i].querySelectorAll("td");
                if (cells.length >= 6) {
                    results.push({
                        year: cells[0].textContent.trim(),
                        paidDate: cells[2].textContent.trim(),
                        paidAmount: cells[5].textContent.trim()
                    });
                }
            }
            return results;
        });

        const taxYearSelector = `span.thumbnail[title="Tax Year - ${rowsData[0].year}"]`;
        await page.waitForSelector(taxYearSelector, { visible: true });
        await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded" }),
            page.click(taxYearSelector)
        ]);

        await page.waitForSelector("#dnn_ctr468_ModuleContent", { visible: true });
        assessedValue = await extractEighthRowAssessedValue(page);
    }

    return { details, due, rowsData, assessedValue, installments, numericDue };
}

async function populateTheObject(details, due, rowsData, assessedValue, installments, numericDue) {
    const result = createPropertyObject();
    result.owner_name.push(details.owner);
    result.property_address = details.address;
    result.total_assessed_value = assessedValue;
    result.total_taxable_value = assessedValue;

    if (numericDue > 0 && installments.length > 0) {
        installments.forEach((inst) => {
            const record = createTaxHistory();
            record.year = inst.year;
            record.base_amount = inst.baseTax;
            record.amount_paid = inst.paidAmount;
            record.amount_due = inst.owed;
            const [month, day, year] = inst.dueDate.split("/");
            record.due_date = `${month.padStart(2, '0')}/${day.padStart(2, '0')}/20${year}`;

            const dueDate = new Date(inst.dueDate);
            dueDate.setDate(dueDate.getDate() + 1);
            const monthDel = String(dueDate.getMonth() + 1).padStart(2, '0');
            const dayDel = String(dueDate.getDate()).padStart(2, '0');
            const yearDel = dueDate.getFullYear();
            record.delq_date = `${monthDel}/${dayDel}/${yearDel}`;

            if (String(inst.installment) === "1") {
                record.payment_type = "Installment 1";
            }
            else record.payment_type = "Installment 2";

            const today = new Date();
            const dueDateObj = new Date(record.due_date);

            if (today <= dueDateObj) {
                record.status = "Due";
            } else {
                record.status = "Delinquent";
            }
            result.tax_history.push(record);
        });

        // 2. NEW: Process the Paid Installment if 1 is due and 1 is paid for the same year
        if (installments.length === 1 && rowsData && rowsData.length > 0) {
            const dueInst = installments[0];
            const paidRow = rowsData[0];

            if (dueInst.year === paidRow.year) {
                const record = createTaxHistory();
                record.year = paidRow.year;
                record.status = "Paid";
                record.base_amount = paidRow.paidAmount;
                record.amount_paid = paidRow.paidAmount;
                record.amount_due = "$0.00";

                // Format paid date correctly if needed, assuming MM/DD/YYYY from rowsData
                const [pMonth, pDay, pYear] = paidRow.paidDate.split("/");
                record.paid_date = `${pMonth.padStart(2, '0')}/${pDay.padStart(2, '0')}/20${pYear}`;

                // Deduce which installment was paid
                let paidInstNum = "1";
                if (String(dueInst.installment).includes("1")) {
                    paidInstNum = "2";
                }

                const yearInt = parseInt(record.year);
                record.payment_type = `Installment ${paidInstNum}`;
                record.due_date = paidInstNum === "1" ? `12/20/${yearInt}` : `06/20/${yearInt + 1}`;
                record.delq_date = paidInstNum === "1" ? `12/21/${yearInt}` : `06/21/${yearInt + 1}`;

                result.tax_history.push(record);
            }
        }

    } else {
        if (rowsData.length > 0) {
            const firstRow = rowsData[0];
            const secondRow = rowsData.length > 1 ? rowsData[1] : null;

            if (secondRow && firstRow.year === secondRow.year) {
                const sortedRows = [...rowsData].sort((a, b) => new Date(a.paidDate) - new Date(b.paidDate));
                sortedRows.forEach((row, index) => {
                    const record = createTaxHistory();
                    record.year = row.year;
                    record.status = "Paid";
                    record.base_amount = row.paidAmount;
                    record.amount_paid = row.paidAmount;
                    record.amount_due = due;
                    const [pMonth, pDay, pYear] = row.paidDate.split("/");
                    record.paid_date = `${pMonth.padStart(2, '0')}/${pDay.padStart(2, '0')}/20${pYear}`;
        
                    const yearInt = parseInt(record.year);
                    record.due_date = index === 0 ? `12/20/${yearInt}` : `06/20/${yearInt + 1}`;
                    record.delq_date = index === 0 ? `12/21/${yearInt}` : `06/21/${yearInt + 1}`;
                    if (index === 0) record.payment_type = "Installment 1";
                    else record.payment_type = "Installment 2";
                    result.tax_history.push(record);
                });
            } else {
                const yearInt = parseInt(firstRow.year);
                const rawAmount = parseFloat(firstRow.paidAmount.replace(/[\$,]/g, '')) || 0;
                const halfAmount = (rawAmount / 2).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

                const record1 = createTaxHistory();
                record1.year = firstRow.year;
                record1.status = "Paid";
                record1.base_amount = halfAmount;
                record1.amount_paid = halfAmount;
                record1.amount_due = due;
                const [month1, day1, year1] = firstRow.paidDate.split("/");
                record1.paid_date = `${month1}/${day1}/20${year1}`;
                record1.payment_type = "Installment 1";
                record1.due_date = `12/20/${yearInt}`;
                record1.delq_date = `12/21/${yearInt}`;
                result.tax_history.push(record1);

                const record2 = createTaxHistory();
                record2.year = firstRow.year;
                record2.status = "Paid";
                record2.base_amount = halfAmount;
                record2.amount_paid = halfAmount;
                record2.amount_due = due;
                const [month2, day2, year2] = firstRow.paidDate.split("/");
                record2.paid_date = `${month2}/${day2}/20${year2}`;
                record2.paid_date = firstRow.paidDate;
                record2.payment_type = "Installment 2";
                record2.due_date = `06/20/${yearInt + 1}`;
                record2.delq_date = `06/21/${yearInt + 1}`;
                result.tax_history.push(record2);
            }
        }
    }

    result.tax_history.sort((a, b) => {
        const yearA = parseInt(a.year, 10) || 0;
        const yearB = parseInt(b.year, 10) || 0;
        if (yearA !== yearB) {
            return yearA - yearB;
        }
        if (a.status === "Paid" && b.status !== "Paid") return -1;
        if (a.status !== "Paid" && b.status === "Paid") return 1;
        return 0;
    });

    if (result.tax_history.length > 0) {
        // Check if ANY tax is delinquent for the main delinquency flag
        const hasDelinquent = result.tax_history.some(
            (t) => t.status === "Delinquent",
        );
        result.delinquent = hasDelinquent
            ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
            : "NONE";

        // Get the latest tax record (the array is sorted ascending by year)
        const latestTax = result.tax_history[result.tax_history.length - 1];

        // Find individual statuses for the 1st and 2nd installments of the latest year
        const latestYearRecords = result.tax_history.filter(t => String(t.year) === String(latestTax.year));
        const inst1 = latestYearRecords.find(t => t.payment_type === "Installment 1");
        const inst2 = latestYearRecords.find(t => t.payment_type === "Installment 2");

        const status1 = inst1 ? inst1.status : "UNKNOWN";
        const status2 = inst2 ? inst2.status : "UNKNOWN";

        // Check if any PRIOR year is delinquent (exclude the latest year)
        const hasPriorDelinquent = result.tax_history.some(
            (t) => t.status === "Delinquent" && String(t.year) !== String(latestTax.year)
        );

        // If priors are delinquent, keys = 0. If priors are paid, keys = 1.
        const keys = hasPriorDelinquent ? 0 : 1;
        result.notes = generate_notes(latestTax.year, keys, status1, status2);
    }

    return result;
}

async function run(accountNumber) {

    try {
        const { browser, page } = await launchBrowser();


        await page.goto(
            "https://id-kootenai.publicaccessnow.com/Treasurer/TaxSearch.aspx",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);

        const { details, due, rowsData, assessedValue, installments, numericDue } = await fetchDetails(page);
        const result = await populateTheObject(details, due, rowsData, assessedValue, installments, numericDue);
        result.parcel_number = accountNumber;

        console.log(result);

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("002090030020");