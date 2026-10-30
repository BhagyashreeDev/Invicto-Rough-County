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

    // The checkbox is in the main DOM, NOT the iframe
    const checkboxSelector = 'input[type="checkbox"]';
    await page.waitForSelector(checkboxSelector, {waitUntil: "domcontentloaded", visible: true});
    await page.click(checkboxSelector);

    // Wait for the Continue button to become enabled (disabled attribute removed)
    await page.waitForFunction(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const continueBtn = buttons.find(b => b.textContent.trim() === 'Continue');
        // Return true only when the button exists and is not disabled
        return continueBtn && !continueBtn.disabled;
    }, {waitUntil: "domcontentloaded", visible: true});

    // Click the Continue button
    await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const continueBtn = buttons.find(b => b.textContent.trim() === 'Continue');
        if (continueBtn) continueBtn.click();
    });
}

async function searchAccountNumber(accountNumber, page) {

    await page.waitForSelector('button[aria-label="Skip walkthrough"]', { waitUntil: "domcontentloaded", visible: true });
    await page.click('button[aria-label="Skip walkthrough"]');

    await page.waitForSelector("#atlas-search-input", { waitUntil: "domcontentloaded", visible: true });
    await page.type("#atlas-search-input", accountNumber);

    const searchButtonSelector = 'button[aria-label="Submit search"]';
    await page.waitForSelector(searchButtonSelector, {waitUntil: "domcontentloaded", visible: true});
    await page.click(searchButtonSelector);

    console.log("Waiting for search suggestions to appear...");
    const suggestionSelector = '#atlas-suggestion-0';
    
    // Wait for the specific suggestion button to be visible
    await page.waitForSelector(suggestionSelector, { visible: true });
    
    // Click the suggestion
    console.log("Clicking the first suggestion...");
    await page.click(suggestionSelector);
}

async function run(accountNumber) {
    let browserContext;
    try {
        const { browser, page } = await launchBrowser();

        console.log("Navigating to site...");
        await page.goto(
            "https://chesapeake.civ.quest/",
            { waitUntil: "domcontentloaded", ...timeout_option }
        );

        console.log("Handling Disclaimer...");
        await handleDisclaimer(page);

        console.log(`Searching for account: ${accountNumber}`);
        await searchAccountNumber(accountNumber, page);

    } catch (err) {
        console.error("Error during sequence execution pipeline: ", err);
    } finally {
        // if (browserContext) {
        //     console.log("Closing browser...");
        //     await browserContext.close();
        // }
    }
}

run("0590000000220");