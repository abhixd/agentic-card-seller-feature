#!/usr/bin/env node
/**
 * scripts/scrape-ebay-psa-images.mjs
 *
 * Scrapes front-card images from eBay sold listings for each PSA grade (5-10).
 * Uses Playwright (headless browser) to bypass eBay's bot detection.
 *
 * Usage:
 *   node scripts/scrape-ebay-psa-images.mjs [--grade 8] [--count 30] [--dry-run]
 *
 * Options:
 *   --grade  N     Only scrape this grade (5-10). Default: all grades.
 *   --count  N     Target images per grade. Default: 40.
 *   --dry-run      Print URLs but don't download.
 *   --query  "…"   Override the search query template (use {grade} as placeholder).
 *
 * Output:  saved to BASE_DIR/{grade}/scraped_NNN_front.jpeg
 * The glob *_front*.jpeg in build_feature_dataset() picks these up automatically.
 */

import { chromium } from 'playwright'
import { createWriteStream, mkdirSync, readdirSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import https from 'https'
import http from 'http'

// ── Config ─────────────────────────────────────────────────────────────────────
const BASE_DIR = '/Users/srinivasdoddi/srini/card-solutoin-testing/datasets/psa_graded'
const GRADES   = [5, 6, 7, 8, 9, 10]
const DEFAULT_COUNT  = 40     // target images per grade
const JPEG_QUALITY   = 95
const SCROLL_STEPS   = 6      // how many times to scroll down per page
const SCROLL_DELAY   = 1200   // ms between scrolls
const DOWNLOAD_DELAY = 800    // ms between image downloads (be polite)
const PAGE_WAIT      = 2500   // ms after navigation before scraping
const MAX_PAGES      = 3      // max eBay result pages to crawl per grade

// eBay search URL — sold/completed pokemon cards category
// LH_Sold=1&LH_Complete=1 = sold listings; _sacat=183454 = Pokémon Individual Cards
const SEARCH_TEMPLATE = 'https://www.ebay.com/sch/i.html?_nkw=PSA+{grade}+pokemon+card+graded&LH_Sold=1&LH_Complete=1&_sacat=183454&_ipg=60&_pgn={page}'

// ── CLI args ───────────────────────────────────────────────────────────────────
const args = process.argv.slice(2)
const getArg = (flag, def) => { const i = args.indexOf(flag); return i >= 0 ? args[i+1] : def }
const hasFlag = flag => args.includes(flag)

const TARGET_GRADES = getArg('--grade', null) ? [parseInt(getArg('--grade'))] : GRADES
const COUNT   = parseInt(getArg('--count', DEFAULT_COUNT))
const DRY_RUN = hasFlag('--dry-run')
const QUERY_TEMPLATE = getArg('--query', SEARCH_TEMPLATE)

// ── Helpers ────────────────────────────────────────────────────────────────────

/** Return the next available scraped_NNN index for a grade dir */
function nextIndex(gradeDir) {
  if (!existsSync(gradeDir)) return 1
  const existing = readdirSync(gradeDir)
    .map(f => { const m = f.match(/^scraped_(\d+)_front/); return m ? parseInt(m[1]) : 0 })
    .filter(Boolean)
  return existing.length ? Math.max(...existing) + 1 : 1
}

/** Upgrade eBay thumbnail URL to full-resolution.
 *  eBay CDN pattern: .../s-l225.jpg → .../s-l1600.jpg
 *  Also handles: s-l64, s-l140, s-l300, s-l500
 */
function upgradeResolution(url) {
  return url
    .replace(/\/s-l\d+(\.\w+)(\?.*)?$/, '/s-l1600$1$2')
    .replace(/\?.*$/, '')  // strip query string (cache busters etc.)
}

/** Download a URL, converting to real JPEG regardless of source format.
 *  eBay CDN often serves WebP with a .jpg/.jpeg URL — this ensures the
 *  saved file is always a genuine JPEG that Pillow/Claude can read. */
async function download(url, destPath) {
  // Fetch the raw bytes via Node http/https
  const rawBuf = await new Promise((resolve) => {
    const proto = url.startsWith('https') ? https : http
    const req = proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://www.ebay.com/',
      },
      timeout: 20000,
    }, (res) => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        download(res.headers.location, destPath).then(resolve)
        return
      }
      if (res.statusCode !== 200) { resolve(null); return }
      const chunks = []
      res.on('data', c => chunks.push(c))
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', () => resolve(null))
    })
    req.on('error', () => resolve(null))
    req.on('timeout', () => { req.destroy(); resolve(null) })
  })
  if (!rawBuf) return false

  // Check magic bytes: if WebP (RIFF....WEBP) convert to JPEG via Python
  const isWebP = rawBuf.slice(0,4).toString('hex') === '52494646' &&
                 rawBuf.slice(8,12).toString() === 'WEBP'
  if (isWebP) {
    // Write temp file, convert with Python Pillow, replace
    const tmp = destPath + '.tmp.webp'
    require('fs').writeFileSync(tmp, rawBuf)
    const { execSync } = require('child_process')
    try {
      execSync(
        `python3 -c "from PIL import Image; Image.open('${tmp}').convert('RGB').save('${destPath}', 'JPEG', quality=95)"`,
        { stdio: 'ignore' }
      )
      require('fs').unlinkSync(tmp)
      return true
    } catch { require('fs').unlinkSync(tmp); return false }
  }

  require('fs').writeFileSync(destPath, rawBuf)
  return true
}

