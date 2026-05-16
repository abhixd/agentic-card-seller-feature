/**
 * cvDetectors.ts — Phase 1 CV measurements using sharp (Node.js / Vercel-safe)
 *
 * Designed for the Chrome extension pipeline where images arrive as public
 * eBay URLs (not base64 uploads). We fetch the first usable image, run
 * pixel-level analysis, and return structured measurements for prompt injection.
 *
 * Detectors (Phase 1):
 *  1. Blur score   — Laplacian variance (higher = sharper, <40 = blurry)
 *  2. Glare        — fraction of pixels ≥ 245 brightness (>5% = problematic)
 *  3. Brightness   — mean + std dev of grayscale
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

// ── Fetch + analyse one image URL ─────────────────────────────────────────────

async function analyseUrl(url: string): Promise<CVMeasurements> {
  // Download image
  const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
  if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`)
  const raw = Buffer.from(await res.arrayBuffer())

  // Resize to canonical, convert to grayscale, get raw pixels
  const { data, info } = await sharp(raw)
    .resize(CANONICAL_W, CANONICAL_H, { fit: 'fill' })
    .grayscale()
    .raw()
    .toBuffer({ resolveWithObject: true })

  const pixels = new Uint8Array(data)
  const { width, height } = info
  const total = width * height

  // Brightness stats + glare
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

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Run CV detectors on the first successfully downloadable image URL.
 *
 * The Chrome extension supplies eBay listing image URLs. We try the first
 * URL (highest resolution) and fall back to the second if it fails.
 * Returns null if all URLs fail — caller should treat this as a soft failure
 * and proceed without CV context rather than blocking the grade request.
 *
 * @param imageUrls  Public image URLs from the eBay listing (already capped at 6).
 */
export async function runCVDetectors(imageUrls: string[]): Promise<CVMeasurements | null> {
  for (const url of imageUrls.slice(0, 2)) {  // try front image, then first fallback
    try {
      return await analyseUrl(url)
    } catch (err) {
      console.warn('[cvDetectors] skipping URL:', url, String(err))
    }
  }
  return null  // soft failure — caller proceeds without CV data
}

// ── Prompt formatter ──────────────────────────────────────────────────────────

/**
 * Format CVMeasurements as a prompt section ready to prepend to the grading
 * instructions. Returns an empty string if cv is null (no-op injection).
 */
export function formatCVSection(cv: CVMeasurements | null): string {
  if (!cv) return ''

  const issueStr = cv.cv_issues.length
    ? cv.cv_issues.map(s => `  • ${s}`).join('\n')
    : '  • none detected'

  const blurNote  = cv.is_blurry  ? '\nNOTE: Image is blurry — lower confidence, flag in issues.' : ''
  const glareNote = cv.has_glare  ? '\nNOTE: Significant glare — surface haze or scratches may be hidden.' : ''

  return `─── CV MEASUREMENTS (pixel analysis, run before this prompt) ───
Blur score   : ${cv.blur_score}  (threshold ≥ ${BLUR_THRESHOLD} = acceptably sharp)
Glare        : ${r1(cv.glare_fraction * 100)}% pixels overexposed  (≤ 5% acceptable)
Brightness   : mean ${cv.brightness_mean} / std ${cv.brightness_std}  (0–255 scale)
CV issues    :
${issueStr}${blurNote}${glareNote}

`
}

// ── Utils ─────────────────────────────────────────────────────────────────────
const r1 = (n: number) => Math.round(n * 10)   / 10
const r4 = (n: number) => Math.round(n * 10000) / 10000
