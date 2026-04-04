import { NextRequest } from 'next/server'
import { createServiceClient } from '@/lib/supabase/server'
import { generateMarketIntelligence } from '@/lib/market/intelligenceEngine'

export const maxDuration = 120

export async function GET(req: NextRequest) {
  const authHeader = req.headers.get('authorization')
  const expected = `Bearer ${process.env.CRON_SECRET}`

  if (!process.env.CRON_SECRET || authHeader !== expected) {
    return new Response(JSON.stringify({ error: 'Unauthorized' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json' },
    })
  }

  try {
    const supabase = createServiceClient()

    // Guard: limit to 1 run per day
    const todayStart = new Date()
    todayStart.setUTCHours(0, 0, 0, 0)

    const { data: existing } = await supabase
      .from('market_intelligence_posts')
      .select('id')
      .gte('generated_at', todayStart.toISOString())
      .limit(1)
      .maybeSingle()

    if (existing) {
      return Response.json({ ok: true, generated: 0, skipped: 'already ran today' })
    }

    // Generate posts
    const posts = await generateMarketIntelligence()

    if (posts.length === 0) {
      return Response.json({ ok: true, generated: 0, note: 'No posts generated — insufficient price history data' })
    }

    // Store posts
    let generated = 0
    const now = new Date().toISOString()

    for (const post of posts) {
      const { error } = await supabase
        .from('market_intelligence_posts')
        .insert({
          headline:         post.headline,
          body:             post.body,
          signal_types:     post.signal_types,
          cards_referenced: post.cards_referenced,
          data_snapshot:    {},
          confidence:       post.confidence,
          generated_at:     now,
        })

      if (error) {
        console.error('[cron/market-intelligence] Insert error:', error.message)
      } else {
        generated++
      }
    }

    return Response.json({ ok: true, generated })
  } catch (err) {
    console.error('[cron/market-intelligence] Error:', err)
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
