#!/usr/bin/env node
/**
 * scripts/scrape-pricecharting-arr.mjs
 *
 * Scrapes PriceCharting price history for top Pokemon TCG cards,
 * computes CAGR at 1yr / 3yr / 5yr windows, and upserts results into:
 *   - pricecharting_history  (per-card price points + CAGR)
 *   - set_investment_metrics (per-set aggregated grade)
 *
 * Usage:  node scripts/scrape-pricecharting-arr.mjs
 */

import { readFileSync } from 'fs'
import { resolve, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createClient } from '@supabase/supabase-js'

// ── Load .env.local ────────────────────────────────────────────────────────────

const __dir = dirname(fileURLToPath(import.meta.url))
const envPath = resolve(__dir, '../.env.local')

let envVars = {}
try {
  const raw = readFileSync(envPath, 'utf8')
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('#')) continue
    const eq = trimmed.indexOf('=')
    if (eq === -1) continue
    const key = trimmed.slice(0, eq).trim()
    const val = trimmed.slice(eq + 1).trim().replace(/^"|"$/g, '')
    envVars[key] = val
  }
} catch {
  console.error('Could not read .env.local — aborting')
  process.exit(1)
}

const SUPABASE_URL          = envVars.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_ROLE_KEY      = envVars.SUPABASE_SERVICE_ROLE_KEY
const PRICECHARTING_TOKEN   = envVars.PRICECHARTING_API_TOKEN ?? process.env.PRICECHARTING_API_TOKEN ?? ''

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

if (!PRICECHARTING_TOKEN) {
  console.log(`
  ⚠️  No PRICECHARTING_API_TOKEN found.

  PriceCharting requires a free API token to fetch price history.
  Get one at: https://www.pricecharting.com/api

  Then add to your .env.local:
    PRICECHARTING_API_TOKEN=your_token_here

  And re-run:  node scripts/scrape-pricecharting-arr.mjs

  `)
  process.exit(0)
}

