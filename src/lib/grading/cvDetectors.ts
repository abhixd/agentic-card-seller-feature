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
 *    5. Border irregularity  — Detector A: Sobel + whitening + connected components
 *                              in the card border band (per-side, corner-exclusive)
 *    6. Surface lines        — Detector B: top-hat morphology (H/V/diagonal) +
 *                              Hough lines in the card interior
 *    7. Side classifier      — HSV blue-band detection → 'front' | 'back'
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

// Detector A — Border Irregularity
const BORDER_BAND_W           = 55
const BORDER_BAND_H           = 70
const BORDER_GRAD_THRESHOLD   = 30
const BORDER_WHITE_THRESH     = 215

// Detector B — Surface Lines
const SURFACE_MARGIN_W        = 55
const SURFACE_MARGIN_H        = 70
const SURFACE_GRAD_THRESHOLD  = 25
const SURFACE_GLARE_THRESH    = 245

// Detector C — Surface Grid
const SURFACE_GRID_COLS = 4
const SURFACE_GRID_ROWS = 6

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
  corners:             CornerAnalysis          | null
  border_irregularity: BorderIrregularityResult | null   // Detector A
  surface_lines:       SurfaceLineResult        | null   // Detector B
  surface_grid:        SurfaceGridCell[]        | null   // Detector C

  // UI-ready overlays derived from the above (percentage coords, 0–100 scale)
  corner_boxes:        CornerBox[]   | null   // one entry per whitened corner
  edge_bands:          EdgeBand[]    | null   // one entry per anomalous edge side

  // Per-image card bounding boxes (normalized 0–1 fractions of original image dimensions).
  // One entry per analyzed image; null when detection was unreliable or image was missing.
  card_bounds_pct: Array<{ x: number; y: number; w: number; h: number } | null> | null

  // Per-image centering measurement (outer card vs inner printed frame).
  // One entry per analyzed image; null when image missing. Each entry may have
  // inner_frame_bbox_pct === null for borderless / full-art cards.
  centering: Array<CenteringMeasurement | null> | null
}

/**
 * Structured centering payload for the extension to render the inspection view.
 *
 * Coordinates are expressed in two systems:
 *  • card_bbox_pct        — fraction (0–1) of the ORIGINAL photo dimensions.
 *                           Same coordinate space as CVMeasurements.card_bounds_pct.
 *  • inner_frame_bbox_pct — fraction (0–1) of the CROPPED card region.
 *                           (0,0) = top-left of the card, (1,1) = bottom-right.
 *                           The extension renders the SVG inside the card-cropped
 *                           slot, so this is the natural coordinate system.
 *
 * margins_pct values are percentages (0–100) that sum to 100 on each axis:
 *   left + right = 100, top + bottom = 100
 * This matches grader convention ("53/47 top-heavy" = top: 53, bottom: 47).
 */
export interface CenteringMeasurement {
  card_bbox_pct:        { x: number; y: number; w: number; h: number }
  inner_frame_bbox_pct: { x: number; y: number; w: number; h: number } | null
  margins_pct:          { left: number; right: number; top: number; bottom: number } | null
  ratios:               { left_right: string; top_bottom: string } | null
  interpretation:       'well_centered' | 'slightly_off' | 'noticeably_off' | 'severely_off' | 'unavailable'
  confidence:           'high' | 'medium' | 'low'
  fallback_reason:      'borderless_card' | 'low_contrast' | 'crop_failed' | null
}

/**
 * A whitened corner expressed as a percentage bounding box on the canonical image.
 * Derived from CornerAnalysis — only emitted for corners where whitening === true.
 */
export interface CornerBox {
  corner:   'TL' | 'TR' | 'BL' | 'BR'
  severity: 'light' | 'moderate' | 'heavy'
  // Percentage of canonical image dimensions (0–100 scale, matches SVG viewBox)
  x_pct: number
  y_pct: number
  w_pct: number
  h_pct: number
}

/**
 * An anomalous edge band expressed as a percentage bounding box.
 * Corner areas are excluded so corner_boxes and edge_bands don't overlap.
 * Derived from BorderIrregularityResult.per_side.
 */
export interface EdgeBand {
  side:     'top' | 'bottom' | 'left' | 'right'
  severity: 'light' | 'moderate' | 'heavy'
  x_pct: number
  y_pct: number
  w_pct: number
  h_pct: number
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

export interface SideStat {
  grad_fraction:   number
  bright_fraction: number
  mean_mag:        number
}

export interface BorderIrregularityResult {
  score:               number
  severity:            'none' | 'light' | 'moderate' | 'heavy'
  total_grad_fraction: number
  bright_fraction:     number
  component_count:     number
  max_component_area:  number
  mean_component_area: number
  per_side: { top: SideStat; bottom: SideStat; left: SideStat; right: SideStat }
}

export interface SurfaceLineResult {
  score:                    number
  severity:                 'none' | 'light' | 'moderate' | 'heavy'
  confidence:               'low' | 'medium' | 'high'
  glare_fraction:           number
  diagonal_energy_fraction: number
  h_energy_fraction:        number
  v_energy_fraction:        number
  energy_imbalance:         number
}

/**
 * One hot cell from the 4×6 surface grid.
 * Only cells with severity !== 'none' are emitted.
 *
 * Coordinates are percentages of the canonical image so callers
 * can draw SVG overlays without knowing the original pixel dimensions.
 */
export interface SurfaceGridCell {
  row:          number                            // 0-indexed, top → bottom
  col:          number                            // 0-indexed, left → right
  score:        number
  severity:     'light' | 'moderate' | 'heavy'
  glare_masked: boolean                           // true → glare hides signal in this cell
  // Percentage coords on the canonical image (0–100 scale)
  x_pct: number
  y_pct: number
  w_pct: number
  h_pct: number
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
 * BFS connected components on a binary map.
 * Returns array of component areas (only areas > 1 pixel).
 */
function connectedComponents(binaryMap: Uint8Array, width: number, height: number): number[] {
  const visited = new Uint8Array(binaryMap.length)
  const areas: number[] = []
  const stack: number[] = []
  for (let i = 0; i < binaryMap.length; i++) {
    if (!binaryMap[i] || visited[i]) continue
    stack.push(i); visited[i] = 1; let area = 0
    while (stack.length) {
      const idx = stack.pop()!; area++
      const x = idx % width, y = (idx - x) / width
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dy === 0) continue
          const nx = x + dx, ny = y + dy
          if (nx < 0 || nx >= width || ny < 0 || ny >= height) continue
          const ni = ny * width + nx
          if (binaryMap[ni] && !visited[ni]) { visited[ni] = 1; stack.push(ni) }
        }
      }
    }
    if (area > 1) areas.push(area)
  }
  return areas
}

