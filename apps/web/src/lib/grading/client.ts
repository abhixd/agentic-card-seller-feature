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

/** Forward a card image (+ optional fields) to a grading-service endpoint that takes multipart `image`. */
async function proxyImageTo(
  endpoint: string,
  image: File,
  fields?: Record<string, string>,
  label = 'grade',
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

  const url = `${GRADING_SERVICE_URL.replace(/\/$/, '')}${endpoint}`
  let res: Response
  try {
    res = await fetch(url, { method: 'POST', body: fd, cache: 'no-store' })
  } catch (err) {
    console.error(`[${label}] service unreachable at ${url}:`, err)
    return NextResponse.json({ error: 'Grading service unreachable.' }, { status: 503 })
  }

  const data: unknown = await res.json().catch(() => null)
  if (!res.ok) {
    const detail = (data as { detail?: string } | null)?.detail
    console.error(`[${label}] service error ${res.status}:`, detail ?? data)
    return NextResponse.json(
      { error: detail ?? 'Grading service returned an error.' },
      { status: res.status },
    )
  }
  return NextResponse.json(data)
}

/** Forward a card image (+ optional listing fields) to the grading service /grade endpoint.
 *  `zoom` requests high-res per-defect close-ups (pillar_zooms) via /grade?zoom=1.
 *  NOTE: stability=1 is intentionally NOT requested here. The probe grades a SECOND full copy, and on the
 *  single-container Modal backend SAM3 serializes, so it added ~10s — pushing interactive grades past
 *  Vercel's 60s function limit (and doubling GPU cost per grade). Confidence still comes from registration
 *  support + warp geometry; the stability MIN stays on the /scout + batch paths where latency isn't
 *  user-facing. Re-add here only if the backend runs the probe without serializing (or async). */
export function proxyGrade(image: File, fields?: Record<string, string>, zoom = false): Promise<NextResponse> {
  return proxyImageTo(`/grade${zoom ? '?zoom=1' : ''}`, image, fields, 'grade')
}

/** Forward one card photo (+ ask/shipping/title) to the Sourcing-scout /scout endpoint.
 *  `light` = identity + comps only (no grade) — the grade page's card profile, fast enough to not
 *  time out on hard cards where the full grade+registration ran 60-90s. */
export function proxyScout(image: File, fields?: Record<string, string>, light = false): Promise<NextResponse> {
  return proxyImageTo(`/scout${light ? '?light=1' : ''}`, image, fields, 'scout')
}
