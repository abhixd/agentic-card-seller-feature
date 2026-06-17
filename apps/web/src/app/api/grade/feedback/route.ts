import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

const ASPECTS = new Set(['centering', 'overall', 'corners', 'edges', 'surface'])
const MAX_COMMENT = 2000
const MAX_IMG_CHARS = 2_000_000 // ~1.5MB decoded — reject anything larger

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
function num(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) ? v : null
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}

/**
 * POST /api/grade/feedback — record a thumbs up/down on a grade read.
 * Body: { verdict: 'up'|'down', aspect?, comment?, context?, warpedJpegB64? }
 * Returns { ok, feedbackId } so the client can attach a comment afterwards via PATCH.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = asRecord(await req.json().catch(() => null))
  if (!body) return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })

  const verdict = body.verdict
  if (verdict !== 'up' && verdict !== 'down')
    return NextResponse.json({ error: 'verdict must be "up" or "down".' }, { status: 400 })

  const aspect = typeof body.aspect === 'string' && ASPECTS.has(body.aspect) ? body.aspect : 'centering'
  const comment = typeof body.comment === 'string' ? body.comment.slice(0, MAX_COMMENT) : null
  const img = typeof body.warpedJpegB64 === 'string' ? body.warpedJpegB64 : null
  if (img && img.length > MAX_IMG_CHARS)
    return NextResponse.json({ error: 'Attached image is too large.' }, { status: 413 })

  const ctx = asRecord(body.context) ?? {}
  const cen = asRecord(ctx.centering) ?? {}

  const row = {
    user_id: user.id,
    aspect,
    verdict,
    comment,
    overall_score: num(ctx.overall_score),
    psa_equivalent: str(ctx.psa_equivalent),
    centering_score: num(cen.score),
    left_right: str(cen.left_right),
    top_bottom: str(cen.top_bottom),
    reliable: typeof cen.reliable === 'boolean' ? cen.reliable : null,
    border_type: str(ctx.border_type),
    grader_backend: str(ctx.grader_backend),
    content_region: ctx.content_region ?? null,
    card_boundary: ctx.card_boundary ?? null,
    warped_image_b64: img,
  }

  const { data, error } = await supabase
    .from('grade_feedback')
    .insert(row)
    .select('feedback_id')
    .single()

  if (error) {
    console.error('[grade/feedback] insert failed:', error.message)
    return NextResponse.json({ error: 'Could not save feedback.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, feedbackId: data.feedback_id })
}

/**
 * PATCH /api/grade/feedback — attach (or update) the comment on a feedback row the
 * user already created with POST. Body: { feedbackId, comment }.
 */
export async function PATCH(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = asRecord(await req.json().catch(() => null))
  if (!body) return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })

  const feedbackId = body.feedbackId
  if (typeof feedbackId !== 'string')
    return NextResponse.json({ error: 'feedbackId is required.' }, { status: 400 })
  const comment = typeof body.comment === 'string' ? body.comment.slice(0, MAX_COMMENT) : null

  // RLS already restricts to own rows; the user_id filter is defence in depth.
  const { error } = await supabase
    .from('grade_feedback')
    .update({ comment })
    .eq('feedback_id', feedbackId)
    .eq('user_id', user.id)

  if (error) {
    console.error('[grade/feedback] update failed:', error.message)
    return NextResponse.json({ error: 'Could not update feedback.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true })
}
