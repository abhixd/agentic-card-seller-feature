/**
 * cvDetectors.ts — Phase 1 CV measurements + card-side classifier
 *
 * Designed for the Chrome extension pipeline where images arrive as public
 * eBay URLs (not base64 uploads). We fetch the first usable image, run
 * pixel-level analysis, and return structured measurements for prompt injection.
 *
 * Detectors (Phase 1):
 *  1. Blur score   — Laplacian variance (higher = sharper, <40 = blurry)
 *  2. Glare        — fraction of pixels ≥ 245 brightness (>5% = problematic)
 *  3. Brightness   — mean + std dev of grayscale
 *  4. Side class.  — HSV blue-band analysis to detect Pokémon card back
 *
 * Phase 2 TODO: edge-scan centering, Hough scratch detection (Python microservice)
 */

import sharp from 'sharp'

// ── Constants ─────────────────────────────────────────────────────────────────

/** Canonical size for CV measurement. Must match notebook preprocessing. */
const CANONICAL_W = 384
const CANONICAL_H = 544

const BLUR_THRESHOLD  = 40    // Laplacian variance; below = blurry
const GLARE_THRESHOLD = 0.05  // 5% overexposed pixels = significant glare

/**
 * Pokémon card back HSV thresholds (standard 0–360° hue scale).
 *
 * The back has had the same blue/teal design since 1996 — a field of
 * hue ~195–220°, saturation >50%, value >25% covering ~50–65% of the card.
 * A pixel fraction above 0.25 reliably identifies the back even under
 * compression, glare, and moderate angle/lighting variation.
 */
const BACK_HUE_MIN         = 195    // degrees
const BACK_HUE_MAX         = 220    // degrees
const BACK_SAT_MIN         = 0.50   // 0–1 scale
const BACK_VAL_MIN         = 0.25   // 0–1 scale
const BACK_PIXEL_THRESHOLD = 0.25   // fraction of image; above = back

// ── Public types ──────────────────────────────────────────────────────────────

export interface CVMeasurements {
  blur_score:      number   // Laplacian variance (0 → very blurry)
  glare_fraction:  number   // 0–1 fraction of pixels ≥ 245
  brightness_mean: number   // mean grayscale (0–255)
  brightness_std:  number   // std dev of grayscale
  is_blurry:       boolean
  has_glare:       boolean
  cv_issues:       string[] // human-readable, injected verbatim into Claude prompt
}

export type CardSide = 'front' | 'back' | 'unknown'

// ── Internal helpers ──────────────────────────────────────────────────────────

/**
 * Laplacian variance — equivalent to cv2.Laplacian(gray, CV_64F).var()
 *
 * Kernel: [ 0  1  0 ]
 *         [ 1 -4  1 ]
 *         [ 0  1  0 ]
 */
function laplacianVariance(pixels: Uint8Array, width: number, height: number): number {
  let lapSum = 0, lapSumSq = 0
  const innerCount = (width - 2) * (height - 2)

  for (let y = 1; y < height - 1; y++) {
    const row = y * width
    for (let x = 1; x < width - 1; x++) {
      const lap =
        pixels[row - width + x] +  // y-1, x
        pixels[row + x - 1] +      // y,   x-1
        pixels[row + x + 1] +      // y,   x+1
        pixels[row + width + x] -  // y+1, x
        4 * pixels[row + x]        // center
      lapSum   += lap
      lapSumSq += lap * lap
    }
  }

  const mean = lapSum / innerCount
  return (lapSumSq / innerCount) - mean * mean
}

// ── Core analysis on a buffer (exported for reuse in claudeVision.ts) ─────────

/**
 * Run blur/glare/brightness detectors on a pre-downloaded image buffer.
 * Exported so claudeVision.ts can pass its already-downloaded buffer
 * instead of triggering a second network fetch.
 */
