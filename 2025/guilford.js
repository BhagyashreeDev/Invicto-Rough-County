import puppeteer from "puppeteer";

const timeout_option = {
    timeout: 90000,
};

async function launchBrowser() {
    const browser = await puppeteer.launch({
        headless: false,
        args: [
            '--disable-gpu',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--lang="en-US"',
            "--disable-features=HttpsFirstBalancedModeAutoEnable"
        ],
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60_000);
    page.setDefaultTimeout(30_000);
    return { browser, page };
}

async function searchAccountNumber(accountNumber, page) {
    await page.waitForSelector("#simpleSearch", timeout_option);
    await page.type("#simpleSearch", accountNumber);

    await page.keyboard.press('Enter');
}

async function run(accountNumber) {
 
    try {
        const { browser, page } = await launchBrowser();
        

        await page.goto(
            "https://lrcpwa.ncptscloud.com/guilford/parcel-search",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);
        

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("7865-30-3763");