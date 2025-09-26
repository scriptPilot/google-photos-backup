import { chromium } from 'playwright-extra'
import stealth from 'puppeteer-extra-plugin-stealth'
import path from 'path'
import fsP from 'node:fs/promises'
import ua from 'user-agents'

const userAgent = new ua({
  platform: 'MacIntel', // 'Win32', 'Linux ...'
  deviceCategory: 'desktop', // 'mobile', 'tablet'
});

chromium.use(stealth())

const timeoutValue = 10000 // 10 seconds timeout
const userDataDir = './session'

let headless = true

// accept --headless=false argument to run in headful mode
if (process.argv[2] === '--headless=false') {
  headless = false
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

const getProgress = async () => {
  try {
    const lastDone = await fsP.readFile('.lastdone', 'utf-8')
    if (lastDone === '') throw new Error('Please add the starting link in .lastdone file')
    return lastDone
  } catch (error) {
    throw new Error(error)
  }
}

const saveProgress = async (page) => {
  const currentUrl = await page.url();
  // Only save if the URL is a valid Google Photos URL 'https://photos.google.com'
  if (currentUrl.startsWith('https://photos.google.com')) {
    await fsP.writeFile('.lastdone', currentUrl, 'utf-8');
  } else {
    console.log('Current URL does not start with https://photos.google.com, not saving progress.');
  }
}
const getMonthAndYear = async (metadata, page) => {
  let year = 1970
  let month = 1
  let dateType = "default"
  if (metadata.DateTimeOriginal) {
    year = metadata.DateTimeOriginal.year
    month = metadata.DateTimeOriginal.month
    dateType = "DateTimeOriginal"
  } else if (metadata.CreateDate) {
    year = metadata.CreateDate.year
    month = metadata.CreateDate.month
    dateType = "CreateDate"
  } else {
    // if metadata is not available, we try to get the date from the html
    console.log('Metadata not found, trying to get date from html')
    const data = await page.request.get(page.url())
    const html = await data.text()

    const regex = /aria-label="(Photo|Video) - (Landscape|Portrait|Square) - ([A-Za-z]{3} \d{1,2}, \d{4}, \d{1,2}:\d{2}:\d{2} [APM]{2})"/
    const match = regex.exec(html)

    if (match) {
      const dateString = match[3].replace(/\u202F/g, ' ') // Remove U+202F character
      const date = new Date(dateString)
      if (date.toString() !== 'Invalid Date') {
        year = date.getFullYear()
        month = date.getMonth() + 1
        dateType = "HTML"
      }
    }
  }
  return { year, month, dateType }
}

(async () => {
  const startLink = await getProgress()
  console.log('Starting from:', new URL(startLink).href)

  const browser = await chromium.launchPersistentContext(path.resolve(userDataDir), {
    headless,
    channel: 'chromium',
    args: [
      '--disable-features=IsolateOrigins,site-per-process',
      '--disable-blink-features=AutomationControlled', 
      '--no-sandbox',         // May help in some environments
      '--disable-infobars',    // Prevent infobars
      '--disable-extensions',   // Disable extensions
      '--start-maximized',      // Start maximized
      '--window-size=1280,720'  // Set a specific window size
    ],
    userAgent: userAgent.toString(),
    viewport: { width: 1280, height: 720 },
    deviceScaleFactor: 1,
  })

  const page = await browser.newPage()

  await page.goto('https://photos.google.com')

  const latestPhoto = await getLatestPhoto(page)
  console.log('Latest Photo:', latestPhoto)
  console.log('-------------------------------------')


  await page.goto(clean(startLink))

  /*
    Process the first (Oldest) photo.
  */
  const firstResult = await archivePhoto(page, true)
  if (firstResult === 'timeout') {
    console.log('First photo timed out, continuing...')
  }

  while (true) {
    const currentUrl = await page.url()

    if (clean(currentUrl) === clean(latestPhoto)) {
      console.log('-------------------------------------')
      console.log('Reached the latest photo, exiting...')
      break
    }

    /*
      We click on the left side of arrow in the html. This will take us to the previous photo.
      Note: I have tried both left arrow press and clicking directly the left side of arrow using playwright click method.
      However, both of them are not working. So, I have injected the click method in the html.
    */
    await page.evaluate(() => document.getElementsByClassName('SxgK2b OQEhnd')[0].click())

    // we wait until new photo is loaded
    await page.waitForURL((url) => {
      return url.host === 'photos.google.com' && url.href !== currentUrl
    },
      {
        timeout: timeoutValue,
      })

    const result = await archivePhoto(page)
    if (result === 'timeout') {
      console.log('Skipping due to timeout, continuing to next photo...')
    }
    await saveProgress(page)
  }
  await browser.close()
})()

const waitForPageLoad = async (page) => {
  console.log(`Loading page ${page.url()}`)
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: timeoutValue })
    await sleep(200) // Short wait for dynamic content
    return true
  } catch (error) {
    console.log('Page load timeout - skipping this image')
    return false
  }
}

