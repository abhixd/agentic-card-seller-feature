/**
 * Shape of the /grade response from the grading microservice (services/grading-api).
 * Mirrors backend cv_grader.grade_card_cv() — the same payload the Chrome extension
 * consumes, so the web grading UI and the extension stay in lockstep.
 */
export interface PillarScore {
  score: number
  worst_severity?: number
}

export interface CenteringBox {
  x1: number
  y1: number
  x2: number
  y2: number
}

export interface CenteringResult {
  score: number
  left_right: string      // e.g. "55/45"
  top_bottom: string
  reliable?: boolean
  confidence?: number     // 0..1 graded reliability (min of selector / geometry / stability signals)
  content_region?: CenteringBox   // inner printed-border rect, normalized to the warped image
  notes?: string
  /** which method produced the read: "print_reg" (registration) | "perside" | "coherentframe" */
  _source?: string
  /** test–retest probe (grade requested with ?stability=1) */
  stability?: {
    delta_pts?: number | null
    confidence?: number | null
    probe_left_right?: string | null
    probe_top_bottom?: string | null
    note?: string | null
    error?: string | null
  } | null
  /** print-registration attempt against the official render (grading service PRINT_REG=1) */
  registration?: {
    accepted?: boolean
    inliers?: number | null
    matches?: number | null
    resid_px?: number | null
    scale?: number | null
    ref_id?: string | null
    reason?: string | null
    gate?: string | null
    tried?: string[] | null
    /** true = outer-anchor rescue relocated the die-cut (cased/sleeved card) */
    outer_corrected?: boolean | null
    /** per-side (T/B/L/R) photometric confirmability of the rescued cut line, 0..1 */
    cut_edge_support?: Record<string, number> | null
    /** sides moved inward (px) by the anchored sleeve-overhang tightener */
    outer_tightened?: Record<string, number> | null
  } | null
}

/** Per-pillar overlay images (base64 jpeg) for click-to-inspect popups (contract v1.1.0). */
export interface PillarVisuals {
  centering?: string | null
  edges?: string | null
  surface?: string | null
  corners?: Partial<Record<'TL' | 'TR' | 'BR' | 'BL', string>> | null
}

/** High-res zoomed defect close-ups (contract v1.2.0) — present only when /grade is called with ?zoom=1.
 * Clean crops (no overlay) so the buyer judges the actual pixels; `flagged` is an advisory hint. */
export interface PillarZooms {
  edges?: Record<string, { crop_b64: string; flagged?: string[] }>   // keyed by side: top|right|bottom|left
  surface?: { scratches?: { crop_b64: string; count?: number } }
  corners?: Partial<Record<'TL' | 'TR' | 'BR' | 'BL', string>> | null
}

export interface SurfaceDefect {
  box?: number[] | null    // [x, y, w, h] as fractions of the warped image (0..1, top-left origin)
  conf?: number | null     // detector confidence (RF-DETR scratch)
  type?: string | null
  category?: string | null
}

export interface DefectBoxes {
  edges?: SurfaceDefect[]
  corners?: SurfaceDefect[]
  surface?: SurfaceDefect[]
}

export interface GradeResult {
  overall_score: number          // 1–10
  psa_equivalent: string         // e.g. "PSA 9 MINT"
  summary: string
  centering: CenteringResult
  corners: PillarScore
  edges: PillarScore
  surface: PillarScore
  issues?: string[]
  // debug / extras (underscore-prefixed) — optional, safe to ignore in the UI
  _tier_distribution?: Record<string, number>
  _confidence?: string           // "high" | "medium" | "low"
  _grader_backend?: string       // "cv"
  _warped_jpeg_b64?: string
  _card_boundary?: number[]      // outer card-edge rect [x1,y1,x2,y2], normalized to the warped image
  _border_type?: string          // detected printed-border style (e.g. "dragon", "yellow")
  pillar_visuals?: PillarVisuals  // per-pillar overlay images for click-to-inspect popups
  pillar_zooms?: PillarZooms      // high-res defect close-ups (present only with ?zoom=1)
  defect_boxes?: DefectBoxes | null  // per-pillar detected defects; surface = RF-DETR scratches (for overlay)
  [key: string]: unknown
}

/**
 * Card identity from vision-ID (grading service identify.py, surfaced via /scout).
 * `name/set/number/year/variant/language/title/confidence` come straight from the vision read;
 * `rarity` is enriched from comps (pokemontcg/PPT). All fields nullable — the card may be unreadable.
 */
export interface CardIdentity {
  name?: string | null
  set?: string | null
  number?: string | null
  year?: number | null
  variant?: string | null
  language?: string | null
  title?: string | null
  rarity?: string | null
  confidence?: number | null     // 0..1 identification confidence
  estimated?: boolean
}

/** Market/comps detail for the card profile (from the /scout `comps_detail` field). */
export interface CardComps {
  card?: { name?: string; setName?: string; cardNumber?: string; rarity?: string; tcgPlayerUrl?: string; imageCdnUrl?: string }
  raw?: { market?: number; low?: number; sellers?: number; lastUpdated?: string }
  grades?: Record<string, {
    count?: number; medianPrice?: number; marketPrice7Day?: number
    minPrice?: number; maxPrice?: number; marketTrend?: string
    smartPrice?: number; smartConfidence?: string
  }>
}

/** Everything the clickable card profile popup shows — identity + comps + a card thumbnail. */
export interface CardProfile {
  identity: CardIdentity
  comps?: CardComps | null
  thumb_b64?: string | null      // warped-card thumbnail (raw base64, no `data:` prefix)
}
