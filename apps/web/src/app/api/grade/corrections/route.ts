import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

const MAX_IMG_CHARS = 2_000_000 // ~1.5MB decoded — reject anything larger

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}
function str(v: unknown): string | null {
  return typeof v === 'string' && v ? v : null
}
/** Accept an inner-box {x1,y1,x2,y2} (all numbers) or an outer [x1,y1,x2,y2]; else null. */
function box(v: unknown): Record<string, number> | number[] | null {
  const r = asRecord(v)
  if (r && ['x1', 'y1', 'x2', 'y2'].every((k) => typeof r[k] === 'number')) return r as Record<string, number>
  if (Array.isArray(v) && v.length === 4 && v.every((n) => typeof n === 'number')) return v
  return null
}

/**
 * POST /api/grade/corrections — record a user's manual fix of the centering inner boundary.
 * Body: { correctedContentRegion: {x1,y1,x2,y2}, originalContentRegion?, cardBoundary?,
 *         leftRight?, topBottom?, originalLeftRight?, originalTopBottom?,
 *         borderType?, graderBackend?, warpedJpegB64? }
 * Each row is a corner-GT label for retraining the per-side centering selector.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const body = asRecord(await req.json().catch(() => null))
  if (!body) return NextResponse.json({ error: 'Invalid JSON body.' }, { status: 400 })

  const corrected = box(body.correctedContentRegion)
  if (!corrected || Array.isArray(corrected))
    return NextResponse.json({ error: 'correctedContentRegion must be {x1,y1,x2,y2}.' }, { status: 400 })

  const img = typeof body.warpedJpegB64 === 'string' ? body.warpedJpegB64 : null
  if (img && img.length > MAX_IMG_CHARS)
    return NextResponse.json({ error: 'Attached image is too large.' }, { status: 413 })

  const row = {
    user_id: user.id,
    original_content_region: box(body.originalContentRegion),
    corrected_content_region: corrected,
    card_boundary: box(body.cardBoundary),
    left_right: str(body.leftRight),
    top_bottom: str(body.topBottom),
    original_left_right: str(body.originalLeftRight),
    original_top_bottom: str(body.originalTopBottom),
    border_type: str(body.borderType),
    grader_backend: str(body.graderBackend),
    warped_image_b64: img,
  }

  const { data, error } = await supabase
    .from('centering_corrections')
    .insert(row)
    .select('correction_id')
    .single()

  if (error) {
    console.error('[grade/corrections] insert failed:', error.message)
    return NextResponse.json({ error: 'Could not save correction.' }, { status: 500 })
  }
  return NextResponse.json({ ok: true, correctionId: data.correction_id })
}
