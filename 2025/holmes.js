import puppeteer from "puppeteer";

const timeout_option = {
    timeout: 90000,
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

async function searchAccountNumber(accountNumber, page) {
    await page.waitForSelector("#propertynumber", timeout_option);
    await page.type("#propertynumber", accountNumber);

    await page.waitForSelector("#search", timeout_option);
    await Promise.all([
        page.waitForNavigation(),
        page.click("#search")
    ]);

    // Selector targets the last <tr> in the table body and grabs the property link anchor
    const lastRowPropertyLink = '#filter-results-table tbody tr:last-child td.tax-detail-link a';
    await page.waitForSelector(lastRowPropertyLink);

    await page.click(lastRowPropertyLink);

    page.once('dialog', async dialog => {
        await dialog.accept();
    });
}

async function getDetails(page) {

    await page.waitForSelector("#ctl00_ContentPlaceHolder1_lblName", timeout_option);
    const ownerName = await page.$eval("#ctl00_ContentPlaceHolder1_lblName", el => el.textContent.trim());
    console.log("Owner Name: ", ownerName);

    await page.waitForSelector("#ctl00_ContentPlaceHolder1_lblPropertyAddress", timeout_option);
    const propertyAddress = await page.$eval("#ctl00_ContentPlaceHolder1_lblPropertyAddress", el => el.textContent.trim());
    console.log("Property Address: ", propertyAddress);

    const tableElement = await page.$("#Table3");

    if (!tableElement) {
        await page.waitForSelector("#ctl00_ContentPlaceHolder1_lblGrossTaxValue", timeout_option);
        const assessedValue = await page.$eval("#ctl00_ContentPlaceHolder1_lblGrossTaxValue", el => el.textContent.trim());
        console.log("Assessed Value: ", assessedValue);

        await page.waitForSelector("#ctl00_ContentPlaceHolder1_lblCoNetTaxValue", timeout_option);
        const taxableValue = await page.$eval("#ctl00_ContentPlaceHolder1_lblCoNetTaxValue", el => el.textContent.trim());
        console.log("Taxable value: ", taxableValue);

        await page.waitForSelector("#ctl00_ContentPlaceHolder1_plCert", timeout_option);

        const extractionResult = await page.evaluate(() => {
            const headers = Array.from(document.querySelectorAll('.HdHeaderBk'));
            const isPaid = headers.some(header => header.textContent.includes('** PAID **'));

            if (isPaid) return null;

            const container = document.querySelector("#ctl00_ContentPlaceHolder1_plCert");
            const table = container.querySelector("table");

            // extract all rows but skipping the first header row
            const rows = Array.from(table.querySelectorAll("tr")).slice(1);
            let installments = [];

            rows.forEach(row => {
                const cells = row.querySelectorAll("td");
                if (cells.length < 6) return;
                const dueDate = cells[1].innerText.trim();
                let year = 0;
                if (dueDate) {
                    const dateParts = dueDate.split("/");
                    if (dateParts.length === 3) {
                        const rawYear = dateParts[2];
                        // Handle 2-digit vs 4-digit years safely
                        year = parseInt(rawYear.length === 2 ? `20${rawYear}` : rawYear, 10);
                    }
                }

                installments.push({
                    installmentNumber: cells[0].innerText.trim(),
                    dueDate: dueDate,
                    year: year,
                    amount: cells[2].innerText.trim(),
                    paidAmount: cells[4].innerText.trim(),
                    amountDue: cells[5].innerText.trim(),
                    paidDate: cells[6] ? cells[6].innerText.trim().split(" ")[0] : null
                });
            });

            // Filter for only the most recent year
            const mostRecentYear = Math.max(...installments.map(i => i.year));
            const recentInstallments = installments.filter(i => i.year === mostRecentYear);

            return recentInstallments;
        });

        console.log("installments: ", extractionResult);

        let paidRecord = null;
        if (extractionResult === null) {
            await page.waitForSelector("tr.TitleColor", timeout_option);
            paidRecord = await page.evaluate(() => {
                const headerRow = document.querySelector("tr.TitleColor");
                if (!headerRow) return null; // Safety check in case the table isn't found
                console.log("Inside the table...");
                const table = headerRow.closest("table");
                const rows = Array.from(table.querySelectorAll("tr"));
                let summaryRecords = [];

                rows.forEach(row => {
                    const cells = row.querySelectorAll("td");

                    // CRITICAL FIX: Skip this row if it doesn't have at least 7 cells 
                    // (since you are trying to access cells[6] later)
                    if (cells.length < 7) return;

                    const yearText = cells[2].innerText.trim();
                    const year = parseInt(yearText, 10);

                    // Optional: Skip if the year isn't a valid number (e.g., a total row)
                    if (isNaN(year)) return;

                    console.log("year:", year);
                    summaryRecords.push({
                        year: year,
                        baseAmount: cells[3].innerText.trim(),
                        datePaid: cells[5].innerText.trim(),
                        amountPaid: cells[6].innerText.trim(),
                    });
                });

                // Find the most recent year safely
                if (summaryRecords.length === 0) return null;

                const mostRecentYear = Math.max(...summaryRecords.map(r => r.year));
                const recentRecord = summaryRecords.find(r => r.year === mostRecentYear);

                return recentRecord;
            });
        }

        console.log("Paid Record: ", paidRecord);
        return populateTheObject(ownerName, propertyAddress, assessedValue, taxableValue, extractionResult, paidRecord, null);
    }
    else { // bardford
        // const certSoldElement = await page.$("#ctl00_ContentPlaceHolder1_lblCertificateStatus");
        // if (certSoldElement) {

        //     await page.waitForSelector("#ctl00_ContentPlaceHolder1_lblTaxableValue", timeout_option);
        //     const taxableValue = await page.$eval("#ctl00_ContentPlaceHolder1_lblTaxableValue", el => el.textContent.trim());
        //     console.log("Taxable value: ", taxableValue);

        //     await page.waitForSelector("#ctl00_ContentPlaceHolder1_dgDelinquentHistory", timeout_option);
        //     const delqRecords = await page.evaluate(() => {
        //         const table = document.querySelector("#ctl00_ContentPlaceHolder1_dgDelinquentHistory");
        //         const rows = Array.from(table.querySelectorAll("tr")).slice(1).slice(-1);
        //         const records = [];

        //         rows.forEach(row => {
        //             const cells = row.querySelectorAll("td");
        //             const year = cells[0].innerText.trim();
        //             records.push({
        //                 year: year,
        //                 baseTax: cells[3].innerText.trim(),
        //                 amountDue: cells[5].innerText.trim()
        //             });
        //         });
        //         return records;
        //     });

        //     console.log("Delq Records: ", delqRecords);
        //     return populateTheObject(ownerName, propertyAddress, taxableValue, taxableValue, null, null, delqRecords);
        // }

        await page.waitForSelector("#ctl00_ContentPlaceHolder1_lblTaxableValue", timeout_option);
        const taxableValue = await page.$eval("#ctl00_ContentPlaceHolder1_lblTaxableValue", el => el.textContent.trim());
        console.log("Taxable value: ", taxableValue);

        const delqRecords = await page.evaluate(() => {
            const table = document.querySelector("#ctl00_ContentPlaceHolder1_dgDelinquentHistory");

            const rows = Array.from(table.querySelectorAll("tr")).slice(1, -1);
            const records = [];

            rows.forEach(row => {
                const cells = row.querySelectorAll("td");
                const yearText = cells[0].innerText.trim();
                const year = parseInt(yearText, 10);
                records.push({
                    year: year,
                    baseTax: cells[3].innerText.trim(),
                    amountDue: cells[5].innerText.trim()
                });
            });
            return records;
        });
        console.log("Delq Records: ", delqRecords);
        return populateTheObject(ownerName, propertyAddress, taxableValue, taxableValue, null, null, delqRecords);
    }
    // const result = await populateTheObject(ownerName, propertyAddress, assessedValue, taxableValue, extractionResult, paidRecord)
}

async function populateTheObject(ownerName, propertyAddress, assessedValue, taxableValue, extractionResult, paidRecord, delqRecords) {
    const result = createPropertyObject();
    result.owner_name.push(ownerName);
    result.property_address = propertyAddress.replace(/\s+/g, " ").trim();
    result.total_taxable_value = taxableValue;
    result.total_assessed_value = assessedValue;

    if (extractionResult) {
        // FIX 1: Use for...of to iterate over array items instead of for...in
        for (const item of extractionResult) {
            const record = createTaxHistory();
            record.year = item.year;
            record.base_amount = `$${item.amount}`;
            record.amount_paid = `$${item.paidAmount}`;
            record.amount_due = item.amountDue;
            record.due_date = item.dueDate;
            record.paid_date = item.paidDate;

            if (item.dueDate) {
                const dueDateObj = new Date(item.dueDate);
                // Create a new date instance so original remains unmutated
                const delqDateObj = new Date(dueDateObj);
                delqDateObj.setDate(delqDateObj.getDate() + 1);

                const month = String(delqDateObj.getMonth() + 1).padStart(2, '0');
                // FIX 2: Call getDate() with parentheses
                const day = String(delqDateObj.getDate()).padStart(2, '0');
                const year = delqDateObj.getFullYear();
                record.delq_date = `${month}/${day}/${year}`;
            }

            if (record.amount_due === "$0.00" || record.amount_due === "0.00") {
                record.status = "Paid";
            } else {
                const today = new Date();
                const dueDateObj = new Date(record.due_date);

                if (today <= dueDateObj) {
                    record.status = "Due";
                } else {
                    record.status = "Delinquent";
                }
            }
            result.tax_history.push(record);
        }
    } else if (paidRecord) {
        const record = createTaxHistory();
        record.year = paidRecord.year;
        record.base_amount = paidRecord.baseAmount;
        record.amount_paid = paidRecord.amountPaid;
        record.paid_date = paidRecord.datePaid;

        record.due_date = `03/31/${record.year}`;
        record.delq_date = `04/01/${record.year}`;
        record.amount_due = "$0.00";
        record.status = "Paid";
        result.tax_history.push(record);
    } else if (delqRecords && delqRecords.length > 0) {
        for (const item of delqRecords) {
            const record = createTaxHistory();
            record.year = item.year;
            record.base_amount = item.baseTax;
            record.amount_due = item.amountDue;
            record.amount_paid = "$0.00";
            record.due_date = `03/31/${item.year}`;
            record.delq_date = `04/01/${item.year}`;
            const today = new Date();
            const dueDateObj = new Date(record.due_date);
            if (today <= dueDateObj) {
                record.status = "Due";
            } else {
                record.status = "Delinquent";
            }
            result.tax_history.push(record);
        }
    }

    console.log("Result: ", JSON.stringify(result, null, 2));
    return result;
}

async function run(accountNumber) {

    try {
        const { browser, page } = await launchBrowser();


        await page.goto(
            "https://www.unioncountytc.com/Property/SearchSelect?Accept=true&ClearData=True",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);
        await getDetails(page);


    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("22-05-18-00-000-0040-0");

