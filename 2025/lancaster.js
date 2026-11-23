import puppeteer from "puppeteer";

const timeout_option = {
    timeout: 90000,
};

async function launchBrowser() {
    const browser = await puppeteer.launch({
        headless: false, // Set to true if you want headless
        args: [
            '--disable-gpu',
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--lang="en-US"',
            '--disable-features=HttpsFirstBalancedModeAutoEnable'
        ],
    });

    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60_000);
    page.setDefaultTimeout(30_000);
    return { browser, page };
}

// Search by owner name in Lancaster County, NE and check for due payment
const lancaster_search_by_owner = async (page, lastName, firstName = "") => {
    return new Promise(async (resolve, reject) => {
        try {
            await page.setViewport({ width: 1280, height: 800 }).catch(() => {});

            // 1. Navigate to default search page
            const url = `https://app.lincoln.ne.gov/aspx/cnty/cto/default.aspx`;
            await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });

            // 2. Enter Owner Last Name and optional First Name
            await page.waitForSelector('#ctl00_ctl00_cph1_cph1_tcOptions_tpOwner_txtLName', timeout_option);
            await page.type('#ctl00_ctl00_cph1_cph1_tcOptions_tpOwner_txtLName', lastName);

            if (firstName) {
                await page.type('#ctl00_ctl00_cph1_cph1_tcOptions_tpOwner_txtFName', firstName);
            }

            // 3. Click Name Search button
            await Promise.all([
                page.click('#ctl00_ctl00_cph1_cph1_tcOptions_tpOwner_btnOwner'),
                page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 })
            ]);

            // 4. Check results table
            await page.waitForSelector('#ctl00_ctl00_cph1_cph1_gvProperty', timeout_option);
            
            // Get all View links/buttons IDs
            const viewButtonIds = await page.$$eval('#ctl00_ctl00_cph1_cph1_gvProperty a[id*="btnSelect"]', links => 
                links.map(l => l.id)
            );

            console.log(`Found ${viewButtonIds.length} properties for owner: ${lastName}`);

            if (viewButtonIds.length === 0) {
                return reject(new Error("No Records Found"));
            }

            // 5. Iterate through results and inspect Property Payment Calculator
            for (let i = 0; i < viewButtonIds.length; i++) {
                const btnId = viewButtonIds[i];
                console.log(`Checking property ${i + 1} of ${viewButtonIds.length}...`);

                // Click View
                await Promise.all([
                    page.click(`#${btnId}`),
                    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 60000 })
                ]);

                // Extract property & calculator details
                const result = await page.evaluate(() => {
                    const parcel = document.querySelector('#ctl00_ctl00_cph1_cph1_fvProperty_lblParcel')?.innerText?.trim() || "";
                    const owner = document.querySelector('#ctl00_ctl00_cph1_cph1_fvProperty_lblPowner')?.innerText?.trim() || "";
                    const address = document.querySelector('#ctl00_ctl00_cph1_cph1_fvProperty_lblSsAddr')?.innerText?.trim() || "";
                    
                    const calcBox = document.querySelector('#ctl00_ctl00_cph1_cph1_panCalc');
                    const notFoundSpan = document.querySelector('#ctl00_ctl00_cph1_cph1_rpPaymentYears_ctl01_lblNotFound');
                    const notFoundText = notFoundSpan?.innerText?.trim() || "";
                    const calcText = calcBox?.innerText?.trim() || "";

                    const isPaid = notFoundText.toLowerCase().includes("no payment is due");

                    return {
                        parcel,
                        owner,
                        address,
                        isPaid,
                        notFoundText,
                        calcText
                    };
                });

                console.log(`Parcel: ${result.parcel} | Status: ${result.isPaid ? 'No Payment Due' : 'PAYMENT DUE / OTHER'}`);

                // If it is NOT "No Payment is Due.", we found the target parcel!
                if (!result.isPaid) {
                    console.log("\n================ FOUND UNPAID PARCEL ================");
                    console.log(`Parcel Number : ${result.parcel}`);
                    console.log(`Owner         : ${result.owner}`);
                    console.log(`Address       : ${result.address}`);
                    console.log(`Calculator    : \n${result.calcText}`);
                    console.log("====================================================\n");
                    return resolve(result);
                }

                // Go back to search results if not the last one
                if (i < viewButtonIds.length - 1) {
                    await page.goBack({ waitUntil: "domcontentloaded" });
                    await page.waitForSelector('#ctl00_ctl00_cph1_cph1_gvProperty', timeout_option);
                }
            }

            resolve(null);

        } catch (error) {
            console.log("Lancaster Search Error:", error.message);
            reject(error);
        }
    });
};

async function run(ownerLastName, ownerFirstName = "") {
    let browserInstance = null;
    try {
        const { browser, page } = await launchBrowser();
        browserInstance = browser;

        const result = await lancaster_search_by_owner(page, ownerLastName, ownerFirstName);
        if (!result) {
            console.log("All properties checked for this owner were fully paid (No Payment is Due).");
        }
    } catch (err) {
        console.log("Error during execution:", err.message);
    } finally {
        // if (browserInstance) await browserInstance.close();
    }
}

// Example: Search common last name
run("SMITH");