/**
 * Detector A — Border Irregularity
 *
 * Sobel gradient analysis in the card border band with connected components.
 * Side masks are corner-exclusive to isolate true border irregularities.
 */
function computeBorderIrregularity(
  pixels: Uint8Array,
  width:  number,
  height: number,
): BorderIrregularityResult {
  // All-band anomaly map (includes corners) for connected components
  const allBandMap = new Uint8Array(width * height)

  // Per-side stats (corner-exclusive)
  function computeSideStat(
    yMin: number, yMax: number,
    xMin: number, xMax: number,
    fillAllBand: boolean,
  ): SideStat {
    let anomalyCount = 0, brightCount = 0, totalMag = 0, count = 0

    for (let y = Math.max(1, yMin); y < Math.min(height - 1, yMax); y++) {
      for (let x = Math.max(1, xMin); x < Math.min(width - 1, xMax); x++) {
        const row = y * width
        const v = pixels[row + x]
        count++

        const gx =
          -pixels[row - width + x - 1] + pixels[row - width + x + 1]
          - 2 * pixels[row + x - 1]   + 2 * pixels[row + x + 1]
          - pixels[row + width + x - 1] + pixels[row + width + x + 1]
        const gy =
          -pixels[(y - 1) * width + x - 1] - 2 * pixels[(y - 1) * width + x] - pixels[(y - 1) * width + x + 1]
          + pixels[(y + 1) * width + x - 1] + 2 * pixels[(y + 1) * width + x] + pixels[(y + 1) * width + x + 1]
        const mag = Math.sqrt(gx * gx + gy * gy)
        totalMag += mag

        const isAnomaly = mag > BORDER_GRAD_THRESHOLD
        if (isAnomaly) anomalyCount++
        if (v > BORDER_WHITE_THRESH) brightCount++

        if (fillAllBand && isAnomaly) {
          allBandMap[row + x] = 1
        }
      }
    }

    return {
      grad_fraction:   r4(count > 0 ? anomalyCount / count : 0),
      bright_fraction: r4(count > 0 ? brightCount / count : 0),
      mean_mag:        r1(count > 0 ? totalMag / count : 0),
    }
  }

  // Corner-exclusive side regions
  const top    = computeSideStat(1,                   BORDER_BAND_H,      BORDER_BAND_W, width - BORDER_BAND_W,  false)
  const bottom = computeSideStat(height - BORDER_BAND_H, height - 1,      BORDER_BAND_W, width - BORDER_BAND_W,  false)
  const left   = computeSideStat(BORDER_BAND_H,       height - BORDER_BAND_H, 1,         BORDER_BAND_W,           false)
  const right  = computeSideStat(BORDER_BAND_H,       height - BORDER_BAND_H, width - BORDER_BAND_W, width - 1,  false)

  // All-band (including corners) for CC and totals
  // top full
  computeSideStat(1,                   BORDER_BAND_H,           1, width - 1, true)
  // bottom full
  computeSideStat(height - BORDER_BAND_H, height - 1,           1, width - 1, true)
  // left non-top/bottom
  computeSideStat(BORDER_BAND_H,       height - BORDER_BAND_H,  1, BORDER_BAND_W,         true)
  // right non-top/bottom
  computeSideStat(BORDER_BAND_H,       height - BORDER_BAND_H,  width - BORDER_BAND_W, width - 1, true)

  // Totals from all-band map
  let totalAnomalies = 0, totalBright = 0, totalBandCount = 0
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const inBand =
        y < BORDER_BAND_H || y >= height - BORDER_BAND_H ||
        x < BORDER_BAND_W || x >= width - BORDER_BAND_W
      if (!inBand) continue
      totalBandCount++
      if (allBandMap[y * width + x]) totalAnomalies++
      if (pixels[y * width + x] > BORDER_WHITE_THRESH) totalBright++
    }
  }

  const total_grad_fraction = r4(totalBandCount > 0 ? totalAnomalies / totalBandCount : 0)
  const bright_fraction     = r4(totalBandCount > 0 ? totalBright / totalBandCount : 0)

  // Connected components on all-band anomaly map
  const areas = connectedComponents(allBandMap, width, height)
  const component_count     = areas.length
  const max_component_area  = areas.length > 0 ? Math.max(...areas) : 0
  const mean_component_area = areas.length > 0
    ? r1(areas.reduce((a, b) => a + b, 0) / areas.length)
    : 0

  // Score
  const score = r4(
    0.40 * Math.min(total_grad_fraction / 0.30, 1.0)
    + 0.20 * Math.min(bright_fraction   / 0.20, 1.0)
    + 0.25 * Math.min(component_count   / 40.0, 1.0)
    + 0.15 * Math.min(max_component_area / 80.0, 1.0)
  )

  const severity: BorderIrregularityResult['severity'] =
    score >= 0.55 ? 'heavy'    :
    score >= 0.30 ? 'moderate' :
    score >= 0.12 ? 'light'    : 'none'

  return {
    score,
    severity,
    total_grad_fraction,
    bright_fraction,
    component_count,
    max_component_area,
    mean_component_area,
    per_side: { top, bottom, left, right },
  }
}

