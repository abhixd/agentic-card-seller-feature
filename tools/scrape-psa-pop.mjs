// PSA Population Scraper
//
// PSA's website (psacard.com/pop) is JavaScript-rendered and requires a headless
// browser. To run this scraper you need:
//   npm install puppeteer
//
// HOW TO RUN:
//   node scripts/scrape-psa-pop.mjs
//
// The script will:
// 1. Use Puppeteer to navigate PSA's pop report for Pokemon TCG
// 2. Extract PSA 10/9/8 counts for each card in our catalog
// 3. Store weekly snapshots in psa_pop_snapshots table
//
// WHY THIS MATTERS:
// PSA 10 supply growth rate is the #1 predictor of graded card price compression.
// "Supply grew 340 PSA 10s this month" = price ceiling coming down.

import { readFileSync } from 'fs'
import { createClient } from '@supabase/supabase-js'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// ── Load .env.local ────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '..', '.env.local')

const envRaw = readFileSync(envPath, 'utf8')
for (const line of envRaw.split('\n')) {
  const trimmed = line.trim()
  if (!trimmed || trimmed.startsWith('#')) continue
  const eq = trimmed.indexOf('=')
  if (eq === -1) continue
  const key = trimmed.slice(0, eq).trim()
  const val = trimmed.slice(eq + 1).trim().replace(/^"(.*)"$/, '$1')
  process.env[key] = val
}

const supabaseUrl    = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ── PSA Pokemon TCG URL ────────────────────────────────────────────────────────
// The pop report URL for Pokemon TCG cards on psacard.com
const PSA_POP_URL = 'https://www.psacard.com/pop/tcg-cards/0/pokemon/40040'

// ── Check if puppeteer is installed ───────────────────────────────────────────

let puppeteer
try {
  puppeteer = (await import('puppeteer')).default
} catch {
  console.log('')
  console.log('Puppeteer is not installed. To use this scraper, run:')
  console.log('')
  console.log('  npm install puppeteer')
  console.log('')
  console.log('Then re-run:')
  console.log('  node scripts/scrape-psa-pop.mjs')
  console.log('')
  process.exit(0)
}

// ── Helpers ────────────────────────────────────────────────────────────────────

/**
 * Parse an integer from PSA pop table cell text (handles commas, dashes, etc.)
 */
function parseCount(text) {
  if (!text || text.trim() === '—' || text.trim() === '-') return 0
  return parseInt(text.replace(/,/g, ''), 10) || 0
}

/**
 * Normalize set name for matching against our catalog
 */
function normalizeSetName(raw) {
  return raw?.trim().toLowerCase().replace(/\s+/g, ' ') ?? ''
}

// ── Main scraper ───────────────────────────────────────────────────────────────

