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

    const propertyUrl = `https://travis.go2gov.net/showPropertyInfo.do?account=${accountNumber}`;
  
    await page.goto(
      propertyUrl,
      { waitUntil: "networkidle2", ...timeout_option },
    );

    await page.waitForSelector("#app-content", { visible: true });

    // get ownerName
    const propertyData = await page.evaluate(() => {
      let ownerName = "";
      const labels = Array.from(document.querySelectorAll("label"));
      for (let label of labels) {
        if (label.innerText.includes("Owner Name")) {
          ownerName = label.parentElement.innerText
            .replace("Owner Name", "")
            .trim();
        }
      }
      const receiptsLink = document.querySelector('a[href^="showPaymentReceipts.do"]')?.href;
      const propertyLink = document.querySelector('a[href^="showPropertyInfo.do"]')?.href;
      return {ownerName, receiptsLink, propertyLink};
    });

    console.log("Owner Name :", propertyData);

    const receiptsLink = propertyData.receiptsLink; 
    const propertyLink = propertyData.propertyLink;
    const cartLink = "https://travis.go2gov.net/cart/responsive/cart/display.do?cartId=null&referenceId=null";

    // getting tables of 2025 or previous
    const taxYearStatus = await page.evaluate(() => {
      const h4Elements = Array.from(document.querySelectorAll("h4"));
      const has2025Tax = h4Elements.some((h4) =>
        h4.innerHTML.includes("2025 Tax Year Taxes Due")
      );
      const hasPreviousTax = h4Elements.some((h4) =>
        h4.innerText.includes("Previous Tax Year Taxes Due")
      );
      return {
        has2025Tax,
        hasPreviousTax,
      };
    });

    console.log("Table Status :", taxYearStatus);

    if (taxYearStatus.has2025Tax) {
        await page.waitForSelector("table.u-full-width tbody tr", {visible: true});
        
        const taxDetails = await page.evaluate(() => {
            // Find the correct h4 first to scope the table search
            const headers = Array.from(document.querySelectorAll("h4"));
            const targetH4 = headers.find(h => h.innerText.includes("2025 Tax Year Taxes Due"));
            if (!targetH4) return null;

            // Find the table that follows this specific h4
            let sibling = targetH4.nextElementSibling;
            let table = null;
            while (sibling) {
                table = sibling.tagName === 'TABLE' ? sibling : sibling.querySelector("table.u-full-width");
                if (table) break;
                sibling = sibling.nextElementSibling;
            }

            if (!table) return null;
            const row = table.querySelector("tbody tr");
            if (!row) return null;

            const cells = row.querySelectorAll("td");
            const taxYear = cells[0].innerText.trim();
            const yearEle = cells[0].querySelector("a");
            const yearLink = yearEle ? yearEle.href : "";
            const baseDue = cells[1].innerText.trim();
            const totalDue = cells[4].innerText.trim();

            return {
                taxYear,
                yearLink,
                baseDue,
                totalDue
            };
        });

        console.log("The current year tax details:", taxDetails);

        if (taxDetails && taxDetails.yearLink) {
            // get assesssed value
            await page.goto(taxDetails.yearLink, {waitUntil: "networkidle2"});
            const assessedAndTaxableValue = await page.evaluate(() => {
                const rows = Array.from(document.querySelectorAll("table.u-full-width tbody tr"));
                let assessedValue = "";
                let taxableValue = "";
                 if (rows.length > 0) {
                    const cells = rows[0].querySelectorAll("td");
                    assessedValue = cells[1]?.innerText.trim();
                    taxableValue = cells[2]?.innerText.trim();
                }
                return {assessedValue, taxableValue};
            });

            console.log("Assessed and taxable value:", assessedAndTaxableValue);
            
            // Navigate back if necessary before proceeding, or use receiptsLink
            // (Assuming your script logic handles the navigation flow here correctly)
        }

        // the current year tax is paid
        if (taxDetails && taxDetails.baseDue === "$0.00" && taxDetails.totalDue === "$0.00") {
            await page.goto(receiptsLink, {waitUntil: "networkidle2", ...timeout_option});

            console.log("Recent year is paid");
            await page.waitForSelector("table.u-full-width tbody tr", {visible: true});
            const pdfUrl = await page.evaluate((targetYear) => {
                const rows = Array.from(document.querySelectorAll("table.u-full-width tbody tr"));
                for (let row of rows) {
                    const cells = row.querySelectorAll("td");
                    if (cells[1] && cells[1].innerText.trim() === targetYear) {
                        const linkEl = cells[0].querySelector("a");
                        return linkEl ? linkEl.href : null;
                    }
                }
                return null;
            }, taxDetails.taxYear);

            if (pdfUrl) {
                console.log("Found URL:", pdfUrl);
            } else {
                console.log("Didnt find the url");
            }
        } else { // that year tax is due.
            console.log("Recent Year is Due:", taxDetails);
        }
    }

    if (taxYearStatus.hasPreviousTax) {
        // Go back to the property page in case the 2025 logic navigated away
        await page.goto(propertyUrl, {waitUntil: "networkidle2", ...timeout_option});
        await page.waitForSelector("table.u-full-width tbody tr", {visible: true});
        
        const yearsUrl = await page.evaluate(() => {
            // Find the correct h4 first to scope the table search
            const headers = Array.from(document.querySelectorAll("h4"));
            const targetH4 = headers.find(h => h.innerText.includes("Previous Tax Year Taxes Due"));
            if (!targetH4) return null;

            // Find the table that follows this specific h4
            let sibling = targetH4.nextElementSibling;
            let table = null;
            while (sibling) {
                table = sibling.tagName === 'TABLE' ? sibling : sibling.querySelector("table.u-full-width");
                if (table) break;
                sibling = sibling.nextElementSibling;
            }

            if (!table) return null;
            const row = table.querySelector("tbody tr");
            if (!row) return null;
            
            const linkElement = row.querySelector("td a");
            return linkElement ? linkElement.href : null;
        });

        if (yearsUrl) {
            await page.goto(yearsUrl, {waitUntil: "networkidle2", timeout: 90000});
            await page.waitForSelector("table.u-full-width", {visible: true});

            const allTaxRecords = await page.evaluate(() => {
                const rows = Array.from(document.querySelectorAll("table.u-full-width tbody tr"));
                return rows.map(row => {
                    const cells = row.querySelectorAll("td");
                    if (cells.length < 5) return null;
                    const taxYear = cells[0].innerText.trim();
                    const baseDue = cells[1].innerText.trim();
                    const total = cells[4].innerText.trim();

                    return { 
                        taxYear, baseDue, total
                    };
                }).filter(record => record !== null);
            });
            console.log("All due records :", allTaxRecords);
        }
    }

    await page.goto(propertyUrl, {waitUntil: "networkidle2", ...timeout_option});
    await page.waitForSelector("#addToCartButton1", {visible: true}); // Changed from waitForDevicePrompt

    await page.click("#addToCartButton1");

    await page.waitForFunction(() => {
            return document.querySelector("#cartResults .ajax ul li a") !== null;
    }, { timeout: 15000 }).catch(() => console.log("Timeout waiting for Cart AJAX response, proceeding anyway."));

    await page.goto(cartLink, { waitUntil: "networkidle2", ...timeout_option });

    await page.waitForSelector("#cartResultsTable", {visible: true});
    const propertyAddress = await page.evaluate(() => {
        const addressEle = document.querySelector('td[headers="locationAddressHeader"] div');
        return addressEle ? addressEle.innerText.trim() : "";
    });

    console.log(propertyAddress);

  } catch (err) {
    console.log("Error during running sequence execution pipeline: ", err);
  } finally {
    // browser.close();
  }
}

run("01270704500000");