import { NextRequest, NextResponse } from 'next/server'
import { z } from 'zod'
import { createClient } from '@/lib/supabase/server'
import { saveToInventory, listInventory } from '@/lib/inventory/inventoryService'

const SaveSchema = z.object({
  catalogId:       z.string().uuid(),
  analysisId:      z.string().uuid().nullable().default(null),
  acquisitionCost: z.number().min(0).default(0),
  notes:           z.string().optional(),
})

// POST /api/inventory — save card to inventory
export async function POST(request: NextRequest) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let body: unknown
  try { body = await request.json() } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const parsed = SaveSchema.safeParse(body)
  if (!parsed.success) {
    return NextResponse.json(
      { error: 'Invalid request', details: parsed.error.flatten() },
      { status: 400 }
    )
  }

  const { item, error } = await saveToInventory(supabase, user.id, parsed.data)
  if (error || !item) {
    return NextResponse.json({ error: error ?? 'Save failed' }, { status: 500 })
  }
  return NextResponse.json(item, { status: 201 })
}

// GET /api/inventory — list all items for authenticated user
export async function GET() {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  const { items, error } = await listInventory(supabase, user.id)
  if (error) return NextResponse.json({ error }, { status: 500 })
  return NextResponse.json({ items, count: items.length })
}
