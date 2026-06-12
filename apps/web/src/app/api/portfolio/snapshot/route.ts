import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'

// Called from dashboard on each load to upsert today's snapshot.
// Uses upsert (on conflict update) so multiple page loads per day are idempotent.
export async function POST(req: Request) {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { totalValue, cardCount } = await req.json()

    const { error } = await supabase
      .from('portfolio_snapshots')
      .upsert(
        {
          user_id:      user.id,
          snapshot_date: new Date().toISOString().slice(0, 10),
          total_value:   totalValue ?? 0,
          card_count:    cardCount  ?? 0,
        },
        { onConflict: 'user_id,snapshot_date' }
      )

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}

export async function GET() {
  try {
    const supabase = await createClient()
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

    const { data, error } = await supabase
      .from('portfolio_snapshots')
      .select('snapshot_date, total_value, card_count')
      .eq('user_id', user.id)
      .order('snapshot_date', { ascending: true })
      .limit(90)  // last ~3 months

    if (error) return NextResponse.json({ error: error.message }, { status: 500 })
    return NextResponse.json({ snapshots: data ?? [] })
  } catch (e) {
    return NextResponse.json({ error: 'Failed' }, { status: 500 })
  }
}
