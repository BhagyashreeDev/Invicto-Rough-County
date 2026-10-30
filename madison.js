import puppeteer from "puppeteer";
import fs from "fs";
import path from "path";
import PDFParser from "pdf2json";

// Bump this whenever the file changes — printed at startup so you can
// confirm, at a glance, that you're running the version you think you are.
const SCRIPT_VERSION = "v6-skeleton-guard-all-bills-too";

const timeout_option = { timeout: 90000 };

// ---------------------------------------------------------------------------
// CONFIG
// ---------------------------------------------------------------------------
const BASE_SEARCH_URL = "https://paymadisontaxes.com/lookup/property-tax";
const DOWNLOAD_DIR = path.resolve("./downloads");

// ---------------------------------------------------------------------------
// SCHEMA HELPERS
// ---------------------------------------------------------------------------
function createPropertyObject() {
    return {
        processed_date: "",
        order_number: "",
        borrower_name: "",
        owner_name: [],
        property_address: "",
        parcel_number: "",
        bill_number: "",
        tax_year: "",
        land_value: "",
        improvements: "",
        total_assessed_value: "",
        exemption: "",
        total_taxable_value: "",
        base_tax: "",
        amount_paid: "",
        paid_date: "",
        delinquent: "NONE",
        taxing_authority: "Madison County Trustee, Jackson, TN",
        notes: "",
        tax_history: []
    };
}

const formatCurrency = (value) => {
    if (!value) return "$0.00";
    const num = parseFloat(value.toString().replace(/[^\d.-]/g, ""));
    if (isNaN(num)) return "$0.00";
    return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
    }).format(num);
};

// ---------------------------------------------------------------------------
// DEBUG HELPER — call this whenever a step fails so you can SEE what the
// page actually looked like, instead of guessing from a stack trace.
// ---------------------------------------------------------------------------
const DEBUG_DIR = path.resolve("./debug");
async function debugDump(page, label) {
    try {
        if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, "-");
        const shotPath = path.join(DEBUG_DIR, `${stamp}_${label}.png`);
        const htmlPath = path.join(DEBUG_DIR, `${stamp}_${label}.html`);
        await page.screenshot({ path: shotPath, fullPage: true });
        const html = await page.content();
        fs.writeFileSync(htmlPath, html);
        console.log(`[debug] Saved ${shotPath} and ${htmlPath} — inspect these to see the actual page state.`);
        console.log(`[debug] Current URL at failure: ${page.url()}`);
    } catch (dumpErr) {
        console.log("[debug] Failed to capture debug dump:", dumpErr.message);
    }
}

// Wraps page.waitForSelector: on timeout, dumps a screenshot/HTML for the
// given label, then rethrows so the caller still knows it failed.
async function waitForSelectorOrDump(page, selector, label, options = {}) {
    try {
        return await page.waitForSelector(selector, { visible: true, ...timeout_option, ...options });
    } catch (err) {
        await debugDump(page, label);
        throw err;
    }
}

// ---------------------------------------------------------------------------
// BROWSER SETUP
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// STEP 1: SEARCH BY "TaxYear-BillNo"
// ---------------------------------------------------------------------------
async function handleDisclaimerIfPresent(page) {
    // Some county portals show a one-time disclaimer/agree page before the
    // real search form. If this site doesn't have one, this is a harmless no-op.
    const hasSearchField = await page.$("#lookup-query-field");
    if (hasSearchField) return; // already on the search form, nothing to do

    const possibleAgreeButtons = await page.$$("button");
    for (const btn of possibleAgreeButtons) {
        const text = await page.evaluate((el) => el.textContent.trim(), btn);
        if (/agree|accept|continue/i.test(text)) {
            await btn.click();
            await page.waitForSelector("#lookup-query-field", { visible: true, ...timeout_option }).catch(() => {});
            return;
        }
    }
}

