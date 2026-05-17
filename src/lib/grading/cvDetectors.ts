/**
 * cvDetectors.ts — CV measurements, card-side classifier, and structural analysis
 *
 * Pipeline (runs before Claude, results injected into prompt):
 *
 *  Phase 1 — image quality
 *    1. Blur score        — Laplacian variance  (< 40 = blurry)
 *    2. Glare             — fraction of pixels ≥ 245 (> 5% = problematic)
 *    3. Brightness        — mean + std dev
 *
 *  Phase 2 — card structure  (new)
 *    4. Corner whitening     — per-corner brightness analysis (TL/TR/BL/BR)
 *    5. Border anomaly score — Sobel gradient in card-border band; detects border
 *                              texture irregularities, edge noise, print transitions,
 *                              whitening chips, compression artifacts, glare boundaries,
 *                              and scratches — anything that creates gradient spikes
 *    6. Side classifier      — HSV blue-band detection → 'front' | 'back'
 *
 * All analysis runs on the canonical 384×544 grayscale image so the same
 * Sharp pipeline handles quality + structure in a single pass.
 *
 * Centering (pixel-accurate via perspective warp) is implemented in the
 * Python notebook using OpenCV — it requires contour finding + homography
 * which are not available in Sharp.
 */

import sharp from 'sharp'

// ── Constants ─────────────────────────────────────────────────────────────────

const CANONICAL_W = 384
const CANONICAL_H = 544

const BLUR_THRESHOLD  = 40
const GLARE_THRESHOLD = 0.05

// Corner analysis — patch size as fraction of canonical dimensions
const CORNER_W_PX        = 46    // ≈ 12% of 384
const CORNER_H_PX        = 55    // ≈ 10% of 544
const WHITE_THRESH        = 215   // grayscale value above which = white / whitening
const WHITENING_THRESHOLD = 0.07  // > 7% white pixels in patch → whitening

// Border anomaly — band around the image perimeter (card border region)
// The card's colored border should be smooth; any high-gradient spikes signal
// border texture irregularities, edge noise, print transitions, whitening chips,
// compression artifacts, glare boundaries, or scratches.
const BORDER_BAND_W = 55   // px from each side to inspect (≈ 14% of 384)
const BORDER_BAND_H = 70   // px from each side to inspect (≈ 13% of 544)
const BORDER_ANOMALY_GRADIENT_THRESHOLD  = 35   // Sobel magnitude above = "edge feature"
const BORDER_ANOMALY_SEVERITY_THRESHOLDS = { none: 0, light: 200, moderate: 600, heavy: 1400 }

// Side classifier HSV thresholds
const BACK_HUE_MIN         = 195
const BACK_HUE_MAX         = 220
const BACK_SAT_MIN         = 0.50
const BACK_VAL_MIN         = 0.25
const BACK_PIXEL_THRESHOLD = 0.25

// ── Public types ──────────────────────────────────────────────────────────────

export interface CVMeasurements {
  // Phase 1 — image quality
  blur_score:      number
  glare_fraction:  number
  brightness_mean: number
  brightness_std:  number
  is_blurry:       boolean
  has_glare:       boolean
  cv_issues:       string[]

  // Phase 2 — card structure
  corners:       CornerAnalysis     | null
  border_anomaly: BorderAnomalyResult | null
}

export interface CornerPatch {
  brightness:     number   // mean grayscale 0–255
  white_fraction: number   // fraction of pixels > WHITE_THRESH
  whitening:      boolean
}

export interface CornerAnalysis {
  TL: CornerPatch
  TR: CornerPatch
  BL: CornerPatch
  BR: CornerPatch
  any_whitening:      boolean
  whitening_corners:  string[]   // e.g. ['TL', 'BR']
}

export interface BorderAnomalyResult {
  edge_pixel_count: number                              // raw gradient spike count in border band
  severity:         'none' | 'light' | 'moderate' | 'heavy'
}

export type CardSide = 'front' | 'back' | 'unknown'

// ── Internal helpers ──────────────────────────────────────────────────────────

function laplacianVariance(pixels: Uint8Array, width: number, height: number): number {
  let lapSum = 0, lapSumSq = 0
  const innerCount = (width - 2) * (height - 2)

  for (let y = 1; y < height - 1; y++) {
    const row = y * width
    for (let x = 1; x < width - 1; x++) {
      const lap =
        pixels[row - width + x] +
        pixels[row + x - 1] +
        pixels[row + x + 1] +
        pixels[row + width + x] -
        4 * pixels[row + x]
      lapSum   += lap
      lapSumSq += lap * lap
    }
  }
  const mean = lapSum / innerCount
  return (lapSumSq / innerCount) - mean * mean
}

/**
 * Extract a rectangular patch from a flat grayscale pixel array and compute
 * brightness stats. Row-major layout: index = row * width + col.
 */