export async function analyseBuffer(buf: Buffer): Promise<CVMeasurements> {
  const { data, info } = await sharp(buf)
    .resize(CANONICAL_W, CANONICAL_H, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const pixels = new Uint8Array(data)
  const { width, height } = info
  const total = width * height

  let sum = 0, sumSq = 0, glareCount = 0
  for (let i = 0; i < total; i++) {
    const v = pixels[i]
    sum   += v
    sumSq += v * v
    if (v >= 245) glareCount++
  }

  const brightness_mean = sum / total
  const brightness_std  = Math.sqrt((sumSq / total) - brightness_mean * brightness_mean)
  const glare_fraction  = glareCount / total
  const blur_score      = laplacianVariance(pixels, width, height)

  const is_blurry = blur_score < BLUR_THRESHOLD
  const has_glare = glare_fraction > GLARE_THRESHOLD
  const cv_issues: string[] = []

  if (is_blurry)
    cv_issues.push(`blurry image (score ${r1(blur_score)}, need ≥${BLUR_THRESHOLD}) — reduce grade confidence`)
  if (has_glare)
    cv_issues.push(`surface glare on ${r1(glare_fraction * 100)}% of card area — may hide scratches or haze`)
  if (brightness_mean < 50)
    cv_issues.push('very dark image — poor lighting may obscure surface defects')
  else if (brightness_mean > 220 && !has_glare)
    cv_issues.push('overexposed image — highlight detail may be lost')

  return {
    blur_score:      r1(blur_score),
    glare_fraction:  r4(glare_fraction),
    brightness_mean: r1(brightness_mean),
    brightness_std:  r1(brightness_std),
    is_blurry,
    has_glare,
    cv_issues,
  }
}

// ── Card-side classifier ──────────────────────────────────────────────────────

/**
 * Classify a card image as 'front', 'back', or 'unknown' via HSV analysis.
 *
 * The Pokémon card back has a distinctive blue/teal field (hue 195–220°,
 * saturation >50%) that covers ~50–65% of the card surface. This colour
 * signature is stable across 25+ years of print runs and survives JPEG
 * compression and moderate lighting variation.
 *
 * Decision rule:
 *   ≥ 25% of pixels in the blue band → 'back'
 *   everything else                  → 'front'  (conservative assumption)
 *   processing error                 → 'unknown'
 */
export async function classifyCardSide(buf: Buffer): Promise<CardSide> {
  try {
    // 128×128 is sufficient for colour distribution — much faster than full res
    const { data, info } = await sharp(buf)
      .resize(128, 128, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true })

    const channels    = info.channels   // 3 (RGB) or 4 (RGBA)
    const totalPixels = info.width * info.height
    let   blueCount   = 0

    for (let i = 0; i < data.length; i += channels) {
      const r = data[i]     / 255
      const g = data[i + 1] / 255
      const b = data[i + 2] / 255

      const cmax = Math.max(r, g, b)
      const cmin = Math.min(r, g, b)
      const diff = cmax - cmin

      // Skip dark and near-grey pixels
      if (cmax < BACK_VAL_MIN)                    continue
      const sat = cmax === 0 ? 0 : diff / cmax
      if (sat  < BACK_SAT_MIN)                    continue
      if (diff === 0)                             continue

      // Compute hue in [0, 360)
      let hue: number
      if      (cmax === r) hue = 60 * (((g - b) / diff) % 6)
      else if (cmax === g) hue = 60 * ((b - r)  / diff + 2)
      else                 hue = 60 * ((r - g)  / diff + 4)
      if (hue < 0) hue += 360

      if (hue >= BACK_HUE_MIN && hue <= BACK_HUE_MAX) blueCount++
    }

    return (blueCount / totalPixels) >= BACK_PIXEL_THRESHOLD ? 'back' : 'front'
  } catch {
    return 'unknown'
  }
}

// ── Main exports ──────────────────────────────────────────────────────────────

/**
 * Run CV detectors on the first successfully downloadable image URL.
 * Kept for backward compatibility; claudeVision.ts now calls analyseBuffer()
 * directly with pre-downloaded buffers to avoid double fetching.
 */
export async function runCVDetectors(imageUrls: string[]): Promise<CVMeasurements | null> {
  for (const url of imageUrls.slice(0, 2)) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const buf = Buffer.from(await res.arrayBuffer())
      return await analyseBuffer(buf)
    } catch (err) {
      console.warn('[cvDetectors] skipping URL:', url, String(err))
    }
  }
  return null
}

// ── Prompt formatters ─────────────────────────────────────────────────────────

/**
 * Format CVMeasurements as a prompt section ready to prepend to grading
 * instructions. Returns empty string if cv is null (no-op injection).
 */
export function formatCVSection(cv: CVMeasurements | null): string {
  if (!cv) return ''

  const issueStr = cv.cv_issues.length
    ? cv.cv_issues.map(s => `  • ${s}`).join('\n')
    : '  • none detected'

  const blurNote  = cv.is_blurry ? '\nNOTE: Image is blurry — lower confidence, flag in issues.' : ''
  const glareNote = cv.has_glare ? '\nNOTE: Significant glare — surface haze or scratches may be hidden.' : ''

  return `─── CV MEASUREMENTS (pixel analysis, run before this prompt) ───
Blur score   : ${cv.blur_score}  (threshold ≥ ${BLUR_THRESHOLD} = acceptably sharp)
Glare        : ${r1(cv.glare_fraction * 100)}% pixels overexposed  (≤ 5% acceptable)
Brightness   : mean ${cv.brightness_mean} / std ${cv.brightness_std}  (0–255 scale)
CV issues    :
${issueStr}${blurNote}${glareNote}

`
}

/**
 * Format per-image side labels for prompt injection.
 * Tells Claude exactly which position is front vs back so it never guesses.
 * Returns empty string when all sides are unknown (no CV classification available).
 */
export function formatSideLabels(sides: CardSide[]): string {
  if (sides.every(s => s === 'unknown')) return ''
  const lines = sides.map((s, i) => `  Image ${i + 1}: ${s.toUpperCase()}`)
  return `─── IMAGE SIDE CLASSIFICATION (pre-classified by pixel analysis) ───
${lines.join('\n')}
NOTE: Trust these labels — do NOT reclassify images yourself.

`
}

// ── Utils ─────────────────────────────────────────────────────────────────────
const r1 = (n: number) => Math.round(n * 10)   / 10
const r4 = (n: number) => Math.round(n * 10000) / 10000
