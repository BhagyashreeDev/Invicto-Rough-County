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

async function searchOwnerName(page, ownerName) {
    const ownerNameSelector = "#P3_OWNER";
    await page.waitForSelector(ownerNameSelector, { visible: true });
    await page.type(ownerNameSelector, ownerName);

    const searchButtonSelector = "#B58332429791730314";
    await page.waitForSelector(searchButtonSelector);
    await page.click(searchButtonSelector);
}

// FIX: Passed ownerName to the function
async function parseTheOwners(page, ownerName) {
    await page.waitForNetworkIdle({ idleTime: 1000 });
    const rowSelector = "tr.a-GV-row";
    let rowCount = 0;
    
    try {
        await page.waitForSelector(rowSelector, { timeout: 10000 });
        rowCount = await page.evaluate((sel) => document.querySelectorAll(sel).length, rowSelector);
        console.log(`Found ${rowCount} records for owner : "${ownerName}".`);

        const properties = await page.evaluate((sel) => {
            const rows = document.querySelectorAll(sel);
            const data = [];

            rows.forEach(row => {
                const cells = row.querySelectorAll("td");
                if (cells.length >= 4) {
                    const anchor = cells[3].querySelector("a");
                    if (anchor) {
                        data.push({
                            serial: anchor.innerText.trim(),
                            relativeUrl: anchor.getAttribute("href")
                        });
                    }
                }
            });
            return data;
        }, rowSelector);

        for (let i = 0; i < properties.length; i++) {
            const prop = properties[i];
            const detailPageUrl = `https://apps.uintah.utah.gov${prop.relativeUrl}`;
            
            try {
                console.log(`\n--- Processing Row ${i + 1} (Serial: ${prop.serial}) ---`);
                await page.goto(detailPageUrl, { waitUntil: "networkidle2" });
                
                const pageData = await page.evaluate(() => {
                    const dueElement = document.querySelector("#P4_BALANCE_DISPLAY");
                    const yearRows = document.querySelectorAll('[id^="P4_YEAR_T_DISPLAY"]');

                    let dueAmount = 0;
                    if (dueElement) {
                        const cleantext = dueElement.innerText.replace(/[^0-9.-]+/g, "");
                        dueAmount = parseFloat(cleantext) || 0;
                    }
                    
                    return {
                        due: dueAmount,
                        // FIX: Changed yearsRows.length to yearRows.length
                        yearsCount: yearRows.length 
                    };
                });

                if (pageData.due === 0) {
                    console.log(`Result: no due`);
                } else {
                    console.log(`Result: due (Amount: ${pageData.due})`);
                }

                if (pageData.yearsCount > 2) {
                    console.log(`Alert: More than 2 years found (${pageData.yearsCount} years)`);
                } else {
                    console.log(`Years found: ${pageData.yearsCount}`);
                }
                
            } catch (err) {
                console.log(`Error on row ${i + 1} detail page:`, err.message);
            }
        }

    } catch (e) {
        console.log("No results found for this user name");
        return;
    }
}

async function run(ownerName) {
    const { browser, page } = await launchBrowser();
    try {
        await page.goto(
            "https://apps.uintah.utah.gov/ords/ucdev/r/public-searches/property-search",
            {
                waitUntil: "networkidle2",
                ...timeout_option,
            },
        );

        await page.waitForSelector("body", { visible: true });
        await searchOwnerName(page, ownerName);
        
        // FIX: Passed ownerName to the function call
        await parseTheOwners(page, ownerName); 

    } catch (err) {
        console.log("Error during running: ", err);
    }
}

run("mick");