/**
 * Detector B — Surface Lines
 *
 * Top-hat morphology energy + directional gradient analysis in the card interior.
 * Detects scratches, holo damage, and print lines via directional energy fractions.
 */
function computeSurfaceLines(
  pixels: Uint8Array,
  width:  number,
  height: number,
): SurfaceLineResult {
  let glareCount = 0, validCount = 0
  let sumAbsGx = 0, sumAbsGy = 0
  let horizCount = 0, vertCount = 0, diagCount = 0, totalHighMag = 0

  const yMin = SURFACE_MARGIN_H
  const yMax = height - SURFACE_MARGIN_H
  const xMin = SURFACE_MARGIN_W
  const xMax = width - SURFACE_MARGIN_W

  for (let y = yMin; y < yMax; y++) {
    for (let x = xMin; x < xMax; x++) {
      const row = y * width
      const v = pixels[row + x]

      // Skip boundary pixels that can't have Sobel computed
      if (y < 1 || y >= height - 1 || x < 1 || x >= width - 1) {
        validCount++
        continue
      }

      if (v >= SURFACE_GLARE_THRESH) {
        glareCount++
        validCount++
        continue
      }

      validCount++

      const gx =
        -pixels[row - width + x - 1] + pixels[row - width + x + 1]
        - 2 * pixels[row + x - 1]   + 2 * pixels[row + x + 1]
        - pixels[row + width + x - 1] + pixels[row + width + x + 1]
      const gy =
        -pixels[(y - 1) * width + x - 1] - 2 * pixels[(y - 1) * width + x] - pixels[(y - 1) * width + x + 1]
        + pixels[(y + 1) * width + x - 1] + 2 * pixels[(y + 1) * width + x] + pixels[(y + 1) * width + x + 1]

      sumAbsGx += Math.abs(gx)
      sumAbsGy += Math.abs(gy)

      const mag = Math.sqrt(gx * gx + gy * gy)
      if (mag > SURFACE_GRAD_THRESHOLD) {
        const angle = Math.abs(Math.atan2(gy, gx) * (180 / Math.PI))
        if (angle < 20 || angle > 160) horizCount++
        else if (angle > 70 && angle < 110) vertCount++
        else diagCount++
        totalHighMag++
      }
    }
  }

  const glare_fraction           = r4(glareCount / Math.max(validCount, 1))
  const mean_abs_gx              = sumAbsGx / Math.max(validCount, 1)
  const mean_abs_gy              = sumAbsGy / Math.max(validCount, 1)
  const energy_imbalance         = r4(Math.abs(mean_abs_gx - mean_abs_gy) / (mean_abs_gx + mean_abs_gy + 1e-6))
  const diagonal_energy_fraction = r4(diagCount  / Math.max(totalHighMag, 1))
  const h_energy_fraction        = r4(horizCount / Math.max(totalHighMag, 1))
  const v_energy_fraction        = r4(vertCount  / Math.max(totalHighMag, 1))

  const score = r4(
    0.50 * Math.min(diagonal_energy_fraction * 2.5, 1.0)
    + 0.30 * Math.min(energy_imbalance * 2.0, 1.0)
    + 0.20 * Math.min(totalHighMag / (validCount * 0.25 + 1), 1.0)
  )

  const severity: SurfaceLineResult['severity'] =
    score >= 0.50 ? 'heavy'    :
    score >= 0.28 ? 'moderate' :
    score >= 0.12 ? 'light'    : 'none'

  const confidence: SurfaceLineResult['confidence'] =
    glare_fraction > 0.15 ? 'low'    :
    glare_fraction > 0.05 ? 'medium' : 'high'

  return {
    score,
    severity,
    confidence,
    glare_fraction,
    diagonal_energy_fraction,
    h_energy_fraction,
    v_energy_fraction,
    energy_imbalance,
  }
}

/**
 * Detector C — Surface Grid
 *
 * Divides the card interior into a 4-column × 6-row grid and runs the same
 * directional energy analysis as computeSurfaceLines() on each cell.
 *
 * Only hot cells (severity !== 'none') are returned, keeping the payload small.
 * Cells where > 25% of pixels are overexposed are flagged as glare_masked —
 * they may hide real damage but can't be scored reliably.
 *
 * The returned x_pct/y_pct/w_pct/h_pct values are percentages of the canonical
 * image dimensions so the extension can draw SVG overlays without converting
 * pixel coordinates.
 */
