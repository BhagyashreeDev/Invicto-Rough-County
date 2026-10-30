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
    const [year, receiptNumber] = accountNumber.split("-");
    await page.select("#searchType", 'receiptfields');

    // await page.waitForSelector('receiptfields', { visible: true });
    await page.type("#year", year);
    await page.type("#receipt", receiptNumber);

    await Promise.all([
        page.waitForNavigation({ waitUntil: 'networkidle0' }),
        page.click('#submitbutton')
    ]);

    await page.waitForSelector('table#example');
    await page.evaluate(() => {
        const viewIcon = document.querySelector('img[src="images/view.png"]');
        if (viewIcon) {
            viewIcon.click();
        }
    });
}

async function extractPropertyInfo(page) {
    await page.waitForSelector('.panel-body');
    const taxData = await page.evaluate(() => {
        const getValueByLabel = (labelText) => {
            const cells = Array.from(document.querySelectorAll('.panel-body td[align="left"]'));
            const targetCell = cells.find(td => td.textContent.includes(labelText));
            return targetCell ? targetCell.nextElementSibling.textContent.trim() : null;
        };

        return {
            ownerName: getValueByLabel('Owner:'),
            address: getValueByLabel('Property Address:'),
            assessedValue: getValueByLabel('Assessed Value:'),
            status: document.querySelector('div[style="color:green"]')?.textContent.trim() || 'UNKNOWN',
            taxAmount: getValueByLabel('Tax Amount:')
        };
    });

    console.log(taxData);
    return taxData;
}

async function clickViewTaxHistoryTab(page) {
    const clicked = await page.evaluate(() => {
        const links = Arrys.from(document.querySelectorAll('a[data-toggle="tab"]'));
        const target = links.find((a) => a.textContent.replace(/\s+/g, " ").trim().toLowerCase().includes("view tax history"));
        target.click();
        return true;
    });

    if (!clicked) {
        throw new Error('"View Tax History" tab link not found');
    }
    await page.waitForFunction(() => {
        const table = document.querySelector("#main table#example");
        return !!table && table.querySelectorAll("tbody tr").length > 0;
    }, timeout_option);
}

async function extractTaxHistory(page) {
    await page.waitForSelector("#main table#example tbody tr", timeout_option);
    return page.evaluate(() => {
        const rows = Array.from(document.querySelectorAll("#main table#example tbody tr"));
        return rows.map((tr) => {
            const cells = tr.querySelectorAll("td");
            if (cells.length < 5) return null;
            return {
                taxYear: cells[0].textContent.trim(),
                taxAmount: cells[1].textContent.trim(),
                taxAmount: cells[2].textContent.replace(/\s+/g, " ").trim(),
                taxPaid: cells[3].textContent.replace(/\s+/g, " ").trim(),
                dateLastPaid: cells[4].textContent.replace(/\s+/g, " ").trim(),
            };
        }).filter(Boolean);
    });
}

function isPaidStatus(statusText) {
    return typeof statusText === "string" && statusText.toLowerCase().includes("paid");
}

async function run(accountNumber) {
    let browserContext;
    try {
        const { browser, page } = await launchBrowser();


        await page.goto(
            "https://tennesseetrustee.org/index.php?entity=crockett&state=TN",
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await searchAccountNumber(accountNumber, page);

        let taxHistory = [];
        const propertyInfo = await extractPropertyInfo(page);
        if (isPaidStatus(propertyInfo.status)) {
            await clickViewTaxHistoryTab(page);
            taxHistory = await extractTaxHistory(page);
            console.log(taxHistory);
        }

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("2025-3977");