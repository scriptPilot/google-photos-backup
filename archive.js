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

// Logging system with counters
let logHistory = []
let archivedCount = 0
let skippedCount = 0
let timeoutCount = 0

const customLog = (message) => {
  // Add to history (keep all messages)
  logHistory.push(message)
  
  // Clear console and show clean format
  console.clear()
  console.log(`📦 Archived: ${archivedCount} | ⏭️  Skipped: ${skippedCount} | ⏰ Timeouts: ${timeoutCount}`)
  console.log()
  
  // Show last 5 messages in ascending order (oldest to newest)
  const recentLogs = logHistory.slice(-5)
  recentLogs.forEach((log) => {
    console.log(log)
  })
}

// Check if we're on the main/home page instead of a photo detail page
const isOnHomePage = async (page) => {
  try {
    const currentUrl = await page.url()
    // Check if URL indicates we're on the main photos page
    const isMainPage = currentUrl.includes('photos.google.com') && 
                      !currentUrl.includes('/photo/') && 
                      !currentUrl.includes('/AF1Q')
    
    if (isMainPage) {
      // Double-check by looking for main page elements
      const hasMainPageElements = await page.evaluate(() => {
        // Look for grid view or main page indicators
        const gridElements = document.querySelectorAll('[data-ved]')
        const photoGrid = document.querySelector('[role="main"]')
        return gridElements.length > 10 || photoGrid !== null
      })
      
      return hasMainPageElements
    }
    
    return false
  } catch (error) {
    return false
  }
}

// Navigate back to the last saved position
const returnToLastPosition = async (page) => {
  try {
    const lastDone = await getProgress()
    
    await page.goto(clean(lastDone))
    await sleep(2000) // Wait for page to load
    
    // Verify we're back on a photo detail page
    const isBack = !(await isOnHomePage(page))
    if (isBack) {
      return true
    } else {
      return false
    }
  } catch (error) {
    customLog('🧭 Error returning to last position: ' + error.message)
    return false
  }
}

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
    customLog('⚠️ Current URL not valid Google Photos URL, not saving progress')
  }
}

