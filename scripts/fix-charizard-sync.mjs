/**
 * fix-charizard-sync.mjs
 *
 * Step 5 of the Charizard catalog investigation:
 *   1. Counts current Charizard rows in DB
 *   2. Gets the Pokemon TCG API total for charizard
 *   3. If DB count < 80% of API total, deletes ALL Charizard Pokémon rows and clears
 *      the catalog_sync_log entry so the next search triggers a fresh full sync
 *   4. Does the same check for other popular Pokémon names
 *
 * Run with:  node scripts/fix-charizard-sync.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))

// Load .env.local manually (no dotenv dependency needed)
const envPath = join(__dirname, '..', '.env.local')
const envLines = readFileSync(envPath, 'utf8').split('\n')
const env = {}
for (const line of envLines) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) env[m[1].trim()] = m[2].trim().replace(/^"|"$/g, '')
}

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY  = env.SUPABASE_SERVICE_ROLE_KEY
const TCG_API_KEY  = env.POKEMON_TCG_API_KEY

if (!SUPABASE_URL || !SERVICE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

async function getApiTotal(name) {
  const encoded = encodeURIComponent(`name:"*${name}*"`)
  const url = `https://api.pokemontcg.io/v2/cards?q=${encoded}&pageSize=1`
  const res = await fetch(url, { headers: { 'X-Api-Key': TCG_API_KEY } })
  if (!res.ok) throw new Error(`TCG API error ${res.status} for ${name}`)
  const json = await res.json()
  return json.totalCount ?? 0
}

async function getDbCount(name) {
  const { count } = await supabase
    .from('card_catalog_items')
    .select('*', { count: 'exact', head: true })
    .ilike('card_name', `%${name}%`)
    .or('franchise_or_brand.eq.Pokémon,franchise_or_brand.eq.Pokemon')
  return count ?? 0
}

async function deleteAndClearSync(name) {
  // Delete stale rows
  const { error: delErr, count: deleted } = await supabase
    .from('card_catalog_items')
    .delete({ count: 'exact' })
    .ilike('card_name', `%${name}%`)
    .or('franchise_or_brand.eq.Pokémon,franchise_or_brand.eq.Pokemon')
  if (delErr) {
    console.error(`  ERROR deleting ${name} rows:`, delErr.message)
    return
  }
  console.log(`  Deleted ${deleted ?? '?'} stale rows for "${name}"`)

  // Clear sync log entry so next search triggers fresh sync
  const { error: logErr } = await supabase
    .from('catalog_sync_log')
    .delete()
    .eq('query_term', name.toLowerCase())
  if (logErr) {
    console.error(`  ERROR clearing sync log for ${name}:`, logErr.message)
  } else {
    console.log(`  Cleared catalog_sync_log entry for "${name}"`)
  }
}

const POPULAR_NAMES = [
  'charizard', 'pikachu', 'mewtwo', 'umbreon', 'eevee',
  'gengar', 'blastoise', 'venusaur', 'lugia', 'rayquaza', 'darkrai',
]

async function main() {
  // --- Step 1: Current DB state ---
  console.log('\n=== Step 1: Current DB state ===')
  const { count: totalPokemon } = await supabase
    .from('card_catalog_items')
    .select('*', { count: 'exact', head: true })
    .eq('franchise_or_brand', 'Pokémon')
  console.log(`Total Pokémon rows in DB: ${totalPokemon}`)

  const { data: syncLogs } = await supabase
    .from('catalog_sync_log')
    .select('*')
    .order('synced_at', { ascending: false })
  console.log('\nAll catalog_sync_log entries:')
  for (const log of syncLogs ?? []) {
    console.log(`  ${log.query_term}: api_total=${log.api_total}, local_count=${log.local_count}, synced_at=${log.synced_at}`)
  }

  // --- Step 2: API totals + comparison ---
  console.log('\n=== Step 2 & 5: Compare DB vs API, delete stale rows ===')
  for (const name of POPULAR_NAMES) {
    let apiTotal
    try {
      apiTotal = await getApiTotal(name)
    } catch (e) {
      console.log(`  ${name}: API error — ${e.message}`)
      continue
    }
    const dbCount = await getDbCount(name)
    const pct = apiTotal > 0 ? Math.round((dbCount / apiTotal) * 100) : 100
    const status = dbCount < apiTotal * 0.8 ? 'STALE - will delete' : 'OK'
    console.log(`  ${name.padEnd(12)}: DB=${String(dbCount).padStart(4)}  API=${String(apiTotal).padStart(4)}  (${pct}%)  ${status}`)

    if (dbCount < apiTotal * 0.8) {
      await deleteAndClearSync(name)
    }
  }

  console.log('\n=== Done. Stale rows deleted and sync log cleared. ===')
  console.log('Next search for any of the above names will trigger a fresh full sync.')
}

main().catch(console.error)
