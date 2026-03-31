import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { getInventoryItem, updateInventoryItem } from '@/lib/inventory/inventoryService'

const UpdateSchema = z.object({
  status:          z.enum(['owned', 'listed', 'sent_to_grading', 'sold']).optional(),
  notes:           z.string().nullable().optional(),
  acquisitionCost: z.number().min(0).optional(),
})

interface Props {
  params: Promise<{ itemId: string }>
}

// GET /api/inventory/[itemId]
export async function GET(_request: NextRequest, { params }: Props) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { itemId } = await params
  const { item, error } = await getInventoryItem(supabase, user.id, itemId)
  if (error || !item) return NextResponse.json({ error: error ?? 'Not found' }, { status: 404 })
  return NextResponse.json(item)
}

// PATCH /api/inventory/[itemId]
export async function PATCH(request: NextRequest, { params }: Props) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = UpdateSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { itemId } = await params
  const { item, error } = await updateInventoryItem(supabase, user.id, itemId, parsed.data)
  if (error || !item) return NextResponse.json({ error: error ?? 'Update failed' }, { status: 500 })
  return NextResponse.json(item)
}