function extractPatch(
  pixels:   Uint8Array,
  imgW:     number,
  imgH:     number,
  rowStart: number,
  colStart: number,
  patchH:   number,
  patchW:   number,
): CornerPatch {
  let sum = 0, whiteCount = 0, count = 0
  const rowEnd = Math.min(rowStart + patchH, imgH)
  const colEnd = Math.min(colStart + patchW, imgW)

  for (let r = rowStart; r < rowEnd; r++) {
    for (let c = colStart; c < colEnd; c++) {
      const v = pixels[r * imgW + c]
      sum += v
      if (v > WHITE_THRESH) whiteCount++
      count++
    }
  }

  const brightness     = count > 0 ? sum / count : 0
  const white_fraction = count > 0 ? whiteCount / count : 0

  return {
    brightness:     r1(brightness),
    white_fraction: r4(white_fraction),
    whitening:      white_fraction > WHITENING_THRESHOLD,
  }
}

/**
 * Analyse the four corners of the canonical grayscale image for whitening.
 * Corner whitening is the #1 indicator of PSA grade ceiling — any whitening
 * rules out PSA 10 and likely caps at PSA 8 or below.
 */
function computeCornerAnalysis(
  pixels: Uint8Array,
  width:  number,
  height: number,
): CornerAnalysis {
  const patches = {
    TL: extractPatch(pixels, width, height, 0,            0,             CORNER_H_PX, CORNER_W_PX),
    TR: extractPatch(pixels, width, height, 0,            width - CORNER_W_PX, CORNER_H_PX, CORNER_W_PX),
    BL: extractPatch(pixels, width, height, height - CORNER_H_PX, 0,    CORNER_H_PX, CORNER_W_PX),
    BR: extractPatch(pixels, width, height, height - CORNER_H_PX, width - CORNER_W_PX, CORNER_H_PX, CORNER_W_PX),
  }

  const whitening_corners = (Object.entries(patches) as [string, CornerPatch][])
    .filter(([, p]) => p.whitening)
    .map(([name]) => name)

  return { ...patches, any_whitening: whitening_corners.length > 0, whitening_corners }
}

/**
 * Border anomaly score — Sobel gradient magnitude in the card-border band.
 *
 * The card's printed border (yellow, black, etc.) should be a smooth, uniform band.
 * Any high-gradient spikes in this region can indicate:
 *   border texture irregularities, edge noise, printing transitions, whitening/chips,
 *   compression artifacts, glare boundaries, or physical scratches.
 * Artwork-area gradients are excluded so artwork detail doesn't inflate the count.
 *
 * Returns a severity label and raw edge-pixel count for prompt injection.
 * Labeled "approximate" — perspective distortion and photo background can also
 * contribute gradients; interpret alongside glare/blur context.
 */
function computeBorderAnomalyScore(
  pixels: Uint8Array,
  width:  number,
  height: number,
): BorderAnomalyResult {
  let edgeCount = 0

  // Iterate only the border band (4 sides, excluding inner artwork)
  // Top band, Bottom band, Left band, Right band — avoid double-counting corners
  const regions: Array<[number, number, number, number]> = [
    [1,                   1,                  BORDER_BAND_H,      width - 1],  // top
    [height - BORDER_BAND_H, 1,              height - 1,         width - 1],  // bottom
    [BORDER_BAND_H,       1,                  height - BORDER_BAND_H, BORDER_BAND_W],  // left
    [BORDER_BAND_H, width - BORDER_BAND_W,   height - BORDER_BAND_H, width - 1],      // right
  ]

  for (const [yMin, xMin, yMax, xMax] of regions) {
    for (let y = Math.max(1, yMin); y < Math.min(height - 1, yMax); y++) {
      for (let x = Math.max(1, xMin); x < Math.min(width - 1, xMax); x++) {
        const row = y * width
        const gx =
          -pixels[row - width + x - 1] + pixels[row - width + x + 1]
          - 2 * pixels[row + x - 1]   + 2 * pixels[row + x + 1]
          - pixels[row + width + x - 1] + pixels[row + width + x + 1]
        const gy =
          -pixels[(y - 1) * width + x - 1] - 2 * pixels[(y - 1) * width + x] - pixels[(y - 1) * width + x + 1]
          + pixels[(y + 1) * width + x - 1] + 2 * pixels[(y + 1) * width + x] + pixels[(y + 1) * width + x + 1]
        if (Math.sqrt(gx * gx + gy * gy) > BORDER_ANOMALY_GRADIENT_THRESHOLD) edgeCount++
      }
    }
  }

  const { light, moderate, heavy } = BORDER_ANOMALY_SEVERITY_THRESHOLDS
  const severity: BorderAnomalyResult['severity'] =
    edgeCount >= heavy    ? 'heavy'    :
    edgeCount >= moderate ? 'moderate' :
    edgeCount >= light    ? 'light'    : 'none'

  return { edge_pixel_count: edgeCount, severity }
}

