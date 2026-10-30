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
    await page.waitForSelector("#ctlBodyPane_ctl02_ctl01_txtParcelID", {visible: true, ...timeout_option});
    await page.type("#ctlBodyPane_ctl02_ctl01_txtParcelID", accountNumber);

    await page.waitForSelector("#ctlBodyPane_ctl02_ctl01_btnSearch", {visible: true, ...timeout_option});
    await Promise.all([
        page.waitForNavigation({waitUntil: "domcontentloaded", ...timeout_option}),
        page.click("#ctlBodyPane_ctl02_ctl01_btnSearch")
    ]);
}

async function run(accountNumber) {

    try {
        const { browser, page } = await launchBrowser();


        await page.goto(
            "https://beacon.schneidercorp.com/Application.aspx?AppID=1125&LayerID=28338&PageTypeID=2&PageID=11805",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        const agreeButton = await page.waitForSelector('::-p-text(Agree)');
        await agreeButton.click();

        await searchAccountNumber(accountNumber, page);


    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("C09431340000002001");