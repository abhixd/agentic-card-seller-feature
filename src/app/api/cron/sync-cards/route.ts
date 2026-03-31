import { NextRequest } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { bulkSyncAllCards } from '@/lib/pokemon/bulkSync'

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
    const supabase = await createClient()
    const stats = await bulkSyncAllCards(supabase)
    return Response.json({ ok: true, stats })
  } catch (err) {
    console.error('[cron/sync-cards] Error:', err)
    return Response.json(
      { ok: false, error: err instanceof Error ? err.message : String(err) },
      { status: 500 }
    )
  }
}
