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

async function getDetails(page) {
    // 1. Owner Name & Property Address
    const ownerName = await page.$eval('#MainContent_lblGIOwnerNameBanner', el => el.innerText.trim());

    const propertyAddress = await page.$eval('#MainContent_lblGIPhysicalAddress', el => {
        return el.innerText.replace('PROPERTY ADDRESS:', '').trim();
    });

    // 2. Assessed & Taxable Values
    const assessments = await page.evaluate(() => {
        const table = document.querySelector('#MainContent_PropertyContainer_tpAssessments_TaxableValuesGrid');
        if (!table) return { assessed: null, taxable: null };

        const rows = Array.from(table.querySelectorAll('tr'));
        for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length > 0) {
                return {
                    assessed: cells[1].innerText.trim(),
                    taxable: cells[3].innerText.trim()
                };
            }
        }

        return { assessed: null, taxable: null };
    });

    console.log({
        ownerName,
        propertyAddress,
        assessedValue: assessments.assessed,
        taxableValue: assessments.taxable
    });

    // 3. Find most recent year
    const targetYearInfo = await page.evaluate(() => {
        const links = Array.from(document.querySelectorAll('.year-links-table a'));
        let maxYear = -1;
        let targetId = null;

        links.forEach(link => {
            const yr = parseInt(link.innerText.trim(), 10);
            if (!isNaN(yr) && yr > maxYear) {
                maxYear = yr;
                targetId = link.id;
            }
        });

        return { maxYear, targetId };
    });

    // Click the year link and navigate
    await Promise.all([
        page.waitForNavigation({ waitUntil: 'domcontentloaded' }),
        page.click(`#${targetYearInfo.targetId}`)
    ]);

    // 4. Extract Base Tax Amount (Charged) from Taxes tab
    const taxes = await page.evaluate(() => {
        const parseCurrency = (str) => {
            if (!str) return 0;
            return parseFloat(str.replace(/[\$,]/g, '').trim()) || 0;
        };

        const getCharged = (tableId, chargedIdx) => {
            const table = document.querySelector(tableId);
            if (!table) return 0;
            const rows = Array.from(table.querySelectorAll('tr'));
            for (const row of rows) {
                const cells = Array.from(row.querySelectorAll('td'));
                if (cells.length > 0 && cells[0].innerText.trim().toUpperCase() === 'TOTAL') {
                    return parseCurrency(cells[chargedIdx]?.innerText);
                }
            }
            return 0;
        };

        const adValCharged = getCharged('#MainContent_PropertyContainer_tpTaxes_TaxesGrid', 2);
        const nonAdCharged = getCharged('#MainContent_PropertyContainer_tpTaxes_TaxesNonAdValoremGrid', 1);

        return {
            baseTaxAmount: `$${(adValCharged + nonAdCharged).toFixed(2)}`
        };
    });

    // 5. Visually switch to Payment History tab (optional)
    const historyTab = await page.$('#__tab_MainContent_PropertyContainer_tpTransactionHistory');
    if (historyTab) {
        await historyTab.click();
    }

    // 6. Extract Paid Date & Paid Amount from Payment History Grid
    const paymentInfo = await page.evaluate((targetYear) => {
        const table = document.querySelector('#MainContent_PropertyContainer_tpTransactionHistory_TransactionHistoryGrid');
        if (!table) return { paidDate: null, amountPaid: "$0.00" };

        const rows = Array.from(table.querySelectorAll('tr'));
        for (const row of rows) {
            const cells = Array.from(row.querySelectorAll('td'));
            if (cells.length > 5 && cells[0].innerText.trim() === String(targetYear)) {
                return {
                    paidDate: cells[4].innerText.trim(),  // Payment Date
                    amountPaid: cells[5].innerText.trim() // Paid Amount from receipt
                };
            }
        }
        return { paidDate: null, amountPaid: "$0.00" };
    }, targetYearInfo.maxYear);

    // Final Consolidated Result
    const finalResult = {
        ownerName,
        propertyAddress,
        assessedValue: assessments.assessed,
        taxableValue: assessments.taxable,
        selectedYear: targetYearInfo.maxYear,
        baseTaxAmount: taxes.baseTaxAmount,
        amountPaid: paymentInfo.amountPaid, // <-- from Payment History!
        paidDate: paymentInfo.paidDate      // <-- from Payment History!
    };

    console.log('\n================ FINAL RESULT ================');
    console.log(JSON.stringify(finalResult, null, 2));
}

async function run(accountNumber) {
    try {
        const { browser, page } = await launchBrowser();

        await page.goto(
            `https://dixie.floridatax.us/PropertyDetail?p=${accountNumber}`,
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await getDetails(page);
    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    }
}

run("360913-45100000-0120");