const supabase = createClient(SUPABASE_URL, SERVICE_ROLE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ── Helpers ────────────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

/**
 * Find the price in history closest to `targetMs` milliseconds ago.
 * history: Array of [timestamp_ms, price_cents]
 */
function findClosestPrice(history, targetMs) {
  if (!history || history.length === 0) return null
  let best = null
  let bestDiff = Infinity
  for (const [ts, priceCents] of history) {
    const diff = Math.abs(ts - targetMs)
    if (diff < bestDiff) {
      bestDiff = diff
      best = priceCents
    }
  }
  return best != null ? best / 100 : null
}

/**
 * Compute CAGR given start price, end price, and number of years.
 * Returns percentage (e.g. 28.3 for 28.3%) or null if not computable.
 */
function computeCagr(currentPrice, pastPrice, years) {
  if (!pastPrice || pastPrice <= 0 || !currentPrice || currentPrice <= 0 || years <= 0) return null
  return (Math.pow(currentPrice / pastPrice, 1 / years) - 1) * 100
}

/**
 * Assign investment grade from 1yr CAGR percentage.
 */
function assignGrade(cagr1yr) {
  if (cagr1yr == null) return 'N/A'
  if (cagr1yr >  30) return 'A+'
  if (cagr1yr >  15) return 'A'
  if (cagr1yr >   8) return 'B+'
  if (cagr1yr >   3) return 'B'
  if (cagr1yr >=  0) return 'C'
  if (cagr1yr > -10) return 'D'
  return 'F'
}

// ── PriceCharting API ──────────────────────────────────────────────────────────

const PC_BASE = 'https://www.pricecharting.com/api'

async function pcSearch(cardName, setName) {
  const q = encodeURIComponent(`${cardName} ${setName} pokemon`)
  const url = `${PC_BASE}/products?q=${q}&token=${PRICECHARTING_TOKEN}`
  const res = await fetch(url, { headers: { 'User-Agent': 'card-seller-os/1.0' } })
  if (!res.ok) return null
  const json = await res.json()
  if (json.status === 'error') { console.error('  PriceCharting API error:', json['error-message']); return null }
  return json
}

async function pcPriceHistory(productId) {
  const url = `${PC_BASE}/product?id=${productId}&status=price-history&token=${PRICECHARTING_TOKEN}`
  const res = await fetch(url, { headers: { 'User-Agent': 'card-seller-os/1.0' } })
  if (!res.ok) return null
  const json = await res.json()
  if (json.status === 'error') return null
  return json
}

// ── Main ───────────────────────────────────────────────────────────────────────

async function main() {
  console.log('PriceCharting ARR scraper starting...\n')

  // 1. Get top 20 sets by card count
  const { data: setRows, error: setErr } = await supabase
    .from('card_catalog_items')
    .select('set_name')

  if (setErr || !setRows?.length) {
    console.error('Could not fetch card catalog:', setErr?.message)
    process.exit(1)
  }

  // Count cards per set
  const setCounts = {}
  for (const row of setRows) {
    const s = row.set_name
    if (!s) continue
    setCounts[s] = (setCounts[s] ?? 0) + 1
  }

  const topSets = Object.entries(setCounts)
    .sort(([, a], [, b]) => b - a)
    .slice(0, 20)
    .map(([name]) => name)

  console.log(`Found ${topSets.length} sets to process\n`)

  const PRICE_BANDS = [
    'holofoil',
    '1stEditionHolofoil',
    'reverseHolofoil',
    'normal',
    'unlimitedHolofoil',
    '1stEditionNormal',
  ]

  function getMarketPrice(metadata_json) {
    const prices = metadata_json?.tcgplayer?.prices
    if (!prices) return 0
    for (const band of PRICE_BANDS) {
      const p = prices[band]
      if (p?.market && p.market > 0) return p.market
    }
    return 0
  }

  const now = Date.now()
  const ONE_YR_MS  = 365  * 24 * 60 * 60 * 1000
  const THREE_YR_MS = 3 * ONE_YR_MS
  const FIVE_YR_MS  = 5 * ONE_YR_MS

  for (const setName of topSets) {
    // 2. Fetch top 5 cards by TCGPlayer market price for this set
    const { data: cards, error: cardErr } = await supabase
      .from('card_catalog_items')
      .select('catalog_id, card_name, set_name, metadata_json')
      .eq('set_name', setName)

    if (cardErr || !cards?.length) {
      console.log(`  ✗ ${setName} — no cards found, skipping`)
      continue
    }

    const ranked = cards
      .map((c) => ({ ...c, marketPrice: getMarketPrice(c.metadata_json) }))
      .filter((c) => c.marketPrice > 0)
      .sort((a, b) => b.marketPrice - a.marketPrice)
      .slice(0, 5)

    if (ranked.length === 0) {
      console.log(`  ✗ ${setName} — no priced cards, skipping`)
      continue
    }

    const cagrResults = []

    for (const card of ranked) {
      await sleep(500)

      // 3. Search PriceCharting
      let searchResult
      try {
        searchResult = await pcSearch(card.card_name, setName)
      } catch (err) {
        console.log(`    ✗ Search failed for "${card.card_name}": ${err.message}`)
        continue
      }

      if (!searchResult?.products?.length) {
        console.log(`    ✗ "${card.card_name}" not found on PriceCharting`)
        continue
      }

      // 4. Find best match: productType === 'game' and console contains 'Pokemon'
      const match = searchResult.products.find(
        (p) =>
          p['product-type'] === 'game' &&
          typeof p['console-name'] === 'string' &&
          p['console-name'].toLowerCase().includes('pokemon'),
      )

      if (!match) {
        console.log(`    ✗ No Pokemon match for "${card.card_name}"`)
        continue
      }

      await sleep(500)

      // 5. Fetch price history
      let historyResult
      try {
        historyResult = await pcPriceHistory(match.id)
      } catch (err) {
        console.log(`    ✗ History fetch failed for "${card.card_name}": ${err.message}`)
        continue
      }

      const history = historyResult?.prices
      if (!history?.length) {
        console.log(`    ✗ No price history for "${card.card_name}"`)
        continue
      }

      // 6. Compute CAGR
      // history entries are [timestamp_ms, loose_price_cents], sorted ascending
      const latestEntry  = history[history.length - 1]
      const currentPrice = latestEntry[1] / 100
      const priceDate    = new Date(latestEntry[0]).toISOString().slice(0, 10)

      const price1yrAgo  = findClosestPrice(history, now - ONE_YR_MS)
      const price3yrAgo  = findClosestPrice(history, now - THREE_YR_MS)
      const price5yrAgo  = findClosestPrice(history, now - FIVE_YR_MS)

      const cagr1yr  = computeCagr(currentPrice, price1yrAgo,  1)
      const cagr3yr  = computeCagr(currentPrice, price3yrAgo,  3)
      const cagr5yr  = computeCagr(currentPrice, price5yrAgo,  5)

      if (cagr1yr != null) cagrResults.push(cagr1yr)

      // 7. Upsert pricecharting_history
      const { error: upsertErr } = await supabase
        .from('pricecharting_history')
        .upsert(
          {
            catalog_id:            card.catalog_id,
            pricecharting_id:      String(match.id),
            card_name:             card.card_name,
            set_name:              setName,
            price_date:            priceDate,
            current_price:         currentPrice,
            price_1yr_ago:         price1yrAgo,
            price_3yr_ago:         price3yrAgo,
            price_5yr_ago:         price5yrAgo,
            cagr_1yr:              cagr1yr != null ? Math.round(cagr1yr * 100) / 100 : null,
            cagr_3yr:              cagr3yr != null ? Math.round(cagr3yr * 100) / 100 : null,
            cagr_5yr:              cagr5yr != null ? Math.round(cagr5yr * 100) / 100 : null,
            raw_history_snapshot:  history.slice(-365), // keep last ~1yr of daily data
            fetched_at:            new Date().toISOString(),
          },
          { onConflict: 'catalog_id,price_date' },
        )

      if (upsertErr) {
        console.log(`    ✗ DB upsert failed for "${card.card_name}": ${upsertErr.message}`)
      }
    }

    // 8. Compute set-level metrics
    if (cagrResults.length === 0) {
      console.log(`  ✗ ${setName} — no CAGR data computed`)
      continue
    }

    const avgCagr1yr = cagrResults.reduce((s, v) => s + v, 0) / cagrResults.length
    const grade      = assignGrade(avgCagr1yr)

    const { error: metricsErr } = await supabase
      .from('set_investment_metrics')
      .upsert(
        {
          set_name:         setName,
          avg_cagr_1yr:     Math.round(avgCagr1yr * 100) / 100,
          investment_grade: grade,
          cards_sampled:    cagrResults.length,
          last_updated:     new Date().toISOString(),
        },
        { onConflict: 'set_name' },
      )

    if (metricsErr) {
      console.log(`  ✗ set_investment_metrics upsert failed for "${setName}": ${metricsErr.message}`)
    } else {
      console.log(
        `  ✓ ${setName} — ${cagrResults.length} cards, avg CAGR 1yr: ${avgCagr1yr.toFixed(1)}% (Grade: ${grade})`,
      )
    }
  }

  console.log('\nDone.')
}

main().catch((err) => {
  console.error('Fatal error:', err)
  process.exit(1)
})
