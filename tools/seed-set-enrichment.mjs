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

const supabaseUrl     = process.env.NEXT_PUBLIC_SUPABASE_URL
const serviceRoleKey  = process.env.SUPABASE_SERVICE_ROLE_KEY

if (!supabaseUrl || !serviceRoleKey) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env.local')
  process.exit(1)
}

const supabase = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false, autoRefreshToken: false },
})

// ── Seed data — manually researched, permanently valuable ─────────────────────

const SETS = [
  { set_name: 'Base Set', release_year: 1999, print_era: 'wotc', reprint_count: 0, last_reprint_year: null, reprint_risk: 'none', print_run_size: 'scarce', collector_notes: 'Original WOTC print. Shadowless 1st Ed PSA 10 Charizard ~$10k+. Never reprinted.' },
  { set_name: 'Jungle', release_year: 1999, print_era: 'wotc', reprint_count: 0, last_reprint_year: null, reprint_risk: 'none', print_run_size: 'scarce', collector_notes: 'First expansion. Scyther and Clefable holos have strong collector demand.' },
  { set_name: 'Fossil', release_year: 1999, print_era: 'wotc', reprint_count: 0, last_reprint_year: null, reprint_risk: 'none', print_run_size: 'scarce', collector_notes: 'Aerodactyl, Lapras, Gengar holos. Heavily age-cracked print quality challenges PSA 10.' },
  { set_name: 'Team Rocket', release_year: 2000, print_era: 'wotc', reprint_count: 0, last_reprint_year: null, reprint_risk: 'none', print_run_size: 'scarce', collector_notes: 'Dark Charizard and Dark Raichu are crown jewels. Only WOTC set with "Dark" mechanic.' },
  { set_name: 'Gym Heroes', release_year: 2000, print_era: 'wotc', reprint_count: 0, last_reprint_year: null, reprint_risk: 'none', print_run_size: 'scarce', collector_notes: "Misty's Tears holo extremely rare print error. Lt. Surge's Raichu strong demand." },
  { set_name: 'Gym Challenge', release_year: 2000, print_era: 'wotc', reprint_count: 0, last_reprint_year: null, reprint_risk: 'none', print_run_size: 'scarce', collector_notes: "Blaine's Charizard #2 is the chase card. Koga's Beedrill is underrated." },
  { set_name: 'Neo Genesis', release_year: 2000, print_era: 'wotc', reprint_count: 0, last_reprint_year: null, reprint_risk: 'none', print_run_size: 'scarce', collector_notes: 'Introduced Gen 2. Lugia is the most valuable Neo card. First baby Pokémon mechanic.' },
  { set_name: 'Neo Discovery', release_year: 2001, print_era: 'wotc', reprint_count: 0, last_reprint_year: null, reprint_risk: 'none', print_run_size: 'scarce', collector_notes: 'Espeon and Umbreon from this set. Umbreon holo is heavily sought after.' },
  { set_name: 'Neo Revelation', release_year: 2001, print_era: 'wotc', reprint_count: 0, last_reprint_year: null, reprint_risk: 'none', print_run_size: 'scarce', collector_notes: 'Ho-oh holo. Suicune and Entei are key pulls.' },
  { set_name: 'Neo Destiny', release_year: 2002, print_era: 'wotc', reprint_count: 0, last_reprint_year: null, reprint_risk: 'none', print_run_size: 'ultra_scarce', collector_notes: 'Last WOTC set. Shining Charizard is one of the rarest WOTC cards. Print run smallest of Neo era.' },
  { set_name: 'Expedition Base Set', release_year: 2002, print_era: 'early_ex', reprint_count: 0, last_reprint_year: null, reprint_risk: 'none', print_run_size: 'scarce', collector_notes: 'First e-reader set. Introduced reverse holos. Charizard holo is key.' },
  { set_name: 'Aquapolis', release_year: 2003, print_era: 'early_ex', reprint_count: 0, last_reprint_year: null, reprint_risk: 'none', print_run_size: 'scarce', collector_notes: 'Crystal Lugia and Crystal Ho-Oh are among most valuable non-WOTC vintage cards.' },
  { set_name: 'Skyridge', release_year: 2003, print_era: 'early_ex', reprint_count: 0, last_reprint_year: null, reprint_risk: 'none', print_run_size: 'ultra_scarce', collector_notes: 'Rarest e-reader set. Crystal Charizard ~$3k. Very small print run — last e-reader set.' },
  { set_name: 'Hidden Legends', release_year: 2004, print_era: 'early_ex', reprint_count: 0, last_reprint_year: null, reprint_risk: 'none', print_run_size: 'scarce', collector_notes: 'Deoxys and Regirock ex are key pulls.' },
  { set_name: 'EX Dragon Frontiers', release_year: 2006, print_era: 'early_ex', reprint_count: 0, last_reprint_year: null, reprint_risk: 'none', print_run_size: 'scarce', collector_notes: 'Delta Species Charizard ★ is one of the most valuable EX-era cards.' },
  { set_name: 'Scarlet & Violet', release_year: 2023, print_era: 'sv_era', reprint_count: 1, last_reprint_year: 2023, reprint_risk: 'medium', print_run_size: 'mass_market', collector_notes: 'Launch set for SV era. Charizard ex Alt-Art is the key pull. High print volume.' },
  { set_name: 'Obsidian Flames', release_year: 2023, print_era: 'sv_era', reprint_count: 2, last_reprint_year: 2024, reprint_risk: 'high', print_run_size: 'mass_market', collector_notes: 'Charizard ex Tera Type Black alt-art. Heavily reprinted. Multiple bundle inclusions.' },
  { set_name: 'Paldea Evolved', release_year: 2023, print_era: 'sv_era', reprint_count: 1, last_reprint_year: 2023, reprint_risk: 'medium', print_run_size: 'mass_market', collector_notes: 'Iono FA and Gardevoir ex are the chase cards.' },
  { set_name: 'Paradox Rift', release_year: 2023, print_era: 'sv_era', reprint_count: 1, last_reprint_year: 2024, reprint_risk: 'medium', print_run_size: 'mass_market', collector_notes: 'Iron Valiant ex and Roaring Moon ex alt-arts are the premium pulls.' },
  { set_name: 'Temporal Forces', release_year: 2024, print_era: 'sv_era', reprint_count: 1, last_reprint_year: 2024, reprint_risk: 'medium', print_run_size: 'mass_market', collector_notes: 'Walking Wake ex and Iron Leaves ex. ACE SPEC cards introduced.' },
  { set_name: 'Twilight Masquerade', release_year: 2024, print_era: 'sv_era', reprint_count: 1, last_reprint_year: 2024, reprint_risk: 'medium', print_run_size: 'mass_market', collector_notes: 'Ogerpon ex alt-arts are the premium pulls. Perrin supporter card high demand.' },
  { set_name: 'Shrouded Fable', release_year: 2024, print_era: 'sv_era', reprint_count: 0, last_reprint_year: null, reprint_risk: 'low', print_run_size: 'large', collector_notes: 'Pecharunt ex and Bloodmoon Ursaluna ex. Smaller print run than mainline sets.' },
  { set_name: 'Stellar Crown', release_year: 2024, print_era: 'sv_era', reprint_count: 2, last_reprint_year: 2025, reprint_risk: 'high', print_run_size: 'mass_market', collector_notes: 'Mew ex and Terapagos ex. Mew ex dropped 40% after bundle reprint.' },
  { set_name: 'Surging Sparks', release_year: 2024, print_era: 'sv_era', reprint_count: 1, last_reprint_year: 2025, reprint_risk: 'medium', print_run_size: 'mass_market', collector_notes: 'Pikachu ex alt-art ultra-premium pull. Pikachu 025/091 in several variants.' },
  { set_name: 'Prismatic Evolutions', release_year: 2025, print_era: 'sv_era', reprint_count: 2, last_reprint_year: 2026, reprint_risk: 'high', print_run_size: 'mass_market', collector_notes: 'Eevee-lution set. Umbreon ex FA floor $170+. Multiple bundle reprints. Demand still very high.' },
  { set_name: 'Destined Rivals', release_year: 2026, print_era: 'sv_era', reprint_count: 0, last_reprint_year: null, reprint_risk: 'medium', print_run_size: 'mass_market', collector_notes: 'March 2026 release. Charizard ex alt-art opened at $220, settled ~$150. Bundle risk watch.' },
]

// ── Upsert ────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`Upserting ${SETS.length} set enrichment rows…`)

  const { data, error } = await supabase
    .from('set_enrichment')
    .upsert(SETS, { onConflict: 'set_name' })
    .select('set_name')

  if (error) {
    console.error('Upsert failed:', error.message)
    process.exit(1)
  }

  console.log(`Done. Upserted ${data?.length ?? 0} rows:`)
  for (const row of data ?? []) {
    console.log(`  ✓ ${row.set_name}`)
  }
}

main().catch(err => {
  console.error('Unexpected error:', err)
  process.exit(1)
})
