/**
 * verify-charizard-sync.mjs
 *
 * Step 6: Trigger a sync by hitting the local search API for 'charizard',
 * then poll catalog_sync_log for up to 60 seconds until local_count >= api_total * 0.95.
 *
 * Run AFTER fix-charizard-sync.mjs and AFTER `npm run dev` is running.
 *
 * Run with:  node scripts/verify-charizard-sync.mjs
 */

import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const envPath = join(__dirname, '..', '.env.local')
const envLines = readFileSync(envPath, 'utf8').split('\n')
const env = {}
for (const line of envLines) {
  const m = line.match(/^([^#=]+)=(.*)$/)
  if (m) env[m[1].trim()] = m[2].trim().replace(/^"|"$/g, '')
}

const SUPABASE_URL = env.NEXT_PUBLIC_SUPABASE_URL
const SERVICE_KEY  = env.SUPABASE_SERVICE_ROLE_KEY
const supabase = createClient(SUPABASE_URL, SERVICE_KEY)

const API_BASE = 'http://localhost:3000'
const TERM = 'charizard'

async function triggerSearch() {
  const url = `${API_BASE}/api/catalog/search?q=${TERM}&limit=2000`
  console.log(`Triggering search: GET ${url}`)
  try {
    const res = await fetch(url)
    const json = await res.json()
    console.log(`  Initial response: count=${json.count}, syncing=${json.syncing}`)
    return json
  } catch (e) {
    console.error('  Could not reach dev server — is `npm run dev` running?', e.message)
    return null
  }
}

async function pollSyncLog(maxWaitMs = 60000) {
  const start = Date.now()
  console.log(`\nPolling catalog_sync_log for "${TERM}" (max ${maxWaitMs / 1000}s)...`)
  while (Date.now() - start < maxWaitMs) {
    const { data } = await supabase
      .from('catalog_sync_log')
      .select('api_total, local_count, synced_at')
      .eq('query_term', TERM)
      .maybeSingle()

    const elapsed = Math.round((Date.now() - start) / 1000)
    if (!data) {
      console.log(`  [${elapsed}s] No log entry yet — sync not started or cleared`)
    } else {
      const pct = data.api_total > 0 ? Math.round((data.local_count / data.api_total) * 100) : 0
      console.log(`  [${elapsed}s] api_total=${data.api_total}  local_count=${data.local_count}  (${pct}%)  synced_at=${data.synced_at}`)
      if (data.api_total > 0 && data.local_count >= data.api_total * 0.95) {
        console.log(`\nSync complete! ${data.local_count}/${data.api_total} variants in DB (${pct}%).`)
        return data
      }
    }
    await new Promise(r => setTimeout(r, 3000))
  }
  console.log('\nTimed out waiting for sync to complete.')
  return null
}

async function main() {
  const initial = await triggerSearch()
  if (!initial) return

  if (!initial.syncing) {
    console.log('\nSearch returned syncing=false — sync log may already be fresh.')
    console.log('Run fix-charizard-sync.mjs first to clear the stale log entry.')
    return
  }

  const result = await pollSyncLog(60000)

  if (result) {
    // Final DB count check
    const { count } = await supabase
      .from('card_catalog_items')
      .select('*', { count: 'exact', head: true })
      .ilike('card_name', '%charizard%')
      .or('franchise_or_brand.eq.Pokémon,franchise_or_brand.eq.Pokemon')
    console.log(`\nFinal Charizard rows in DB: ${count}`)
    console.log(`Expected: ~${result.api_total}`)
    console.log(count >= result.api_total * 0.95 ? 'PASS — all variants synced.' : 'WARN — still below 95% threshold.')
  }
}

main().catch(console.error)
