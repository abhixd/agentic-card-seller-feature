/**
 * POST /api/grade/debug-crop
 *
 * Phase 3 debug endpoint — runs cropCard() with { debug: true } on a single
 * image and returns the crop metadata plus two debug images:
 *
 *   debug_original   JPEG (base64) of the detection-resolution image with the
 *                    detected quad outline and labelled corner dots drawn on it.
 *                    When detection fails, shows a "failed_detection" banner.
 *
 *   debug_rectified  JPEG (base64) of the perspective-corrected canonical output
 *                    (384×544). null when no quad was found (color_threshold /
 *                    failed_detection paths don't produce a rectified image).
 *
 * Request body:
 *   { image_url?: string, image_data?: string }   (base64 image_data preferred)
 *
 * Typical usage from the Chrome extension dev-tools panel or curl:
 *   curl -X POST https://<host>/api/grade/debug-crop \
 *        -H 'Content-Type: application/json' \
 *        -d '{"image_url":"https://i.ebayimg.com/...jpg"}' | jq '.crop_confidence'
 */

import { NextRequest, NextResponse } from 'next/server'
import { cropCard } from '@/lib/grading/cardCrop'

export const runtime    = 'nodejs'
export const maxDuration = 30   // seconds — WASM init + detection fits comfortably

const CORS_HEADERS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
}

export async function OPTIONS() {
  return new NextResponse(null, { status: 204, headers: CORS_HEADERS })
}

export async function POST(req: NextRequest) {
  let body: { image_url?: string; image_data?: string }
  try {
    body = await req.json()
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400, headers: CORS_HEADERS })
  }

  // ── Resolve image buffer ─────────────────────────────────────────────────
  let buf: Buffer | null = null

  if (body.image_data) {
    // Preferred path: base64 payload from extension (no CDN restrictions)
    buf = Buffer.from(body.image_data, 'base64')
  } else if (body.image_url) {
    try {
      const res = await fetch(body.image_url, { signal: AbortSignal.timeout(8_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      buf = Buffer.from(await res.arrayBuffer())
    } catch (err) {
      return NextResponse.json(
        { error: `Failed to fetch image: ${err instanceof Error ? err.message : String(err)}` },
        { status: 400, headers: CORS_HEADERS },
      )
    }
  }

  if (!buf) {
    return NextResponse.json(
      { error: 'Provide image_url or image_data (base64)' },
      { status: 400, headers: CORS_HEADERS },
    )
  }

  // ── Run crop + rectification in debug mode ───────────────────────────────
  const result = await cropCard(buf, { debug: true })

  return NextResponse.json({
    // §11 status codes
    status:            result.status,
    crop_confidence:   result.crop_confidence,
    visible_fraction:  result.visible_fraction,
    card_quad:         result.card_quad,       // [TL,TR,BR,BL] in original px or null
    fallback_used:     result.fallback_used,
    detector:          result.detector,
    // §3 debug images (base64 JPEG strings, or null when not available)
    debug_original:    result.debug_original  ? result.debug_original.toString('base64')  : null,
    debug_rectified:   result.debug_rectified ? result.debug_rectified.toString('base64') : null,
  }, { headers: CORS_HEADERS })
}