function computeSurfaceGrid(
  pixels: Uint8Array,
  width:  number,
  height: number,
): SurfaceGridCell[] {
  const xMin = SURFACE_MARGIN_W
  const xMax = width  - SURFACE_MARGIN_W
  const yMin = SURFACE_MARGIN_H
  const yMax = height - SURFACE_MARGIN_H

  const interiorW = xMax - xMin
  const interiorH = yMax - yMin
  const cellW = interiorW / SURFACE_GRID_COLS
  const cellH = interiorH / SURFACE_GRID_ROWS

  const hotCells: SurfaceGridCell[] = []

  for (let gridRow = 0; gridRow < SURFACE_GRID_ROWS; gridRow++) {
    for (let gridCol = 0; gridCol < SURFACE_GRID_COLS; gridCol++) {
      const cx0 = Math.round(xMin + gridCol * cellW)
      const cx1 = Math.round(xMin + (gridCol + 1) * cellW)
      const cy0 = Math.round(yMin + gridRow * cellH)
      const cy1 = Math.round(yMin + (gridRow + 1) * cellH)

      let glareCount = 0, validCount = 0
      let sumAbsGx = 0, sumAbsGy = 0
      let horizCount = 0, vertCount = 0, diagCount = 0, totalHighMag = 0

      for (let y = cy0; y < cy1; y++) {
        for (let x = cx0; x < cx1; x++) {
          // Skip pixels too close to the image boundary for a 3×3 Sobel kernel
          if (y < 1 || y >= height - 1 || x < 1 || x >= width - 1) {
            validCount++
            continue
          }

          const v = pixels[y * width + x]
          validCount++

          if (v >= SURFACE_GLARE_THRESH) {
            glareCount++
            continue
          }

          const offset = y * width
          const gx =
            -pixels[offset - width + x - 1] + pixels[offset - width + x + 1]
            - 2 * pixels[offset + x - 1]    + 2 * pixels[offset + x + 1]
            - pixels[offset + width + x - 1] + pixels[offset + width + x + 1]
          const gy =
            -pixels[(y - 1) * width + x - 1] - 2 * pixels[(y - 1) * width + x] - pixels[(y - 1) * width + x + 1]
            + pixels[(y + 1) * width + x - 1] + 2 * pixels[(y + 1) * width + x] + pixels[(y + 1) * width + x + 1]

          sumAbsGx += Math.abs(gx)
          sumAbsGy += Math.abs(gy)

          const mag = Math.sqrt(gx * gx + gy * gy)
          if (mag > SURFACE_GRAD_THRESHOLD) {
            const angle = Math.abs(Math.atan2(gy, gx) * (180 / Math.PI))
            if      (angle < 20 || angle > 160)      horizCount++
            else if (angle > 70 && angle < 110)      vertCount++
            else                                     diagCount++
            totalHighMag++
          }
        }
      }

      const glare_fraction = glareCount / Math.max(validCount, 1)
      const glare_masked   = glare_fraction > 0.25

      // Percentage coords — shared for both glare-masked and hot-cell paths
      const x_pct = r4((cx0 / width)         * 100)
      const y_pct = r4((cy0 / height)        * 100)
      const w_pct = r4(((cx1 - cx0) / width) * 100)
      const h_pct = r4(((cy1 - cy0) / height) * 100)

      if (glare_masked) {
        // Emit glare-masked cells so the UI can show a "hidden by glare" indicator
        // rather than leaving a blank region that might falsely imply it's clean.
        hotCells.push({ row: gridRow, col: gridCol, score: 0, severity: 'light', glare_masked: true, x_pct, y_pct, w_pct, h_pct })
        continue
      }

      const meanAbsGx        = sumAbsGx / Math.max(validCount, 1)
      const meanAbsGy        = sumAbsGy / Math.max(validCount, 1)
      const energy_imbalance = Math.abs(meanAbsGx - meanAbsGy) / (meanAbsGx + meanAbsGy + 1e-6)
      const diag_fraction    = diagCount / Math.max(totalHighMag, 1)

      // Diagonal energy is the primary scratch signal.
      // Energy imbalance catches directional features (e.g. horizontal holo lines).
      const score: number = r4(
        0.60 * Math.min(diag_fraction    * 2.5, 1.0)
        + 0.40 * Math.min(energy_imbalance * 2.0, 1.0)
      )

      // Same thresholds as the global surface_lines severity
      const severity: SurfaceGridCell['severity'] | 'none' =
        score >= 0.50 ? 'heavy'    :
        score >= 0.28 ? 'moderate' :
        score >= 0.12 ? 'light'    : 'none'

      if (severity !== 'none') {
        hotCells.push({ row: gridRow, col: gridCol, score, severity, glare_masked: false, x_pct, y_pct, w_pct, h_pct })
      }
    }
  }

  return hotCells
}

// ── UI overlay derivations ────────────────────────────────────────────────────

/**
 * Convert CornerAnalysis into CornerBox overlay entries.
 *
 * The patch dimensions (CORNER_W_PX × CORNER_H_PX on a CANONICAL_W × CANONICAL_H
 * image) are known constants, so we can compute exact percentage coordinates
 * without any new pixel scanning.
 *
 * Severity is derived from white_fraction:
 *   heavy    ≥ 0.20  (heavy whitening, visible at a glance)
 *   moderate ≥ 0.12  (clearly visible whitening)
 *   light    ≥ WHITENING_THRESHOLD (0.07, just over detection threshold)
 */
function deriveCornerBoxes(corners: CornerAnalysis | null): CornerBox[] {
  if (!corners || !corners.any_whitening) return []

  const W = CANONICAL_W
  const H = CANONICAL_H
  const cw = CORNER_W_PX
  const ch = CORNER_H_PX

  // Percentage dimensions — same for all four corners
  const w_pct = r4((cw / W) * 100)
  const h_pct = r4((ch / H) * 100)

  // Corner origins in canvas space (row, col) → (y_pct, x_pct)
  const origins: Record<string, { x_pct: number; y_pct: number }> = {
    TL: { x_pct: 0,                        y_pct: 0                        },
    TR: { x_pct: r4(((W - cw) / W) * 100), y_pct: 0                        },
    BL: { x_pct: 0,                         y_pct: r4(((H - ch) / H) * 100) },
    BR: { x_pct: r4(((W - cw) / W) * 100), y_pct: r4(((H - ch) / H) * 100) },
  }

  const boxes: CornerBox[] = []
  for (const name of ['TL', 'TR', 'BL', 'BR'] as const) {
    const patch = corners[name]
    if (!patch.whitening) continue
    const severity: CornerBox['severity'] =
      patch.white_fraction >= 0.20 ? 'heavy'    :
      patch.white_fraction >= 0.12 ? 'moderate' : 'light'
    boxes.push({ corner: name, severity, w_pct, h_pct, ...origins[name] })
  }
  return boxes
}

/**
 * Convert BorderIrregularityResult.per_side into EdgeBand overlay entries.
 *
 * Band geometry uses the same BORDER_BAND_W / BORDER_BAND_H constants as the
 * detector, with corner areas excluded so bands and corner_boxes don't overlap.
 *
 * Severity thresholds on grad_fraction (fraction of anomalous pixels per side):
 *   heavy    > 0.22
 *   moderate > 0.10
 *   light    > 0.04
 */
