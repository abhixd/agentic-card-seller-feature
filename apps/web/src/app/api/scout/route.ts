import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { proxyScout } from '@/lib/grading/client'

export const runtime = 'nodejs'
export const maxDuration = 60 // identify (Claude vision) + grade, per card, ~10–25s

/**
 * POST /api/scout — Sourcing scout, ONE card photo per call.
 * Body: multipart/form-data with `image` (File) + optional `ask`, `shipping`, `title`.
 * Forwards to the grading service /scout (identify → grade → economics) and returns the compact result.
 * The /scout page calls this once per photo so a photo dump streams in card-by-card.
 */
export async function POST(req: Request) {
  const supabase = await createClient()
  const { data: { user } } = await supabase.auth.getUser()
  if (!user) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })

  let formData: FormData
  try {
    formData = await req.formData()
  } catch {
    return NextResponse.json({ error: 'Expected multipart form-data.' }, { status: 400 })
  }

  const file = formData.get('image')
  if (!(file instanceof File)) return NextResponse.json({ error: 'No image provided.' }, { status: 400 })
  if (file.size > 10 * 1024 * 1024) return NextResponse.json({ error: 'Image must be under 10MB.' }, { status: 400 })

  const fields: Record<string, string> = {}
  for (const k of ['ask', 'shipping', 'title']) {
    const v = formData.get(k)
    if (typeof v === 'string' && v) fields[k] = v
  }
  const light = new URL(req.url).searchParams.get('light') === '1'
  return proxyScout(file, Object.keys(fields).length ? fields : undefined, light)
}
