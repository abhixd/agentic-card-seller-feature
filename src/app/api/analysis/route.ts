import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { runAnalysis } from '@/lib/analysis/analysisService'

const ConditionRatingsSchema = z.object({
  corners_rating:   z.number().int().min(1).max(5),
  edges_rating:     z.number().int().min(1).max(5),
  surface_rating:   z.number().int().min(1).max(5),
  centering_rating: z.number().int().min(1).max(5),
  notes:            z.string().optional(),
})

const AnalysisRequestSchema = z.object({
  catalogId:        z.string().uuid(),
  conditionRatings: ConditionRatingsSchema.nullable().optional(),
  platform:         z.enum(['ebay', 'tcgplayer']).default('ebay'),
  shippingCost:     z.number().min(0).default(4.0),
  acquisitionCost:  z.number().min(0).default(0),
})

export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  let body: unknown
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = AnalysisRequestSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { analysis, error } = await runAnalysis(supabase, user.id, parsed.data)

  if (error || !analysis) {
    return NextResponse.json({ error: error ?? 'Analysis failed' }, { status: 500 })
  }

  return NextResponse.json(analysis, { status: 201 })
}
