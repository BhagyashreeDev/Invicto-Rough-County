// CLAUDEFLARE - CAPTCHA

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

async function searchAccountNumber(accountNumber, page) {
    
}

async function run(accountNumber) {
 
    try {
        const { browser, page } = await launchBrowser();
        

        await page.goto(
            `https://troupcountyga.governmentwindow.com/select-map-code.html?mode=&lang=&map_code=${accountNumber}`,
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);
        

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("R000023874");