async function searchByTaxYearBill(page, taxYearBillNo) {
    await page.goto(BASE_SEARCH_URL, { waitUntil: "networkidle2", ...timeout_option });
    await handleDisclaimerIfPresent(page);

    const inputSelector = "#lookup-query-field";
    await waitForSelectorOrDump(page, inputSelector, "search_form_not_found");
    await page.click(inputSelector);
    await page.type(inputSelector, taxYearBillNo, { delay: 30 });

    // Prefer clicking the arrow_forward submit button; fall back to Enter key.
    const submitSelector = 'form button[type="submit"]';
    const submitBtn = await page.$(submitSelector);
    if (submitBtn) {
        await submitBtn.click();
    } else {
        await page.keyboard.press("Enter");
    }

    // SPA navigation — wait for whichever of these three states shows up
    // first: the <ol> card list (narrow screens), the <table> of rows (wide
    // screens), or the bill detail page directly (single exact match).
    // Promise.any resolves as soon as ONE of them appears, and only rejects
    // (AggregateError) if ALL THREE time out — which means the search
    // genuinely produced nothing recognizable, worth dumping for inspection.
    try {
        await Promise.any([
            page.waitForSelector("ol.parcel-result-list li.parcel-result-item", { visible: true, ...timeout_option }),
            page.waitForSelector("table.results tbody tr.clickable", { visible: true, ...timeout_option }),
            page.waitForSelector("ppt-parcel-details", { visible: true, ...timeout_option }),
        ]);
    } catch (err) {
        await debugDump(page, "search_no_results_or_wrong_selectors");
        throw new Error(
            `After submitting the search for "${taxYearBillNo}", none of the expected result states ` +
            `(card list / table rows / bill detail page) appeared within ${timeout_option.timeout}ms. ` +
            `Check ./debug for a screenshot + HTML of what actually rendered — likely causes: ` +
            `a disclaimer/consent page blocking the form, no matching account for that search string, ` +
            `or the site changed its markup.`
        );
    }
}

// ---------------------------------------------------------------------------
// ROBUST ROW CLICK — a plain ElementHandle.click() can silently land on an
// overlapping element (fixed background, cdk-overlay container, etc.) and
// do nothing, with NO error thrown. This helper tries several strategies in
// order and confirms the click actually did something by checking whether
// the URL changed, logging each attempt so a failure is diagnosable.
async function clickRowRobustly(page, rowHandle, label) {
    const urlBefore = page.url();
    const rowHtmlPreview = await page
        .evaluate((el) => el.outerHTML.slice(0, 300), rowHandle)
        .catch(() => "(could not read row HTML)");
    console.log(`[click:${label}] URL before click: ${urlBefore}`);
    console.log(`[click:${label}] Row HTML (first 300 chars): ${rowHtmlPreview}`);

    const urlChanged = async () => page.url() !== urlBefore;

    // Strategy 1: scroll into view, then puppeteer's real mouse click.
    await rowHandle.scrollIntoView().catch(() => {});
    await rowHandle.click().catch((e) => console.log(`[click:${label}] Strategy 1 (mouse click) threw:`, e.message));
    await new Promise((r) => setTimeout(r, 800));
    if (await urlChanged()) {
        console.log(`[click:${label}] Strategy 1 worked — URL is now ${page.url()}`);
        return;
    }
    console.log(`[click:${label}] Strategy 1 had no effect (URL unchanged).`);

    // Strategy 2: native DOM .click() via evaluate — bypasses screen
    // coordinates entirely, so it can't be intercepted by an overlapping element.
    await page.evaluate((el) => el.click(), rowHandle).catch((e) =>
        console.log(`[click:${label}] Strategy 2 (native click) threw:`, e.message)
    );
    await new Promise((r) => setTimeout(r, 800));
    if (await urlChanged()) {
        console.log(`[click:${label}] Strategy 2 worked — URL is now ${page.url()}`);
        return;
    }
    console.log(`[click:${label}] Strategy 2 had no effect (URL unchanged).`);

    // Strategy 3: click the first child cell/element instead of the row
    // itself, in case the Angular (click) binding lives one level down.
    const firstChild = await rowHandle.$("td, h4, a, div").catch(() => null);
    if (firstChild) {
        await firstChild.click().catch((e) =>
            console.log(`[click:${label}] Strategy 3 (child click) threw:`, e.message)
        );
        await new Promise((r) => setTimeout(r, 800));
        if (await urlChanged()) {
            console.log(`[click:${label}] Strategy 3 worked — URL is now ${page.url()}`);
            return;
        }
        console.log(`[click:${label}] Strategy 3 had no effect (URL unchanged).`);
    }

    console.log(`[click:${label}] All click strategies failed to change the URL. Proceeding anyway — the wait below will time out and dump debug info if nothing rendered.`);
}

