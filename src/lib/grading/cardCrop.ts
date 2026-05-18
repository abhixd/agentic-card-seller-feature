/**
 * cardCrop.ts — OpenCV-based card isolation, perspective rectification,
 * and crop quality assessment.
 *
 * Phases 1–3 implementation of docs/crop_rectification_subsystem_design.docx
 *
 * Detection cascade (priority order):
 *   1. Contour quad     Canny → morphClose → findContours → approxPolyDP(4pt) → warpPerspective
 *   2. Min-area rect    minAreaRect on largest plausible contour → warpPerspective
 *   3. Color threshold  background colour sampling → axis-aligned extract  (Sharp only, no warp)
 *   4. Full image       passthrough, status = 'failed_detection'
 *
 * Phase 2 scoring signals (in addition to area fraction):
 *   • Solidity       = contourArea / convexHullArea  — filters out non-convex clutter
 *   • Geometry score = corner angle deviation from 90° — rewards true rectangles
 *
 * Phase 3 debug visualization:
 *   Pass { debug: true } to cropCard() to get debug_original (detection image with
 *   quad overlay) and debug_rectified (canonical output) in the returned CropResult.
 *   POST /api/grade/debug-crop uses this to let you inspect the detector visually.
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

// Phase 2 scoring thresholds
// Cards are nearly convex — a solidity below 0.75 means the contour is spiky
// (hands, holders, multiple objects) rather than a clean rectangle.
const SOLIDITY_MIN = 0.75
// Corner angles further from 90° than this are penalised in the geometry score.
// Real perspective distortion rarely exceeds 30° per corner.
const MAX_ANGLE_DEV_DEG = 40

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
  buffer:            Buffer
  // Phase 3 debug images — only populated when cropCard() is called with { debug: true }
  debug_original?:   Buffer  // detection-size image with quad outline + corner labels drawn
  debug_rectified?:  Buffer  // canonical 384×544 output (same as buffer when status=ok)
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

// ── Phase 2 scoring helpers (pure JS — no OpenCV) ─────────────────────────────

/**
 * Angle in degrees at vertex `o` between rays o→a and o→b.
 * Returns 0–180; a perfect rectangle corner returns 90.
 */
function cornerAngleDeg(
  o: [number,number],
  a: [number,number],
  b: [number,number],
): number {
  const v1 = [a[0] - o[0], a[1] - o[1]]
  const v2 = [b[0] - o[0], b[1] - o[1]]
  const dot = v1[0] * v2[0] + v1[1] * v2[1]
  const mag = Math.sqrt((v1[0] ** 2 + v1[1] ** 2) * (v2[0] ** 2 + v2[1] ** 2))
  return Math.acos(Math.max(-1, Math.min(1, dot / (mag + 1e-9)))) * (180 / Math.PI)
}

/**
 * Geometry score for an ordered [TL,TR,BR,BL] quad.
 * 1.0 = perfect rectangle; approaches 0 as corners deviate from 90°.
 * Cards distorted by perspective typically score ≥ 0.60.
 */
function quadGeometryScore(quad: [number,number][]): number {
  const [TL, TR, BR, BL] = quad
  const angles = [
    cornerAngleDeg(TL, TR, BL),  // TL: rays toward TR and BL
    cornerAngleDeg(TR, TL, BR),  // TR: rays toward TL and BR
    cornerAngleDeg(BR, TR, BL),  // BR: rays toward TR and BL
    cornerAngleDeg(BL, BR, TL),  // BL: rays toward BR and TL
  ]
  const maxErr = Math.max(...angles.map(a => Math.abs(a - 90)))
  return Math.max(0, 1 - maxErr / MAX_ANGLE_DEV_DEG)
}

// ── Internal detection result ─────────────────────────────────────────────────

interface QuadResult {
  quad:           [number,number][]   // [TL,TR,BR,BL] in DETECT downsample space
  area_frac:      number
  solidity:       number              // contourArea / convexHullArea  (0–1)
  geometry_score: number              // corner angle quality          (0–1, quad only)
  confidence:     number              // composite score               (0–1)
  method:         'contour_quad' | 'min_area_rect'
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

      // ── Phase 2: solidity filter ────────────────────────────────────────
      // Cards are nearly convex. Solidity = contourArea / convexHullArea.
      // Below SOLIDITY_MIN → spiky contour (hands, holders, clutter) → skip.
      const hull = new cv.Mat()
      cv.convexHull(c, hull)
      const hullArea = cv.contourArea(hull)
      hull.delete()
      const solidity = area / (hullArea + 1e-9)
      if (solidity < SOLIDITY_MIN) continue