(async () => {
  const startLink = await getProgress()
  customLog(`🚀 Starting archive process from: ${new URL(startLink).href}`)

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
      '--window-size=800,600'  // Set a specific window size
    ],
    userAgent: userAgent.toString(),
    viewport: { width: 800, height: 600 },
    deviceScaleFactor: 1,
  })

  const page = await browser.newPage()

  await page.goto('https://photos.google.com')

  const latestPhoto = await getLatestPhoto(page)
  customLog(`ℹ️ Latest photo detected: ${latestPhoto}`)


  await page.goto(clean(startLink))

  /*
    Process the first (Oldest) photo.
  */
  const initialUrl = await page.url()
  processedUrls.add(clean(initialUrl))
  
  const firstResult = await archivePhoto(page, true)
  if (firstResult === 'timeout') {
    timeoutCount++
    customLog('⏰ First photo timed out, continuing...')
  } else if (firstResult === 'archived') {
    archivedCount++
    customLog('📦 First photo archived successfully')
  } else if (firstResult === 'skipped') {
    skippedCount++
    customLog('⏭️ First photo skipped (in album)')
  }
  
  // Only save progress if photo was NOT archived (archived photos cannot be used as starting point)
  if (firstResult !== 'archived') {
    await saveProgress(page)
  }

  while (true) {
    const currentUrl = await page.url()
    
    // Check if we've been redirected to the home page
    if (await isOnHomePage(page)) {
      customLog('🧭 Redirected to home page, recovering position...')
      const recovered = await returnToLastPosition(page)
      
      if (!recovered) {
        customLog('🧭 Could not recover from home page, exiting process')
        break
      }
      
      // Update currentUrl after recovery
      const newCurrentUrl = await page.url()
      customLog('✅ Successfully resumed from saved position')
      continue // Skip the rest of this iteration and start fresh
    }

    if (clean(currentUrl) === clean(latestPhoto)) {
      customLog('🏁 Reached the latest photo - Archive process completed!')
      customLog(`📊 Final totals: 📦 ${archivedCount} archived, ⏭️ ${skippedCount} skipped, ⏰ ${timeoutCount} timeouts`)
      break
    }

    /*
      We click on the left side of arrow in the html. This will take us to the previous photo.
      Note: I have tried both left arrow press and clicking directly the left side of arrow using playwright click method.
      However, both of them are not working. So, I have injected the click method in the html.
    */
    // Process current photo first
    const result = await archivePhoto(page)
    
    // Update counters and log result
    if (result === 'timeout') {
      timeoutCount++
      customLog('⏰ Photo timed out, continuing to next...')
    } else if (result === 'archived') {
      archivedCount++
      customLog('📦 Photo archived successfully')
    } else if (result === 'skipped') {
      skippedCount++
      customLog('⏭️ Photo skipped (in album)')
    }
    
    // Track this URL as processed
    const cleanCurrentUrl = clean(currentUrl)
    processedUrls.add(cleanCurrentUrl)
    
    // Only save progress if photo was NOT archived (archived photos cannot be used as starting point)
    if (result !== 'archived') {
      await saveProgress(page)
    }
    
    // Smart navigation handling post-archive behavior
    try {
      if (result === 'archived') {
        customLog('🧭 Photo archived, using optimized navigation...')
        
        // After archiving, Google Photos often navigates back automatically
        // Wait for this automatic navigation to complete
        await sleep(1000)
        
        // Check if we're back at a previous photo
        let navigationAttempts = 0
        let currentNavigationUrl = await page.url()
        
        while (navigationAttempts < 5) { // Max 5 attempts to get to new photo
          navigationAttempts++
          
          // Navigate forward (to older photos)
          await page.evaluate(() => document.getElementsByClassName('SxgK2b OQEhnd')[0].click())
          
          // Wait for navigation with shorter timeout for faster response
          try {
            await page.waitForURL((url) => {
              const newCleanUrl = url.href.replace(/\/u\/\d+\//, '/')
              const currentCleanUrl = currentNavigationUrl.replace(/\/u\/\d+\//, '/')
              return url.host === 'photos.google.com' && newCleanUrl !== currentCleanUrl
            }, { timeout: 3000 }) // Shorter timeout for faster navigation
            
            const newUrl = await page.url()
            const newCleanUrl = clean(newUrl)
            
            // Check if we've been redirected to home page
            if (await isOnHomePage(page)) {
              customLog('🧭 Redirected to home page during navigation')
              break // Exit navigation loop, let main loop handle recovery
            }
            
            // Check if this is a new photo we haven't processed
            if (!processedUrls.has(newCleanUrl)) {
              customLog(`✅ Successfully navigated to new photo after ${navigationAttempts} attempts`)
              consecutiveRepeats = 0
              break
            } else {
              customLog(`🧭 Still at processed photo, attempt ${navigationAttempts}/5`)
              currentNavigationUrl = newUrl
              await sleep(500) // Short wait before next attempt
            }
            
          } catch (navError) {
            customLog(`⏰ Navigation attempt ${navigationAttempts} timed out, trying again...`)
            await sleep(500)
          }
        }
        
        if (navigationAttempts >= 5) {
          customLog('🧭 Could not navigate after 5 attempts, trying keyboard navigation')
          await page.keyboard.press('ArrowLeft')
          await sleep(1000)
        }
        
      } else {
        // Normal navigation for non-archived photos
        await page.evaluate(() => document.getElementsByClassName('SxgK2b OQEhnd')[0].click())

        await page.waitForURL((url) => {
          const newCleanUrl = url.href.replace(/\/u\/\d+\//, '/')
          return url.host === 'photos.google.com' && newCleanUrl !== cleanCurrentUrl
        }, { timeout: timeoutValue })
        
        // Check for backward navigation
        const newUrl = await page.url()
        const newCleanUrl = clean(newUrl)
        
        if (processedUrls.has(newCleanUrl)) {
          consecutiveRepeats++
          customLog(`🧭 Navigated backward, repeat ${consecutiveRepeats}`)
          
          if (consecutiveRepeats >= 2) {
            customLog('🧭 Using keyboard navigation to break cycle')
            await page.keyboard.press('ArrowLeft')
            await sleep(1000)
            consecutiveRepeats = 0
          }
        } else {
          consecutiveRepeats = 0
        }
      }
      
    } catch (error) {
      customLog('⚠️ Navigation error, using keyboard fallback')
      await page.keyboard.press('ArrowLeft')
      await sleep(1000)
    }
  }
  await browser.close()
})()

const waitForPageLoad = async (page) => {
  customLog(`� Loading page ${page.url()}`)
  try {
    await page.waitForLoadState('domcontentloaded', { timeout: timeoutValue })
    await sleep(200) // Short wait for dynamic content
    return true
  } catch (error) {
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
      customLog('ℹ️ Show right hand drawer')
      await page.keyboard.press('KeyI');
      await sleep(200); // Faster response
    } else {
      customLog('ℹ️ Right hand drawer already visible')
    }
    return true
  } catch (error) {
    customLog('❌ Drawer timeout - skipping this image')
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
      customLog(`❌ ${albumInfo.error}, archiving skipped`)
      return false;
    }
    
    if (albumInfo.hasAlbums) {
      customLog('ℹ️ Albums found - skipping archive')
      return false; // Exit immediately, no archiving needed
    } else {
      customLog('📦 No albums found - photo will be archived')
      // Archive the photo using SHIFT + A
      await page.keyboard.down('Shift');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Shift');
      await sleep(300); // Even shorter wait time
      return true;
    }
  } catch (error) {
    customLog('⏰ Archive element timeout - skipping this image')
    return false;
  }
}

const archivePhoto = async (page, firstOne = false) => {
  try {
    const pageLoaded = await waitForPageLoad(page)
    if (!pageLoaded) {
      return 'timeout'
    }
    
    const drawerShown = await showDrawer(page)
    if (!drawerShown) {
      return 'timeout'
    }
    
    const archived = await archiveElement(page)
    await sleep(200) // Reduced wait time
    
    if (archived) {
      customLog('✅ Photo archived successfully')
      return 'archived'
    } else {
      customLog('⏭️ Photo skipped (in album or error)')
      return 'skipped'
    }
  } catch (error) {
    customLog('⏰ Photo processing timeout - skipping')
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