// ---------------------------------------------------------------------------
// STEP 2: PICK THE FIRST/BEST MATCH FROM THE ACCOUNTS RESULT LIST
// ---------------------------------------------------------------------------
// ppt-lookup-results renders the SAME data two different ways depending on
// viewport width:
//   - narrow screens:  <ol class="parcel-result-list"><li class="parcel-result-item">
//   - wide screens:    <table class="... results"><tbody><tr class="clickable">
// Only one of the two will actually be present/visible at a time, so we
// check both and click whichever one exists.
// ---------------------------------------------------------------------------
// WAIT FOR REAL DATA — the results table/list first renders with
// <egov-text-ui-placeholder> shimmer/skeleton rows while the actual account
// data is still loading. Grabbing rows before that resolves means clicking
// a skeleton row that has no real click handler (which is exactly what was
// happening: URL never changed no matter which click strategy was tried).
// This waits until at least one row's content has NO skeleton placeholder
// left inside it — i.e. real owner/address text has rendered.
async function waitForRealResultRows(page, containerSelector, rowSelector) {
    await page.waitForFunction(
        (containerSel, rowSel) => {
            const rows = document.querySelectorAll(rowSel);
            if (rows.length === 0) return false;
            return Array.from(rows).some(
                (row) => !row.querySelector("egov-text-ui-placeholder") && row.textContent.trim().length > 0
            );
        },
        { ...timeout_option },
        containerSelector,
        rowSelector
    );
}

async function selectBestMatch(page) {
    const listItems = await page.$$("ol.parcel-result-list li.parcel-result-item");
    if (listItems.length > 0) {
        await waitForRealResultRows(page, "ol.parcel-result-list", "ol.parcel-result-list li.parcel-result-item");
        const freshListItems = await page.$$("ol.parcel-result-list li.parcel-result-item");
        const realItem = await pickFirstNonSkeletonRow(page, freshListItems);
        await clickRowRobustly(page, realItem, "ol_row");
        await waitForSelectorOrDump(page, "ppt-parcel-details", "after_click_ol_row_no_detail_page");
        return;
    }

    const tableRows = await page.$$("table.results tbody tr.clickable");
    if (tableRows.length > 0) {
        await waitForRealResultRows(page, "table.results", "table.results tbody tr.clickable");
        const freshTableRows = await page.$$("table.results tbody tr.clickable");
        const realRow = await pickFirstNonSkeletonRow(page, freshTableRows);
        await clickRowRobustly(page, realRow, "table_row");
        await waitForSelectorOrDump(page, "ppt-parcel-details", "after_click_table_row_no_detail_page");
        return;
    }

    // Neither result layout was found — assume we already landed directly
    // on the bill detail page (single exact match), so there's nothing to click.
}

// Given a list of row handles, return the first one that is NOT a loading
// skeleton (i.e. contains no <egov-text-ui-placeholder>). Falls back to the
// first row if somehow all of them look like skeletons (shouldn't happen
// after waitForRealResultRows resolves, but better than crashing).
async function pickFirstNonSkeletonRow(page, rowHandles) {
    for (const row of rowHandles) {
        const isSkeleton = await page.evaluate((el) => !!el.querySelector("egov-text-ui-placeholder"), row);
        if (!isSkeleton) return row;
    }
    return rowHandles[0];
}

// ---------------------------------------------------------------------------
// STEP 3: CHECK "Unpaid Bills" TAB; FALL BACK TO "All Bills" TAB IF EMPTY
// ---------------------------------------------------------------------------
async function ensureAllBillsTabIfNoneUnpaid(page) {
    await page.waitForSelector("ppt-parcel-history", { visible: true, ...timeout_option });

    const hasNoUnpaidBills = await page.evaluate(() => {
        const activePane = document.querySelector(
            'mat-tab-body[id="mat-tab-content-0-0"] .no-history, .content-pane .no-history'
        );
        return !!activePane && /no unpaid bills/i.test(activePane.textContent || "");
    });

    if (!hasNoUnpaidBills) {
        // There ARE unpaid bills — caller should decide how to handle that case.
        return { switchedToAllBills: false };
    }

    const allBillsTabSelector = "#mat-tab-label-0-1";
    await page.waitForSelector(allBillsTabSelector, { visible: true, ...timeout_option });
    await page.click(allBillsTabSelector);

    // Give Angular a moment to render the "All Bills" table inside app-show-more,
    // AND wait past any shimmer/skeleton placeholder rows this site tends to
    // render before the real bill-history data arrives (same pattern that
    // caused the earlier "click does nothing" bug on the search results table).
    await waitForRealResultRows(page, "table.parcel-result-list", "table.parcel-result-list tbody tr.bill");

    return { switchedToAllBills: true };
}