async function scrapePsaPop() {
  console.log('Launching headless browser…')
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  })

  const page = await browser.newPage()

  // Set a realistic user agent to avoid bot detection
  await page.setUserAgent(
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
  )

  console.log(`Navigating to ${PSA_POP_URL}`)
  await page.goto(PSA_POP_URL, { waitUntil: 'networkidle2', timeout: 60_000 })

  // Wait for the pop report table to render
  try {
    await page.waitForSelector('table', { timeout: 30_000 })
  } catch {
    console.error('Timed out waiting for PSA pop table. The page structure may have changed.')
    await browser.close()
    process.exit(1)
  }

  console.log('Extracting table data…')

  // Extract rows from the pop report table
  // PSA table typically has columns: Card Name | Set | Grade 10 | Grade 9 | Grade 8 | ... | Total
  const rows = await page.evaluate(() => {
    const results = []
    const tables = document.querySelectorAll('table')

    for (const table of tables) {
      const headerRow = table.querySelector('thead tr, tr:first-child')
      if (!headerRow) continue

      const headers = Array.from(headerRow.querySelectorAll('th, td')).map(
        th => th.textContent?.trim().toLowerCase() ?? ''
      )

      // Find column indices
      const nameIdx  = headers.findIndex(h => h.includes('name') || h.includes('card'))
      const setIdx   = headers.findIndex(h => h.includes('set'))
      const psa10Idx = headers.findIndex(h => h === '10' || h.includes('grade 10') || h.includes('psa 10'))
      const psa9Idx  = headers.findIndex(h => h === '9'  || h.includes('grade 9')  || h.includes('psa 9'))
      const psa8Idx  = headers.findIndex(h => h === '8'  || h.includes('grade 8')  || h.includes('psa 8'))

      if (nameIdx === -1 || psa10Idx === -1) continue

      const bodyRows = table.querySelectorAll('tbody tr, tr:not(:first-child)')
      for (const row of bodyRows) {
        const cells = Array.from(row.querySelectorAll('td'))
        if (cells.length < 3) continue

        results.push({
          card_name:  cells[nameIdx]?.textContent?.trim() ?? '',
          set_name:   setIdx  !== -1 ? cells[setIdx]?.textContent?.trim()  ?? '' : '',
          psa_10:     cells[psa10Idx]?.textContent?.trim() ?? '0',
          psa_9:      psa9Idx !== -1 ? cells[psa9Idx]?.textContent?.trim()  ?? '0' : '0',
          psa_8:      psa8Idx !== -1 ? cells[psa8Idx]?.textContent?.trim()  ?? '0' : '0',
        })
      }

      if (results.length > 0) break // Use first matching table
    }

    return results
  })

  await browser.close()

  if (rows.length === 0) {
    console.warn('No rows extracted. PSA page structure may have changed — inspect the page manually.')
    process.exit(1)
  }

  console.log(`Extracted ${rows.length} rows from PSA pop report`)

  // ── Load our catalog to match card_name + set_name ──────────────────────────

  const { data: catalog } = await supabase
    .from('card_catalog_items')
    .select('catalog_id, card_name, set_name')
    .eq('franchise_or_brand', 'Pokémon')

  const catalogIndex = new Map()
  for (const item of catalog ?? []) {
    const key = `${item.card_name?.toLowerCase().trim()}||${normalizeSetName(item.set_name)}`
    catalogIndex.set(key, item.catalog_id)
  }

  // ── Build snapshot records ───────────────────────────────────────────────────

  const snapshotDate = new Date().toISOString().slice(0, 10) // YYYY-MM-DD
  const snapshots = []
  let matched = 0
  let unmatched = 0

  for (const row of rows) {
    const key = `${row.card_name.toLowerCase().trim()}||${normalizeSetName(row.set_name)}`
    const catalogId = catalogIndex.get(key)

    if (!catalogId) {
      unmatched++
      continue
    }

    matched++
    snapshots.push({
      catalog_id:    catalogId,
      snapshot_date: snapshotDate,
      set_name:      row.set_name,
      card_name:     row.card_name,
      psa_10_count:  parseCount(row.psa_10),
      psa_9_count:   parseCount(row.psa_9),
      psa_8_count:   parseCount(row.psa_8),
    })
  }

  console.log(`Matched: ${matched}  |  Unmatched: ${unmatched}`)

  if (snapshots.length === 0) {
    console.warn('No snapshots to upsert — check if card names align between PSA and our catalog.')
    process.exit(0)
  }

  // ── Upsert into psa_pop_snapshots ────────────────────────────────────────────

  console.log(`Upserting ${snapshots.length} PSA pop snapshots…`)

  const { data, error } = await supabase
    .from('psa_pop_snapshots')
    .upsert(snapshots, { onConflict: 'catalog_id,snapshot_date' })
    .select('catalog_id, snapshot_date')

  if (error) {
    console.error('Upsert failed:', error.message)
    process.exit(1)
  }

  console.log(`Done. Stored ${data?.length ?? 0} snapshots for ${snapshotDate}.`)
}

scrapePsaPop().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
