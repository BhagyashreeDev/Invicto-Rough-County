// import puppeteer from "puppeteer";

// const timeout_option = {
//     timeout: 90000,
// };
// async function launchBrowser() {
//     const browser = await puppeteer.launch({
//         headless: false,
//         defaultViewport: null,
//         args: ["--start-maximized"],
//     });

//     const page = await browser.newPage();
//     page.setDefaultNavigationTimeout(60_000);
//     page.setDefaultTimeout(30_000);
//     return { browser, page };
// }

// function createPropertyObject() {
//     return {
//         processed_date: "",
//         order_number: "",
//         borrower_name: "",
//         owner_name: [],
//         property_address: "",
//         parcel_number: "",
//         land_value: "",
//         improvements: "",
//         total_assessed_value: "",
//         exemption: "",
//         total_taxable_value: "",
//         delinquent: "NONE",
//         taxing_authority: "Shelby County Trustee, 157 Poplar Ave, Memphis, TN 38103",
//         notes: "",
//         tax_history: []
//     };
// }

// function createTaxHistory() {
//     return {
//         jurisdiction: "County",
//         year: "",
//         payment_type: "Annual",
//         status: "",
//         base_amount: "",
//         amount_paid: "",
//         amount_due: "",
//         mailing_date: "N/A",
//         due_date: "",
//         delq_date: "",
//         paid_date: "",
//         good_through_date: "",
//     };
// }

// // for generating notes
// const generate_notes = (year, keys, status) => {
//     let notes = "";
//     try {
//         notes =
//             keys === 1
//                 ? `ALL PRIORS ARE PAID, ${year} `
//                 : `PRIORS ARE DELINQUENT, ${year} `;
//         notes += `TAXES ARE ${status.toUpperCase()},`;
//         notes += ` NORMALLY TAXES ARE PAID ANNUALLY,`;
//         notes += ` NORMAL DUE DATE IS 1st MONDAY IN OCTOBER`;
//     } catch (error) {
//         console.log(error);
//     } finally {
//         return notes;
//     }
// };

// // calculating the due date of that tax year
// function getFirstMondayOfOctober(year) {
//     const d = new Date(year, 9, 1);
//     const day = d.getDay();
//     const diff = day === 0 ? 1 : (day === 1 ? 0 : 8 - day);
//     d.setDate(d.getDate() + diff);

//     const mm = String(d.getMonth() + 1).padStart(2, "0");
//     const dd = String(d.getDate()).padStart(2, "0");
//     const yyyy = d.getFullYear();
//     return `${mm}/${dd}/${yyyy}`;
// }

// async function getDetails(page) {

//     const info = await page.evaluate(() => {
//         const getValueByLabel = (labelText) => {
//             const labels = Array.from(document.querySelectorAll("span"));
//             const targetLabel = labels.find(el => el.textContent.trim() === labelText);
//             return targetLabel ? targetLabel.nextElementSibling?.textContent.trim() : null;
//         };

//         return {
//             primaryOwner: getValueByLabel('Primary Owner'),
//             location: getValueByLabel('Location')
//         };
//     });

//     console.log("Info : ", info);

//     const billData = await page.evaluate(() => {
//         const firstRow = document.querySelector("tbody tr");
//         const cells = firstRow.querySelectorAll("td");

//         return {
//             taxYear: cells[1]?.textContent.trim(),
//             taxDue: cells[3]?.textContent.trim(),
//             totalDue: cells[6]?.textContent.trim(),
//             assessment: cells[7]?.textContent.trim()
//         };
//     });

//     console.log("Bill data: ", billData);

//     return { info, billData };
// }

// async function populateData(info, billData, page) {
//     const result = createPropertyObject();
//     result.owner_name.push(info.primaryOwner);
//     result.property_address = info.location;
//     result.total_assessed_value = billData.assessment;
//     result.total_taxable_value = billData.assessment;

//     const record = createTaxHistory();
//     record.year = billData.taxYear;
//     record.base_amount = billData.taxDue;
//     record.amount_due = billData.totalDue;
//     record.amount_paid = "$0.00";

