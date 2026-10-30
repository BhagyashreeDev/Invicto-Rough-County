import puppeteer from "puppeteer";

const timeout_option = {
    timeout: 90000,
};

async function launchBrowser() {
    const browser = await puppeteer.launch({
        headless: true,
        defaultViewport: null,
        args: ["--start-maximized"],
    });
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(60_000);
    page.setDefaultTimeout(30_000);
    return { browser, page };
}

async function autoScrollToElement(page, selector) {
    await page.evaluate(async (targetSelector) => {
        await new Promise((resolve) => {
            let totalHeight = 0;
            const distance = 100;
            const timer = setInterval(() => {
                window.scrollBy(0, distance);
                totalHeight += distance;

                const element = document.querySelector(targetSelector);
                if (element || totalHeight >= document.body.scrollHeight) {
                    clearInterval(timer);
                    resolve();
                }
            }, 100);
        });
    }, selector);
}

// Extracted into a helper function to reuse during the loop
async function acceptDisclaimer(page) {
    const agreeBtnHandle = await page.waitForFunction(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const targetBtn = buttons.find(btn => btn.textContent.trim() === 'I AGREE');
        return targetBtn || null;
    }, { timeout: 30000 });
    
    await page.evaluate(() => {
        const textarea = document.querySelector('textarea[name="wlDisclamerWords"]') || document.querySelector('textarea');
        if (textarea) {
            textarea.scrollTop = textarea.scrollHeight;
            textarea.dispatchEvent(new Event('scroll', { bubbles: true }));
        }
    });
    
    await new Promise(r => setTimeout(r, 1000));
    await agreeBtnHandle.click();
    await new Promise(r => setTimeout(r, 2000)); // Wait for UI transition
}

async function searchOwnerName(page, ownerName) {
    const ownerInputSelector = 'input[name="fOwnerName"]';
    await page.waitForSelector(ownerInputSelector, { visible: true });

    // Clear input just in case of state retention
    await page.evaluate((sel) => { document.querySelector(sel).value = ''; }, ownerInputSelector);
    
    await page.click(ownerInputSelector);
    await page.type(ownerInputSelector, ownerName, { delay: 100 });

    const searchBtnHandle = await page.waitForFunction(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(b => b.textContent.trim() === 'Search');
    });

    await searchBtnHandle.click();
    
    // Buffer for the WebSocket to return results and paint the table
    await new Promise(r => setTimeout(r, 4000));
}

async function clickRowIndex(page, index) {
    const rowSelector = '.dt-scroll-body table tbody tr:not(.dt-empty)';
    await page.waitForSelector(rowSelector);
    
    const rows = await page.$$(rowSelector);
    if (index >= rows.length) return false;

    // Double click the specific row for this iteration
    await rows[index].click({ clickCount: 2 });
    console.log(`Double-clicked row ${index + 1}. Waiting for Xojo container to load...`);

    const xojoContainerSelector = 'div.XojoContainer';
    await page.waitForSelector(xojoContainerSelector, { visible: true, timeout: 30000 });

    await new Promise(r => setTimeout(r, 4000)); 
    return true;
}

async function extractXojoData(page) {
    return await page.evaluate(() => {
        const labels = [];
        const values = [];
        const result = {};

        const elements = document.querySelectorAll('div.XojoContainer .XojoLabel');

        elements.forEach(el => {
            const text = el.innerText.trim();
            if (!text) return; 

            const topStyle = el.style.top;
            if(!topStyle) return;

            const topVal = parseInt(topStyle.replace('px', ''), 10);
            const leftVal = parseInt(el.style.left.replace('px', ''), 10);

            if (text.endsWith(':') || leftVal < 400) {
                labels.push({ text: text.replace(':', '').trim(), top: topVal });
            } else {
                values.push({ text: text, top: topVal });
            }
        });

        labels.forEach(label => {
            const matchingValue = values.find(val => Math.abs(val.top - label.top) <= 5);
            result[label.text] = matchingValue ? matchingValue.text : "N/A";
        });

        return result;
    });
}

async function run(ownerName) {
    const { browser, page } = await launchBrowser();
    try {
        await page.goto("https://www.morgancountyutah.gov/", {
            waitUntil: "networkidle2",
            ...timeout_option,
        });

        const carouselWidgetSelector = '[id="1827084358"]';
        const taxRollSelector = 'a[href*="taxroll.cloudapput.com"]';
        await autoScrollToElement(page, carouselWidgetSelector);
        await page.waitForSelector(taxRollSelector); 
        await new Promise(r => setTimeout(r, 1500));
        
        const newTargetPromise = browser.waitForTarget(
            (target) => target.opener() === page.target()
        );
        
        await page.evaluate((selector) => {
            const links = Array.from(document.querySelectorAll(selector));
            const targetLink = links.find(el => el.textContent.toLowerCase().includes("view taxroll"));
            if (targetLink) targetLink.click();
            else if (links.length > 0) links[0].click(); 
        }, taxRollSelector);

        const newTarget = await newTargetPromise;
        const newPage = await newTarget.page();

        await newPage.bringToFront();
        await newPage.waitForNetworkIdle();
        
        // 1. Initial Access & Search
        await acceptDisclaimer(newPage);
        await searchOwnerName(newPage, ownerName);
        
        const rowSelector = '.dt-scroll-body table tbody tr:not(.dt-empty)';
        let rowCount = 0;
        
        try {
            await newPage.waitForSelector(rowSelector, { timeout: 10000 });
            rowCount = await newPage.evaluate((sel) => document.querySelectorAll(sel).length, rowSelector);
            console.log(`Found ${rowCount} records for owner: "${ownerName}".`);
        } catch (e) {
            console.log("No results found or table took too long to load.");
            await browser.close();
            return;
        }

        const flaggedParcels = [];

        // 2. Loop through every row
        for (let i = 0; i < rowCount; i++) {
            if (i > 0) {
                // To guarantee clean state and avoid broken SPA "Back" transitions, 
                // we refresh the page and rerun the search to click the next row index.
                console.log(`\nReloading session to fetch row ${i + 1}...`);
                await newPage.reload({ waitUntil: "networkidle2" });
                await acceptDisclaimer(newPage);
                await searchOwnerName(newPage, ownerName);
                await newPage.waitForSelector(rowSelector);
            }

            const success = await clickRowIndex(newPage, i);
            if (!success) continue;

            const extractedData = await extractXojoData(newPage);
            
            const parcelNumber = extractedData["Parcel Number"] || "Unknown";
            const backTaxFlag = extractedData["Back Tax Flag"] || "N/A";

            console.log(`--> Parcel: ${parcelNumber} | Back Tax Flag: ${backTaxFlag}`);

            // Check condition: Exists, is not the default clean string, and is not N/A
            if (backTaxFlag !== "No Back Taxes Owed" && backTaxFlag !== "N/A") {
                flaggedParcels.push(parcelNumber);
            }
        }

        console.log("\n=== FINAL PARCELS WITH BACK TAXES ===");
        console.log(flaggedParcels);

    } catch (err) {
        console.log("Error during scraping execution: ", err);
    } finally {
        // Optional: Keep browser open to review, or close it automatically
        // await browser.close(); 
    }
}

// Execute with the requested name
run("james");