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
        delinquent: "NONE",
        taxing_authority: "",
        notes: "",
        tax_history: []
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

const generate_notes = (year, keys, status) => {
    let notes = "";
    try {
        notes =
            keys === 1
                ? `ALL PRIORS ARE PAID,`
                : `PRIORS ARE DELINQUENT,`;
        notes += ` ${year} 1ST INSTALLMENT IS ${status.toUpperCase()}, 2ND INSTALLMENT IS ${status.toUpperCase()},`;
        notes += ` NORMALLY TAXES ARE PAID SEMI-ANNUALLY,`;
        notes += ` NORMAL DUE DATES ARE 01/01 AND 11/01`;
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
    await page.locator("button ::-p-text(Search)").click();
    const searchSelector = "#auto-complete-id";
    await page.waitForSelector(searchSelector, { visible: true });
    await page.type(searchSelector, accountNumber);

    await page.keyboard.press("Enter");
}

async function getData(page) {
    await page.waitForSelector("#mainPage");

    const propertyData = await page.evaluate(() => {

        const findTableByHeader = (headerText) => {
            const thElements = Array.from(document.querySelectorAll("th"));
            const targetTh = thElements.find(th => th.textContent.includes(headerText));
            return targetTh ? targetTh.closest("table") : null;
        };

        // 1. Get Property Address
        // It's in the first table ("Edmunds County, SD - Property Report")
        let address = "N/A";
        const mainTable = document.querySelector("table");
        if (mainTable) {
            // The address is in the second column (index 1) of the first row of tbody
            const cells = mainTable.querySelectorAll("tbody tr td");
            if (cells.length > 1) {
                address = cells[1].innerText.trim();
            }
        }

        // 2. Get Owner Name
        // It's in the "Owner Information" table
        let ownerName = "N/A";
        const ownerTable = findTableByHeader("Owner Information");
        if (ownerTable) {
            // The owner name is in the first row of tbody, second column
            const ownerCell = ownerTable.querySelector("tbody tr td:nth-child(2)");
            if (ownerCell) {
                ownerName = ownerCell.innerText.trim();
            }
        }

        // 3. Get Total Assessed Value
        // It's in the "Total Assessed Values" table
        let assessedValue = "N/A";
        const assessedTable = findTableByHeader("Total Assessed Values");
        if (assessedTable) {
            // It's in the last column (4th) of the first row of tbody
            const cells = assessedTable.querySelectorAll("tbody tr td");
            if (cells.length >= 4) {
                assessedValue = cells[3].innerText.trim();
            }
        }

        // 4. Get Taxes Payable Table Data
        const taxesData = [];
        const taxesTable = findTableByHeader("Taxes Payable");
        if (taxesTable) {
            const rows = taxesTable.querySelectorAll("tbody tr");
            rows.forEach(row => {
                const cells = row.querySelectorAll("td");
                if (cells.length === 4) {
                    taxesData.push({
                        yearDue: cells[0].innerText.trim(),
                        owner: cells[1].innerText.trim(),
                        address: cells[2].innerText.trim(),
                        totalTax: cells[3].innerText.trim()
                    });
                }
            });

            return {
                address, ownerName, assessedValue, taxesPayable: taxesData
            };
        }
    });
    return propertyData;
}

async function populateData(page, propertyData) {
    const result = createPropertyObject();
    result.owner_name = propertyData.ownerName;
    result.property_address = propertyData.address;
    result.total_assessed_value = propertyData.assessedValue;
    result.total_taxable_value = propertyData.assessedValue;

    const today = new Date();
    for (const item of propertyData.taxesPayable) {
        // 1. Remove '$' and ',' from the string, convert to Float, divide by 2
        const rawTax = parseFloat(item.totalTax.replace(/[$,]/g, ""));
        const installmentValue = isNaN(rawTax) ? 0 : rawTax / 2;
        // Format back to currency string
        const formattedInstallment = `$${installmentValue.toFixed(2)}`;

        // 2. Loop explicitly for the 2 installments
        for (let i = 1; i <= 2; i++) {
            // 3. Create a NEW object for EACH installment inside the loop
            const record = createTaxHistory();
            record.year = item.yearDue;
            record.payment_type = `Installment ${i}`;
            record.amount_paid = "$0.00";
            record.base_amount = formattedInstallment;
            record.amount_due = formattedInstallment;

            record.due_date = `01/01/${record.year}`;
            record.delq_date = i === 1 ? `05/01/${record.year}` : `11/01/${record.year}`;

            // 4. Calculate status specifically for this installment's dates
            const dueDateObj = new Date(record.due_date);
            if (today <= dueDateObj) {
                record.status = "Due";
            } else {
                record.status = "Delinquent";
            }

            // 5. Push the unique installment record exactly once
            result.tax_history.push(record);
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

        // Check if any PRIOR year is delinquent (exclude the latest year)
        const hasPriorDelinquent = result.tax_history.some(
            (t) => t.status === "Delinquent" && String(t.year) !== String(latestTax.year)
        );

        // If priors are delinquent, keys = 0. If priors are paid, keys = 1.
        const keys = hasPriorDelinquent ? 0 : 1;
        result.notes = generate_notes(latestTax.year, keys, latestTax.status);
    }

    console.log(result);

}


async function run(accountNumber) {

    try {
        const { browser, page } = await launchBrowser();


        await page.goto(
            "https://www.1stdistrict.org/edmundsts/#",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await page.locator('button ::-p-text(Agree)').click();
        await searchAccountNumber(accountNumber, page);
        // Wait for the link containing the text "Property Report"
        let propertyReportLink;
        try {
            propertyReportLink = await page.waitForSelector('a ::-p-text(Property Report)', { timeout: 5000 });
        } catch (error) {
            throw new Error("Multiple parcels found for this parcel id.");
        }


        // Extract the href URL property from the element
        const url = await propertyReportLink.evaluate(el => el.href);

        console.log('Navigating to URL:', url);

        // Navigate to the extracted URL in the same page
        await page.goto(url);

        const propertyData = await getData(page);
        await populateData(page, propertyData);

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("2576");