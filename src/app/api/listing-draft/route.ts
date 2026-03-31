import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { generateDraftForItem } from '@/lib/listing/listingDraftService'

// GET /api/listing-draft?itemId={uuid}
export async function GET(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const itemId = request.nextUrl.searchParams.get('itemId')
  if (!itemId) {
    return NextResponse.json({ error: 'itemId query parameter is required' }, { status: 400 })
  }

  const { draft, error } = await generateDraftForItem(supabase, user.id, itemId)
  if (error || !draft) {
    return NextResponse.json({ error: error ?? 'Draft generation failed' }, { status: 404 })
  }

  return NextResponse.json(draft)
}
