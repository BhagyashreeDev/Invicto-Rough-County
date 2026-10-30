const getBrowserInstance = require("../../utils/chromium/browserLaunch.js");

const county_data = {
      "anderson": { url:"https://anderson.paytntaxes.com/property-tax/bill/48941", auth: ""},
      "blount": { url:"https://blount.paytntaxes.com/property-tax/bill/33339", auth: ""},
};

const timeout_option = { timeout: 90000 };

const ac_1 = (page, url, account) => {
      return new Promise(async (resolve, reject) => {
            try{
                  account = account.trim().replace(/[- ]/g, '');
                  await page.goto(url, { waitUntil: "domcontentloaded"});

                  await page.setViewport({
                        width: 1920,
                        height: 1080,
                  });

                  // PROPERTY INFO
                  await page.waitForSelector(".content-pane .info .data-field .content", timeout_option);
                  await page.waitForFunction('document.querySelector(".content-pane .info .data-field").lastElementChild.childElementCount == 0', timeout_option);
                  let text = await page.evaluate(() => {
                        let text = [];
                        let divs = document.querySelectorAll(".content-pane .info .data-field .content");
                        divs.forEach((div) => {
                              text.push(div.textContent.trim());
                        });
                        return text;
                  })

                  // TAX INFO
                  await page.waitForSelector("#mat-tab-label-0-1", timeout_option);
                  await page.locator("#mat-tab-label-0-1").click();

                  await page.waitForSelector(".history table tbody tr td", timeout_option);
                  await page.waitForFunction('!document.querySelector(".history table tbody tr td .placeholders")', timeout_option);
                  let history = await page.evaluate(() => {
                        let history = [];

                        let tbody = document.querySelector(".history table tbody");
                        let trs = tbody.querySelectorAll("tr");
                        trs.forEach((tr, i) => {                              
                              let tds = tr.querySelectorAll("td");

                              let year = tds[0]?.textContent.split('-').at(0);
                              let due = tds[2]?.textContent.trim();
                              let paid_date = tds[4]?.textContent.trim();
                              let status = tds[5]?.textContent.trim();
                              let paid = tds[6]?.textContent.trim();
                              
                              history.push({year, due, paid_date, status, paid});
                        })
                        return history;
                  })

                  resolve({text, history});
            }
            catch(error){
                  console.log(error);
                  reject(new Error(error.message));
            }
      })
}

const account_search = async (page, url, account, county) => {
      return new Promise(async (resolve, reject) => {
            try{
                  ac_1(page, url, account)
                  .then((data1) => {
                        
                        resolve(data1)    

                  })
                  .catch((error) =>{
                        reject(new Error(error.message));
                  });
            }
            catch(error){
                  console.log(error);
                  reject(new Error(error.message));
            }
      });
}

const search = async (req, res) => {
      const { fetch_type, account } = req.body;
      const county  = req.path.replace('/', '').toLowerCase();
      try{  

            if(!fetch_type && (fetch_type != "html" || fetch_type != "api")) {
                  return res.status(200).render('error_data', {
                        error: true,
                        message: "Invalid Access"
                  });
            }

            const url = county_data[county]['url'];

            const browser = await getBrowserInstance();
            const context = await browser.createBrowserContext();
            const page = await context.newPage();
            await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/69.0.3497.100 Safari/537.36')

            page.setDefaultNavigationTimeout(90000);

            // INTERCEPT REQUESTS AND BLOCK CERTAIN RESOURCE TYPES
            await page.setRequestInterception(true);
            page.on('request', (req) => {
                  if (req.resourceType() === 'font' || req.resourceType() === 'image') {
                        req.abort();
                  } else {
                        req.continue();
                  }
            });

            if(fetch_type == "html"){
                  // FRONTEND ENDPOINT
                  account_search(page, url, account, county)
                  .then((data) => {
                        res.status(200).render("parcel_data_official", data);
                  })
                  .catch((error) => {
                        console.log(error)
                        res.status(200).render('error_data', {
                              error: true,
                              message: error.message
                        });
                  })
                  .finally(async () => {
                        try{
                              await context.close();
                        }
                        catch(error){
                              console.log(error)
                        }     
                  });
            }
            else if(fetch_type == "api"){
                  // API ENDPOINT
                  account_search(page, url, account, county)
                  .then((data) => {
                        res.status(200).json({
                              result: data
                        })
                  })
                  .catch((error) => {
                        console.log(error);
                        res.status(500).json({
                              error: true,
                              message: error.message
                        })
                  })
                  .finally(async () => {
                        try{
                              await context.close();
                        }
                        catch(error){
                              console.log(error)
                        }
                  });
            }
      }
      catch(error){
            console.log(error);
            if(fetch_type == "html"){
                  res.status(200).render('error_data', {
                        error: true,
                        message: error.message
                  });
            }
            else if(fetch_type == "api"){
                  res.status(500).json({
                        error: true,
                        message: error.message
                  });
            }
      }
}

module.exports = { search };