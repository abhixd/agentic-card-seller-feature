/**
 * scrape-limitlesstcg.mjs
 * Fetches top-8 decklists from limitlesstcg.com and upserts card appearances
 * into the tournament_appearances table.
 *
 * Usage:
 *   node scripts/scrape-limitlesstcg.mjs
 *
 * If limitlesstcg returns 403 (blocked / bot-detection triggered), you can pass
 * a live browser session cookie to bypass it:
 *
 *   LIMITLESS_COOKIE="sessionid=abc123; csrftoken=xyz" node scripts/scrape-limitlesstcg.mjs
 *
 * To get a valid cookie:
 *   1. Open https://limitlesstcg.com in your browser, log in (or just browse).
 *   2. Open DevTools → Application → Cookies → copy the Cookie header value.
 *   3. Export it as LIMITLESS_COOKIE before running this script.
 *
 * If the site is unreachable or consistently 403, the script will automatically
 * fall back to seeding from data/sample-tournament-seed.json instead.
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

// ── env setup ────────────────────────────────────────────────────────────────
const __dir = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dir, '..', '.env.local')
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)="?([^"]*)"?$/)
    if (m) process.env[m[1]] = m[2]
  }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY  = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY')
  process.exit(1)
}

const supa = createClient(SUPABASE_URL, SERVICE_KEY, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ── constants ─────────────────────────────────────────────────────────────────
const BASE = 'https://limitlesstcg.com'
const LIST_URL = `${BASE}/tournaments?game=PTCG&type=major&format=standard`
const RATE_LIMIT_MS = 500
const LOOKBACK_DAYS = 90    // for the scraper script; cron uses 14

const UA = 'CardSellerOS/1.0 research-scraper'

const extraHeaders = process.env.LIMITLESS_COOKIE
  ? { Cookie: process.env.LIMITLESS_COOKIE }
  : {}

// ── helpers ───────────────────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise(r => setTimeout(r, ms))
}

async function fetchHtml(url) {
  await sleep(RATE_LIMIT_MS)
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, ...extraHeaders },
  })
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
  return res.text()
}

async function fetchJson(url) {
  await sleep(RATE_LIMIT_MS)
  const res = await fetch(url, {
    headers: { 'User-Agent': UA, Accept: 'application/json', ...extraHeaders },
  })
  if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), { status: res.status })
  const text = await res.text()
  try {
    return JSON.parse(text)
  } catch {
    // Fallback: look for JSON embedded in a <script> tag
    const m = text.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/)
    if (m) return JSON.parse(m[1])
    throw new Error('Response is not JSON and no embedded JSON found')
  }
}

/**
 * Parse the tournament list HTML.
 * Links look like: href="/tournament/XXXXXXXXXXXXXXXX"
 */
function parseTournamentIds(html) {
  const ids = new Set()
  const re = /href="\/tournament\/([a-zA-Z0-9_-]+)"/g
  let m
  while ((m = re.exec(html)) !== null) ids.add(m[1])
  return [...ids]
}

/**
 * Attempt to extract a date from the tournament data or HTML.
 */
function parseDate(raw) {
  if (!raw) return null
  const d = new Date(raw)
  return isNaN(d.getTime()) ? null : d.toISOString().slice(0, 10)
}

/**
 * Look up catalog_id for a card by card_name + set_name.
 * Returns null if not found.
 */
async function lookupCatalog(cardName, setName) {
  const query = supa
    .from('card_catalog_items')
    .select('catalog_id')
    .ilike('card_name', cardName)

  if (setName) query.ilike('set_name', setName)

  const { data } = await query.limit(1).maybeSingle()
  return data?.catalog_id ?? null
}

/**
 * Insert a batch of appearance rows, silently ignoring duplicates.
 * The unique index uses coalesce(set_name,'') which PostgREST can't target
 * by column name, so we use plain insert with ignoreDuplicates (ON CONFLICT DO NOTHING).
 */
async function upsertAppearances(rows) {
  if (rows.length === 0) return 0
  const { error, count } = await supa
    .from('tournament_appearances')
    .insert(rows, { ignoreDuplicates: true })
    .select('id', { count: 'exact', head: true })
  if (error) {
    console.error('  Insert error:', error.message)
    return 0
  }
  return count ?? rows.length
}

// ── main scraping logic ───────────────────────────────────────────────────────

/**
 * Scrape tournaments from the last `days` days.
 * Returns total appearances stored.
 */
