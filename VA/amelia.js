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

async function handleDisclaimer(page) {
    await page.waitForSelector("#ctl00_MainContent_txtDisclaimer", timeout_option);
    await page.waitForSelector("#ctl00_MainContent_btnAccept", timeout_option);

    await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.click("#ctl00_MainContent_btnAccept", timeout_option)
    ]);
}

async function searchAccountNumber(accountNumber, page) {
    await page.waitForSelector("#ctl00_MainContent_btnAccount", timeout_option);
    await page.click("#ctl00_MainContent_btnAccount");

    await page.waitForSelector("#ctl00_MainContent_txtAccount", timeout_option);
    await page.type("#ctl00_MainContent_txtAccount", accountNumber);

    await page.waitForSelector("#ctl00_MainContent_btnSearch", timeout_option);

    await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.click("#ctl00_MainContent_btnSearch", timeout_option)
    ]);
}

async function getDetails(page) {
    await page.waitForSelector("#ctl00_MainContent_gvSearch", timeout_option);

    // ----- Amelia -------
    // handling the number of pages
    // await page.waitForSelector('.dt-paging.paging_full_numbers', timeout_option);
    // // Evaluate the state of the "Last" button
    // const isLastPageDisabled = await page.evaluate(() => {
    //     const lastButton = document.querySelector('button.page-link.last');
    //     // If the button doesn't exist, we can't click it
    //     if (!lastButton) return true;
    //     // Check if the parent <li> element has the 'disabled' class 
    //     // or if the button itself has aria-disabled="true"
    //     const parentLi = lastButton.closest('li');
    //     return parentLi.classList.contains('disabled') || lastButton.getAttribute('aria-disabled') === 'true';
    // });

    // if (!isLastPageDisabled) {
    //     // Click the button
    //     await page.click('button.page-link.last');
    //     // Wait for the new table data to load after clicking
    //     // Replace '.table-row' with a selector specific to the data that loads
    //     // await page.waitForSelector('.table-row'); 
    // }


    // ------- Bristol ---------
    await page.waitForSelector('#ctl00_MainContent_gvSearch_paginate', timeout_option);
    const isLastPageDisabled = await page.evaluate(() => {
        const lastButton = document.querySelector("#ctl00_MainContent_gvSearch_last");
        return lastButton.classList.contains("disabled");
    });

    if (!isLastPageDisabled) {
        await page.click("#ctl00_MainContent_gvSearch_last a");
    }


    // details on the main page
    const lastRowData = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#ctl00_MainContent_gvSearch tbody tr:not(.child)'));
        const lastRow = rows[rows.length - 1];
        const cells = lastRow.querySelectorAll("td");
        const text = cells[0] ? cells[0].innerText.trim() : "";
        const match = text.match(/RE(\d{4})/i);
        return {
            taxYear: match ? match[1] : null,
            accountNo: cells[3] ? cells[3].innerText.trim() : null,
            dueDate: cells[4] ? cells[4].innerText.trim() : null,
            name: cells[5] ? cells[5].innerText.trim() : null,
        };
    });
    console.log("Last row details: ", lastRowData);

    await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.evaluate(() => {
            const rows = Array.from(document.querySelectorAll('#ctl00_MainContent_gvSearch tbody tr:not(.child)'));
            const lastRow = rows[rows.length - 1];
            let detailsBtn = lastRow.nextElementSibling.querySelector('a[href*="GETTICKET"]');
            detailsBtn.click();
        })
    ]);

    await page.waitForSelector("#ctl00_MainContent_ORIGBILL", timeout_option);
    const baseTax = await page.$eval("#ctl00_MainContent_ORIGBILL", el => el.textContent.trim());
    console.log("Base tax: ", baseTax);

    await page.waitForSelector("#ctl00_MainContent_PAYMENTS", timeout_option);
    const paidAmount = await page.$eval("#ctl00_MainContent_PAYMENTS", el => el.textContent.trim());
    console.log("Paid Amount: ", paidAmount);

    await page.waitForSelector("#ctl00_MainContent_LASTDATE", timeout_option);
    const paidDate = await page.$eval("#ctl00_MainContent_LASTDATE", el => el.textContent.trim());
    console.log("Paid Date: ", paidDate);

    await page.waitForSelector("#ctl00_MainContent_TOTALOWED", timeout_option);
    const due = await page.$eval("#ctl00_MainContent_TOTALOWED", el => el.textContent.trim());
    console.log("Due: ", due);
}

async function run(accountNumber) {

    try {
        const { browser, page } = await launchBrowser();


        await page.goto(
            "https://eservices.bristolva.org/applications/trapps/REIindex.htm",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await handleDisclaimer(page);
        await searchAccountNumber(accountNumber, page);

        await getDetails(page);


    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("66818");