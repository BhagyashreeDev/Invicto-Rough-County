import puppeteer from "puppeteer";

const timeout_option = {
    timeout: 90000,
};

function createPropertyObject() {
    return {
        processed_date: "",
        order_number: "",
        borrower_name: "",
        owner_name: [],
        property_address: "",
        parcel_number: "",
        land_value: "",
        improvements: "",
        total_assessed_value: "",
        exemption: "",
        total_taxable_value: "",
        taxing_authority: "Delaware County Treasurer, 145 N Union St, Delaware, OH 43015",
        notes: "",
        delinquent: "NONE",
        tax_history: [],
    };
}

function createTaxHistory() {
    return {
        jurisdiction: "County",
        year: "",
        payment_type: "",
        status: "",
        base_amount: "",
        amount_paid: "",
        amount_due: "",
        mailing_date: "N/A",
        due_date: "",
        delq_date: "",
        paid_date: "",
        good_through_date: "-",
    };
}

const generate_notes = (year, keys, status1, status2) => {
    let notes = "";
    try {
        notes =
            keys === 1
                ? `ALL PRIORS ARE PAID,`
                : `PRIORS ARE DELINQUENT,`;
        notes += ` ${year} 1ST INSTALLMENT IS ${(status1).toUpperCase()}, 2ND INSTALLMENT IS ${(status2).toUpperCase()},`;
        notes += ` NORMALLY TAXES ARE PAID SEMI-ANNUALLY,`;
        notes += ` NORMAL DUE DATES ARE 02/10 AND 07/10`;
    } catch (error) {
        console.log(error);
    } finally {
        return notes;
    }
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

function populateObject(accountNumber, propData, taxData) {
    const result = createPropertyObject();

    result.parcel_number = accountNumber;
    
    if (propData.ownerName) {
        result.owner_name = propData.ownerName.split("&").map(name => name.trim());
    }
    result.property_address = propData.propertyAddress || "";
    result.total_assessed_value = taxData.totalAssessedValue || "";
    result.total_taxable_value = result.total_assessed_value;

    if (taxData.taxYear !== "Unknown") {
        const dueYear = parseInt(taxData.taxYear, 10) + 1;

        const inst1 = createTaxHistory();
        inst1.year = taxData.taxYear;
        inst1.payment_type = "Installment 1";
        inst1.base_amount = taxData.firstHalf.netTaxDue || "";
        inst1.amount_paid = taxData.firstHalf.totalPaid || "";
        inst1.amount_due = taxData.firstHalf.balanceDue || "";
        inst1.due_date = `02/10/${dueYear}`;
        inst1.delq_date = `02/11/${dueYear}`;
        inst1.paid_date = taxData.firstHalf.paidDate !== "Not Paid / Not Found" ? taxData.firstHalf.paidDate : "";

        const inst2 = createTaxHistory();
        inst2.year = taxData.taxYear;
        inst2.payment_type = "Installment 2";
        inst2.base_amount = taxData.secondHalf.netTaxDue || "";
        inst2.amount_paid = taxData.secondHalf.totalPaid || "";
        inst2.amount_due = taxData.secondHalf.balanceDue || "";
        inst2.due_date = `07/10/${dueYear}`;
        inst2.delq_date = `07/11/${dueYear}`;
        inst2.paid_date = taxData.secondHalf.paidDate !== "Not Paid / Not Found" ? taxData.secondHalf.paidDate : "";

        result.tax_history.push(inst1, inst2);
    }

    result.tax_history.forEach((record) => {
        if (record.amount_due === "$0.00") {
            record.status = "Paid";
        } else {
            const today = new Date();
            const dueDateObj = new Date(record.due_date);

            if (today <= dueDateObj) {
                record.status = "Due";
            } else {
                record.status = "Delinquent";
            }
        }
    });

    result.tax_history.sort((a, b) => {
        const yearA = parseInt(a.year, 10) || 0;
        const yearB = parseInt(b.year, 10) || 0;
        if (yearA !== yearB) {
            return yearA - yearB;
        }
        if (a.status === "Paid" && b.status !== "Paid") return -1;
        if (a.status !== "Paid" && b.status === "Paid") return 1;
        return 0;
    });

    if (result.tax_history.length > 0) {
        const hasDelinquent = result.tax_history.some(
            (t) => t.status.toUpperCase() === "DELINQUENT"
        );
        
        result.delinquent = hasDelinquent
            ? "TAXES ARE DELINQUENT, NEED TO CALL FOR PAYOFF"
            : "NONE";

        const latestTax = result.tax_history[result.tax_history.length - 1];
        const latestYearRecords = result.tax_history.filter(t => String(t.year) === String(latestTax.year));
        
        const inst1 = latestYearRecords.find(t => t.payment_type === "Installment 1");
        const inst2 = latestYearRecords.find(t => t.payment_type === "Installment 2");

        const status1 = inst1 ? inst1.status : "UNKNOWN";
        const status2 = inst2 ? inst2.status : "UNKNOWN";

        const hasPriorDelinquent = result.tax_history.some(
            (t) => t.status.toUpperCase() === "DELINQUENT" && String(t.year) !== String(latestTax.year)
        );

        const keys = hasPriorDelinquent ? 0 : 1;
        result.notes = generate_notes(latestTax.year, keys, status1, status2);
    }

    return result;
}

async function getDetails(page, accountNumber) {
    // 1. Verify Property Exists before scraping
    try {
        await page.waitForSelector("td.ui-state-default", { timeout: 10000 });
    } catch (error) {
        console.log(`No property found for account number: ${accountNumber}`);
        return null; // Exit early
    }

    // 2. Extract General Property Details
    const propertyDetails = await page.evaluate(() => {
        const getValueByLabel = (labelText) => {
            const cells = Array.from(document.querySelectorAll("td.ui-state-default"));
            const targetCell = cells.find(td => td.textContent.trim() === labelText);
            if (targetCell && targetCell.nextElementSibling) {
                return targetCell.nextElementSibling.textContent.trim().replace(/\s+/g, " ");
            }
            return null;
        };

        const getPropertyAddress = () => {
            const cells = Array.from(document.querySelectorAll("td.ui-state-default"));
            const labelCell = cells.find(td => td.textContent.trim() === "Property Address:");
            if (labelCell && labelCell.parentElement && labelCell.parentElement.nextElementSibling) {
                const addressCell = labelCell.parentElement.nextElementSibling.querySelector("td");
                return addressCell ? addressCell.textContent.trim().replace(/\s+/g, " ") : null;
            }
            return null;
        };

        return {
            ownerName: getValueByLabel("Owner Name"),
            propertyAddress: getPropertyAddress(),
        };
    });

    // 3. Navigate to the Tax page
    await page.goto(
        `https://delaware-auditor-ohio.manatron.com/Tax.aspx?mpropertynumber=${accountNumber}`,
        { waitUntil: "networkidle2", ...timeout_option }
    );

    // Verify Tax Data Exists
    try {
        await page.waitForSelector("td.ui-state-default", { timeout: 10000 });
    } catch (error) {
        console.log(`No tax data found for account number: ${accountNumber}`);
        return null;
    }

    // 4. Extract Tax Details
    const taxData = await page.evaluate(() => {
        const clean = (str) => (str ? str.trim().replace(/\s+/g, " ") : null);
        const tds = Array.from(document.querySelectorAll("td.ui-state-default"));

        const getValueByTdLabel = (label) => {
            const targetTd = tds.find(td => td.textContent.trim() === label && td.nextElementSibling && td.nextElementSibling.textContent.includes("$"));
            return targetTd ? clean(targetTd.nextElementSibling.textContent) : null;
        };

        const landValue = getValueByTdLabel("Land");
        const improvementsValue = getValueByTdLabel("Improvements");
        const totalAssessedValue = getValueByTdLabel("Total");

        const getTaxRowValues = (rowLabel) => {
            const labelTd = tds.find(td => td.textContent.trim() === rowLabel);
            if (labelTd && labelTd.parentElement) {
                const cells = labelTd.parentElement.children;
                return {
                    firstHalf: cells.length > 3 ? clean(cells[3].textContent) : null,
                    secondHalf: cells.length > 5 ? clean(cells[5].textContent) : null,
                };
            }
            return { firstHalf: null, secondHalf: null };
        };

        const netTaxDue = getTaxRowValues("Net Tax Due");
        const totalPaid = getTaxRowValues("Total Paid");
        const balanceDue = getTaxRowValues("Balance Due");

        let firstHalfPaidDate = null;
        let secondHalfPaidDate = null;
        let taxYear = null;

        const headers = Array.from(document.querySelectorAll("th"));
        const dateHeader = headers.find(th => th.textContent.trim() === "Date");

        if (dateHeader) {
            const paymentTable = dateHeader.closest("table");
            const paymentRows = Array.from(paymentTable.querySelectorAll("tbody tr"));

            for (const row of paymentRows) {
                const cells = row.children;
                if (cells.length >= 5) {
                    const date = clean(cells[0].textContent);
                    const halfStr = clean(cells[1].textContent);
                    const amount1stHalf = clean(cells[3].textContent);
                    const amount2ndHalf = clean(cells[4].textContent);

                    if (!firstHalfPaidDate && totalPaid.firstHalf && totalPaid.firstHalf !== "$0.00" && amount1stHalf === totalPaid.firstHalf) {
                        firstHalfPaidDate = date;
                        if (halfStr && !taxYear) {
                            const yearPart = halfStr.split("-")[1];
                            if (yearPart) taxYear = "20" + yearPart;
                        }
                    }

                    if (!secondHalfPaidDate && totalPaid.secondHalf && totalPaid.secondHalf !== "$0.00" && amount2ndHalf === totalPaid.secondHalf) {
                        secondHalfPaidDate = date;
                        if (halfStr && !taxYear) {
                            const yearPart = halfStr.split("-")[1];
                            if (yearPart) taxYear = "20" + yearPart;
                        }
                    }
                }
            }
        }

        return {
            landValue,
            improvementsValue,
            totalAssessedValue,
            taxYear: taxYear || "Unknown",
            firstHalf: {
                netTaxDue: netTaxDue.firstHalf,
                totalPaid: totalPaid.firstHalf,
                balanceDue: balanceDue.firstHalf,
                paidDate: firstHalfPaidDate || "Not Paid / Not Found",
            },
            secondHalf: {
                netTaxDue: netTaxDue.secondHalf,
                totalPaid: totalPaid.secondHalf,
                balanceDue: balanceDue.secondHalf,
                paidDate: secondHalfPaidDate || "Not Paid / Not Found",
            },
        };
    });

    // 5. Populate and format the final object
    const finalResult = populateObject(accountNumber, propertyDetails, taxData);
    console.log(JSON.stringify(finalResult, null, 2));
    
    return finalResult;
}

async function run(accountNumber) {
    let browser, page;
    try {
        ({ browser, page } = await launchBrowser());

        await page.goto(
            `https://delaware-auditor-ohio.manatron.com/Property.aspx?mpropertynumber=${accountNumber}`,
            { waitUntil: "networkidle2", ...timeout_option }
        );

        await getDetails(page, accountNumber);

    } catch (err) {
        console.log("Error during running sequence execution pipeline: ", err);
    } finally {
        // if (browser) await browser.close();
    }
}

// Execute
run("618-131-21-008-000");