#!/usr/bin/env node
/**
 * scripts/scrape-ebay-sir.mjs
 *
 * Scrapes PSA-graded Special Illustration Rare (SIR/SAR) Pokémon card images
 * from eBay SOLD listings.
 *
 * Strategy:
 *   1. Search eBay completed/sold listings for PSA SIR cards → collect /itm/ URLs
 *   2. Visit each individual listing page → extract the real seller gallery photo
 *      (sold listing pages keep original photos; only search thumbnails are replaced)
 *   3. Download + convert WebP → JPEG via sips
 *   4. Write metadata.csv row with grading_company + is_sir + grade
 *
 * Usage:
 *   node scripts/scrape-ebay-sir.mjs [--count N] [--dry-run] [--headed]
 *
 * Output:
 *   BASE_DIR/staging/sir_NNNNNN_front.jpeg   (sir_ prefix so they're easy to spot)
 *   BASE_DIR/staging/metadata.csv            (appended)
 *   BASE_DIR/staging/.seen_sir_ids.json      (visited item IDs, for resume)
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
const SEEN_FILE   = join(STAGING_DIR, '.seen_sir_ids.json')
const META_FILE   = join(STAGING_DIR, 'metadata.csv')

const PAGE_WAIT      = 2500   // ms after navigation
const LISTING_WAIT   = 2000   // ms on individual listing page
const DOWNLOAD_DELAY = 400    // ms between downloads
const JPEG_QUALITY   = 95
const MAX_SEARCH_PAGES = 6    // result pages per query

// SIR-specific queries for SOLD/COMPLETED listings
const QUERIES = [
  'PSA+pokemon+special+illustration+rare',
  'PSA+pokemon+SAR+japanese+graded',
  'PSA+charizard+ex+special+illustration+rare',
  'PSA+gardevoir+ex+special+illustration+rare',
  'PSA+iono+special+illustration+rare+pokemon',
  'PSA+pokemon+SIR+gem+mint+graded',
  'PSA+iron+valiant+ex+special+illustration',
  'PSA+miraidon+ex+special+illustration+rare',
  'PSA+arven+SIR+pokemon+graded',
  'PSA+pokemon+SAR+full+art+rare+japanese',
]

// eBay SOLD/COMPLETED listings - Pokémon Individual Cards (cat 183454)
const SEARCH_URL = (q, page) =>
  `https://www.ebay.com/sch/i.html?_nkw=${q}&LH_Sold=1&LH_Complete=1&_sacat=183454&_ipg=60&_pgn=${page}`

// Grade-targeted queries for PSA 5/6/7 — use sold listings so eBay keeps
// the real seller photos on the individual listing pages.
// Vintage Base Set / Jungle / Fossil / Neo cards dominate at these grades.
const LOWER_GRADE_QUERIES = [
  // PSA 6 — explicit grade in title, various card types
  'PSA+6+pokemon+card+graded',
  'PSA+6+pokemon+holo+rare+graded',
  'PSA+6+pokemon+base+set+graded',
  'PSA+6+pokemon+fossil+graded',
  'PSA+6+pokemon+jungle+graded',
  'PSA+6+pokemon+1st+edition+graded',
  'PSA+6+charizard+pokemon+graded',
  // PSA 7 — explicit grade in title
  'PSA+7+pokemon+card+graded',
  'PSA+7+pokemon+holo+rare+graded',
  'PSA+7+pokemon+base+set+graded',
  'PSA+7+pokemon+fossil+graded',
  'PSA+7+pokemon+jungle+graded',
  'PSA+7+pokemon+1st+edition+graded',
  'PSA+7+charizard+pokemon+graded',
]

// ── CLI ────────────────────────────────────────────────────────────────────────
const args        = process.argv.slice(2)
const getArg      = (f, d) => { const i = args.indexOf(f); return i >= 0 ? args[i+1] : d }
const hasFlag     = f => args.includes(f)
const TARGET      = parseInt(getArg('--count', 200))
const DRY_RUN     = hasFlag('--dry-run')
const HEADED      = hasFlag('--headed')
const LOWER_GRADES = hasFlag('--lower-grades')   // switch to PSA 5/6/7 queries

const ACTIVE_QUERIES = LOWER_GRADES ? LOWER_GRADE_QUERIES : QUERIES

// ── Helpers ────────────────────────────────────────────────────────────────────
function loadSeen() {
  if (!existsSync(SEEN_FILE)) return new Set()
  try { return new Set(JSON.parse(readFileSync(SEEN_FILE, 'utf8'))) }
  catch { return new Set() }
}
function saveSeen(seen) { writeFileSync(SEEN_FILE, JSON.stringify([...seen])) }

function nextIndex() {
  if (!existsSync(STAGING_DIR)) return 1
  const nums = readdirSync(STAGING_DIR)
    .map(f => { const m = f.match(/^sir_(\d+)_front/); return m ? parseInt(m[1]) : 0 })
    .filter(Boolean)
  return nums.length ? Math.max(...nums) + 1 : 1
}

function gradeFromTitle(title) {
  const t = title.toUpperCase()
  for (const re of [/PSA[\s\-]*GRADE[\s\-]*(\d+)/, /PSA[\s\-]*(\d{1,2})/, /GEM\s*MINT\s*(\d+)/]) {
    const m = t.match(re)
    if (m) { const g = parseInt(m[1]); if (g >= 1 && g <= 10) return String(g) }
  }
  return ''
}

function gradingCompany(title) {
  const t = title.toUpperCase()
  if (/\bPSA\b/.test(t)) return 'PSA'
  if (/\bBGS\b|\bBECKETT\b/.test(t)) return 'BGS'
  if (/\bCGC\b/.test(t)) return 'CGC'
  if (/\bSGC\b/.test(t)) return 'SGC'
  return 'unknown'
}

function isSIR(title) {
  const t = title.toUpperCase()
  if (/SIRFETCH|SIR\s*FETCH/.test(t)) return 'no'
  if (/\bLOT\b|\bPACK\b|\bBUNDLE\b|\bMYSTERY\b/.test(t)) return 'no'
  return /SPECIAL\s+ILLUSTRATION\s+RARE|\bSAR\b|HYPER\s+RARE|(?<!\w)SIR(?!\w)/.test(t) ? 'yes' : 'no'
}

function upgradeResolution(url) {
  return url.replace(/\/s-l\d+(\.\w+)(\?.*)?$/, '/s-l1600$1').replace(/\?.*$/, '')
}

async function download(url, destPath) {
  const rawBuf = await new Promise(resolve => {
    const proto = url.startsWith('https') ? https : http
    const req = proto.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36',
        'Referer': 'https://www.ebay.com/',
      }, timeout: 25000,
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
  if (!rawBuf || rawBuf.length < 5000) return false   // too small = placeholder/error

  const isWebP = rawBuf.slice(0,4).toString('hex') === '52494646' &&
                 rawBuf.slice(8,12).toString() === 'WEBP'
  if (isWebP) {
    const tmp = destPath + '.tmp.webp'
    writeFileSync(tmp, rawBuf)
    try {
      execSync(`sips -s format jpeg "${tmp}" --out "${destPath}"`, { stdio: 'pipe' })
      try { execSync(`rm -f "${tmp}"`) } catch {}
      return true
    } catch {
      try { execSync(`rm -f "${tmp}"`) } catch {}
      return false
    }
  }
  writeFileSync(destPath, rawBuf)
  return true
}

function csvEscape(s) {
  s = String(s ?? '').replace(/\r?\n/g, ' ')
  return (s.includes(',') || s.includes('"')) ? '"' + s.replace(/"/g, '""') + '"' : s
}

const META_COLS = ['filename','ebay_title','card_name_guess','psa_grade_from_title',
                   'grading_company','is_sir','sold_price','sold_date',
                   'ebay_url','image_url','query','vision_grade']

function writeMeta(row) {
  const needsHeader = !existsSync(META_FILE) || statSync(META_FILE).size === 0
  if (needsHeader) appendFileSync(META_FILE, META_COLS.join(',') + '\n')
  appendFileSync(META_FILE, META_COLS.map(c => csvEscape(row[c] ?? '')).join(',') + '\n')
}

const sleep = ms => new Promise(r => setTimeout(r, ms))

// ── Step 1: collect item IDs from a search results page ───────────────────────
async function collectItemIds(page, query, seenIds, maxIds) {
  const ids = []
  for (let pg = 1; pg <= MAX_SEARCH_PAGES && ids.length < maxIds; pg++) {
    const url = SEARCH_URL(query, pg)
    console.log(`    page ${pg}: collecting item IDs...`)
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }) }
    catch { console.log('      timeout'); continue }
    await sleep(PAGE_WAIT)

    const pageIds = await page.evaluate(() => {
      const ids = new Set()
      for (const a of document.querySelectorAll('a[href*="/itm/"]')) {
        const m = a.href.match(/\/itm\/(\d{10,})/)
        if (m) ids.add(m[1])
      }
      return [...ids]
    })

    let newCount = 0
    for (const id of pageIds) {
      if (!seenIds.has(id) && ids.length < maxIds) { ids.push(id); newCount++ }
    }
    console.log(`      found ${pageIds.length} item IDs, ${newCount} new`)
    if (pageIds.length === 0) break
  }
  return ids
}

// ── Step 2: visit listing page and extract gallery photo URL ──────────────────
async function getListingPhoto(page, itemId) {
  try {
    await page.goto(`https://www.ebay.com/itm/${itemId}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 })
    await sleep(LISTING_WAIT)
  } catch { return null }

  return page.evaluate(() => {
    // Try 1: JSON-LD structured data (most reliable)
    for (const el of document.querySelectorAll('script[type="application/ld+json"]')) {
      try {
        const d = JSON.parse(el.textContent)
        const imgs = d.image ? (Array.isArray(d.image) ? d.image : [d.image]) : []
        const url = imgs.find(u => u && u.includes('ebayimg.com') && !u.includes('s-l64'))
        if (url) return url
      } catch {}
    }

    // Try 2: embedded __PRELOADED_STATE__ or window data
    for (const el of document.querySelectorAll('script:not([src])')) {
      const text = el.textContent || ''
      // Look for pictureURLLarge or pictureURLSuperSize
      const m = text.match(/"pictureURL(?:Large|SuperSize)"\s*:\s*"([^"]+ebayimg[^"]+)"/)
      if (m) return m[1].replace(/\\u002F/g, '/')
    }

    // Try 3: main carousel image
    for (const img of document.querySelectorAll(
        '.ux-image-carousel-item img, img[data-idx="0"], img.img600, #icImg')) {
      const src = img.getAttribute('data-zoom-src') || img.src || ''
      if (src && src.includes('ebayimg.com') && !src.includes('s-l64') &&
          !/\$_\d+\./.test(src) && !/\/00\/s\//.test(src)) return src
    }

    // Try 4: any large ebayimg that isn't a thumbnail
    for (const img of document.querySelectorAll('img[src*="ebayimg"]')) {
      const src = img.src || ''
      if (/s-l[4-9]\d\d|s-l1[0-9]\d\d/.test(src)) return src
    }
    return null
  })
}

// ── Main ───────────────────────────────────────────────────────────────────────
;(async () => {
  const mode = LOWER_GRADES ? 'PSA 5/6/7 lower-grade mode' : 'SIR mode'
  console.log(`eBay PSA Scraper — sold listing photo extraction [${mode}]`)
  console.log(`Target: ${TARGET} images  |  Dry-run: ${DRY_RUN}  |  Headed: ${HEADED}`)
  console.log(`Staging: ${STAGING_DIR}\n`)

  if (!DRY_RUN) mkdirSync(STAGING_DIR, { recursive: true })

  const seenIds = loadSeen()
  let idx       = nextIndex()
  let collected = 0

  console.log(`Resuming: index ${idx}  |  ${seenIds.size} item IDs already visited\n`)

  let browser
  try {
    browser = await chromium.launch({
      headless: !HEADED,
      args: ['--disable-blink-features=AutomationControlled', '--no-sandbox']
    })
  } catch {
    console.error('Chromium not installed:  npx playwright install chromium')
    process.exit(1)
  }

  // Use ONE context for the whole run (keeps cookies/session)
  const context = await browser.newContext({
    userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    viewport: { width: 1440, height: 900 },
    locale: 'en-US',
    timezoneId: 'America/New_York',
  })
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined })
    window.chrome = { runtime: {} }
  })
  const page = await context.newPage()
  await page.route('**/*.{woff,woff2,otf,ttf}', r => r.abort())

  // Seed eBay cookies
  await page.goto('https://www.ebay.com/', { waitUntil: 'domcontentloaded', timeout: 20000 })
  await sleep(1200)

  for (const query of ACTIVE_QUERIES) {
    if (collected >= TARGET) break
    const qLabel = decodeURIComponent(query.replace(/\+/g,' '))
    console.log(`\n${'='.repeat(60)}`)
    console.log(`Query: ${qLabel}`)
    console.log(`Progress: ${collected}/${TARGET}`)
    console.log('='.repeat(60))

    const remaining = TARGET - collected
    const itemIds = await collectItemIds(page, query, seenIds, remaining + 20) // grab extras for fallback
    console.log(`  → ${itemIds.length} new item IDs to visit`)

    for (const itemId of itemIds) {
      if (collected >= TARGET) break
      seenIds.add(itemId)

      const listingUrl = `https://www.ebay.com/itm/${itemId}`
      process.stdout.write(`  item ${itemId}: `)

      if (DRY_RUN) {
        console.log(`[dry-run] would visit ${listingUrl}`)
        collected++
        continue
      }

      // Get title + photo from listing page
      let title = '', photoUrl = ''
      try {
        await page.goto(listingUrl, { waitUntil: 'domcontentloaded', timeout: 30000 })
        await sleep(LISTING_WAIT)

        title    = await page.title().catch(() => '')
        // Clean up eBay page title: "CARD NAME | eBay" → "CARD NAME"
        title    = title.replace(/\s*\|\s*eBay.*$/i, '').trim()
        photoUrl = await getListingPhoto(page, itemId) || ''
      } catch { console.log('nav error — skip'); continue }

      if (!photoUrl) { console.log(`no photo found — skip ("${title.substring(0,40)}")`); continue }

      const canonical   = upgradeResolution(photoUrl)
      const parsedGrade = gradeFromTitle(title)
      const company     = gradingCompany(title)
      const sir         = isSIR(title)
      const cardName    = title.replace(/PSA[\s\-]*\d*/gi,'').replace(/graded|gem\s*mint|near\s*mint/gi,'').replace(/\s{2,}/g,' ').trim()

      const fname    = `sir_${String(idx + collected).padStart(6,'0')}_front.jpeg`
      const destPath = join(STAGING_DIR, fname)

      process.stdout.write(`[${company} ${parsedGrade || '?'}${sir==='yes'?' SIR':''}] ← `)
      const ok = await download(canonical, destPath)
      if (!ok) {
        // Try lower res fallback
        const fallback = photoUrl.replace(/\/s-l\d+(\.\w+)/, '/s-l500$1').replace(/\?.*$/,'')
        const ok2 = await download(fallback, destPath)
        if (!ok2) { console.log(`SKIP  "${title.substring(0,40)}"`); continue }
      }

      console.log(`ok  "${title.substring(0,55)}"`)
      collected++
      writeMeta({
        filename: fname, ebay_title: title, card_name_guess: cardName,
        psa_grade_from_title: parsedGrade, grading_company: company, is_sir: sir,
        sold_price: '', sold_date: '', ebay_url: listingUrl,
        image_url: canonical, query: qLabel, vision_grade: ''
      })
      await sleep(DOWNLOAD_DELAY)
    }

    if (!DRY_RUN) saveSeen(seenIds)
    console.log(`  Query done. Total so far: ${collected}/${TARGET}`)
  }

  await context.close()
  await browser.close()

  console.log(`\n${'='.repeat(60)}`)
  console.log('COMPLETE')
  console.log(`SIR images collected: ${collected}`)
  console.log(`Staging: ${STAGING_DIR}`)
  console.log('\nNext: sort by grade with  python3 scripts/sort_staged_images.py')
})()
