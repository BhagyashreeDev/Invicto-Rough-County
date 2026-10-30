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
        taxing_authority: "Payette County Treasurer, 1130 3rd Avenue North, Payette, ID 83661",
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

async function searchAccountNumber(accountNumber, page) {
    const url = `https://id-payette.publicaccessnow.com/Treasurer/TaxSearch.aspx?s=ParcelID:${accountNumber.split(" ")[0].trim()}&pg=1&g=1&moduleId=449`;
    await page.goto(url, { waitUntil: "networkidle2", ...timeout_option });

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
    // details
    await page.waitForSelector("#dnn_ctr462_ModuleContent", { visible: true });
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
                if (label.includes("Property Owner(s):")) {
                    owner = value;
                }
                if (label.includes("Property Address:")) {
                    address = value;
                }
            }
        });
        return { owner, address };
    });
    console.log("Details: ", details);

    // due
    let installments = [];
    await page.waitForSelector("#dnn_ctr464_ModuleContent", timeout_option);
    const dueSelector = "#dnn_ctr464_ModuleContent .grand-total-bill-amount.bill-header__total-amount";
    const dueElement = await page.$(dueSelector);

    if (dueElement) {

        
        installments = await page.evaluate(() => {
            // Select all the main bill section containers
            const billContainers = document.querySelectorAll("div.mb-4.collapse.show");
            const allBills = []; // This will hold our flattened results or grouped objects

            billContainers.forEach((container) => {
                // 1. Extract Tax Year from the header card
                const tileValues = container.querySelectorAll(".tile-header__value");
                let taxYear = "";

                tileValues.forEach((el) => {
                    const text = el.textContent.trim();
                    if (/^\d{4}$/.test(text)) {
                        taxYear = text; // Matches 4-digit year (e.g., 2023)
                    }
                });

                // 2. Extract Installment rows from the table
                const rows = container.querySelectorAll("table tbody tr");

                rows.forEach((row) => {
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

                        // Push directly to allBills so it gets returned correctly
                        allBills.push({
                            year: taxYear,
                            status: cells[0].textContent.replace('●', '').trim(),
                            installmentNumber: cells[1].textContent.trim(),
                            dueDate: cells[2].textContent.trim(),
                            baseTax: baseTax,
                            paidAmount: cells[4].textContent.trim(),
                            owed: cells[5].textContent.trim()
                        });
                    }
                });
            });

            return allBills; // Fixed: returning the populated array
        });

        console.log("Extracted Bills and Installments: ", installments);
    }

    // paid records
    let paidData = [];
    await page.waitForSelector("#dnn_ctr592_ContentPane", timeout_option);

    const paidTableSelector = "#dnn_ctr592_ModuleContent table[aria-label='view.group.data.table.label 1']";
    const paidTableElement = await page.$(paidTableSelector);

    if (paidTableElement) {
        const historyRowSelector = `${paidTableSelector} tbody tr`;
        await page.waitForSelector(historyRowSelector, { visible: true, timeout: 10000 });

        paidData = await page.evaluate((selector) => {
            const rows = document.querySelectorAll(selector);
            const results = [];
            // Safely loop up to 2 times, or less if there are fewer rows
            const limit = Math.min(rows.length, 2);

            for (let i = 0; i < limit; i++) {
                const cells = rows[i].querySelectorAll("td");
                // Adjusted check to match the 5 columns present in the HTML structure (length >= 5)
                if (cells.length >= 5) {
                    results.push({
                        year: cells[0].textContent.trim(),
                        paidDate: cells[2].textContent.trim(),
                        paidAmount: cells[4].textContent.trim() // Corrected from cells[5] to cells[4]
                    });
                }
            }
            return results;
        }, historyRowSelector);
    }
    console.log("Paid Records: ", paidData);

    //assessed Value
    let assessedValue = null;
    const currentUrl = new URL(page.url());
    const pValue = currentUrl.searchParams.get('p');
    const aValue = currentUrl.searchParams.get('a');

    const newUrl = new URL('https://id-payette.publicaccessnow.com/Assessor/PropertySearch/Detail.aspx');
    newUrl.searchParams.set('p', pValue);
    newUrl.searchParams.set('a', aValue);

    await page.goto(newUrl.toString(), { waitUntil: "networkidle2" });

    // Wait for the specific container to load
    const containerSelector = "#dnn_ctr624_ModuleContent";
    await page.waitForSelector(containerSelector, { visible: true });

    // Scope the table search explicitly inside that container
    const tableSelector = `${containerSelector} table[aria-label='view.group.data.table.label 1']`;
    await page.waitForSelector(`${tableSelector} tbody tr`, { visible: true });

    assessedValue = await page.evaluate((selector) => {
        // This will now correctly target the 3rd cell in the 1st row of the right table
        const valueElement = document.querySelector(`${selector} tbody tr:first-child td:nth-child(3)`);
        if (valueElement) {
            return valueElement.textContent.trim();
        }
        return null;
    }, tableSelector);
    console.log("AssessedValue: ", assessedValue);

    return { details, installments, paidData, assessedValue };

}

