import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'
export const maxDuration = 60 // the server-side LOO retrain takes ~15–30s

/**
 * POST /api/admin/train — launch a server-side retrain of the per-side centering selector.
 * Pulls the caller's corrections (RLS; service-role for all-users is a later upgrade), forwards
 * them to the grading-api's /admin/train, and returns the leave-one-card-out accuracy delta.
 * Report-only — it doesn't deploy the new model yet (that's the hot-swap, P2b).
 */
export async function POST(req: Request) {
  let deploy = false
  try { deploy = (await req.json())?.deploy === true } catch { /* no body → report-only */ }

  const { supabase, user } = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const base = process.env.GRADING_SERVICE_URL
  if (!base) return NextResponse.json({ error: 'Grading service not configured (GRADING_SERVICE_URL).' }, { status: 500 })

  const { data: corrections, error } = await supabase
    .from('centering_corrections')
    .select('correction_id, original_content_region, corrected_content_region, card_boundary, border_type, warped_image_b64')
  if (error) {
    console.error('[admin/train] read corrections failed:', error.message)
    return NextResponse.json({ error: 'Could not read corrections.' }, { status: 500 })
  }

  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/admin/train`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(process.env.ADMIN_TRAIN_TOKEN ? { 'X-Admin-Token': process.env.ADMIN_TRAIN_TOKEN } : {}),
      },
      body: JSON.stringify({ corrections: corrections ?? [], deploy }),
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ error: data?.detail ?? 'Training failed.' }, { status: 502 })

    // durable: persist the deployed model so it survives grading-api restarts (it loads the latest at startup)
    if (deploy && typeof data.model_b64 === 'string') {
      const { error: insErr } = await supabase.from('model_artifacts').insert({
        kind: 'perside_centering',
        model_b64: data.model_b64,
        config: data.config ?? null,   // checkpoint the config with the model
        note: 'training run',
        loo: data.loo_after,
        n_corrections: data.n_corrections,
        created_by: user.id,
      })
      data.persisted = !insErr
      if (insErr) console.error('[admin/train] persist model failed:', insErr.message)
    }
    delete data.model_b64 // never ship the model blob to the browser
    return NextResponse.json(data)
  } catch (e) {
    console.error('[admin/train] grading-api call failed:', e instanceof Error ? e.message : e)
    return NextResponse.json({ error: 'Could not reach the grading service.' }, { status: 502 })
  }
}
