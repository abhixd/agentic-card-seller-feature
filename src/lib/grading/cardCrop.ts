/**
 * cardCrop.ts — OpenCV-based card isolation, perspective rectification,
 * and crop quality assessment.
 *
 * Phase 1 implementation of docs/crop_rectification_subsystem_design.docx
 *
 * Detection cascade (priority order):
 *   1. Contour quad     Canny → morphClose → findContours → approxPolyDP(4pt) → warpPerspective
 *   2. Min-area rect    minAreaRect on largest plausible contour → warpPerspective
 *   3. Color threshold  background colour sampling → axis-aligned extract  (Sharp only, no warp)
 *   4. Full image       passthrough, status = 'failed_detection'
 *
 * All detection runs on a DETECT_SIZE downsample for speed. Warping also
 * runs at that resolution; the output is CANONICAL_W×CANONICAL_H JPEG which
 * is the exact input size expected by analyseBuffer() in cvDetectors.ts.
 *
 * Memory management: every cv.Mat / cv.MatVector is .delete()-d in finally
 * blocks via a collected "trash" array — the WASM heap does NOT garbage-collect.
 */

import sharp from 'sharp'
import { detectCardBounds } from './cvDetectors'

// ── Constants ─────────────────────────────────────────────────────────────────

const CANONICAL_W  = 384    // must match cvDetectors.ts CANONICAL_W
const CANONICAL_H  = 544    // must match cvDetectors.ts CANONICAL_H
const DETECT_SIZE  = 640    // max side length for detection downsample

// Standard trading card portrait W/H ≈ 63.5/88.9 ≈ 0.714
// Allow slack for perspective distortion and landscape orientation
const CARD_ASPECT_MIN = 0.58
const CARD_ASPECT_MAX = 0.86

// Contour area as fraction of detection image: skip if too small or full-frame
const CONTOUR_AREA_MIN = 0.05
const CONTOUR_AREA_MAX = 0.95

// ── Public types ──────────────────────────────────────────────────────────────

export type CropStatus =
  | 'ok'                   // contour quad found, high confidence (≥ 0.75)
  | 'low_confidence_crop'  // min-area-rect, color-threshold, or marginal quad
  | 'failed_detection'     // no plausible card; original buffer returned

export interface CropMeta {
  status:           CropStatus
  crop_confidence:  number            // 0.0–1.0
  visible_fraction: number            // detected card area / total image area
  card_quad:        [number,number][] | null  // [TL,TR,BR,BL] in original px coords
  fallback_used:    boolean
  detector:         'contour_quad' | 'min_area_rect' | 'color_threshold' | 'full_image'
}

export interface CropResult extends CropMeta {
  buffer: Buffer
}

// ── OpenCV singleton ──────────────────────────────────────────────────────────
// The WASM runtime (~8 MB) is loaded once per Node.js process.
// Dynamic import keeps it out of the initial module bundle.

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _cv:        any             = null
let _cvPromise: Promise<any> | null = null

async function getCV(): Promise<any> { // eslint-disable-line @typescript-eslint/no-explicit-any
  if (_cv) return _cv
  if (!_cvPromise) {
    _cvPromise = (async () => {
      const mod = await import('@techstark/opencv-js')
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const cv  = (mod as any).default ?? mod
      // Wait for Emscripten WASM to finish initialising (fires onRuntimeInitialized)
      if (typeof cv.Mat === 'undefined') {
        await new Promise<void>((resolve) => {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          ;(cv as any).onRuntimeInitialized = resolve
        })
      }
      _cv = cv
      console.log('[cardCrop] OpenCV WASM ready')
      return cv
    })().catch((err) => {
      _cvPromise = null  // allow retry on transient failure
      throw err
    })
  }
  return _cvPromise
}

// ── Point ordering ────────────────────────────────────────────────────────────

/**
 * Re-order any 4 points into [TL, TR, BR, BL] using the sum/diff trick:
 *   TL → min(x+y)    BR → max(x+y)
 *   TR → min(x-y)    BL → max(x-y)
 */
