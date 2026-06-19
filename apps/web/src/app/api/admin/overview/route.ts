import { NextResponse } from 'next/server'
import { requireAdmin } from '@/lib/auth/admin'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/**
 * GET /api/admin/overview — the self-improving grader's data + history for the panel:
 *  - corrections collected (your own, via RLS — all-users is a service-role upgrade)
 *  - training/deploy history from model_artifacts (world-readable)
 */
export async function GET() {
  const { supabase, user } = await requireAdmin()
  if (!user) return NextResponse.json({ error: 'Forbidden' }, { status: 403 })

  const { data: corrections } = await supabase
    .from('centering_corrections')
    .select('correction_id, border_type, left_right, top_bottom, original_left_right, original_top_bottom, created_at')
    .order('created_at', { ascending: false })

  const { data: history } = await supabase
    .from('model_artifacts')
    .select('loo, n_corrections, created_at')
    .eq('kind', 'perside_centering')
    .order('created_at', { ascending: false })
    .limit(10)

  return NextResponse.json({
    corrections: { total: corrections?.length ?? 0, recent: (corrections ?? []).slice(0, 6) },
    history: history ?? [],
  })
}