const showDrawer = async (page) => {
  try {
    const drawerSelector = '.Q77Pt.eejsDc';
    const isDrawerVisible = await page.evaluate(({ drawerSelector }) => {
      const el = document.querySelector(drawerSelector);
      return el && window.getComputedStyle(el).display !== 'none' && el.innerHTML.trim() !== '';
    }, { drawerSelector });
    if (!isDrawerVisible) {
      console.log('Show right hand drawer.');
      await page.keyboard.press('KeyI');
      await sleep(300); // Reduced wait time
    } else {
      console.log('Right hand drawer already visible.');
    }
    return true
  } catch (error) {
    console.log('Drawer timeout - skipping this image')
    return false
  }
}

const archiveElement = async (page) => {
  try {
    // Fast check using page.evaluate to avoid multiple DOM queries
    const albumInfo = await Promise.race([
      page.evaluate(() => {
        const infoBoxSelector = '.WUbige';
        const albumBoxSelector = '.wiOkb';
        
        const infoBoxes = document.querySelectorAll(infoBoxSelector);
        const visibleBoxes = Array.from(infoBoxes).filter(box => {
          const style = window.getComputedStyle(box);
          return style.display !== 'none' && box.offsetParent !== null;
        });
        
        if (visibleBoxes.length !== 1) {
          return { error: `Found ${visibleBoxes.length} visible info boxes` };
        }
        
        const albumBoxes = visibleBoxes[0].querySelectorAll(albumBoxSelector);
        const albumCount = Array.from(albumBoxes).filter(el => 
          el.textContent.trim() === 'Alben'
        ).length;
        
        return { albumCount };
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), timeoutValue)
      )
    ]);
    
    if (albumInfo.error) {
      console.log(albumInfo.error + ', archiving skipped.');
      return false;
    }
    
    if (albumInfo.albumCount === 0) {
      console.log('No albums found - photo will be archived.');
      // Archive the photo using SHIFT + A
      await page.keyboard.down('Shift');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Shift');
      await sleep(500); // Reduced wait time
      return true;
    } else {
      console.log(`Found ${albumInfo.albumCount} album boxes - skipping archive.`);
      return false;
    }
  } catch (error) {
    console.log('Archive element timeout - skipping this image');
    return false;
  }
}

const archivePhoto = async (page, firstOne = false) => {
  try {
    const pageLoaded = await waitForPageLoad(page)
    if (!pageLoaded) {
      console.log('Photo skipped (page load timeout)')
      return 'timeout'
    }
    
    const drawerShown = await showDrawer(page)
    if (!drawerShown) {
      console.log('Photo skipped (drawer timeout)')
      return 'timeout'
    }
    
    const archived = await archiveElement(page)
    await sleep(200) // Reduced wait time
    
    if (archived) {
      console.log('Photo archived successfully')
      return 'archived'
    } else {
      console.log('Photo skipped (in album or error)')
      return 'skipped'
    }
  } catch (error) {
    console.log('Photo processing timeout - skipping:', error.message)
    return 'timeout'
  }
}



/*
  This function is used to get the latest photo in the library. Once Page is loaded,
  We press right click, It will select the latest photo in the grid. And then
  we get the active element, which is the latest photo.
*/
const getLatestPhoto = async (page) => {
  await page.keyboard.press('ArrowRight')
  await sleep(500)
  return await page.evaluate(() => document.activeElement.toString())
}

// remove /u/0/
const clean = (link) => {
  return link.replace(/\/u\/\d+\//, '/')
}