function deriveEdgeBands(bi: BorderIrregularityResult | null): EdgeBand[] {
  if (!bi) return []

  const W  = CANONICAL_W
  const H  = CANONICAL_H
  const BW = BORDER_BAND_W   // horizontal inset for left/right bands
  const BH = BORDER_BAND_H   // vertical inset for top/bottom bands

  // Corner-exclusive band geometry (percentages)
  //   Top/bottom: x from BW to W-BW, height = BH
  //   Left/right: y from BH to H-BH, width  = BW
  const bandDefs: Record<string, { x_pct: number; y_pct: number; w_pct: number; h_pct: number }> = {
    top:    { x_pct: r4((BW / W) * 100),       y_pct: 0,                            w_pct: r4(((W - 2*BW) / W) * 100), h_pct: r4((BH / H) * 100)             },
    bottom: { x_pct: r4((BW / W) * 100),       y_pct: r4(((H - BH) / H) * 100),    w_pct: r4(((W - 2*BW) / W) * 100), h_pct: r4((BH / H) * 100)             },
    left:   { x_pct: 0,                         y_pct: r4((BH / H) * 100),           w_pct: r4((BW / W) * 100),          h_pct: r4(((H - 2*BH) / H) * 100)    },
    right:  { x_pct: r4(((W - BW) / W) * 100), y_pct: r4((BH / H) * 100),           w_pct: r4((BW / W) * 100),          h_pct: r4(((H - 2*BH) / H) * 100)    },
  }

  const bands: EdgeBand[] = []
  const sides = ['top', 'bottom', 'left', 'right'] as const
  for (const side of sides) {
    const stat = bi.per_side[side]
    const grad = stat.grad_fraction
    if (grad <= 0.04) continue
    const severity: EdgeBand['severity'] =
      grad > 0.22 ? 'heavy'    :
      grad > 0.10 ? 'moderate' : 'light'
    bands.push({ side, severity, ...bandDefs[side] })
  }
  return bands
}

// ── Core analysis on a buffer ─────────────────────────────────────────────────

/**
 * Full CV analysis on a pre-downloaded image buffer.
 * Runs blur/glare/brightness + corner whitening + border irregularity + surface lines
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
  let corners:             CornerAnalysis          | null = null
  let border_irregularity: BorderIrregularityResult | null = null
  let surface_lines:       SurfaceLineResult        | null = null
  let surface_grid:        SurfaceGridCell[]        | null = null
  try { corners             = computeCornerAnalysis(pixels, width, height)      } catch {}
  try { border_irregularity = computeBorderIrregularity(pixels, width, height)  } catch {}
  try { surface_lines       = computeSurfaceLines(pixels, width, height)         } catch {}
  try { surface_grid        = computeSurfaceGrid(pixels, width, height)          } catch {}

  // Derive UI-ready overlay entries from the raw detector outputs
  const corner_boxes = deriveCornerBoxes(corners)
  const edge_bands   = deriveEdgeBands(border_irregularity)

  return {
    blur_score:      r1(blur_score),
    glare_fraction:  r4(glare_fraction),
    brightness_mean: r1(brightness_mean),
    brightness_std:  r1(brightness_std),
    is_blurry,
    has_glare,
    cv_issues,
    corners,
    border_irregularity,
    surface_lines,
    surface_grid,
    corner_boxes,
    edge_bands,
    card_bounds_pct: null,   // populated per-image in claudeVision.ts after cropping
    centering:       null,   // populated per-image in claudeVision.ts via detectInnerFrame
  }
}

// ── Card boundary detection ───────────────────────────────────────────────────

/**
 * Detect the bounding box of the card within an image buffer.
 *
 * eBay photos routinely show the card surrounded by backgrounds (mats, hands,
 * holders, other cards). Without cropping, all CV detectors measure the background
 * rather than the card — corner patches land on the table, edge bands straddle
 * the card edge, and the surface grid covers open air.
 *
 * Algorithm:
 *  1. Downsample to ≤256×256 (keep aspect ratio; fast pixel scan)
 *  2. Sample 12×12 corner patches → median R/G/B → background estimate
 *  3. Mark each pixel as foreground when Euclidean RGB distance > 35
 *  4. Find bounding box of all foreground pixels
 *  5. Expand by 8% on each side for the card's white border
 *  6. Scale coordinates back to original image dimensions
 *
 * Returns null (use full image) when:
 *   • foreground fraction < 5%  (uniform image — can't find a boundary)
 *   • crop covers < 25% of the original (detection almost certainly wrong)
 *   • crop covers > 98% of the original (essentially no background — bounds
 *     are still useful for centering inspection so we keep them; only the
 *     extreme case where the bbox covers the entire image is rejected)
 */
