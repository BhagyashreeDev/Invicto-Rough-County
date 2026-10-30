import puppeteer from "puppeteer";

const timeout_option = {
    timeout_option: 90000,
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
    return {browser, page};
}

async function handleDisclaimer(page) {
    await page.waitForSelector("#ctl00_MainContent_txtDisclaimer", timeout_option);
    await page.waitForSelector("#ctl00_MainContent_txtDisclaimer", timeout_option);
}