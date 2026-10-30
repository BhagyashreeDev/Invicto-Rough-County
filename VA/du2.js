import { resolve } from "path";
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

async function handleDisclaimer(page, browser) {
    await page.waitForSelector("#ctl00_MainContent_txtDisclaimer", timeout_option);
    await page.waitForSelector("#ctl00_MainContent_btnAccept", timeout_option);

    await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded" }),
        page.click("#ctl00_MainContent_btnAccept", timeout_option)
    ]);

    return page;

    // ----- sussex -----
    // await page.waitForSelector("#ctl00_MainContent_txtDisclaimer", timeout_option);
    // await page.waitForSelector("#ctl00_MainContent_btnAccept", timeout_option);

    // // Set up a promise to catch the new tab before clicking the accept button
    // const newPagePromise = new Promise(resolve =>
    //     browser.once("targetcreated", async target => {
    //         const newPage = await target.page();
    //         resolve(newPage);
    //     })
    // );

    // await page.click("#ctl00_MainContent_btnAccept", timeout_option);
    // console.log("I clicked the accept btn");

    // // Wait for the new tab to open and resolve its page object
    // const newPage = await newPagePromise;

    // // REMOVED: await newPage.waitForNavigation(...) - This was causing the timeout!

    // // Optionally close the old tab if you no longer need it
    // await page.close();

    // // Return the new page so subsequent functions (like searchAccountNumber) use it
    // return newPage;


}

// async function searchAccountNumber(accountNumber, page) {

//     await page.waitForSelector("#ctl00_MainContent_contentbody", timeout_option);

//     await page.waitForSelector("#ctl00_MainContent_btnAccount", timeout_option);
//     await page.click("#ctl00_MainContent_btnAccount");

//     await page.waitForSelector("#ctl00_MainContent_txtAccount", timeout_option);
//     await page.type("#ctl00_MainContent_txtAccount", accountNumber);

//     await page.waitForSelector("#ctl00_MainContent_btnSearch", timeout_option);

//     await Promise.all([
//         page.waitForNavigation({ waitUntil: "domcontentloaded" }),
//         page.click("#ctl00_MainContent_btnSearch", timeout_option)
//     ]);
// }
async function searchAccountNumber(accountNumber, page) {
    // 1. Wait a moment for any ASP.NET postback or dynamic script initialization to finish
    await new Promise(resolve => setTimeout(resolve, 2000));

    // 2. Handle potential frames if the content is nested
    // let targetPage = page;
    // const frames = page.frames();
    // const frame = frames.find(f => f.url().includes('webform1') || f.name() === '');
    // if (frame) {
    //     targetPage = frame;
    // }

    await page.waitForSelector("#ctl00_MainContent_contentbody", timeout_option);

    // 3. Wait for the button using XPath or direct selector, ensuring it's clickable
    const accountBtnSelector = "#ctl00_MainContent_btnAccount";
    await page.waitForSelector(accountBtnSelector, { visible: true, ...timeout_option });

    // Use evaluate to click in case standard .click() is intercepted by an overlay
    await page.evaluate(selector => {
        document.querySelector(selector).click();
    }, accountBtnSelector);

    // 4. Wait for input field to appear, clear it if necessary, and type
    const inputSelector = "#ctl00_MainContent_txtAccount";
    await page.waitForSelector(inputSelector, { visible: true, ...timeout_option });

    await page.click(inputSelector);
    await page.type(inputSelector, accountNumber, { delay: 100 }); // Added delay for stability

    // 5. Click Search
    const searchBtnSelector = "#ctl00_MainContent_btnSearch";
    await page.waitForSelector(searchBtnSelector, { visible: true, ...timeout_option });

    await Promise.all([
        page.waitForNavigation({ waitUntil: "domcontentloaded", ...timeout_option }),
        page.evaluate(selector => {
            document.querySelector(selector).click();
        }, searchBtnSelector)
    ]);
}