//     if (record.amount_due === "$0.00" || record.amount_due === "$0") {
//         record.status = "Paid";
//     } else {
//         const today = new Date();
//         const dueDateObj = new Date(record.due_date);
//         if (today <= dueDateObj) {
//             record.status = "Due";
//         } else {
//             record.status = "Delinquent";
//         }
//     }


//     const yearInt = parseInt(record.year, 10);

//     record.due_date = getFirstMondayOfOctober(yearInt);
//     record.delq_date = `03/03/${yearInt + 1}`;

//     result.tax_history.push(record);

//     console.log("Result: ", result);
// }

// async function run(accountNumber) {

//     try {
//         const { browser, page } = await launchBrowser();

//         await page.goto(`https://apps2.shelbycountytrustee.com/Parcel?parcel=${accountNumber}`, { waitUntil: 'networkidle2' });

//         const { info, billData } = await getDetails(page);

//         await populateData(info, billData, page);


//     } catch (err) {
//         console.log("Error during running sequence execution pipeline: ", err);
//     } finally {

//     }
// }

// run("026025 00035");

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
        delinquent: "NONE",
        taxing_authority: "Shelby County Trustee, 157 Poplar Ave, Memphis, TN 38103",
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
        good_through_date: "",
    };
}

// Helper to parse currency string into a numeric float
function parseAmount(val) {
    if (!val) return 0;
    const clean = val.replace(/[^0-9.-]+/g, "");
    const num = parseFloat(clean);
    return isNaN(num) ? 0 : num;
}

// for generating notes
const generate_notes = (year, keys, status) => {
    let notes = "";
    try {
        notes =
            keys === 1
                ? `ALL PRIORS ARE PAID, ${year} `
                : `PRIORS ARE DELINQUENT, ${year} `;
        notes += `TAXES ARE ${status.toUpperCase()},`;
        notes += ` NORMALLY TAXES ARE PAID ANNUALLY,`;
        notes += ` NORMAL DUE DATE IS 1st MONDAY IN OCTOBER`;
    } catch (error) {
        console.log(error);
    }
    return notes;
};

// calculating the due date of that tax year (1st Monday of October)
function getFirstMondayOfOctober(year) {
    const d = new Date(year, 9, 1);
    const day = d.getDay();
    const diff = day === 0 ? 1 : (day === 1 ? 0 : 8 - day);
    d.setDate(d.getDate() + diff);

    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    const yyyy = d.getFullYear();
    return `${mm}/${dd}/${yyyy}`;
}

async function getDetails(page) {
    // 1. Wait for property information and table rows to render
    await page.waitForSelector("tbody tr", { timeout: 30000 });

    const info = await page.evaluate(() => {
        const getValueByLabel = (labelText) => {
            const labels = Array.from(document.querySelectorAll("span"));
            const targetLabel = labels.find(el => el.textContent.trim() === labelText);
            return targetLabel ? targetLabel.nextElementSibling?.textContent.trim() : null;
        };

        return {
            primaryOwner: getValueByLabel('Primary Owner') || "",
            location: getValueByLabel('Location') || ""
        };
    });

    console.log("Info: ", info);

    // 2. Extract ALL rows from the tax bill table
    const allBills = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("tbody tr"));
        return rows.map(row => {
            const cells = row.querySelectorAll("td");
            return {
                billNumber: cells[0]?.textContent.trim() || "",
                taxYear: cells[1]?.textContent.trim() || "",
                authority: cells[2]?.textContent.trim() || "",
                taxDue: cells[3]?.textContent.trim() || "$0.00",
                interest: cells[4]?.textContent.trim() || "$0.00",
                totalFees: cells[5]?.textContent.trim() || "$0.00",
                totalDue: cells[6]?.textContent.trim() || "$0.00",
                assessment: cells[7]?.textContent.trim() || "$0.00"
            };
        });
    });

    console.log(`Found ${allBills.length} total bill records across all years.`);

    return { info, allBills };
}