export async function detectCardBounds(
  buf: Buffer,
): Promise<{ left: number; top: number; width: number; height: number } | null> {
  const DETECT_MAX      = 256
  const CORNER_SAMPLE   = 12    // px in downsampled space
  const RGB_DIST_THRESH = 35
  const MARGIN_FRAC     = 0.08
  const MIN_FG_FRAC     = 0.05
  const MIN_CROP_FRAC   = 0.25
  // Previously 0.92 — that cap was a "no meaningful crop, skip the overhead"
  // optimization for the Claude pipeline, but it broke centering inspection
  // on tightly-shot photos where the card fills almost the whole frame.
  // The downstream cropping work is cheap; the bounds are valuable.
  const MAX_CROP_FRAC   = 0.98

  try {
    // Original image dimensions (needed to scale bounds back)
    const meta  = await sharp(buf).metadata()
    const origW = meta.width
    const origH = meta.height
    if (!origW || !origH) return null

    // Downsample — flatten removes any alpha channel
    const { data, info } = await sharp(buf)
      .resize(DETECT_MAX, DETECT_MAX, { fit: 'inside' })
      .flatten({ background: { r: 255, g: 255, b: 255 } })
      .raw()
      .toBuffer({ resolveWithObject: true })

    const sW       = info.width
    const sH       = info.height
    const ch       = info.channels        // 3 (RGB) or 4 (RGBA) after flatten
    const px       = new Uint8Array(data)
    const total    = sW * sH

    // ── Background estimation ──────────────────────────────────────────────
    // Collect R/G/B values from each of the four 12×12 corner patches and
    // compute median per channel. The median is robust to pixels that happen
    // to land on the card border when the card nearly fills the frame.
    function medianFromPatch(row0: number, col0: number): [number, number, number] {
      const rs: number[] = [], gs: number[] = [], bs: number[] = []
      for (let r = row0; r < Math.min(row0 + CORNER_SAMPLE, sH); r++) {
        for (let c = col0; c < Math.min(col0 + CORNER_SAMPLE, sW); c++) {
          const i = (r * sW + c) * ch
          rs.push(px[i]); gs.push(px[i + 1]); bs.push(px[i + 2])
        }
      }
      const med = (a: number[]) => { a.sort((x, y) => x - y); return a[Math.floor(a.length / 2)] }
      return [med(rs), med(gs), med(bs)]
    }

    const patches = [
      medianFromPatch(0,                    0),
      medianFromPatch(0,                    sW - CORNER_SAMPLE),
      medianFromPatch(sH - CORNER_SAMPLE,   0),
      medianFromPatch(sH - CORNER_SAMPLE,   sW - CORNER_SAMPLE),
    ]
    const bgR = Math.round(patches.reduce((s, p) => s + p[0], 0) / 4)
    const bgG = Math.round(patches.reduce((s, p) => s + p[1], 0) / 4)
    const bgB = Math.round(patches.reduce((s, p) => s + p[2], 0) / 4)

    // ── Foreground bounding box ────────────────────────────────────────────
    let fgCount = 0
    let minRow = sH, maxRow = -1, minCol = sW, maxCol = -1

    for (let r = 0; r < sH; r++) {
      for (let c = 0; c < sW; c++) {
        const i  = (r * sW + c) * ch
        const dr = px[i]     - bgR
        const dg = px[i + 1] - bgG
        const db = px[i + 2] - bgB
        if (Math.sqrt(dr * dr + dg * dg + db * db) > RGB_DIST_THRESH) {
          fgCount++
          if (r < minRow) minRow = r
          if (r > maxRow) maxRow = r
          if (c < minCol) minCol = c
          if (c > maxCol) maxCol = c
        }
      }
    }

    // Too little foreground → uniform background or near-uniform card fill
    if (fgCount / total < MIN_FG_FRAC) return null
    if (maxRow < minRow || maxCol < minCol) return null

    // ── Expand bounding box for card's white border ────────────────────────
    const mRow = Math.round((maxRow - minRow) * MARGIN_FRAC)
    const mCol = Math.round((maxCol - minCol) * MARGIN_FRAC)
    const eMinRow = Math.max(0,      minRow - mRow)
    const eMaxRow = Math.min(sH - 1, maxRow + mRow)
    const eMinCol = Math.max(0,      minCol - mCol)
    const eMaxCol = Math.min(sW - 1, maxCol + mCol)

    // ── Scale to original image coordinates ───────────────────────────────
    const scaleX = origW / sW
    const scaleY = origH / sH
    const left   = Math.max(0, Math.round(eMinCol * scaleX))
    const top    = Math.max(0, Math.round(eMinRow * scaleY))
    const right  = Math.min(origW, Math.round(eMaxCol * scaleX))
    const bottom = Math.min(origH, Math.round(eMaxRow * scaleY))
    const cropW  = right - left
    const cropH  = bottom - top

    if (cropW <= 0 || cropH <= 0) return null

    // ── Sanity checks ──────────────────────────────────────────────────────
    const cropFrac = (cropW * cropH) / (origW * origH)
    if (cropFrac < MIN_CROP_FRAC) return null  // detection is probably wrong
    if (cropFrac > MAX_CROP_FRAC) return null  // barely any crop — not worth it

    return { left, top, width: cropW, height: cropH }
  } catch {
    return null
  }
}

// ── Inner frame detection (for centering) ─────────────────────────────────────

/**
 * Detect the inner printed frame of a card within an already-cropped card image.
 *
 * Most graded card series (vintage Pokémon, base WoTC, modern non-full-art) have
 * a printed inner border or frame that is the actual reference used for centering
 * grades. PSA "53/47 top-heavy centering" is measured between the outer card edge
 * and this inner frame.
 *
 * Algorithm (Sharp-only — no OpenCV):
 *  1. Downsample card-cropped buffer to ≤384 px on its longest side
 *  2. Grayscale + compute a horizontal-gradient column profile and a
 *     vertical-gradient row profile (Sobel-style absolute differences)
 *  3. Scan inward from each side; the first peak whose strength is ≥
 *     PEAK_THRESH of the max profile value marks the inner frame edge
 *  4. Require all 4 sides found within sane bounds; otherwise return null
 *     (borderless / full-art / low-contrast frame)
 *
 * Returns coordinates in card-fraction space (0–1, where (0,0) = top-left
 * of the cropped card and (1,1) = bottom-right).
 */
