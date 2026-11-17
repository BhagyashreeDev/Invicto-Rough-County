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

// Search for parcel
const jc_1 = async (page, account) => {
	return new Promise(async (resolve, reject) => {
		try {
			// Ensure desktop viewport so #search-results (d-none d-md-block) is visible
			await page.setViewport({ width: 1280, height: 800 }).catch(() => {});

			// SEARCH PAGE
			const url = `https://jeffersoncountyoh.com/auditor/real-estate`;
			await page.goto(url, { waitUntil: "domcontentloaded" });

			// PARCEL FIELD
			await page.waitForSelector('input[type="email"]', timeout_option);
			const inputs = await page.$$('input[type="email"]');
			if (inputs.length < 4) return reject(new Error("Parcel input not found"));
			await inputs[3].type(account);

			// SEARCH CLICK
			await page.waitForSelector('button.btn.btn-primary', timeout_option);
			await page.click('button.btn.btn-primary');

			// RESULTS TABLE
			await page.waitForSelector('#search-results table, .clickable', timeout_option);
			const rowCount = await page.$$eval('#search-results table tbody tr.clickable', rows => rows.length).catch(() => 0);

			if (rowCount !== 1) {
				return reject(new Error(rowCount === 0 ? "No Record Found" : "Account Number is Invalid"));
			}

			// CAPTURE NEW TAB SAFELY (WITH DIRECT FALLBACK IF POP-UP IS BLOCKED)
			let detailPage = null;

			const targetPromise = new Promise((resolveTarget, rejectTarget) => {
				const timeout = setTimeout(() => {
					rejectTarget(new Error("New tab did not open"));
				}, 10000);

				const listener = async target => {
					try {
						if (target.type() === 'page') {
							const p = await target.page();
							if (p) {
								clearTimeout(timeout);
								page.browser().off('targetcreated', listener);
								resolveTarget(p);
							}
						}
					} catch (err) {
						// ignore and wait for page attachment
					}
				};

				page.browser().on('targetcreated', listener);
			});

			// Trigger row click safely
			await page.evaluate(() => {
				const row = document.querySelector('#search-results table tbody tr.clickable') || document.querySelector('.clickable');
				if (row) row.click();
			});

			try {
				detailPage = await targetPromise;
			} catch (err) {
				// Fallback: If Chrome pop-up blocker blocked window.open, navigate directly
				const currentYear = new Date().getFullYear();
				const ownerParam = "                          " + account.trim() + "        ";
				const fallbackUrl = `http://www1.jeffersoncountyoh.com/taxdata/JefPub3.dbw?Owner=${encodeURIComponent(ownerParam)}&SelectYear=${currentYear - 1}`;
				await page.goto(fallbackUrl, { waitUntil: "domcontentloaded", timeout: 90000 });
				detailPage = page;
			}

			if (!detailPage) return reject(new Error("Failed to capture new detail page"));

			// FOCUS PAGE & ENSURE DETAIL CONTENT IS LOADED
			await detailPage.bringToFront().catch(() => {});
			await detailPage.waitForSelector('table', { timeout: 30000 }).catch(() => {});

			resolve(detailPage);

		} catch (error) {
			console.log("JC ERROR:", error.message);
			reject(new Error(error.message));
		}
	});
};


async function run(accountNumber) {
 
    try {
        const { browser, page } = await launchBrowser();
        

        jc_1(page, accountNumber);

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {

    }
}

run("24-01153-001");