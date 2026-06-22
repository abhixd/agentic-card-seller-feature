import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { gradeCard, type GradeResponse } from '@acs/grading-contract'
import { mockGrade } from '@/lib/grading/mock'

export const runtime = 'nodejs'

/**
 * POST /api/grade — PSA grade a card image via the grading microservice.
 * Body: multipart/form-data with `image` (File) and optional `title`/`price`.
 * Returns the grade payload (overall_score, psa_equivalent, pillars, centering, summary).
 *
 * The backend is selected by GRADING_API_URL: "mock" (default — local dev, no dependency
 * on the grading service) or a grading-service base URL (e.g. the Railway deploy). All
 * grading goes through `gradeCard()` from @acs/grading-contract — the single boundary.
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

  const titleRaw = formData.get('title')
  const priceRaw = formData.get('price')
  const title = typeof titleRaw === 'string' && titleRaw ? titleRaw : undefined
  const price = typeof priceRaw === 'string' && priceRaw ? Number(priceRaw) : undefined

  const url = process.env.GRADING_API_URL ?? 'mock'
  try {
    const grade: GradeResponse =
      url === 'mock' ? mockGrade() : await gradeCard(url, { image: file, title, price })
    return NextResponse.json(grade)
  } catch (err) {
    console.error('[grade] grading failed:', err)
    return NextResponse.json({ error: 'Grading service error.' }, { status: 502 })
  }
}
