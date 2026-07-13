import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { proxyGrade } from '@/lib/grading/client'

export const runtime = 'nodejs'
// Grading goes through the Modal SAM3 vision pipeline; a grade after Modal has scaled to zero cold-starts the
// GPU container (~40s to load SAM3's 3GB). Give the function room so that first-after-idle grade SUCCEEDS (slow)
// instead of the default ~10-15s function timeout killing it → "Grading service returned an error". 60 = the
// Vercel Hobby ceiling (covers typical ~40s cold starts); on Pro, raise toward 120 for margin on very-cold ones.
export const maxDuration = 60

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
  const contour = formData.get('contour')   // manual 4-corner boundary (source px) → grader skips SAM3
  const zoom = new URL(req.url).searchParams.get('zoom') === '1'   // high-res defect close-ups
  const fields: Record<string, string> = {}
  if (typeof title === 'string' && title) fields.title = title
  if (typeof contour === 'string' && contour) fields.contour = contour
  return proxyGrade(file, Object.keys(fields).length ? fields : undefined, zoom)
}
