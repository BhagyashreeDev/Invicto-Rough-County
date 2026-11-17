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


async function run(accountNumber) {
 
    try {
        const { browser, page } = await launchBrowser();
        

        await page.goto(
            `https://taxpayments.stlouiscountymo.gov/parcel/view/${accountNumber}`,
            { waitUntil: "networkidle2", ...timeout_option }
        );

        // await searchAccountNumber(accountNumber, page);
        

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("08K620659");