export async function scrapeTournaments(days = LOOKBACK_DAYS) {
  const cutoff = new Date(Date.now() - days * 86_400_000)

  // 1. Fetch tournament list
  let html
  try {
    html = await fetchHtml(LIST_URL)
  } catch (err) {
    if (err.status === 403) {
      console.warn('⚠  limitlesstcg returned 403. Set LIMITLESS_COOKIE env var for authenticated access.')
      console.warn('   Falling back to sample seed data...')
      return seedFromSample()
    }
    throw err
  }

  const ids = parseTournamentIds(html)
  if (ids.length === 0) {
    console.warn('No tournament IDs found in HTML — page structure may have changed.')
    console.warn('Falling back to sample seed data...')
    return seedFromSample()
  }

  console.log(`Found ${ids.length} tournament IDs on the listing page`)

  let totalStored = 0

  for (const tid of ids) {
    let tournament
    try {
      tournament = await fetchJson(`${BASE}/api/tournament/${tid}`)
    } catch (err) {
      if (err.status === 403) {
        console.warn(`⚠  403 on tournament ${tid} — falling back to sample seed`)
        return totalStored + (await seedFromSample())
      }
      console.warn(`  Skipping tournament ${tid}: ${err.message}`)
      continue
    }

    // Normalise the shape — the API may wrap data
    const t = tournament.data ?? tournament
    const rawDate = t.date ?? t.tournament_date ?? t.start_date
    const tDate = parseDate(rawDate)

    if (!tDate || new Date(tDate) < cutoff) continue

    const tName = t.name ?? t.title ?? `Tournament ${tid}`
    const format = t.format ?? 'Standard'

    // 2. Pull top-8 placements
    const placements = Array.isArray(t.placements)
      ? t.placements
      : Array.isArray(t.players)
        ? t.players
        : []

    const top8 = placements
      .filter(p => (p.placement ?? p.rank ?? 99) <= 8)
      .slice(0, 8)

    if (top8.length === 0) {
      console.log(`  ${tName} — no top-8 data, skipping`)
      continue
    }

    const rows = []
    let decksFetched = 0

    for (const player of top8) {
      const placement = player.placement ?? player.rank
      const playerName = player.name ?? player.player_name ?? player.player ?? null
      const deckId = player.decklist_id ?? player.deck_id ?? player.id

      if (!deckId) continue

      let decklist
      try {
        decklist = await fetchJson(`${BASE}/api/decklist/${deckId}`)
      } catch {
        continue
      }

      // Normalise decklist cards
      const cards = Array.isArray(decklist.cards)
        ? decklist.cards
        : Array.isArray(decklist.decklist)
          ? decklist.decklist
          : []

      if (cards.length === 0) continue
      decksFetched++

      for (const card of cards) {
        const cardName = card.name ?? card.card_name ?? card.card
        const setName  = card.set ?? card.set_name ?? card.expansion ?? null
        const cardNum  = card.number ?? card.card_number ?? null
        const count    = card.count ?? card.quantity ?? card.qty ?? 1

        if (!cardName) continue

        const catalogId = await lookupCatalog(cardName, setName)

        rows.push({
          catalog_id:      catalogId,
          card_name:       cardName,
          set_name:        setName,
          card_number:     cardNum,
          tournament_id:   tid,
          tournament_name: tName,
          tournament_date: tDate,
          placement,
          deck_count:      count,
          format,
          player_name:     playerName,
          source:          'limitlesstcg.com',
        })
      }
    }

    const stored = await upsertAppearances(rows)
    totalStored += stored
    console.log(`✓ ${tName} ${tDate} — ${decksFetched} decks, ${stored} card appearances stored`)
  }

  return totalStored
}

// ── sample seed fallback ──────────────────────────────────────────────────────
async function seedFromSample() {
  const samplePath = join(__dir, '..', 'data', 'sample-tournament-seed.json')
  if (!existsSync(samplePath)) {
    console.error('Sample seed file not found at data/sample-tournament-seed.json')
    return 0
  }

  const rows = JSON.parse(readFileSync(samplePath, 'utf8'))

  // Attempt catalog lookups
  for (const row of rows) {
    if (!row.catalog_id) {
      row.catalog_id = await lookupCatalog(row.card_name, row.set_name)
    }
  }

  const stored = await upsertAppearances(rows)
  console.log(`✓ Sample seed — ${stored} card appearances stored from ${samplePath}`)
  return stored
}

// ── CLI entry ─────────────────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]
if (isMain) {
  scrapeTournaments()
    .then(total => {
      console.log(`\nTotal appearances stored: ${total}`)
      process.exit(0)
    })
    .catch(err => {
      console.error('Fatal error:', err)
      process.exit(1)
    })
}
