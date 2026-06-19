import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/restore-baseline — always-available rollback to the original baked-in model.
 * Asks the grading-api to swap back to its baked-in baseline (returning the bytes), then records
 * that as the new latest model_artifacts checkpoint so the rollback survives restarts.
 */
export async function POST() {
  const { supabase, user } = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const base = process.env.GRADING_SERVICE_URL
  if (!base) return NextResponse.json({ error: 'Grading service not configured.' }, { status: 500 })

  try {
    const res = await fetch(`${base.replace(/\/$/, '')}/admin/reset-baseline`, {
      method: 'POST',
      headers: { ...(process.env.ADMIN_TRAIN_TOKEN ? { 'X-Admin-Token': process.env.ADMIN_TRAIN_TOKEN } : {}) },
    })
    const data = await res.json()
    if (!res.ok) return NextResponse.json({ error: data?.detail ?? 'Restore failed.' }, { status: 502 })

    if (typeof data.model_b64 === 'string') {
      const { error: insErr } = await supabase.from('model_artifacts').insert({
        kind: 'perside_centering',
        model_b64: data.model_b64,
        config: data.config ?? null,
        note: 'restored baseline',
        created_by: user.id,
      })
      if (insErr) console.error('[admin/restore-baseline] record failed:', insErr.message)
      return NextResponse.json({ restored: true, recorded: !insErr })
    }
    return NextResponse.json({ restored: true, recorded: false })
  } catch {
    return NextResponse.json({ error: 'Could not reach the grading service.' }, { status: 502 })
  }
}