export async function detectInnerFrame(
  cardOnlyBuf: Buffer,
): Promise<{ x: number; y: number; w: number; h: number; confidence: 'high' | 'medium' | 'low' } | null> {
  const DETECT_MAX     = 384
  // Limit scan to the outer 30% of each side — real card frames sit within
  // 2–18% of the edge. Beyond 30% we're well into artwork territory.
  const SEARCH_FRAC    = 0.30
  // Inner frame must lie outside the immediate edge (which may be the white
  // border captured by the outer crop) and inside SEARCH_FRAC.
  const MIN_INSET_FRAC = 0.015
  const MAX_INSET_FRAC = 0.22
  // Required peak strength as a fraction of the max gradient on that axis.
  const PEAK_THRESH    = 0.45

  try {
    const { data, info } = await sharp(cardOnlyBuf)
      .resize(DETECT_MAX, DETECT_MAX, { fit: 'inside' })
      .grayscale()
      .raw()
      .toBuffer({ resolveWithObject: true })

    const W = info.width
    const H = info.height
    if (W < 40 || H < 40) return null

    const px = new Uint8Array(data)

    // ── Build gradient profiles ──────────────────────────────────────────────
    // colGrad[c] = sum over all rows of |px(r, c+1) - px(r, c-1)|
    //   → tall peaks at c = vertical frame edges (left & right)
    // rowGrad[r] = sum over all cols of |px(r+1, c) - px(r-1, c)|
    //   → tall peaks at r = horizontal frame edges (top & bottom)
    const colGrad = new Float32Array(W)
    const rowGrad = new Float32Array(H)

    for (let r = 1; r < H - 1; r++) {
      for (let c = 1; c < W - 1; c++) {
        const hG = Math.abs(px[r * W + c + 1] - px[r * W + c - 1])
        const vG = Math.abs(px[(r + 1) * W + c] - px[(r - 1) * W + c])
        colGrad[c] += hG
        rowGrad[r] += vG
      }
    }

    // ── Helper: scan inward for the first strong peak ────────────────────────
    function findInnerEdge(
      profile: Float32Array,
      length: number,
      fromStart: boolean,        // true = scan left→right (looking for LEFT/TOP edge)
    ): { idx: number; strength: number } | null {
      const searchMax = Math.floor(length * SEARCH_FRAC)
      const minInset  = Math.floor(length * MIN_INSET_FRAC)
      const maxInset  = Math.floor(length * MAX_INSET_FRAC)

      // Local max over a small window prevents picking single-pixel noise.
      // We also need an absolute strength threshold.
      let maxVal = 0
      for (let i = 0; i < length; i++) if (profile[i] > maxVal) maxVal = profile[i]
      if (maxVal <= 0) return null
      const absThresh = maxVal * PEAK_THRESH

      let bestIdx = -1
      let bestStrength = 0

      // Scan only within [minInset, maxInset]
      const lo = minInset
      const hi = Math.min(maxInset, searchMax)
      for (let i = lo; i <= hi; i++) {
        const idx = fromStart ? i : length - 1 - i
        const v = profile[idx]
        if (v >= absThresh && v > bestStrength) {
          // Verify it's a local maximum within a ±2 window
          const i0 = Math.max(0, idx - 2)
          const i1 = Math.min(length - 1, idx + 2)
          let isLocalMax = true
          for (let k = i0; k <= i1; k++) {
            if (profile[k] > v) { isLocalMax = false; break }
          }
          if (isLocalMax) {
            bestStrength = v
            bestIdx = idx
          }
        }
      }

      if (bestIdx < 0) return null
      return { idx: bestIdx, strength: bestStrength / maxVal }
    }

    const left   = findInnerEdge(colGrad, W, true)
    const right  = findInnerEdge(colGrad, W, false)
    const top    = findInnerEdge(rowGrad, H, true)
    const bottom = findInnerEdge(rowGrad, H, false)

    // Require all 4 sides — partial detection isn't reliable enough to measure
    if (!left || !right || !top || !bottom) return null

    // Sanity: inner frame must be a proper rectangle (right > left, bottom > top)
    if (right.idx <= left.idx + 8) return null
    if (bottom.idx <= top.idx + 8) return null

    // ── Confidence from average peak strength ────────────────────────────────
    const avgStrength = (left.strength + right.strength + top.strength + bottom.strength) / 4
    const confidence: 'high' | 'medium' | 'low' =
      avgStrength >= 0.75 ? 'high'   :
      avgStrength >= 0.55 ? 'medium' :
                            'low'

    // Convert pixel indices to fractions of the card region (0–1)
    const x = left.idx / W
    const y = top.idx / H
    const w = (right.idx - left.idx) / W
    const h = (bottom.idx - top.idx) / H

    return { x, y, w, h, confidence }
  } catch {
    return null
  }
}

/**
 * Build a CenteringMeasurement payload from the outer card bounds and
 * an optional inner frame detection. This is pure geometry — no I/O.
 *
 * @param cardBoundsPct  outer card bbox in photo-fraction space (0–1)
 * @param innerFrame     inner frame in card-fraction space (0–1), or null
 */
