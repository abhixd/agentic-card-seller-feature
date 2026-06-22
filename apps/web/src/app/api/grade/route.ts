import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { proxyGrade } from '@/lib/grading/client'

export const runtime = 'nodejs'

/**
 * POST /api/grade — PSA grade a card image via the grading microservice.
 * Body: multipart/form-data with `image` (File) and optional `title`.
 * Returns the grade payload (overall_score, psa_equivalent, pillars, centering, summary).
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
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'No image provided.' }, { status: 400 })
  }
  if (file.size > 10 * 1024 * 1024) {
    return NextResponse.json({ error: 'Image must be under 10MB.' }, { status: 400 })
  }

  const title = formData.get('title')
  const zoom = new URL(req.url).searchParams.get('zoom') === '1'   // high-res defect close-ups
  return proxyGrade(file, typeof title === 'string' && title ? { title } : undefined, zoom)
}
