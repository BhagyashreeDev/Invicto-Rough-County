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

async function getDetails(page) {
    const data = await page.evaluate(() => {
        const getTextAfterLabel = (labelText) => {
            const labels = Array.from(document.querySelectorAll('strong'));
            const el = labels.find(l => l.textContent.trim().toLowerCase() === labelText.toLowerCase());
            if (!el || !el.parentElement) return null;
            return el.parentElement.textContent.replace(el.textContent, '').trim();
        }

        return {
            address: getTextAfterLabel('Situs Address')
        };
    });

    console.log(data);
}


async function run(accountNumber) {
 
    try {
        const { browser, page } = await launchBrowser();
        

        await page.goto(
            "https://treasurer.lincolncountyco.us:8443/assessor/taxweb/search.jsp",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await getDetails(page);
        

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("R000492");