async function getDetails(page) {
    await page.waitForSelector("#ctl00_MainContent_gvSearch", timeout_option);

    // ----- Amelia, Cumberland, warren -------
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
    // ----------------------------------

    // ------- Bristol, caroline, King & Queen, Page, Rockbridge, Shenandoah, Surry, west more land ---------
    await page.waitForSelector('#ctl00_MainContent_gvSearch_paginate', timeout_option);
    const isLastPageDisabled = await page.evaluate(() => {
        const lastButton = document.querySelector("#ctl00_MainContent_gvSearch_last");
        return lastButton ? lastButton.classList.contains("disabled") : true;
    });

    if (!isLastPageDisabled) {
        await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded", ...timeout_option }).catch(() => { }), // Catch added in case it loads via AJAX instead of full navigation
            page.click("#ctl00_MainContent_gvSearch_last a"),
            console.log("-----I clicked the last page button-----")
        ]);
        // Wait for table to reload after pagination click
        await page.waitForSelector("#ctl00_MainContent_gvSearch", timeout_option);
    }
    // -------------------------------------

    // 1. Scrape all parent rows to find all available years and sequences
    const tableData = await page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll('#ctl00_MainContent_gvSearch tbody tr:not(.child)'));

        return rows.map((row) => {
            const cells = row.querySelectorAll("td");
            const deptText = cells[0] ? cells[0].innerText.trim() : "";
            const seqText = cells[2] ? cells[2].innerText.trim() : "1";

            // Extract year (e.g., "RE2026" -> 2026)
            const match = deptText.match(/RE(\d{4})/i);

            // Grab the specific __doPostBack href for this row's detail button
            // We use this to safely click the exact row later, even after page.goBack()
            const detailsBtn = row.querySelector('a[href*="GETTICKET"]');
            const clickTarget = detailsBtn ? detailsBtn.getAttribute("href") : null;

            return {
                taxYear: match ? parseInt(match[1], 10) : 0,
                seq: parseInt(seqText, 10),
                accountNo: cells[3] ? cells[3].innerText.trim() : null,
                dueDate: cells[4] ? cells[4].innerText.trim() : null,
                name: cells[5] ? cells[5].innerText.trim() : null,
                clickTarget: clickTarget
            };
        }).filter(item => item.taxYear > 0 && item.clickTarget);
    });

    if (tableData.length === 0) {
        console.log("No valid records found in the table.");
        return;
    }

    // 2. Identify the maximum tax year (e.g., 2026)
    const latestYear = Math.max(...tableData.map(d => d.taxYear));

    // 3. Filter to keep only the installments for the latest year and sort them by Sequence (1, then 2)
    const latestYearRows = tableData
        .filter(d => d.taxYear === latestYear)
        .sort((a, b) => a.seq - b.seq);

    console.log(`Found ${latestYearRows.length} installment(s) for the latest tax year: ${latestYear}`);

    // 4. Loop through each sequence/installment
    for (const rowData of latestYearRows) {
        console.log(`\n--- Fetching details for Year: ${rowData.taxYear}, Sequence: ${rowData.seq} ---`);
        console.log("Installment overview: ", {
            Account: rowData.accountNo,
            Due: rowData.dueDate,
            Name: rowData.name
        });

        // Click the corresponding details button for this sequence
        await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded", ...timeout_option }),
            page.evaluate((href) => {
                // Find the anchor matching the specific href for this sequence and click it
                const btn = document.querySelector(`a[href="${href}"]`);
                if (btn) btn.click();
            }, rowData.clickTarget)
        ]);

        // Scrape details from the inner page
        await page.waitForSelector("#ctl00_MainContent_ORIGBILL", timeout_option);
        const baseTax = await page.$eval("#ctl00_MainContent_ORIGBILL", el => el.textContent.trim());
        console.log("Base tax: ", baseTax);

        await page.waitForSelector("#ctl00_MainContent_PAYMENTS", timeout_option);
        const paidAmount = await page.$eval("#ctl00_MainContent_PAYMENTS", el => el.textContent.trim());
        console.log("Paid Amount: ", paidAmount);

        await page.waitForSelector("#ctl00_MainContent_LASTDATE", timeout_option);
        const paidDate = await page.$eval("#ctl00_MainContent_LASTDATE", el => el.textContent.trim());
        console.log("Paid Date: ", paidDate);

        await page.waitForSelector("#ctl00_MainContent_AMOUNTOWED", timeout_option);
        const due = await page.$eval("#ctl00_MainContent_AMOUNTOWED", el => el.textContent.trim());
        console.log("Due: ", due);

        // Navigate back to the search results table
        await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded", ...timeout_option }),
            page.goBack()
        ]);

        // Wait for the table to fully load again before the next loop iteration
        await page.waitForSelector("#ctl00_MainContent_gvSearch", timeout_option);
    }
}

async function run(accountNumber) {
    let browser, page;
    try {
        ({ browser, page } = await launchBrowser());

        await page.goto(
            "https://eservices.westmoreland-county.org/applications/REPublicInquiry/webform1.aspx",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        page = await handleDisclaimer(page, browser);
        await searchAccountNumber(accountNumber, page);

        await getDetails(page);

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {
        // if (browser) {
        //     await browser.close();
        // }
    }
}

run("26133");