// ---------------------------------------------------------------------------
// STEP 4: FIND THE MATCHING ROW IN THE "All Bills" TABLE AND OPEN ITS
//         KEBAB MENU, THEN CLICK "Print Receipt"
// ---------------------------------------------------------------------------
async function openPrintReceiptForRow(page, taxYearBillNo) {
    await waitForRealResultRows(page, "table.parcel-result-list", "table.parcel-result-list tbody tr.bill");

    const rows = await page.$$("table.parcel-result-list tbody tr.bill");
    let targetRow = null;

    for (const row of rows) {
        const isSkeleton = await page.evaluate((el) => !!el.querySelector("egov-text-ui-placeholder"), row);
        if (isSkeleton) continue; // skip any leftover skeleton rows

        const yearBillText = await row.$eval("ppt-tax-year", (el) => el.textContent.trim()).catch(() => null);
        if (yearBillText === taxYearBillNo) {
            targetRow = row;
            break;
        }
    }

    // Fall back to the row flagged "current" (the bill originally searched for).
    if (!targetRow) {
        for (const row of rows) {
            const isSkeleton = await page.evaluate((el) => !!el.querySelector("egov-text-ui-placeholder"), row);
            if (isSkeleton) continue;
            const isCurrent = await page.evaluate((el) => el.classList.contains("current"), row);
            if (isCurrent) {
                targetRow = row;
                break;
            }
        }
    }

    if (!targetRow) {
        await debugDump(page, "no_matching_bill_row_found");
        throw new Error(`Could not find a matching bill row for "${taxYearBillNo}"`);
    }

    const kebabButton = await targetRow.$("app-icon-button.mat-menu-trigger button");
    if (!kebabButton) throw new Error("Could not find the row's action (more_vert) button.");
    await kebabButton.click();

    // The <mat-menu> content is rendered lazily into an overlay on click.
    await page.waitForSelector(".mat-menu-panel", { visible: true, ...timeout_option });

    const menuItems = await page.$$(".mat-menu-panel button, .mat-menu-panel a");
    let printReceiptItem = null;
    for (const item of menuItems) {
        const text = await page.evaluate((el) => el.textContent.trim(), item);
        if (/print receipt/i.test(text)) {
            printReceiptItem = item;
            break;
        }
    }

    if (!printReceiptItem) {
        throw new Error('Could not find a "Print Receipt" option in the row menu.');
    }

    // "Print Receipt" opens a new tab (target="_blank"-style behavior).
    const newPagePromise = new Promise((resolve) => {
        page.browser().once("targetcreated", async (target) => {
            const newPage = await target.page();
            resolve(newPage);
        });
    });

    await printReceiptItem.click();
    const receiptPage = await newPagePromise;
    await receiptPage.waitForNetworkIdle({ idleTime: 500, timeout: 30000 }).catch(() => {});

    return receiptPage;
}

// ---------------------------------------------------------------------------
// STEP 5: DOWNLOAD THE RECEIPT PDF
// ---------------------------------------------------------------------------
async function downloadReceiptPdf(receiptPage, taxYearBillNo) {
    if (!fs.existsSync(DOWNLOAD_DIR)) fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });

    const pdfUrl = receiptPage.url();
    const safeName = taxYearBillNo.replace(/[^\w-]/g, "_");
    const filePath = path.join(DOWNLOAD_DIR, `receipt_${safeName}.pdf`);

    const base64 = await receiptPage.evaluate(async (url) => {
        const res = await fetch(url, { credentials: "include" });
        if (!res.ok) throw new Error(`Fetch failed: ${res.status} ${res.statusText}`);
        const buf = await res.arrayBuffer();
        const bytes = new Uint8Array(buf);
        let binary = "";
        for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
        return btoa(binary);
    }, pdfUrl);

    const buffer = Buffer.from(base64, "base64");

    if (buffer.slice(0, 5).toString("latin1") !== "%PDF-") {
        throw new Error("Downloaded content is not a valid PDF (missing %PDF- header).");
    }

    fs.writeFileSync(filePath, buffer);
    await receiptPage.close().catch(() => {});
    return filePath;
}