async function populateData(info, allBills, accountNumber) {
    const result = createPropertyObject();
    result.parcel_number = accountNumber;
    if (info.primaryOwner) result.owner_name.push(info.primaryOwner);
    result.property_address = info.location;
    result.processed_date = new Date().toLocaleDateString("en-US", {
        month: "2-digit",
        day: "2-digit",
        year: "numeric"
    });

    if (allBills.length === 0) {
        console.log("No bill records found.");
        return result;
    }

    // Set assessed value from the most recent record
    result.total_assessed_value = allBills[0].assessment;
    result.total_taxable_value = allBills[0].assessment;

    // Filter all bills that have dues (totalDue > 0)
    const unpaidBills = allBills.filter(bill => parseAmount(bill.totalDue) > 0);

    let targetBills = [];
    if (unpaidBills.length > 0) {
        // If there are unpaid dues across 1 or more years, include all unpaid bills
        console.log(`Found ${unpaidBills.length} bill(s) with outstanding dues.`);
        targetBills = unpaidBills;
    } else {
        // If all taxes are paid ($0.00), grab all bills from the most recent year (e.g. 2026 Lakeland & Shelby)
        const latestYear = allBills[0].taxYear;
        console.log(`All taxes are paid. Populating most recent year (${latestYear}) records.`);
        targetBills = allBills.filter(bill => bill.taxYear === latestYear);
    }

    const today = new Date();

    // Populate tax_history
    for (const bill of targetBills) {
        const record = createTaxHistory();
        const yearInt = parseInt(bill.taxYear, 10);

        record.jurisdiction = bill.authority || "County";
        record.year = bill.taxYear;
        record.base_amount = bill.taxDue;
        record.amount_due = bill.totalDue;

        // Calculate Due Date and Delinquent Date first
        record.due_date = getFirstMondayOfOctober(yearInt);
        record.delq_date = `03/03/${yearInt + 1}`;

        const totalDueNum = parseAmount(bill.totalDue);

        if (totalDueNum === 0) {
            record.status = "Paid";
            record.amount_paid = bill.taxDue;
        } else {
            record.amount_paid = "$0.00";
            const delqDateObj = new Date(record.delq_date);
            const dueDateObj = new Date(record.due_date);

            if (today >= delqDateObj) {
                record.status = "Delinquent";
            } else {
                record.status = "Due";
            }
        }

        result.tax_history.push(record);
    }

    // Determine Delinquent and Notes
    const hasDelinquent = result.tax_history.some(r => r.status === "Delinquent");
    result.delinquent = hasDelinquent ? "TAXES DELINQUENT" : "NONE";

    const latestYearStr = allBills[0].taxYear;
    const latestYearInt = parseInt(latestYearStr, 10);
    const latestYearStatus = result.tax_history.find(r => r.year === latestYearStr)?.status || "PAID";

    // Check if any older/prior year has delinquent taxes
    const priorYearsDelinquent = allBills.some(bill => {
        const y = parseInt(bill.taxYear, 10);
        return y < latestYearInt && parseAmount(bill.totalDue) > 0;
    });

    const keys = priorYearsDelinquent ? 0 : 1;
    result.notes = generate_notes(latestYearStr, keys, latestYearStatus);

    console.log("Populated Property Result:\n", JSON.stringify(result, null, 2));
    return result;
}

async function run(accountNumber) {
    let browser;
    try {
        const launched = await launchBrowser();
        browser = launched.browser;
        const page = launched.page;

        console.log(`Searching for Parcel: ${accountNumber}...`);
        await page.goto(`https://apps2.shelbycountytrustee.com/Parcel?parcel=${encodeURIComponent(accountNumber)}`, {
            waitUntil: 'networkidle2'
        });

        const { info, allBills } = await getDetails(page);
        const result = await populateData(info, allBills, accountNumber);

        return result;

    } catch (err) {
        console.error("Error during running sequence execution pipeline: ", err);
    } finally {
        if (browser) {
            // await browser.close();
        }
    }
}

// Execute with sample parcel
run("038031 00027");