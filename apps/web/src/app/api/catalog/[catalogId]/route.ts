import { NextRequest, NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { getCatalogItem } from '@/lib/catalog/searchService'
import type { CatalogDetailResponse } from '@/types/catalog'

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ catalogId: string }> }
) {
  const { catalogId } = await params

  const supabase = await createClient()
  const { card, error } = await getCatalogItem(supabase, catalogId)

  if (error || !card) {
    return NextResponse.json({ error: error ?? 'Not found' }, { status: 404 })
  }

  const body: CatalogDetailResponse = { card }
  return NextResponse.json(body)
}