export function buildCenteringMeasurement(
  cardBoundsPct: { x: number; y: number; w: number; h: number },
  innerFrame:    { x: number; y: number; w: number; h: number; confidence: 'high' | 'medium' | 'low' } | null,
): CenteringMeasurement {
  // Borderless / full-art fallback — return outer bbox only
  if (!innerFrame) {
    return {
      card_bbox_pct:        cardBoundsPct,
      inner_frame_bbox_pct: null,
      margins_pct:          null,
      ratios:               null,
      interpretation:       'unavailable',
      confidence:           'low',
      fallback_reason:      'borderless_card',
    }
  }

  // Margins as a percentage of the available space on each axis.
  // left + right = 100, top + bottom = 100 (matches "53/47" grader convention).
  const leftRaw   = innerFrame.x
  const rightRaw  = 1 - (innerFrame.x + innerFrame.w)
  const topRaw    = innerFrame.y
  const bottomRaw = 1 - (innerFrame.y + innerFrame.h)

  const horizSum = leftRaw + rightRaw
  const vertSum  = topRaw  + bottomRaw

  // Degenerate (inner == outer) → no measurable centering
  if (horizSum <= 1e-6 || vertSum <= 1e-6) {
    return {
      card_bbox_pct:        cardBoundsPct,
      inner_frame_bbox_pct: innerFrame,
      margins_pct:          null,
      ratios:               null,
      interpretation:       'unavailable',
      confidence:           innerFrame.confidence,
      fallback_reason:      'low_contrast',
    }
  }

  const leftPct   = Math.round((leftRaw   / horizSum) * 100)
  const rightPct  = 100 - leftPct
  const topPct    = Math.round((topRaw    / vertSum)  * 100)
  const bottomPct = 100 - topPct

  // Worst-axis deviation from perfect 50/50 drives the interpretation bucket
  const lrDev = Math.abs(50 - leftPct)
  const tbDev = Math.abs(50 - topPct)
  const worst = Math.max(lrDev, tbDev)

  const interpretation: CenteringMeasurement['interpretation'] =
    worst <= 2  ? 'well_centered'   :
    worst <= 5  ? 'slightly_off'    :
    worst <= 10 ? 'noticeably_off'  :
                  'severely_off'

  return {
    card_bbox_pct:        cardBoundsPct,
    inner_frame_bbox_pct: innerFrame,
    margins_pct:          { left: leftPct, right: rightPct, top: topPct, bottom: bottomPct },
    ratios:               { left_right: `${leftPct}/${rightPct}`, top_bottom: `${topPct}/${bottomPct}` },
    interpretation,
    confidence:           innerFrame.confidence,
    fallback_reason:      null,
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

  // Detector A — Border Irregularity
  let borderIrregularityStr = ''
  if (cv.border_irregularity) {
    const s = cv.border_irregularity
    const ps = s.per_side
    borderIrregularityStr = `
─── CV DETECTOR A: BORDER IRREGULARITY ───
  Score: ${s.score}  Severity: ${s.severity.toUpperCase()}
  Gradient: ${r1(s.total_grad_fraction * 100)}%  Bright: ${r1(s.bright_fraction * 100)}%  Clusters: ${s.component_count}  Largest: ${s.max_component_area}px
  Per-side grad%: top=${r1(ps.top.grad_fraction * 100)}% bottom=${r1(ps.bottom.grad_fraction * 100)}% left=${r1(ps.left.grad_fraction * 100)}% right=${r1(ps.right.grad_fraction * 100)}%
NOTE: ${s.severity !== 'none'
  ? 'Elevated border anomaly — inspect for whitening, chips, edge roughness, or print artifacts.'
  : 'Border band appears clean.'}
`
  }

  // Detector B — Surface Lines
  let surfaceLinesStr = ''
  if (cv.surface_lines) {
    const s = cv.surface_lines
    surfaceLinesStr = `
─── CV DETECTOR B: SURFACE LINES ───
  Score: ${s.score}  Severity: ${s.severity.toUpperCase()}  Confidence: ${s.confidence}
  Diagonal: ${r1(s.diagonal_energy_fraction * 100)}%  H: ${r1(s.h_energy_fraction * 100)}%  V: ${r1(s.v_energy_fraction * 100)}%  Energy imbalance: ${s.energy_imbalance}  Glare: ${r1(s.glare_fraction * 100)}%
NOTE: ${s.severity !== 'none'
  ? 'Directional surface features detected — possible scratches, holo damage, or print lines.'
  : 'No dominant directional surface features detected.'}${s.confidence === 'low' ? '\nNOTE: High glare limits surface analysis reliability.' : ''}
`
  }

  // Detector C — Surface Grid
  let surfaceGridStr = ''
  if (cv.surface_grid !== null) {
    const hot   = cv.surface_grid.filter(c => !c.glare_masked)
    const glare = cv.surface_grid.filter(c =>  c.glare_masked)

    // Map row/col indices to human-readable region labels
    const rowLabel = (r: number) => r <= 1 ? 'upper' : r <= 3 ? 'middle' : 'lower'
    const colLabel = (c: number) => c <= 1 ? 'left'  : 'right'

    if (hot.length === 0 && glare.length === 0) {
      surfaceGridStr = `
─── CV DETECTOR C: SURFACE GRID (${SURFACE_GRID_COLS}×${SURFACE_GRID_ROWS} cell analysis) ───
  No anomalous cells detected — surface appears clean in this image.
`
    } else {
      const hotLines = hot.map(c =>
        `  • ${rowLabel(c.row)}-${colLabel(c.col)} (row ${c.row} col ${c.col}): ${c.severity.toUpperCase()} [score ${c.score}]`
      ).join('\n')

      const glareLines = glare.length > 0
        ? `  Glare-masked cells (signal hidden): ${glare.map(c => `row ${c.row} col ${c.col}`).join(', ')}`
        : ''

      surfaceGridStr = `
─── CV DETECTOR C: SURFACE GRID (${SURFACE_GRID_COLS}×${SURFACE_GRID_ROWS} cell analysis) ───
${hot.length > 0 ? `  Anomalous cells:\n${hotLines}` : '  No anomalous cells detected.'}
${glareLines}
NOTE: ${hot.length > 0
  ? 'These surface regions show elevated directional energy — possible scratches, holo damage, or print lines. Cross-reference with image inspection.'
  : 'Surface appears clean in measurable regions.'}
`
    }
  }

  return `─── CV MEASUREMENTS (pixel analysis, run before this prompt) ───
Blur score   : ${cv.blur_score}  (threshold ≥ ${BLUR_THRESHOLD} = acceptably sharp)
Glare        : ${r1(cv.glare_fraction * 100)}% pixels overexposed  (≤ 5% acceptable)
Brightness   : mean ${cv.brightness_mean} / std ${cv.brightness_std}  (0–255 scale)
CV issues    :
${issueStr}${blurNote}${glareNote}
${cornerStr}${borderIrregularityStr}${surfaceLinesStr}${surfaceGridStr}
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
const r2 = (n: number) => Math.round(n * 100)  / 100
const r4 = (n: number) => Math.round(n * 10000) / 10000
