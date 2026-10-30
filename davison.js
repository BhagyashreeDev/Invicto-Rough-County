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
    const inputSelector = "#ctl00_ctl00_cphBody_cphBodyLeft_ctrlVSInputs_rptInputs_ctl01_txtValue";
    await page.waitForSelector(inputSelector);
    await page.type(inputSelector, accountNumber);

    const searchBtnSelector = "#ctl00_ctl00_cphBody_cphBodyLeft_btnSearch";
    await page.waitForSelector(searchBtnSelector);
    await page.click(searchBtnSelector);
}

async function run(accountNumber) {
    let browserContext;
    try {
        const { browser, page } = await launchBrowser();
        browserContext = browser;

        await page.goto(
            "https://www.invoicecloud.com/portal/(S(gp3cjqxitxkzttbpmdi0quzb))/2/customerlocator.aspx?iti=8&bg=0b3648b3-dc85-4da4-9141-7e408a7cd7da&vsii=1&return=Site.aspx%3fG%3de457c8e9-dd69-4932-a778-48945f7ed9c0",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);
        
        // console.log(JSON.stringify(result, null, 2));

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("R000023874");