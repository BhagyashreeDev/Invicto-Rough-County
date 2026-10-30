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

    // Page 1: Used for search and pagination
    const searchPage = await browser.newPage();
    searchPage.setDefaultNavigationTimeout(60_000);
    searchPage.setDefaultTimeout(30_000);

    // Page 2: Used for visiting individual accounts
    const detailPage = await browser.newPage();
    detailPage.setDefaultNavigationTimeout(60_000);
    detailPage.setDefaultTimeout(30_000);

    return { browser, searchPage, detailPage };
}

async function searchName(searchPage, ownerName) {
    // 1. Wait for the search pane container
    await searchPage.waitForSelector("#dnn_ctr449_ContentPane", { visible: true });
    
    // 2. Click the expand button to reveal search options
    const expandBtnSelector = "button[title='Search Options']";
    await searchPage.waitForSelector(expandBtnSelector, { visible: true });
    await searchPage.click(expandBtnSelector);

    // Give the UI animation a brief moment to slide down/expand
    await new Promise(resolve => setTimeout(resolve, 1000));

    // 3. Now wait for the Name input selector to become fully visible
    const nameInputSelector = "input[name='Owner']";
    await searchPage.waitForSelector(nameInputSelector, { visible: true });
    
    // 4. Clear existing text and type the new name
    await searchPage.click(nameInputSelector, { clickCount: 3 });
    await searchPage.keyboard.press('Backspace');
    await searchPage.type(nameInputSelector, ownerName, { delay: 50 });

    // 5. Wait for the Search button to be enabled and click it
    const executeSearchBtnSelector = "button[title='Search']";
    await searchPage.waitForSelector(`${executeSearchBtnSelector}:not([disabled])`, { visible: true });

    await Promise.all([
        searchPage.waitForNavigation({ waitUntil: "domcontentloaded" }),
        searchPage.click(executeSearchBtnSelector)
    ]);
}

async function processSearchResults(searchPage, detailPage) {
    let hasNextPage = true;
    const accountsWithDues = [];

    while (hasNextPage) {
        // 1. Wait for the search results container and "View Account" buttons to render
        await searchPage.waitForSelector("a[title^='View Account']", { visible: true, timeout: timeout_option.timeout });

        // 2. Extract all URLs and PINs for the current page
        const accountLinks = await searchPage.evaluate(() => {
            const links = document.querySelectorAll("a[title^='View Account']");
            return Array.from(links).map(link => {
                return {
                    url: link.href,
                    // Extracting PIN from the title (e.g., "View Account 000200030070")
                    pin: link.title.replace('View Account', '').trim() 
                };
            });
        });

        console.log(`Found ${accountLinks.length} accounts on the current page. Processing...`);

        // 3. Process each account in the detail tab
        for (const account of accountLinks) {
            console.log(`Checking account: ${account.pin}`);
            
            try {
                await detailPage.goto(account.url, { waitUntil: "networkidle2", ...timeout_option });
                
                // Wait for the due amount element to appear
                await detailPage.waitForSelector("#dnn_ctr464_ModuleContent", { visible: true, timeout: 10000 });
                
                const dueText = await detailPage.evaluate(() => {
                    const spanElement = document.querySelector(".grand-total-bill-amount");
                    return spanElement ? spanElement.textContent.trim() : null;
                });

                if (dueText) {
                    // Convert text like "$1,234.56" to a float number 1234.56
                    const numericDue = parseFloat(dueText.replace(/[^0-9.-]+/g, ""));
                    
                    if (numericDue > 0) {
                        console.log(`[ALERT] Account ${account.pin} has a balance due: $${numericDue}`);
                        accountsWithDues.push({
                            pin: account.pin,
                            due: numericDue,
                            url: account.url
                        });

                        // -> YOU CAN CALL YOUR fetchDetails() HERE IF YOU NEED THE FULL PROPERTY OBJECT <-
                    }
                }
            } catch (error) {
                console.log(`Skipping ${account.pin} due to timeout/error reading due amount.`);
            }
        }

        // 4. Check if there is a "Next Page" button and if it is disabled
        const nextButtonSelector = 'div[bento-test="next-button"] button';
        const isNextDisabled = await searchPage.evaluate((selector) => {
            const btn = document.querySelector(selector);
            // Returns true if the button doesn't exist, or if it has the disabled property
            return btn ? btn.disabled : true; 
        }, nextButtonSelector);

        if (!isNextDisabled) {
            console.log("Moving to the next page of results...");
            await searchPage.click(nextButtonSelector);
            
            // Wait for the UI to update with new records. 
            // Because this is an Angular/SPA pagination, it won't trigger a full page navigation.
            // A short delay gives the DOM time to replace the table rows.
            await new Promise(resolve => setTimeout(resolve, 3000)); 
        } else {
            console.log("Reached the last page.");
            hasNextPage = false;
        }
    }

    return accountsWithDues;
}

async function run(ownerName) {
    let browser;
    try {
        const setup = await launchBrowser();
        browser = setup.browser;
        const searchPage = setup.searchPage;
        const detailPage = setup.detailPage;

        await searchPage.goto(
            "https://id-kootenai.publicaccessnow.com/Treasurer/TaxSearch.aspx",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        // 1. Enter the name and search
        await searchName(searchPage, ownerName);

        // 2. Process all paginated results and capture the ones with dues
        const delinquentAccounts = await processSearchResults(searchPage, detailPage);
        
        console.log("\n=================================");
        console.log("FINAL RESULTS: ACCOUNTS WITH DUES");
        console.log("=================================");
        console.table(delinquentAccounts);

    } catch (err) {
        console.error("Error during sequence execution pipeline: ", err);
    } finally {
        if (browser) {
            await browser.close();
        }
    }
}

// Run the script using the owner name
run("Albert");