      // ── Phase 2: solidity score (0–1) for confidence weighting ─────────
      // Maps [SOLIDITY_MIN, 1.0] → [0, 1]
      const solidityScore = Math.min(1, (solidity - SOLIDITY_MIN) / (1 - SOLIDITY_MIN))

      // ── Try approxPolyDP → 4-point quadrilateral ───────────────────────
      const arcLen = cv.arcLength(c, true)
      const approx = new cv.Mat()
      cv.approxPolyDP(c, approx, 0.02 * arcLen, true)

      if (approx.rows === 4) {
        const pts: [number,number][] = Array.from({ length: 4 }, (_, j) => [
          approx.data32S[j * 2],
          approx.data32S[j * 2 + 1],
        ] as [number,number])
        approx.delete()

        const ordered = orderQuad(pts)
        const [TL, TR, , BL] = ordered
        const rectW   = Math.hypot(TR[0] - TL[0], TR[1] - TL[1])
        const rectH   = Math.hypot(BL[0] - TL[0], BL[1] - TL[1])

        if (isCardAspect(rectW, rectH)) {
          // Phase 2: composite confidence (area + solidity + geometry)
          const geomScore  = quadGeometryScore(ordered)
          const areaScore  = Math.min(1, areaFrac / 0.70)
          const conf       = Math.min(0.95,
            0.40 * areaScore + 0.30 * solidityScore + 0.30 * geomScore,
          )
          if (!bestQuad || conf > bestQuad.confidence) {
            bestQuad = {
              quad:           ordered,
              area_frac:      areaFrac,
              solidity,
              geometry_score: geomScore,
              confidence:     conf,
              method:         'contour_quad',
            }
          }
        }
      } else {
        approx.delete()
      }

      // ── minAreaRect fallback ────────────────────────────────────────────
      const rr     = cv.minAreaRect(c)
      const bpts   = cv.boxPoints(rr)   // Point2f[] — plain JS array
      const rawPts = bpts.map((p: { x: number; y: number }) =>
        [Math.round(p.x), Math.round(p.y)] as [number,number],
      )

