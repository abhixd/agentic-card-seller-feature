#!/usr/bin/env node
/**
 * scripts/scrape-ebay-bulk.mjs
 *
 * Scrapes PSA-graded Pokémon card images from eBay sold listings WITHOUT
 * filtering by grade, and captures full listing metadata alongside each image.
 *
 * Usage:
 *   node scripts/scrape-ebay-bulk.mjs [options]
 *
 * Options:
 *   --count  N   Total images to collect (default: 500)
 *   --dry-run    Print what would be downloaded, don't save anything
 *   --headed     Show browser window (useful for debugging)
 *
 * Outputs (all in BASE_DIR/staging/):
 *   staged_NNNNNN_front.jpeg   — downloaded listing image
 *   metadata.csv               — one row per image: filename + listing details
 *   .seen_urls.json            — URL dedup log (delete to rescrape from scratch)
 *
 * Next step after scraping:
 *   python3 scripts/sort_staged_images.py
 * — reads grade from PSA label via Claude Vision, moves to grade folders.
 *
 * The metadata.csv grade_from_title column already gives a rough sort for free
 * (parsed from the eBay listing title), but Vision verification is more reliable.
 */

import { chromium } from 'playwright'
import { mkdirSync, existsSync, readFileSync, writeFileSync,
         readdirSync, appendFileSync, statSync } from 'fs'
import { join } from 'path'
import https from 'https'
import http from 'http'
import { execSync } from 'child_process'

// ── Config ─────────────────────────────────────────────────────────────────────
const BASE_DIR    = '/Users/srinivasdoddi/srini/card-solutoin-testing/datasets/psa_graded'
const STAGING_DIR = '/Users/srinivasdoddi/srini/agentic-card-seller-os/notebooks/staging'
const SEEN_FILE   = join(STAGING_DIR, '.seen_urls.json')
const META_FILE   = join(STAGING_DIR, 'metadata.csv')

const SCROLL_STEPS   = 8      // scrolls per page (triggers lazy-load images)
const SCROLL_DELAY   = 900    // ms between scrolls
const DOWNLOAD_DELAY = 600    // ms between image downloads
const PAGE_WAIT      = 2800   // ms after navigation before scraping
const MAX_PAGES      = 8      // result pages to crawl per query
const JPEG_QUALITY   = 95

// SIR-targeted queries — Special Illustration Rare (SIR) are the full-art,
// highly detailed modern Pokémon cards collectors care most about.
// Japanese equivalents are SAR (Special Art Rare).
// All queries include PSA to bias toward PSA-graded slabs.
const QUERIES = [
  'PSA+pokemon+special+illustration+rare+graded',
  'PSA+pokemon+SIR+graded+card',
  'PSA+pokemon+SAR+japanese+graded',
  'PSA+charizard+ex+SIR+special+illustration',
  'PSA+gardevoir+ex+SIR+special+illustration',
  'PSA+iono+SIR+pokemon+graded',
  'PSA+pokemon+hyper+rare+full+art+graded',
  'PSA+miraidon+ex+SIR+graded',
  'PSA+iron+valiant+ex+SIR+graded',
  'PSA+pokemon+special+illustration+rare+paldea',
  'PSA+pokemon+SIR+obsidian+flames+graded',
  'PSA+pokemon+SIR+paradox+rift+graded',
]

// eBay ACTIVE listings — Pokémon Individual Cards (cat 183454).
// Active listings always show the seller's real slab photo.
// Completed/sold listings replace the photo with eBay catalog placeholders.
// BIN + Auction gives broadest coverage; no sold filter.
const SEARCH_URL = (q, page) =>
  `https://www.ebay.com/sch/i.html?_nkw=${q}&_sacat=183454&LH_ItemCondition=3000&_ipg=60&_pgn=${page}`

// ── CLI ────────────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2)
const getArg  = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : d }
const hasFlag = f => args.includes(f)
const TARGET  = parseInt(getArg('--count', 500))
const DRY_RUN = hasFlag('--dry-run')
const HEADED  = hasFlag('--headed')

// ── Helpers ────────────────────────────────────────────────────────────────────

function loadSeen() {
  if (!existsSync(SEEN_FILE)) return new Set()
  try { return new Set(JSON.parse(readFileSync(SEEN_FILE, 'utf8'))) }
  catch { return new Set() }
}
function saveSeen(seen) {
  writeFileSync(SEEN_FILE, JSON.stringify([...seen]))
}

function nextIndex() {
  if (!existsSync(STAGING_DIR)) return 1
  const nums = readdirSync(STAGING_DIR)
    .map(f => { const m = f.match(/^staged_(\d+)_front/); return m ? parseInt(m[1]) : 0 })
    .filter(Boolean)
  return nums.length ? Math.max(...nums) + 1 : 1
}

