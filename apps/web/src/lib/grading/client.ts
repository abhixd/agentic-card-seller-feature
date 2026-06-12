/**
 * Shared proxy helper for the grading microservice (services/grading-api on Railway).
 *
 * The web app does NOT run the (heavy Python/CV) grader itself — it forwards the card
 * image to the same /grade endpoint the Chrome extension uses, so both surfaces share
 * one grading backend. Mirrors src/lib/optimize/client.ts.
 *
 * Env: GRADING_SERVICE_URL  (e.g. https://card-grader-api-production.up.railway.app)
 */
import { NextResponse } from 'next/server'

export const runtime = 'nodejs'
const GRADING_SERVICE_URL = process.env.GRADING_SERVICE_URL

/** Forward a card image (+ optional listing fields) to the grading service /grade endpoint. */
export async function proxyGrade(
  image: File,
  fields?: Record<string, string>,
): Promise<NextResponse> {
  if (!GRADING_SERVICE_URL) {
    return NextResponse.json(
      { error: 'Grading service not configured. Set GRADING_SERVICE_URL.' },
      { status: 503 },
    )
  }

  const fd = new FormData()
  fd.append('image', image, image.name || 'card.jpg')
  for (const [k, v] of Object.entries(fields ?? {})) fd.append(k, v)

  const url = `${GRADING_SERVICE_URL.replace(/\/$/, '')}/grade`
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', body: fd, cache: 'no-store' })
  } catch (err) {
    console.error(`[grade] service unreachable at ${url}:`, err)
    return NextResponse.json({ error: 'Grading service unreachable.' }, { status: 503 })
  }

  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = (data as { detail?: string } | null)?.detail
    console.error(`[grade] service error ${res.status}:`, detail ?? data)
    return NextResponse.json(
      { error: detail ?? 'Grading service returned an error.' },
      { status: res.status },
    )
  }
  return NextResponse.json(data)
}
