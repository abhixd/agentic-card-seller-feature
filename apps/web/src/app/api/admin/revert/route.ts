import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * POST /api/admin/revert { id } — roll the live model back to a prior checkpoint.
 * History is append-only, so a revert RE-DEPLOYS the chosen model_artifacts row as the new latest
 * (carrying its config), then asks the grading-api to reload the latest. Fully reversible itself.
 */
export async function POST(req: Request) {
  const { supabase, user } = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  let id: string | undefined
  try { id = (await req.json())?.id } catch { /* below */ }
  if (typeof id !== 'string') return NextResponse.json({ error: 'id required' }, { status: 400 })

  const { data: cp, error } = await supabase
    .from('model_artifacts')
    .select('model_b64, config, loo, n_corrections')
    .eq('id', id)
    .eq('kind', 'perside_centering')
    .single()
  if (error || !cp) return NextResponse.json({ error: 'Checkpoint not found.' }, { status: 404 })

  const { error: insErr } = await supabase.from('model_artifacts').insert({
    kind: 'perside_centering',
    model_b64: cp.model_b64,
    config: cp.config,
    loo: cp.loo,
    n_corrections: cp.n_corrections,
    note: `reverted to ${id.slice(0, 8)}`,
    created_by: user.id,
  })
  if (insErr) {
    console.error('[admin/revert] re-deploy insert failed:', insErr.message)
    return NextResponse.json({ error: 'Could not re-deploy checkpoint.' }, { status: 500 })
  }

  let reloaded = false
  const base = process.env.GRADING_SERVICE_URL
  if (base) {
    try {
      const res = await fetch(`${base.replace(/\/$/, '')}/admin/reload-model`, {
        method: 'POST',
        headers: { ...(process.env.ADMIN_TRAIN_TOKEN ? { 'X-Admin-Token': process.env.ADMIN_TRAIN_TOKEN } : {}) },
      })
      reloaded = res.ok
    } catch { reloaded = false }
  }
  return NextResponse.json({ reverted: true, reloaded })
}