async function populateTheObject(details, installments, paidData, assessedValue) {
    const result = createPropertyObject();
    result.owner_name.push(details.owner);
    result.property_address = details.address ? details.address : "N/A";
    result.total_assessed_value = `$${assessedValue}`;
    result.total_taxable_value = `$${assessedValue}`;

    // which means we have unpaid records
    if (installments.length > 0) {
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

            if (String(inst.installmentNumber) === "1") {
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
    }
    else if (paidData.length > 0) {
        if (paidData[0].year === paidData[1].year) {
            const sortedRows = [...paidData].sort((a, b) => new Date(a.paidDate) - new Date(b.paidDate));
            sortedRows.forEach((row, index) => {
                const record = createTaxHistory();
                record.year = row.year;
                record.status = "Paid";
                record.base_amount = row.paidAmount;
                record.amount_paid = row.paidAmount;
                record.amount_due = "$0.00";
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
            const yearInt = parseInt(paidData[0].year);
            const rawAmount = parseFloat(paidData[0].paidAmount.replace(/[\$,]/g, '')) || 0;
            const halfAmount = (rawAmount / 2).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

            const record1 = createTaxHistory();
            record1.year = paidData[0].year;
            record1.status = "Paid";
            record1.base_amount = halfAmount;
            record1.amount_paid = halfAmount;
            record1.amount_due = "$0.00";
            const [month1, day1, year1] = paidData[0].paidDate.split("/");
            record1.paid_date = `${month1}/${day1}/20${year1}`;
            record1.payment_type = "Installment 1";
            record1.due_date = `12/20/${yearInt}`;
            record1.delq_date = `12/21/${yearInt}`;
            result.tax_history.push(record1);

            const record2 = createTaxHistory();
            record2.year = paidData[0].year;
            record2.status = "Paid";
            record2.base_amount = halfAmount;
            record2.amount_paid = halfAmount;
            record2.amount_due = "$0.00";
            const [month2, day2, year2] = paidData[0].paidDate.split("/");
            record2.paid_date = `${month2}/${day2}/20${year2}`;
            record2.payment_type = "Installment 2";
            record2.due_date = `06/20/${yearInt + 1}`;
            record2.delq_date = `06/21/${yearInt + 1}`;
            result.tax_history.push(record2);
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

    console.log(result);

}


async function run(accountNumber) {

    try {
        const { browser, page } = await launchBrowser();


        await page.goto(
            "	https://id-payette.publicaccessnow.com/Treasurer/TaxSearch.aspx",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);
        const { details, installments, paidData, assessedValue } = await fetchDetails(page);
        await populateTheObject(details, installments, paidData, assessedValue);

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("F36400020060");