// ── Core analysis on a buffer ─────────────────────────────────────────────────

/**
 * Full CV analysis on a pre-downloaded image buffer.
 * Runs blur/glare/brightness + corner whitening + scratch indicator
 * in a single Sharp pass so callers don't trigger extra network fetches.
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

  // ── Phase 1: quality metrics ───────────────────────────────────────────────
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

  // ── Phase 2: structural analysis ──────────────────────────────────────────
  let corners:        CornerAnalysis     | null = null
  let border_anomaly: BorderAnomalyResult | null = null

  try { corners        = computeCornerAnalysis(pixels, width, height) } catch { /* soft fail */ }
  try { border_anomaly = computeBorderAnomalyScore(pixels, width, height) } catch { /* soft fail */ }

  return {
    blur_score:      r1(blur_score),
    glare_fraction:  r4(glare_fraction),
    brightness_mean: r1(brightness_mean),
    brightness_std:  r1(brightness_std),
    is_blurry,
    has_glare,
    cv_issues,
    corners,
    border_anomaly,
  }
}

// ── Card-side classifier ──────────────────────────────────────────────────────

export async function classifyCardSide(buf: Buffer): Promise<CardSide> {
  try {
    const { data, info } = await sharp(buf)
      .resize(128, 128, { fit: 'fill' })
      .raw()
      .toBuffer({ resolveWithObject: true })

    const channels    = info.channels
    const totalPixels = info.width * info.height
    let   blueCount   = 0

    for (let i = 0; i < data.length; i += channels) {
      const r = data[i]     / 255
      const g = data[i + 1] / 255
      const b = data[i + 2] / 255

      const cmax = Math.max(r, g, b)
      const cmin = Math.min(r, g, b)
      const diff = cmax - cmin

      if (cmax < BACK_VAL_MIN) continue
      const sat = cmax === 0 ? 0 : diff / cmax
      if (sat  < BACK_SAT_MIN) continue
      if (diff === 0)          continue

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

export function formatCVSection(cv: CVMeasurements | null): string {
  if (!cv) return ''

  const issueStr = cv.cv_issues.length
    ? cv.cv_issues.map(s => `  • ${s}`).join('\n')
    : '  • none detected'

  const blurNote  = cv.is_blurry ? '\nNOTE: Image is blurry — lower confidence, flag in issues.' : ''
  const glareNote = cv.has_glare ? '\nNOTE: Significant glare — surface haze or scratches may be hidden.' : ''

  // Corner section
  let cornerStr = ''
  if (cv.corners) {
    const c = cv.corners
    const fmt = (p: CornerPatch) =>
      `brightness ${p.brightness}, white ${(p.white_fraction * 100).toFixed(1)}%${p.whitening ? ' ⚠ WHITENING' : ''}`
    cornerStr = `
─── CV CORNER ANALYSIS (pixel measurement) ───
  TL: ${fmt(c.TL)}
  TR: ${fmt(c.TR)}
  BL: ${fmt(c.BL)}
  BR: ${fmt(c.BR)}
${c.any_whitening
  ? `NOTE: Whitening detected at ${c.whitening_corners.join(', ')} — these corners cannot grade PSA 10; likely caps at PSA 8 or below.`
  : 'NOTE: No corner whitening detected in pixel analysis.'}
`
  }

  // Border anomaly section
  let borderAnomalyStr = ''
  if (cv.border_anomaly) {
    const s = cv.border_anomaly
    borderAnomalyStr = `
─── CV BORDER ANOMALY SCORE (border-band gradient, approximate) ───
  Edge-pixel count: ${s.edge_pixel_count}  Severity: ${s.severity.toUpperCase()}
  (Detects: border texture irregularities, edge noise, print transitions, whitening/chips,
   compression artifacts, glare boundaries, scratches — anything causing gradient spikes)
${s.severity !== 'none'
  ? `NOTE: Elevated border anomaly detected — inspect border band carefully for the above defects.`
  : 'NOTE: Border band appears smooth — no significant gradient spikes detected.'}
`
  }

  return `─── CV MEASUREMENTS (pixel analysis, run before this prompt) ───
Blur score   : ${cv.blur_score}  (threshold ≥ ${BLUR_THRESHOLD} = acceptably sharp)
Glare        : ${r1(cv.glare_fraction * 100)}% pixels overexposed  (≤ 5% acceptable)
Brightness   : mean ${cv.brightness_mean} / std ${cv.brightness_std}  (0–255 scale)
CV issues    :
${issueStr}${blurNote}${glareNote}
${cornerStr}${borderAnomalyStr}
`
}

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
