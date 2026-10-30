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
        taxing_authority: "Canyon County Treasurer, 111 N 11th Avenue, Caldwell, ID 83605",
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
    const url = `https://id-canyon.publicaccessnow.com/Treasurer/TaxSearch.aspx?s=ParcelID:${accountNumber.split(" ")[0].trim()}%200&pg=1&g=2&moduleId=624`;
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
    console.log("Details: ", details);


    await page.waitForSelector("#dnn_ctr464_ModuleContent", timeout_option);
    const dueSelector = "#dnn_ctr464_ModuleContent .grand-total-bill-amount.bill-header__total-amount";
    // Wait for the span itself to be rendered by Angular
    await page.waitForSelector(dueSelector, { visible: true, timeout: 10000 });
    const due = await page.evaluate((selector) => {
        const spanElement = document.querySelector(selector);
        return spanElement ? spanElement.textContent.trim() : null;
    }, dueSelector);
    console.log("Due: ", due);

    let numericDue = 0;
    if (due) numericDue = parseFloat(due.replace(/[\$,]/g, ''));
    let installments = []; // for unpaid records
    let paidData = []; // for paid records
    let assessedValue = null;

    if (numericDue > 0) {

        const expandBtnSelector = 'payment-bill-group button.card.red-expand';
        const expandBtn = await page.$(expandBtnSelector);

        if (expandBtn) {
            await expandBtn.click();
            await page.waitForSelector('payment-bill-grid table tbody tr', { visible: true, timeout: 5000 });

            //     // Replace it with this:
            await page.evaluate(() => {
                const btns = document.querySelectorAll("payment-bill-grid table tbody button.expandable-header");
                btns.forEach(btn => {
                    // Check aria-expanded to ensure we don't accidentally close an already open tab
                    if (btn.getAttribute('aria-expanded') !== 'true') {
                        btn.click();
                    }
                });
            });

            //     // Give the DOM and Angular a moment to render all the inner tables simultaneously
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

            console.log("Installments are : ", installments);


            if (installments.length === 1 && !installments[0].error) {
                paidData = await page.evaluate(() => {
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


        }

    } else {

        await page.waitForSelector("#caretIcon1", { visible: true });
        await page.click("#caretIcon1");

        const historyContainer = "#dnn_ctr586_ModuleContent";
        // Wait for the container first
        await page.waitForSelector(historyContainer, timeout_option);

        // Define a strict selector for the table rows inside THIS specific container
        const historyRowSelector = `${historyContainer} table[aria-label='view.group.data.table.label 1'] tbody tr`;
        try {
            // Wait specifically for at least one row to be rendered by Angular
            await page.waitForSelector(historyRowSelector, { visible: true, timeout: 10000 });

            paidData = await page.evaluate((selector) => {
                const rows = document.querySelectorAll(selector);
                const results = [];
                // Safely loop up to 2 times, or less if there are fewer rows
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
            }, historyRowSelector);

        } catch (error) {
            console.log("History rows did not load or table is empty.");
        }
        console.log("Rows data: ", paidData);
    }

    // getting assessed Value
    const currentUrl = new URL(page.url());
    const pValue = currentUrl.searchParams.get('p');
    const aValue = currentUrl.searchParams.get('a');

    const newUrl = new URL('https://id-canyon.publicaccessnow.com/Assessor/PropertySearch/Detail.aspx');
    newUrl.searchParams.set('p', pValue);
    newUrl.searchParams.set('a', aValue);

    await page.goto(newUrl.toString(), { waitUntil: "networkidle2" });

    // Wait for the specific container to load
    const containerSelector = "#dnn_ctr629_ModuleContent";
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


    return { details, due, paidData, installments, assessedValue };
}

async function populateObject(details, due, paidData, installments, assessedValue) {
    const result = createPropertyObject();
    result.owner_name.push(details.owner);
    result.property_address = details.address ? details.address : "N/A";
    result.total_assessed_value = `$${assessedValue}`;
    result.total_taxable_value = `$${assessedValue}`;

    const numericDue = parseFloat(due.replace(/[\$,]/g, ''));
    // then we have paid records
    if (numericDue === 0) {

        if (paidData[0].year === paidData[1].year) {
            const sortedRows = [...paidData].sort((a, b) => new Date(a.paidDate) - new Date(b.paidDate));
            sortedRows.forEach((row, index) => {
                const record = createTaxHistory();
                record.year = row.year;
                record.status = "PAID";
                record.base_amount = row.paidAmount;
                record.amount_paid = row.paidAmount;
                record.amount_due = due;
                const [pMonth, pDay, pYear] = row.paidDate.split("/");
                record.paid_date = `${pMonth.padStart(2, '0')}/${pDay.padStart(2, '0')}/20${pYear}`;

                const yearInt = parseInt(record.year);
                record.due_date = index === 0 ? `12/20/${yearInt}` : `06/20/${yearInt + 1}`;
                record.delq_date = index === 0 ? `12/21/${yearInt}` : `06/21/${yearInt + 1}`;
                if (index === 0) record.payment_type = "INSTALLMENT 1";
                else record.payment_type = "INSTALLMENT 2";
                result.tax_history.push(record);
            });
        } else {
            const yearInt = parseInt(paidData[0].year);
            const rawAmount = parseFloat(paidData[0].paidAmount.replace(/[\$,]/g, '')) || 0;
            const halfAmount = (rawAmount / 2).toLocaleString('en-US', { style: 'currency', currency: 'USD' });

            const record1 = createTaxHistory();
            record1.year = paidData[0].year;
            record1.status = "PAID";
            record1.base_amount = halfAmount;
            record1.amount_paid = halfAmount;
            record1.amount_due = due;
            const [month1, day1, year1] = paidData[0].paidDate.split("/");
            record1.paid_date = `${month1}/${day1}/20${year1}`;
            record1.payment_type = "INSTALLMENT 1";
            record1.due_date = `12/20/${yearInt}`;
            record1.delq_date = `12/21/${yearInt}`;
            result.tax_history.push(record1);

            const record2 = createTaxHistory();
            record2.year = paidData[0].year;
            record2.status = "PAID";
            record2.base_amount = halfAmount;
            record2.amount_paid = halfAmount;
            record2.amount_due = due;
            const [month2, day2, year2] = paidData[0].paidDate.split("/");
            record2.paid_date = `${month2}/${day2}/20${year2}`;
            record2.payment_type = "INSTALLMENT 2";
            record2.due_date = `06/20/${yearInt + 1}`;
            record2.delq_date = `06/21/${yearInt + 1}`;
            result.tax_history.push(record2);
        }

    } else {
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
                record.payment_type = "INSTALLMENT 1";
            }
            else record.payment_type = "INSTALLMENT 2";

            const today = new Date();
            const dueDateObj = new Date(record.due_date);

            if (today <= dueDateObj) {
                record.status = "DUE";
            } else {
                record.status = "DELINQUENT";
            }
            result.tax_history.push(record);
        });

        if (installments.length === 1 && paidData && paidData.length > 0) {
            const dueInst = installments[0];
            const paidRow = paidData[0];

            if (dueInst.year === paidRow.year) {
                const record = createTaxHistory();
                record.year = paidRow.year;
                record.status = "PAID";
                record.base_amount = paidRow.paidAmount;
                record.amount_paid = paidRow.paidAmount;
                record.amount_due = "$0.00";

                // Format paid date correctly if needed, assuming MM/DD/YYYY from paidData
                const [pMonth, pDay, pYear] = paidRow.paidDate.split("/");
                record.paid_date = `${pMonth.padStart(2, '0')}/${pDay.padStart(2, '0')}/20${pYear}`;

                // Deduce which installment was paid
                let paidInstNum = "1";
                if (String(dueInst.installment).includes("1")) {
                    paidInstNum = "2";
                }

                const yearInt = parseInt(record.year);
                record.payment_type = `INSTALLMENT ${paidInstNum}`;
                record.due_date = paidInstNum === "1" ? `12/20/${yearInt}` : `06/20/${yearInt + 1}`;
                record.delq_date = paidInstNum === "1" ? `12/21/${yearInt}` : `06/21/${yearInt + 1}`;

                result.tax_history.push(record);
            }
        }

    }

    result.tax_history.sort((a, b) => {
        const yearA = parseInt(a.year, 10) || 0;
        const yearB = parseInt(b.year, 10) || 0;
        if (yearA !== yearB) {
            return yearA - yearB;
        }
        if (a.status === "PAID" && b.status !== "PAID") return -1;
        if (a.status !== "PAID" && b.status === "PAID") return 1;
        return 0;
    });

    if (result.tax_history.length > 0) {
        // Check if ANY tax is delinquent for the main delinquency flag
        const hasDelinquent = result.tax_history.some(
            (t) => t.status === "DELINQUENT",
        );
        result.delinquent = hasDelinquent
            ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
            : "NONE";

        // Get the latest tax record (the array is sorted ascending by year)
        const latestTax = result.tax_history[result.tax_history.length - 1];

        // Find individual statuses for the 1st and 2nd installments of the latest year
        const latestYearRecords = result.tax_history.filter(t => String(t.year) === String(latestTax.year));
        const inst1 = latestYearRecords.find(t => t.payment_type === "INSTALLMENT 1");
        const inst2 = latestYearRecords.find(t => t.payment_type === "INSTALLMENT 2");

        const status1 = inst1 ? inst1.status : "UNKNOWN";
        const status2 = inst2 ? inst2.status : "UNKNOWN";

        // Check if any PRIOR year is delinquent (exclude the latest year)
        const hasPriorDelinquent = result.tax_history.some(
            (t) => t.status === "DELINQUENT" && String(t.year) !== String(latestTax.year)
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
            "https://id-canyon.publicaccessnow.com/Treasurer/TaxSearch.aspx",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);
        const { details, due, paidData, installments, assessedValue } = await fetchDetails(page);
        await populateObject(details, due, paidData, installments, assessedValue);


    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("10952010 0");