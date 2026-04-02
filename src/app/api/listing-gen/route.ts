import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import Anthropic from '@anthropic-ai/sdk'

const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY })

export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { analysisId } = await req.json()
    if (!analysisId) return NextResponse.json({ error: 'analysisId required' }, { status: 400 })

    // Fetch analysis + card data
    const { data: analysis } = await supabase
      .from('card_analyses')
      .select(`
        recommendation_type,
        estimated_market_value,
        platform,
        acquisition_cost,
        catalog_id,
        card_catalog_items (
          card_name, set_name, card_number, variant,
          franchise_or_brand, year, metadata_json
        )
      `)
      .eq('analysis_id', analysisId)
      .eq('user_id', user.id)
      .single()

    if (!analysis) return NextResponse.json({ error: 'Analysis not found' }, { status: 404 })

    const card = analysis.card_catalog_items as any
    const prices = card?.metadata_json?.tcgplayer?.prices ?? {}
    const bandNames = Object.keys(prices)
    const priceLines = bandNames.map((b: string) => {
      const p = prices[b]
      return `${b}: market $${p?.market ?? '—'}, mid $${p?.mid ?? '—'}`
    }).join('\n')

    const prompt = `You are a professional trading card listing copywriter. Generate a polished eBay listing for this card.

Card: ${card?.card_name} ${card?.variant ? `(${card.variant})` : ''}
Set: ${card?.set_name} (${card?.year ?? 'unknown year'})
Card Number: ${card?.card_number ?? 'N/A'}
Franchise: ${card?.franchise_or_brand ?? 'Pokémon'}
Platform Target: ${analysis.platform ?? 'eBay'}
Estimated Market Value: $${analysis.estimated_market_value?.toFixed(2) ?? '—'}
Recommendation: ${analysis.recommendation_type}

TCGPlayer Price Bands:
${priceLines || 'No price data'}

Return a JSON object with exactly these fields:
{
  "title": "string — eBay listing title, max 80 characters, include key search terms like card name, set, year, PSA-ready if applicable",
  "description": "string — 3-4 sentence professional listing description. Mention the card, its set, condition (assume Near Mint unless noted), why it's desirable, and a brief call to action.",
  "condition_label": "string — one of: Near Mint, Lightly Played, Moderately Played, Heavily Played, Damaged"
}

Return ONLY the JSON object, no markdown, no explanation.`

    const message = await anthropic.messages.create({
      model:      'claude-opus-4-5',
      max_tokens: 512,
      messages:   [{ role: 'user', content: prompt }],
    })

    const text = (message.content[0] as any)?.text ?? ''
    // Strip any markdown code fences if present
    const clean = text.replace(/```json?\n?/g, '').replace(/```/g, '').trim()
    const result = JSON.parse(clean)

    return NextResponse.json(result)
  } catch (e: any) {
    console.error('listing-gen error:', e)
    return NextResponse.json({ error: e?.message ?? 'Failed to generate listing' }, { status: 500 })
  }
}