function orderQuad(pts: [number,number][]): [number,number][] {
  const sums  = pts.map(([x,y]) => x + y)
  const diffs = pts.map(([x,y]) => x - y)
  return [
    pts[sums.indexOf(Math.min(...sums))],    // TL
    pts[diffs.indexOf(Math.min(...diffs))],  // TR
    pts[sums.indexOf(Math.max(...sums))],    // BR
    pts[diffs.indexOf(Math.max(...diffs))],  // BL
  ]
}

/** True when W/H ratio (either orientation) is plausible for a trading card. */
function isCardAspect(w: number, h: number): boolean {
  const r = w / (h + 1e-6)
  return (r >= CARD_ASPECT_MIN && r <= CARD_ASPECT_MAX)
      || (1/r >= CARD_ASPECT_MIN && 1/r <= CARD_ASPECT_MAX)
}

// ── Internal detection result ─────────────────────────────────────────────────

interface QuadResult {
  quad:       [number,number][]   // [TL,TR,BR,BL] in DETECT downsample space
  area_frac:  number
  confidence: number
  method:     'contour_quad' | 'min_area_rect'
}

// ── Phase 1: Contour + quad detection (OpenCV) ────────────────────────────────

/**
 * detect_card_quad — Canny → morphClose → findContours → score each contour.
 *
 * Returns the highest-confidence quadrilateral found, or null if no plausible
 * card region could be isolated. All Mats are .delete()-d before returning.
 */
async function detectCardQuad(
  grayU8: Uint8Array,
  w:      number,
  h:      number,
): Promise<QuadResult | null> {
  const cv = await getCV()

  // Collect every Mat/MatVector that needs explicit deletion
  const trash: Array<{ delete(): void }> = []
  const T = <M extends { delete(): void }>(m: M): M => { trash.push(m); return m }
  const cleanup = () => trash.forEach(m => { try { m.delete() } catch {} })

  try {
    // ── Build grayscale Mat ────────────────────────────────────────────────
    const gray = T(cv.matFromArray(h, w, cv.CV_8UC1, grayU8))

    // ── Gaussian blur — suppress texture noise ─────────────────────────────
    const blurred = T(new cv.Mat())
    cv.GaussianBlur(gray, blurred, new cv.Size(5, 5), 0)

    // ── Canny — adaptive thresholds based on median brightness ────────────
    const sorted  = Array.from(grayU8).sort((a, b) => a - b)
    const median  = sorted[Math.floor(sorted.length / 2)]
    const cannyLo = Math.max(0,   0.67 * median)
    const cannyHi = Math.min(255, 1.33 * median)
    const edges   = T(new cv.Mat())
    cv.Canny(blurred, edges, cannyLo, cannyHi)

    // ── Morphological close — reconnect broken card borders ────────────────
    const kernel = T(cv.getStructuringElement(cv.MORPH_RECT, new cv.Size(9, 9)))
    const closed = T(new cv.Mat())
    cv.morphologyEx(edges, closed, cv.MORPH_CLOSE, kernel)

    // ── findContours ───────────────────────────────────────────────────────
    const contours  = new cv.MatVector()   // deleted explicitly below
    const hierarchy = T(new cv.Mat())
    cv.findContours(closed, contours, hierarchy, cv.RETR_EXTERNAL, cv.CHAIN_APPROX_SIMPLE)

    const totalArea  = w * h
    let bestQuad:     QuadResult | null = null
    let bestMinRect:  QuadResult | null = null

    for (let i = 0; i < contours.size(); i++) {
      const c        = contours.get(i)
      const area     = cv.contourArea(c)
      const areaFrac = area / totalArea

      if (areaFrac < CONTOUR_AREA_MIN || areaFrac > CONTOUR_AREA_MAX) continue

      // ── Try approxPolyDP → 4-point quadrilateral ───────────────────────
      const arcLen = cv.arcLength(c, true)
      const approx = new cv.Mat()           // deleted immediately in both branches
      cv.approxPolyDP(c, approx, 0.02 * arcLen, true)

      if (approx.rows === 4) {
        // Extract 4 points from CV_32SC2 flat array
        const pts: [number,number][] = Array.from({ length: 4 }, (_, j) => [
          approx.data32S[j * 2],
          approx.data32S[j * 2 + 1],
        ] as [number,number])
        approx.delete()

        const ordered   = orderQuad(pts)
        const [TL, TR, , BL] = ordered
        const rectW     = Math.hypot(TR[0] - TL[0], TR[1] - TL[1])
        const rectH     = Math.hypot(BL[0] - TL[0], BL[1] - TL[1])

        if (isCardAspect(rectW, rectH)) {
          // Confidence: base 0.55 + proportional area boost, capped at 0.95
          const conf = Math.min(0.95, 0.55 + areaFrac * 0.40)
          if (!bestQuad || areaFrac > bestQuad.area_frac) {
            bestQuad = { quad: ordered, area_frac: areaFrac, confidence: conf, method: 'contour_quad' }
          }
        }
      } else {
        approx.delete()
      }

      // ── Phase 2: minAreaRect fallback ──────────────────────────────────
      const rr   = cv.minAreaRect(c)
      const bpts = cv.boxPoints(rr)  // Point2f[] — JS array, no .delete() needed
      const rawPts = bpts.map((p: { x: number; y: number }) =>
        [Math.round(p.x), Math.round(p.y)] as [number,number],
      )

      if (isCardAspect(rr.size.width, rr.size.height)) {
        const conf = Math.min(0.70, 0.30 + areaFrac * 0.40)
        if (!bestMinRect || areaFrac > bestMinRect.area_frac) {
          bestMinRect = {
            quad:      orderQuad(rawPts),
            area_frac: areaFrac,
            confidence: conf,
            method:    'min_area_rect',
          }
        }
      }
    }

    contours.delete()
    return bestQuad ?? bestMinRect ?? null

  } finally {
    cleanup()
  }
}