/** Wait ms */
const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Main scraper ───────────────────────────────────────────────────────────────

async function scrapeGrade(browser, grade, targetCount) {
  const gradeDir = join(BASE_DIR, String(grade))
  if (!DRY_RUN) mkdirSync(gradeDir, { recursive: true })

  let startIdx = nextIndex(gradeDir)
  let collected = 0
  const seen = new Set()

  console.log(`\n${'='.repeat(60)}`)
  console.log(`PSA ${grade} — target ${targetCount} images (next index: scraped_${String(startIdx).padStart(3,'0')})`)
  console.log('='.repeat(60))

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 768 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'gzip, deflate, br',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
    }
  })
  // Hide headless / webdriver fingerprints
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })
  const page = await context.newPage()

  // Block unnecessary resources to speed up loading
  await page.route('**/*.{woff,woff2,otf,ttf}', r => r.abort())
  await page.route('**/analytics/**', r => r.abort())
  await page.route('**/tracking/**', r => r.abort())

  // Seed eBay homepage to pick up cookies (bypasses bot detection)
  await page.goto('https://www.ebay.com/', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await sleep(1500)

  try {
    for (let pageNum = 1; pageNum <= MAX_PAGES && collected < targetCount; pageNum++) {
      const url = QUERY_TEMPLATE
        .replace('{grade}', grade)
        .replace('{page}', pageNum)
      console.log(`\n  Page ${pageNum}: ${url}`)

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      } catch (e) {
        console.log(`    Navigation timeout — continuing with what loaded`)
      }
      await sleep(PAGE_WAIT)

      // Scroll to trigger lazy-loaded images
      for (let s = 0; s < SCROLL_STEPS; s++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.8))
        await sleep(SCROLL_DELAY)
      }

      // Extract image URLs — collect all ebayimg src values visible on the page
      const imageUrls = await page.evaluate(() => {
        const seen = new Set()
        const urls = []
        for (const img of document.querySelectorAll('img')) {
          // Try src, then data-src (lazy-load), then first srcset entry
          let src = img.src || img.dataset.src || ''
          if (!src || src.startsWith('data:')) {
            const ss = img.getAttribute('srcset') || ''
            src = ss.split(',').map(p => p.trim().split(' ')[0]).filter(Boolean).pop() || ''
          }
          if (src && src.includes('ebayimg') && !seen.has(src)) {
            seen.add(src)
            urls.push(src)
          }
        }
        return urls
      })

      console.log(`    Raw image URLs found: ${imageUrls.length}`)

      for (const rawUrl of imageUrls) {
        if (collected >= targetCount) break
        if (seen.has(rawUrl)) continue
        seen.add(rawUrl)

        const fullUrl = upgradeResolution(rawUrl)
        const idx = startIdx + collected
        const fname = `scraped_${String(idx).padStart(3,'0')}_front.jpeg`
        const destPath = join(gradeDir, fname)

        if (DRY_RUN) {
          console.log(`    [dry-run] ${fname}  ← ${fullUrl}`)
          collected++
          continue
        }

        process.stdout.write(`    ${fname}  ← downloading... `)
        const ok = await download(fullUrl, destPath)
        if (ok) {
          console.log('ok')
          collected++
        } else {
          // Try lower-res fallback
          const fallback = rawUrl.replace(/\/s-l\d+(\.\w+)/, '/s-l500$1').replace(/\?.*$/, '')
          process.stdout.write(`FAILED → trying s-l500... `)
          const ok2 = await download(fallback, destPath)
          if (ok2) { console.log('ok (fallback)'); collected++ }
          else { console.log('FAILED (skipping)') }
        }

        await sleep(DOWNLOAD_DELAY)
      }

      if (imageUrls.length === 0) {
        console.log('    No images found on this page — stopping pagination')
        break
      }
    }
  } finally {
    await context.close()
  }

  console.log(`\n  PSA ${grade}: collected ${collected}/${targetCount} images`)
  return collected
}

// ── Entry point ────────────────────────────────────────────────────────────────

;(async () => {
  console.log('eBay PSA Card Image Scraper')
  console.log(`Grades: ${TARGET_GRADES.join(', ')}   Count/grade: ${COUNT}   Dry-run: ${DRY_RUN}`)
  console.log(`Output: ${BASE_DIR}/{grade}/scraped_NNN_front.jpeg`)

  // Check Playwright browsers are installed
  let browser
  try {
    browser = await chromium.launch({
      headless: true,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    })
  } catch (e) {
    console.error('\nERROR: Chromium not installed. Run:')
    console.error('  npx playwright install chromium')
    process.exit(1)
  }

  const totals = {}
  for (const grade of TARGET_GRADES) {
    totals[grade] = await scrapeGrade(browser, grade, COUNT)
  }

  await browser.close()

  console.log('\n' + '='.repeat(60))
  console.log('SUMMARY')
  console.log('='.repeat(60))
  for (const [grade, n] of Object.entries(totals)) {
    console.log(`  PSA ${grade}: ${n} new images`)
  }
  console.log('\nDone. Run build_feature_dataset() in the notebook to process new images.')
})()
