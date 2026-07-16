import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

/**
 * GET /api/catalog/resolve?ptcg=<pokemon_tcg_id>
 * Resolve a pokemontcg id (the grade's RAG-verified registration ref_id, e.g. "sv3pt5-199") to the
 * internal catalog_id, so the grade page's card profile can deep-link to the full /analyze/[catalogId]
 * page (price chart, PSA-by-grade pricing, tournament meta). Returns { catalogId } or { catalogId: null }.
 */
export async function GET(req: Request) {
  const ptcg = new URL(req.url).searchParams.get('ptcg')?.trim()
  if (!ptcg) return NextResponse.json({ catalogId: null })
  try {
    const supabase = await createClient()
    const { data } = await supabase
      .from('card_catalog_items')
      .select('catalog_id')
      .eq('metadata_json->>pokemon_tcg_id', ptcg)
      .limit(1)
      .maybeSingle()
    return NextResponse.json({ catalogId: data?.catalog_id ?? null })
  } catch {
    return NextResponse.json({ catalogId: null })
  }
}
