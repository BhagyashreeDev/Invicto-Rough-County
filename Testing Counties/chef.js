import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import PDFParser from "pdf2json"; // Ensure you have this installed if you uncomment

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
        taxing_authority: "Chaffee County Treasurer, 104 Crestone Avenue, Salida, CO 81201",
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
    const searchSelector = "#MainContent_txtParcelNumber";
    await page.waitForSelector(searchSelector, { visible: true });
    await page.type(searchSelector, accountNumber);

    const submitBtnSelector = "#MainContent_btnSearch2";
    await page.waitForSelector(submitBtnSelector, { visible: true });
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click(submitBtnSelector)
    ]);

    const selectSelector = "input[value='Select Property']";
    await page.waitForSelector(selectSelector, { visible: true });
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click(selectSelector)
    ]);
}

async function getPropertyDetails(page) {
    const propertyDetails = await page.evaluate(() => {
        // Select the first data row (skipping the <th> header row)
        const row = document.querySelector('#MainContent_gvParcelSearchResults tr:nth-child(2)');
        if (!row) return null;

        const cells = row.querySelectorAll('td');

        // Index 3 corresponds to Parcel Address (4th <td>)
        // Index 4 corresponds to Owner Name (5th <td>)
        const propertyAddress = cells[3]?.innerText.replace(/\s+/g, ' ').trim();
        const ownerName = cells[4]?.innerText.replace(/\s+/g, ' ').trim();

        return { propertyAddress, ownerName };
    });

    return propertyDetails;
}

async function goToTaxes(page) {
    await page.waitForSelector('#Taxes a');

    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle2' }),
        page.click('#Taxes a')
    ]);
}

async function getTaxRecords(page) {
    const installmentData = await page.evaluate(() => {
        const getText = (id) => {
            const el = document.getElementById(id);
            return el ? el.innerText.trim() : '';
        };

        return {
            firstInstallment: {
                dueDate: getText('MainContent_Label11'),
                taxesDue: getText('MainContent_Label12'),
                datePaid: getText('MainContent_Label17'),
                totalPaid: getText('MainContent_Label201'),
                amtDue: getText('MainContent_Label203')
            },
            secondInstallment: {
                dueDate: getText('MainContent_Label21'),
                taxesDue: getText('MainContent_Label22'),
                datePaid: getText('MainContent_Label27'),
                totalPaid: getText('MainContent_Label301'),
                amtDue: getText('MainContent_Label303')
            }
        };
    });

    console.log("Extracted Data:", JSON.stringify(installmentData, null, 2));
    return installmentData;
}

function getDelinquentDate(dueDateStr) {
    if (!dueDateStr) return null;
    const date = new Date(dueDateStr);
    date.setDate(date.getDate() + 1);

    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    const year = date.getFullYear();

    return `${month}/${day}/${year}`;
}

async function populateTheObject(details, data, page) {
    const result = createPropertyObject();
    result.owner_name.push(details.ownerName);
    result.property_address = details.propertyAddress;

    const usCurrencyFormatter = new Intl.NumberFormat('en-US', {
        style: 'currency',
        currency: 'USD',
    });

    // Remove the `for...in` loop entirely, just access `data` directly
    
    // --- RECORD 1 ---
    const record1 = createTaxHistory();
    record1.base_amount = usCurrencyFormatter.format(data.firstInstallment.taxesDue);
    record1.amount_paid = usCurrencyFormatter.format(data.firstInstallment.totalPaid);
    record1.amount_due = usCurrencyFormatter.format(data.firstInstallment.amtDue);
    record1.due_date = data.firstInstallment.dueDate;
    record1.delq_date = getDelinquentDate(record1.due_date); // Fixed property name
    record1.paid_date = data.firstInstallment.datePaid;
    record1.payment_type = "Installment 1";
    
    if (record1.amount_due === "$0.00") {
        record1.status = "Paid";
    } else {
        const today = new Date();
        const dueDateObj = new Date(record1.due_date);
        if (today <= dueDateObj) {
            record1.status = "Due";
        } else {
            record1.status = "Delinquent";
        }
    }

    // --- RECORD 2 ---
    const record2 = createTaxHistory();
    record2.base_amount = usCurrencyFormatter.format(data.secondInstallment.taxesDue);
    record2.amount_paid = usCurrencyFormatter.format(data.secondInstallment.totalPaid);
    record2.amount_due = usCurrencyFormatter.format(data.secondInstallment.amtDue); // Added missing assignment
    record2.due_date = data.secondInstallment.dueDate;
    record2.delq_date = getDelinquentDate(record2.due_date); // Fixed property name
    record2.paid_date = data.secondInstallment.datePaid;
    record2.payment_type = "Installment 2";
    
    if (record2.amount_due === "$0.00") {
        record2.status = "Paid";
    } else {
        const today = new Date();
        const dueDateObj = new Date(record2.due_date);
        if (today <= dueDateObj) {
            record2.status = "Due";
        } else {
            record2.status = "Delinquent";
        }
    }
    
    result.tax_history.push(record1, record2);

    console.log(JSON.stringify(result, null, 2));
    return result;
}

async function run(accountNumber) {
    let browser, page;
    try {
        const launchResult = await launchBrowser();
        browser = launchResult.browser;
        page = launchResult.page;

        await page.goto(
            "https://co118.cichosting.com/CTASWebPortal/parcelSearch.aspx",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);
        const details = await getPropertyDetails(page);
        await goToTaxes(page);
        const data = await getTaxRecords(page);

        const result = await populateTheObject(details, data, page);

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {
        if (browser) {
            // await browser.close(); // Recommend uncommenting so it doesn't leave orphan instances
        }
    }
}

run("368130400050");