/** Upgrade eBay CDN thumbnail URL to full resolution (s-l1600). */
function upgradeResolution(url) {
  return url.replace(/\/s-l\d+(\.\w+)(\?.*)?$/, '/s-l1600$1').replace(/\?.*$/, '')
}

/** Extract PSA grade from a listing title string.
 *  Handles: "PSA 10", "PSA-9", "PSA9", "PSA Grade 8", "Grade 7 PSA"
 *  Returns grade as a string ("5"–"10") or "" if not found. */
function gradeFromTitle(title) {
  const t = title.toUpperCase()
  // patterns: "PSA 10", "PSA-10", "PSA10", "PSA GRADE 10", "GRADE 10 PSA"
  const patterns = [
    /PSA[\s\-]*GRADE[\s\-]*(\d+)/,
    /PSA[\s\-]*(\d{1,2})/,
    /GRADE[\s\-]*(\d{1,2})[\s\S]*PSA/,
  ]
  for (const re of patterns) {
    const m = t.match(re)
    if (m) {
      const g = parseInt(m[1])
      if (g >= 1 && g <= 10) return String(g)
    }
  }
  return ''
}

/** Download a URL and save as a genuine JPEG (converts WebP if needed). */
async function download(url, destPath) {
  const rawBuf = await new Promise(resolve => {
    const proto = url.startsWith('https') ? https : http
    const req = proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://www.ebay.com/',
      },
      timeout: 20000,
    }, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        download(res.headers.location, destPath).then(resolve); return
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
  if (!rawBuf || rawBuf.length < 2000) return false

  // eBay CDN now serves almost all images as WebP regardless of the URL extension.
  // Use macOS sips (always available, no Python env needed) for WebP → JPEG.
  const isWebP = rawBuf.slice(0,4).toString('hex') === '52494646' &&
                 rawBuf.slice(8,12).toString() === 'WEBP'
  if (isWebP) {
    const tmp = destPath + '.tmp.webp'
    writeFileSync(tmp, rawBuf)
    try {
      execSync(`sips -s format jpeg "${tmp}" --out "${destPath}"`, { stdio: 'pipe' })
      try { execSync(`rm -f "${tmp}"`) } catch {}
      return true
    } catch (e) {
      try { execSync(`rm -f "${tmp}"`) } catch {}
      return false
    }
  }
  // JPEG or other format — save as-is
  writeFileSync(destPath, rawBuf)
  return true
}

/** Detect grading company from listing title. */
function gradingCompany(title) {
  const t = title.toUpperCase()
  if (/\bPSA\b/.test(t))           return 'PSA'
  if (/\bBGS\b|\bBECKETT\b/.test(t)) return 'BGS'
  if (/\bCGC\b/.test(t))           return 'CGC'
  if (/\bSGC\b/.test(t))           return 'SGC'
  return 'unknown'
}

/** Detect SIR / Special Illustration Rare from title. */
function isSIR(title) {
  const t = title.toUpperCase()
  return /\bSIR\b|SPECIAL\s+ILLUSTRATION\s+RARE|\bSAR\b|SPECIAL\s+ART\s+RARE|HYPER\s+RARE/.test(t) ? 'yes' : 'no'
}

