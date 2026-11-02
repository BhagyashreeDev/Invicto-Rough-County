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
    const propertyData = await page.evaluate(() => {
        const tdElement = document.querySelector('td');
        if (!tdElement) return null;

        const text = tdElement.innerText;

        // 1. Get Property Address
        const addressMatch = text.match(/Property Address:\n([\s\S]*?)\nOwner Information:/);
        const propertyAddress = addressMatch ? addressMatch[1].trim() : 'Not found';

        // 2. Get the raw Owner Information block
        const ownerMatch = text.match(/Owner Information:\n([\s\S]*?)\nView unpaid bills/);
        let ownerNames = [];

        if (ownerMatch) {
            const rawOwnerText = ownerMatch[1].trim();

            // Split the text into blocks by double newlines (the spaces between owners)
            const ownerBlocks = rawOwnerText.split(/\n\s*\n/);

            // For each block, the actual name is always the very first line
            ownerNames = ownerBlocks.map(block => {
                return block.split('\n')[0].trim();
            });
        }

        return {
            propertyAddress,
            ownerNames // Returns: ['DIEMOZ FRANCES', 'DIEMOZ JOHN', 'DERADDO CORINNE DIEMOZ']
        };
    });

    await page.goto(`https://taxsearch.gunnisoncounty.org/Prod/PropertyTaxSearchWebsite/TaxAccount/BillHistory/${accountNumber}`, { waitUntil: "networkidle2", ...timeout_option });
    

    console.log(propertyData);
}

async function run(accountNumber) {

    try {
        const { browser, page } = await launchBrowser();


        await page.goto(
            `https://taxsearch.gunnisoncounty.org/Prod/PropertyTaxSearchWebsite/TaxAccount/List?searchPhrase=${accountNumber}`,
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);


    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("R003965");