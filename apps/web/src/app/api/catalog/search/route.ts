import { NextRequest, NextResponse, after } from 'next/server'
import { createClient, createServiceClient } from '@/lib/supabase/server'
import { searchCatalog } from '@/lib/catalog/searchService'
import { searchPokemonCards } from '@/lib/pokemon/pokemonTcgApi'
import { syncPokemonCards } from '@/lib/pokemon/pokemonTcgSync'
import type { CatalogSearchResponse, CardSearchResult } from '@/types/catalog'

// How long a sync log entry is considered fresh (6 hours).
// Shorter window means new sets (e.g. a brand-new 2026 release) appear
// within a few hours of being added to the Pokemon TCG API.
const SYNC_STALE_MS = 6 * 60 * 60 * 1000

function isPokemon(r: CardSearchResult) {
  return r.franchise_or_brand === 'Pokémon' || r.franchise_or_brand === 'Pokemon'
}

/**
 * De-duplicate search results by (card_name, card_number, set_name).
 * When two rows represent the same card, prefer the one with a pokemon_tcg_id
 * (synced from the API) over bare seed data.
 */
function deduplicateResults(results: CardSearchResult[]): CardSearchResult[] {
  const seen = new Map<string, CardSearchResult>()
  for (const r of results) {
    const key = [
      (r.card_name ?? '').toLowerCase(),
      (r.card_number ?? '').toLowerCase(),
      (r.set_name ?? '').toLowerCase(),
    ].join('|')

    const existing = seen.get(key)
    if (!existing) {
      seen.set(key, r)
    } else {
      const rHasId        = !!(r.metadata_json as any)?.pokemon_tcg_id
      const existingHasId = !!(existing.metadata_json as any)?.pokemon_tcg_id
      if (rHasId && !existingHasId) {
        seen.set(key, r)
      }
    }
  }
  return [...seen.values()]
}

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const q     = searchParams.get('q') ?? ''
  const limit = Number(searchParams.get('limit') ?? '2000')

  // anon client for reads, service client for writes (bypasses RLS)
  const supabase      = await createClient()
  const writeSupabase = createServiceClient()

  const term = q.trim()

  // 1. Check sync_log FIRST so we can widen the DB fetch to match the known api_total.
  //    This prevents popular names (Pikachu: 450+ variants) from being silently cut off
  //    by the default DB_FETCH_MULTIPLIER heuristic.
  let logEntry: { api_total: number; local_count: number; synced_at: string } | null = null
  let needsSync = false

  if (term.length >= 2) {
    const { data } = await writeSupabase
      .from('catalog_sync_log')
      .select('api_total, local_count, synced_at')
      .eq('query_term', term.toLowerCase())
      .maybeSingle()
    logEntry = data

    if (!logEntry) {
      needsSync = true
    } else {
      const stale      = Date.now() - new Date(logEntry.synced_at).getTime() > SYNC_STALE_MS
      // Incomplete: we have fewer DB rows than the API reported (or <95% of expected)
      const incomplete = logEntry.api_total > 0 && logEntry.local_count < logEntry.api_total
      needsSync = stale || incomplete
    }
  }

  // Use api_total + generous buffer as the DB fetch floor so no variants are missed.
  // e.g. Pikachu has 450 API cards → dbLimitOverride=650 ensures all 450+ are returned.
  const dbLimitOverride = logEntry?.api_total
    ? Math.ceil(logEntry.api_total * 1.5) + 100
    : undefined

  // 2. Hit local DB — this is the fast path (~50 ms)
  const { results: localResults, error } = await searchCatalog(supabase, { q, limit, dbLimitOverride })
  if (error) {
    return NextResponse.json({ error }, { status: 500 })
  }

  // 3. Optimistically stamp the log NOW so concurrent requests skip duplicate syncs,
  //    then schedule the actual work to run after the response is sent.
  if (needsSync) {
    await writeSupabase
      .from('catalog_sync_log')
      .upsert(
        {
          query_term:  term.toLowerCase(),
          api_total:   0,   // real value written by after() once sync completes
          local_count: localResults.filter(isPokemon).length,
          synced_at:   new Date().toISOString(),
        },
        { onConflict: 'query_term' },
      )

    after(async () => {
      try {
        const { cards: apiCards, totalCount: apiTotal } = await searchPokemonCards(q)
        if (apiCards.length > 0) {
          await syncPokemonCards(writeSupabase, apiCards, term)
          // Use a high limit to count every synced variant (not just the display limit)
          const { results: refreshed } = await searchCatalog(writeSupabase, { q, limit: apiCards.length + 200 })
          const localCount = (refreshed ?? []).filter(isPokemon).length
          await writeSupabase
            .from('catalog_sync_log')
            .upsert(
              {
                query_term:  term.toLowerCase(),
                api_total:   apiTotal,
                local_count: localCount,
                synced_at:   new Date().toISOString(),
              },
              { onConflict: 'query_term' },
            )
        }
      } catch (err) {
        console.error('[PokemonTCG] Background sync error:', err)
      }
    })
  }

  // 4. Return local results immediately — client re-fetches after sync if syncing=true
  const deduped = deduplicateResults(localResults)
  const body: CatalogSearchResponse = {
    results: deduped,
    query:   q,
    count:   deduped.length,
    syncing: needsSync,
  }
  return NextResponse.json(body)
}