/** Escape a string for CSV (quote if it contains comma, quote, or newline). */
function csvEscape(s) {
  s = String(s ?? '').replace(/\r?\n/g, ' ')
  if (s.includes(',') || s.includes('"') || s.includes("'")) {
    return '"' + s.replace(/"/g, '""') + '"'
  }
  return s
}

/** Append one row to metadata.csv (creates header on first write). */
function writeMeta(row) {
  const COLS = ['filename','ebay_title','card_name_guess','psa_grade_from_title',
                'grading_company','is_sir',
                'sold_price','sold_date','ebay_url','image_url','query','vision_grade']
  const needsHeader = !existsSync(META_FILE) || statSync(META_FILE).size === 0
  if (needsHeader) appendFileSync(META_FILE, COLS.join(',') + '\n')
  const line = COLS.map(c => csvEscape(row[c] ?? '')).join(',')
  appendFileSync(META_FILE, line + '\n')
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Extract listings from one eBay results page ────────────────────────────────
// Only collects items that have a real /itm/ listing URL (skips nav/category images).

async function extractListings(page) {
  return page.evaluate(() => {
    const results  = []
    const seenImgs = new Set()
    const seenHrefs = new Set()

    // Title selectors — eBay sometimes changes class names between headless/headed.
    const TITLE_SEL = [
      '.s-item__title',
      '[class*="item-title"]',
      '[class*="itemTitle"]',
      'h3', 'h2',
    ].join(',')
    const PRICE_SEL = [
      '.s-item__price',
      '[class*="item__price"]',
      '[class*="itemPrice"]',
      '[class*="notranslate"]',
    ].join(',')
    const DATE_SEL = [
      '.s-item__title--tag',
      '[class*="COMPLETED"]',
      '[class*="s-item__ended"]',
      '[class*="sold"]',
    ].join(',')

    for (const img of document.querySelectorAll('img')) {
      // ── image URL ───────────────────────────────────────────────────────────
      let src = img.src || img.dataset.src || ''
      if (!src || src.startsWith('data:')) {
        const ss = img.getAttribute('srcset') || ''
        src = ss.split(',').map(p => p.trim().split(' ')[0]).filter(Boolean).pop() || ''
      }
      if (!src || !src.includes('ebayimg.com')) continue
      if (/\/s-l(64|140|96|48|32)\b/.test(src)) continue   // skip tiny icons
      // Skip eBay catalog/placeholder images — these are NOT seller photos.
      // Pattern: /00/s/{dimensions}/  or  /$_1.JPG  or  /thumbs/images/g/
      if (/\/00\/s\//.test(src) || /\$_\d+\./.test(src)) continue
      if (seenImgs.has(src)) continue
      seenImgs.add(src)

      // ── title: img alt attribute is the most reliable in headless mode ──────
      // eBay's CDN images carry the listing title in alt text even when the DOM
      // text nodes aren't fully hydrated in headless.
      const BAD_TITLES = new Set(['Category','Have one to sell?','Shop on eBay',
                                  'eBay','Motors','Fashion','Electronics',''])
      let title = (img.alt || img.title || '').trim()
      if (BAD_TITLES.has(title) || title.length < 6) title = ''

      // ── walk up DOM for href, price, date, and title fallback ───────────────
      let node = img.parentElement
      let price = '', date = '', href = ''
      for (let depth = 0; depth < 10 && node; depth++) {
        if (!href) {
          const a = node.matches('a[href*="/itm/"]') ? node
                  : node.querySelector('a[href*="/itm/"]')
          if (a) href = a.href || ''
        }
        if (!title) {
          // Try text-based selectors as fallback
          const t = node.querySelector(TITLE_SEL)
          const txt = t?.innerText?.trim() || ''
          if (txt && !BAD_TITLES.has(txt) && txt.length > 10) title = txt
        }
        if (!price) {
          const p = node.querySelector(PRICE_SEL)
          if (p) price = p.innerText?.trim() || ''
        }
        if (!date) {
          const d = node.querySelector(DATE_SEL)
          if (d) date = d.innerText?.trim() || ''
        }
        node = node.parentElement
      }

      // ── require a real listing URL; skip nav/category/sidebar images ────────
      if (!href || !href.includes('/itm/')) continue
      // Deduplicate by item ID within this page extraction call
      const itemId = href.match(/\/itm\/(\d+)/)?.[1] || href
      if (seenHrefs.has(itemId)) continue
      seenHrefs.add(itemId)

      results.push({ imageUrl: src, title, price, date, href, itemId })
    }
    return results
  })
}

// ── Scrape one search query across multiple pages ──────────────────────────────

async function scrapeQuery(browser, query, seen, idx, remaining) {
  let collected = 0

  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    }
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })

  const page = await context.newPage()
  await page.route('**/*.{woff,woff2,otf,ttf}', r => r.abort())
  await page.route('**/analytics/**', r => r.abort())

  // Seed homepage to pick up cookies (helps bypass bot detection)
  await page.goto('https://www.ebay.com/', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await sleep(1200)

  try {
    for (let pageNum = 1; pageNum <= MAX_PAGES && collected < remaining; pageNum++) {
      const url = SEARCH_URL(query, pageNum)
      console.log(`    page ${pageNum}: ${url.substring(0, 95)}...`)

      try {
        await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
      } catch {
        console.log('      navigation timeout — using what loaded')
      }
      await sleep(PAGE_WAIT)

      // Scroll to trigger lazy-loaded images
      for (let s = 0; s < SCROLL_STEPS; s++) {
        await page.evaluate(() => window.scrollBy(0, window.innerHeight * 0.75))
        await sleep(SCROLL_DELAY)
      }

      const listings = await extractListings(page)
      console.log(`      listings found: ${listings.length}`)
      if (!listings.length) { console.log('      no results — stopping'); break }

      for (const listing of listings) {
        if (collected >= remaining) break
        // Deduplicate by listing item ID across pages and queries —
        // eBay reuses the same CDN image URL for the same card across many
        // different listings, so image-URL dedup causes almost everything
        // to be skipped. Item ID is unique per listed object.
        const itemId = listing.itemId || listing.href
        if (seen.has(itemId)) continue
        seen.add(itemId)
        const canonical = upgradeResolution(listing.imageUrl)

        const fileIdx  = idx + collected
        const fname    = `staged_${String(fileIdx).padStart(6, '0')}_front.jpeg`
        const destPath = join(STAGING_DIR, fname)

        const parsedGrade = gradeFromTitle(listing.title)

        // Guess card name: strip common PSA/grade/grading noise from title
        const cardName = listing.title
          .replace(/PSA[\s\-]*\d*/gi, '').replace(/graded/gi, '')
          .replace(/gem mint|mint|near mint|nm/gi, '').replace(/\s{2,}/g, ' ').trim()

        const company = gradingCompany(listing.title)
        const sir     = isSIR(listing.title)

        if (DRY_RUN) {
          console.log(`      [dry-run] ${fname}  ${company}  SIR=${sir}  grade=${parsedGrade || '?'}  "${listing.title.substring(0,55)}"`)
          collected++
          writeMeta({ filename: fname, ebay_title: listing.title, card_name_guess: cardName,
                      psa_grade_from_title: parsedGrade, grading_company: company, is_sir: sir,
                      sold_price: listing.price, sold_date: listing.date, ebay_url: listing.href,
                      image_url: canonical, query: decodeURIComponent(query.replace(/\+/g,' ')),
                      vision_grade: '' })
          continue
        }

        process.stdout.write(`      ${fname} [${company} ${parsedGrade || '?'}${sir==='yes'?' SIR':''}] ← `)
        let ok = await download(canonical, destPath)
        if (!ok) {
          const fallback = listing.imageUrl.replace(/\/s-l\d+(\.\w+)/, '/s-l500$1').replace(/\?.*$/, '')
          ok = await download(fallback, destPath)
        }

        if (ok) {
          console.log(`ok  "${listing.title.substring(0, 55)}"`)
          collected++
          writeMeta({ filename: fname, ebay_title: listing.title, card_name_guess: cardName,
                      psa_grade_from_title: parsedGrade, grading_company: company, is_sir: sir,
                      sold_price: listing.price, sold_date: listing.date, ebay_url: listing.href,
                      image_url: canonical, query: decodeURIComponent(query.replace(/\+/g,' ')),
                      vision_grade: '' })
        } else {
          console.log('SKIP')
        }

        await sleep(DOWNLOAD_DELAY)
      }
    }
  } finally {
    await context.close()
  }
  return collected
}

// ── Entry point ────────────────────────────────────────────────────────────────

;(async () => {
  console.log('eBay PSA Pokémon — Bulk Scraper (no grade filter)')
  console.log(`Target: ${TARGET} images  |  Dry-run: ${DRY_RUN}  |  Headed: ${HEADED}`)
  console.log(`Staging: ${STAGING_DIR}`)
  console.log(`Metadata: ${META_FILE}\n`)

  if (!DRY_RUN) mkdirSync(STAGING_DIR, { recursive: true })

  const seen     = loadSeen()
  let   totalNew = 0
  let   idx      = nextIndex()

  console.log(`Resuming from index ${idx}  |  ${seen.size} URLs already seen\n`)

  let browser
  try {
    browser = await chromium.launch({
      headless: !HEADED,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    })
  } catch {
    console.error('Chromium not installed. Run:  npx playwright install chromium')
    process.exit(1)
  }

  for (const query of QUERIES) {
    if (totalNew >= TARGET) break
    const remaining = TARGET - totalNew
    console.log(`\n${'='.repeat(60)}`)
    console.log(`Query: ${decodeURIComponent(query.replace(/\+/g,' '))}`)
    console.log(`Progress: ${totalNew}/${TARGET}  remaining: ${remaining}`)
    console.log('='.repeat(60))

    const got = await scrapeQuery(browser, query, seen, idx + totalNew, remaining)
    totalNew += got

    if (!DRY_RUN) saveSeen(seen)
    console.log(`  Done: +${got}  (total: ${totalNew}/${TARGET})`)
  }

  await browser.close()

  console.log(`\n${'='.repeat(60)}`)
  console.log('COMPLETE')
  console.log('='.repeat(60))
  console.log(`Images staged   : ${totalNew}`)
  console.log(`Metadata CSV    : ${META_FILE}`)
  console.log(`\nNext steps:`)
  console.log(`  1. python3 scripts/sort_staged_images.py   # classify by grade via Claude Vision`)
  console.log(`     (vision_grade column is written back to metadata.csv after sorting)`)
})()