// ---------------------------------------------------------------------------
// STEP 6: PARSE THE RECEIPT PDF FOR ASSESSED VALUE / BASE TAX / DATE / AMOUNT
// ---------------------------------------------------------------------------
// NOTE: pdf2json returns each PDF text run as a flat array of strings, in the
// order they appear on the page. The label -> value offsets below are best
// guesses based on typical county receipt layouts ("Label" followed shortly
// by its value). Once you have a real sample PDF from this portal, open it,
// log `data` inside the parser below, and adjust the offsets/regexes to
// match the exact layout.
function extractDataFromPdf(filePath) {
    return new Promise((resolve, reject) => {
        const pdfParser = new PDFParser();
        pdfParser.on("pdfParser_dataError", (e) => reject(e.parserError));

        pdfParser.on("pdfParser_dataReady", (pdfData) => {
            try {
                const data = [];
                pdfData["Pages"].forEach((p) => {
                    p["Texts"].forEach((t) => {
                        let text = t["R"][0]["T"];
                        text = decodeURIComponent(text).trim();
                        if (text) data.push(text);
                    });
                });

                const currencyRegex = /^\$?[0-9]{1,3}(,[0-9]{3})*\.[0-9]{2}$/;
                const dateRegex = /^\d{1,2}\/\d{1,2}\/\d{2,4}$/;

                const findValueNear = (labelPredicate, matcher, lookahead = 6) => {
                    for (let i = 0; i < data.length; i++) {
                        if (labelPredicate(data[i], data)) {
                            for (let j = 1; j <= lookahead; j++) {
                                const candidate = data[i + j];
                                if (candidate && matcher(candidate)) return candidate;
                            }
                        }
                    }
                    return null;
                };

                const assessedValue = findValueNear(
                    (d) => /assessed value/i.test(d),
                    (v) => currencyRegex.test(v) || /^[0-9,]+$/.test(v)
                );

                const baseTax = findValueNear(
                    (d) => /base tax/i.test(d),
                    (v) => currencyRegex.test(v)
                );

                const amountPaid = findValueNear(
                    (d) => /amount paid/i.test(d) || /^amount$/i.test(d),
                    (v) => currencyRegex.test(v)
                );

                const paidDate = findValueNear(
                    (d) => /date paid/i.test(d) || /^date$/i.test(d) || /paid date/i.test(d),
                    (v) => dateRegex.test(v)
                );

                resolve({
                    assessed_value: assessedValue,
                    base_tax: baseTax,
                    amount_paid: amountPaid,
                    date: paidDate,
                    raw_text: data, // keep raw text for manual inspection/debugging
                });
            } catch (error) {
                reject(error);
            }
        });

        pdfParser.loadPDF(filePath);
    });
}

// ---------------------------------------------------------------------------
// ORCHESTRATION
// ---------------------------------------------------------------------------
async function run(taxYearBillNo) {
    console.log(`\n=== madison_tn_tax_scraper ${SCRIPT_VERSION} ===`);
    console.log(`Looking up: ${taxYearBillNo}\n`);

    // Sanity check: prove the debug mechanism itself works, BEFORE anything
    // else runs. If this file doesn't show up in ./debug, you are not
    // running this version of the script — full stop, go check your file.
    if (!fs.existsSync(DEBUG_DIR)) fs.mkdirSync(DEBUG_DIR, { recursive: true });
    fs.writeFileSync(
        path.join(DEBUG_DIR, "_session_start.txt"),
        `Started at ${new Date().toISOString()} — script version ${SCRIPT_VERSION}, looking up ${taxYearBillNo}\n`
    );

    let browser;
    let page;
    try {
        const launched = await launchBrowser();
        browser = launched.browser;
        page = launched.page;

        // 1. Search
        await searchByTaxYearBill(page, taxYearBillNo);

        // 2. Select best/first match (no-op if search landed directly on the bill page)
        await selectBestMatch(page);

        // 3. Check Unpaid Bills tab; switch to All Bills if empty
        const { switchedToAllBills } = await ensureAllBillsTabIfNoneUnpaid(page);
        if (!switchedToAllBills) {
            console.log("This bill has unpaid balances — handle the Unpaid Bills flow separately if needed.");
        }

        // 4. Open the Print Receipt option for the matching row
        const receiptPage = await openPrintReceiptForRow(page, taxYearBillNo);

        // 5. Download the receipt PDF
        const pdfPath = await downloadReceiptPdf(receiptPage, taxYearBillNo);
        console.log("Downloaded receipt PDF:", pdfPath);

        // 6. Parse it
        const parsed = await extractDataFromPdf(pdfPath);
        console.log("Parsed receipt data:", {
            assessed_value: parsed.assessed_value,
            base_tax: parsed.base_tax,
            amount_paid: parsed.amount_paid,
            date: parsed.date,
        });

        // Optional: clean up the downloaded PDF once you're done with it.
        // fs.unlinkSync(pdfPath);

        return parsed;
    } catch (err) {
        console.log("Error during sequence execution:", err);
        if (page) await debugDump(page, "run_failed");
    } finally {
        if (browser) await browser.close().catch(() => {});
    }
}

// Example invocation — replace with the actual "TaxYear-BillNo" you're looking up.
run("2025-23168");