      if (isCardAspect(rr.size.width, rr.size.height)) {
        // Phase 2: composite confidence for min-rect (no geometry score — rect is by definition rectangular)
        const areaScore = Math.min(1, areaFrac / 0.70)
        const conf      = Math.min(0.70, 0.50 * areaScore + 0.30 * solidityScore + 0.10)
        if (!bestMinRect || conf > bestMinRect.confidence) {
          bestMinRect = {
            quad:           orderQuad(rawPts),
            area_frac:      areaFrac,
            solidity,
            geometry_score: 0,        // not computed for rotated rect
            confidence:     conf,
            method:         'min_area_rect',
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

// ── Phase 3: debug overlay ────────────────────────────────────────────────────

/**
 * Draw the detected quad outline and labelled corner dots onto a copy of the
 * detection-resolution RGB image, returning it as a JPEG Buffer.
 *
 * Color scheme (RGB order — consistent with Sharp raw output):
 *   Outline  — bright green
 *   TL dot   — green    TR dot — blue
 *   BR dot   — red      BL dot — orange
 *
 * Called only when cropCard() receives { debug: true }.
 */
async function drawDebugOverlay(
  rgbU8:      Uint8Array,
  w:          number,
  h:          number,
  quad:       [number,number][] | null,
  confidence: number,
  method:     string,
): Promise<Buffer> {
  const cv = await getCV()

  const trash: Array<{ delete(): void }> = []
  const T = <M extends { delete(): void }>(m: M): M => { trash.push(m); return m }
  const cleanup = () => trash.forEach(m => { try { m.delete() } catch {} })

  try {
    const img = T(cv.matFromArray(h, w, cv.CV_8UC3, rgbU8))

    if (quad) {
      const [TL, TR, BR, BL] = quad

      // Quad outline (green)
      const ptsMat = T(cv.matFromArray(4, 1, cv.CV_32SC2, [
        TL[0], TL[1], TR[0], TR[1], BR[0], BR[1], BL[0], BL[1],
      ]))
      const ptsVec = new cv.MatVector()
      ptsVec.push_back(ptsMat)
      cv.polylines(img, ptsVec, true, new cv.Scalar(0, 220, 0), 3)
      ptsVec.delete()

      // Corner dots with distinct colors + text labels
      const corners: [[number,number], [number,number,number], string][] = [
        [TL, [0,   220, 0  ], 'TL'],   // green
        [TR, [0,   80,  220], 'TR'],   // blue
        [BR, [220, 0,   0  ], 'BR'],   // red
        [BL, [220, 140, 0  ], 'BL'],   // orange
      ]
      for (const [[x, y], [r, g, b], label] of corners) {
        cv.circle(img, new cv.Point(x, y), 10, new cv.Scalar(r, g, b), -1)
        cv.putText(img, label, new cv.Point(x + 13, y + 5),
          cv.FONT_HERSHEY_SIMPLEX, 0.55, new cv.Scalar(255, 255, 255), 2)
      }
    }

    // Banner: method + confidence
    const banner = quad
      ? `${method}  conf=${(confidence * 100).toFixed(0)}%`
      : 'failed_detection'
    // Dark background strip so text is readable over any image
    cv.rectangle(img, new cv.Point(0, 0), new cv.Point(w, 36),
      new cv.Scalar(0, 0, 0), -1)
    cv.putText(img, banner, new cv.Point(8, 26),
      cv.FONT_HERSHEY_SIMPLEX, 0.70, new cv.Scalar(0, 220, 180), 2)

    const rawPixels = new Uint8Array(img.data)
    return await sharp(Buffer.from(rawPixels), {
      raw: { width: w, height: h, channels: 3 },
    })
      .jpeg({ quality: 85 })
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
export async function cropCard(
  buf:  Buffer,
  opts: { debug?: boolean } = {},
): Promise<CropResult> {
  const debug = opts.debug ?? false

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
        `[cardCrop] ${detection.method}` +
        ` conf=${detection.confidence.toFixed(2)}` +
        ` area=${(detection.area_frac * 100).toFixed(0)}%` +
        ` solidity=${detection.solidity.toFixed(2)}` +
        ` geom=${detection.geometry_score.toFixed(2)}`,
      )

      // Phase 3: generate debug overlay when requested
      let debug_original: Buffer | undefined
      let debug_rectified: Buffer | undefined
      if (debug) {
        debug_original  = await drawDebugOverlay(
          new Uint8Array(rgbData), dW, dH,
          detection.quad, detection.confidence, detection.method,
        ).catch(() => undefined)
        debug_rectified = warpedBuf
      }

      return {
        buffer:           warpedBuf,
        status:           detection.confidence >= 0.75 ? 'ok' : 'low_confidence_crop',
        crop_confidence:  Math.round(detection.confidence * 100) / 100,
        visible_fraction: Math.round(detection.area_frac * 100) / 100,
        card_quad:        origQuad,
        fallback_used:    detection.method === 'min_area_rect',
        detector:         detection.method,
        debug_original,
        debug_rectified,
      }
    }

    // ── Fallback: color-threshold bounding box (Sharp only, no perspective) ─
    const bounds = await detectCardBounds(buf)
    if (bounds) {
      const cropBuf = await sharp(buf).extract(bounds).toBuffer()
      const visFrac = (bounds.width * bounds.height) / (origW * origH)
      console.log(`[cardCrop] color_threshold — visible ${(visFrac * 100).toFixed(0)}%`)

      // Phase 3 debug: draw "no quad detected" banner on the detection image
      let debug_original: Buffer | undefined
      if (debug) {
        debug_original = await drawDebugOverlay(
          new Uint8Array(rgbData), dW, dH, null, 0.45, 'color_threshold',
        ).catch(() => undefined)
      }

      return {
        buffer:           cropBuf,
        status:           'low_confidence_crop',
        crop_confidence:  0.45,
        visible_fraction: Math.round(visFrac * 100) / 100,
        card_quad:        null,
        fallback_used:    true,
        detector:         'color_threshold',
        debug_original,
      }
    }

    // ── No card found — return original ──────────────────────────────────
    console.warn('[cardCrop] failed_detection — using full image')
    if (debug) {
      const debug_original = await drawDebugOverlay(
        new Uint8Array(rgbData), dW, dH, null, 0, 'failed_detection',
      ).catch(() => undefined)
      return { ...failed(), debug_original }
    }
    return failed()

  } catch (err) {
    return failed(err)
  }
}
