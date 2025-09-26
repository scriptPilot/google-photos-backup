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

  // Track processed URLs to avoid going backwards
  const processedUrls = new Set()
  let consecutiveRepeats = 0

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
  const initialUrl = await page.url()
  processedUrls.add(clean(initialUrl))
  
  const firstResult = await archivePhoto(page, true)
  if (firstResult === 'timeout') {
    console.log('First photo timed out, continuing...')
  }
  
  await saveProgress(page)

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
    // Process current photo first
    const result = await archivePhoto(page)
    if (result === 'timeout') {
      console.log('Skipping due to timeout, continuing to next photo...')
    }
    
    // Track this URL as processed
    const cleanCurrentUrl = clean(currentUrl)
    processedUrls.add(cleanCurrentUrl)
    await saveProgress(page)
    
    // Navigate to next photo
    try {
      // If we just archived a photo, wait a bit longer for the page to stabilize
      if (result === 'archived') {
        console.log('Photo was archived, waiting for page to stabilize...')
        await sleep(2000) // Longer wait after archiving
      }
      
      await page.evaluate(() => document.getElementsByClassName('SxgK2b OQEhnd')[0].click())

      // Wait for navigation with URL change detection
      await page.waitForURL((url) => {
        const newCleanUrl = url.href.replace(/\/u\/\d+\//, '/')
        return url.host === 'photos.google.com' && newCleanUrl !== cleanCurrentUrl
      },
        {
          timeout: timeoutValue,
        })
      
      // Check if we've seen this URL before (went backwards)
      const newUrl = await page.url()
      const newCleanUrl = clean(newUrl)
      
      if (processedUrls.has(newCleanUrl)) {
        consecutiveRepeats++
        console.log(`Warning: Navigated to previously processed URL (${consecutiveRepeats} repeats): ${newCleanUrl}`)
        
        if (consecutiveRepeats >= 3) {
          console.log('Too many consecutive repeats, possibly stuck. Trying alternative navigation...')
          // Try keyboard navigation as fallback
          await page.keyboard.press('ArrowLeft')
          await sleep(1000)
          consecutiveRepeats = 0
        }
      } else {
        consecutiveRepeats = 0 // Reset counter on successful new navigation
      }
      
    } catch (error) {
      console.log('Navigation timeout or error, trying alternative navigation:', error.message)
      // Try keyboard navigation as fallback
      try {
        await page.keyboard.press('ArrowLeft')
        await sleep(1000)
        console.log('Used keyboard navigation fallback')
      } catch (innerError) {
        console.log('All navigation methods failed, skipping...')
        continue
      }
    }
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
      await sleep(200); // Faster response
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
    // Super fast check - exit immediately if albums are found
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
        
        // Fast check: if any album box contains "Alben", immediately return
        const albumBoxes = visibleBoxes[0].querySelectorAll(albumBoxSelector);
        for (let i = 0; i < albumBoxes.length; i++) {
          if (albumBoxes[i].textContent.trim() === 'Alben') {
            return { hasAlbums: true }; // Exit immediately when found
          }
        }
        
        return { hasAlbums: false }; // No albums found
      }),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Timeout')), 5000) // Even shorter timeout for faster response
      )
    ]);
    
    if (albumInfo.error) {
      console.log(albumInfo.error + ', archiving skipped.');
      return false;
    }
    
    if (albumInfo.hasAlbums) {
      console.log('Albums found - skipping archive.');
      return false; // Exit immediately, no archiving needed
    } else {
      console.log('No albums found - photo will be archived.');
      // Archive the photo using SHIFT + A
      await page.keyboard.down('Shift');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Shift');
      await sleep(300); // Even shorter wait time
      return true;
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