// ── Perspective warp ──────────────────────────────────────────────────────────

/**
 * rectify_card — Apply a 4-point perspective transform to straighten the card
 * into a canonical top-down view at CANONICAL_W × CANONICAL_H.
 *
 * Input:  RGB Uint8Array at srcW × srcH, plus [TL,TR,BR,BL] quad in that space.
 * Output: JPEG Buffer at CANONICAL_W × CANONICAL_H.
 */
async function rectifyCard(
  rgbU8: Uint8Array,
  srcW:  number,
  srcH:  number,
  quad:  [number,number][],
): Promise<Buffer> {
  const cv = await getCV()

  const trash: Array<{ delete(): void }> = []
  const T = <M extends { delete(): void }>(m: M): M => { trash.push(m); return m }
  const cleanup = () => trash.forEach(m => { try { m.delete() } catch {} })

  try {
    const [TL, TR, BR, BL] = quad

    // Source Mat — CV_8UC3 RGB at detection resolution
    const src = T(cv.matFromArray(srcH, srcW, cv.CV_8UC3, rgbU8))

    // Source and destination point arrays for the homography
    const srcPts = T(cv.matFromArray(4, 1, cv.CV_32FC2, [
      TL[0], TL[1],
      TR[0], TR[1],
      BR[0], BR[1],
      BL[0], BL[1],
    ]))
    const dstPts = T(cv.matFromArray(4, 1, cv.CV_32FC2, [
      0,           0,
      CANONICAL_W, 0,
      CANONICAL_W, CANONICAL_H,
      0,           CANONICAL_H,
    ]))

    // Perspective transform matrix + warp
    const M   = T(cv.getPerspectiveTransform(srcPts, dstPts))
    const dst = T(new cv.Mat())
    cv.warpPerspective(src, dst, M, new cv.Size(CANONICAL_W, CANONICAL_H))

    // dst.data is a Uint8Array backed by WASM memory — copy it before cleanup
    const rawPixels = new Uint8Array(dst.data)

    // Convert raw RGB → JPEG via Sharp
    return await sharp(Buffer.from(rawPixels), {
      raw: { width: CANONICAL_W, height: CANONICAL_H, channels: 3 },
    })
      .jpeg({ quality: 92 })
      .toBuffer()

  } finally {
    cleanup()
  }
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * preprocess_card — full crop + rectification pipeline.
 *
 * Never throws. On any failure returns status='failed_detection' with the
 * original buffer unchanged so downstream callers always get a usable image.
 *
 * Status codes (from the design doc §11):
 *   ok                  — contour quad found, high confidence (≥ 0.75)
 *   low_confidence_crop — min-area-rect or color-threshold fallback
 *   failed_detection    — no card isolated; original buffer returned
 */
export async function cropCard(buf: Buffer): Promise<CropResult> {
  const failed = (err?: unknown): CropResult => {
    if (err) console.error('[cardCrop] error:', err)
    return {
      buffer:           buf,
      status:           'failed_detection',
      crop_confidence:  0,
      visible_fraction: 1.0,
      card_quad:        null,
      fallback_used:    true,
      detector:         'full_image',
    }
  }

  try {
    // Original dimensions — needed to scale quad back to source coords
    const meta  = await sharp(buf).metadata()
    const origW = meta.width  ?? 0
    const origH = meta.height ?? 0
    if (!origW || !origH) return failed()

    // ── Downsample for detection (keeps aspect ratio) ─────────────────────
    const { data: rgbData, info: rgbInfo } = await sharp(buf)
      .resize(DETECT_SIZE, DETECT_SIZE, { fit: 'inside' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    const dW     = rgbInfo.width
    const dH     = rgbInfo.height
    const scaleX = origW / dW
    const scaleY = origH / dH

    // Grayscale conversion for OpenCV detection (luminance formula)
    const grayU8 = new Uint8Array(dW * dH)
    for (let i = 0; i < dW * dH; i++) {
      grayU8[i] = Math.round(
        0.299 * rgbData[i * 3] +
        0.587 * rgbData[i * 3 + 1] +
        0.114 * rgbData[i * 3 + 2],
      )
    }

    // ── Phase 1 + 2: OpenCV quad detection ───────────────────────────────
    let detection: QuadResult | null = null
    try {
      detection = await detectCardQuad(grayU8, dW, dH)
    } catch (err) {
      console.warn('[cardCrop] OpenCV detection failed, using fallback:', String(err))
    }

    if (detection) {
      // Scale detected quad from detection space → original image space
      const origQuad = detection.quad.map(([x, y]) => [
        Math.round(x * scaleX),
        Math.round(y * scaleY),
      ]) as [number,number][]

      // Warp at detection resolution; output is CANONICAL_W×CANONICAL_H JPEG
      const warpedBuf = await rectifyCard(new Uint8Array(rgbData), dW, dH, detection.quad)

      console.log(
        `[cardCrop] ${detection.method} — confidence ${detection.confidence.toFixed(2)},` +
        ` area ${(detection.area_frac * 100).toFixed(0)}%`,
      )

      return {
        buffer:           warpedBuf,
        status:           detection.confidence >= 0.75 ? 'ok' : 'low_confidence_crop',
        crop_confidence:  Math.round(detection.confidence * 100) / 100,
        visible_fraction: Math.round(detection.area_frac * 100) / 100,
        card_quad:        origQuad,
        fallback_used:    detection.method === 'min_area_rect',
        detector:         detection.method,
      }
    }

    // ── Phase 3: color-threshold bounding box (Sharp only, no perspective) ─
    const bounds = await detectCardBounds(buf)
    if (bounds) {
      const cropBuf    = await sharp(buf).extract(bounds).toBuffer()
      const visFrac    = (bounds.width * bounds.height) / (origW * origH)
      console.log(`[cardCrop] color_threshold — visible ${(visFrac * 100).toFixed(0)}%`)
      return {
        buffer:           cropBuf,
        status:           'low_confidence_crop',
        crop_confidence:  0.45,
        visible_fraction: Math.round(visFrac * 100) / 100,
        card_quad:        null,
        fallback_used:    true,
        detector:         'color_threshold',
      }
    }

    // ── Phase 4: no card found — return original ──────────────────────────
    console.warn('[cardCrop] failed_detection — using full image')
    return failed()

  } catch (err) {
    return failed(err)
  }
}
