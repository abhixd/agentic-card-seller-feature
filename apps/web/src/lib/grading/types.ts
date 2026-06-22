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
  confidence?: number     // 0..1 graded reliability (min per-side P)
  content_region?: CenteringBox   // inner printed-border rect, normalized to the warped image
  notes?: string
}

/** Per-pillar overlay images (base64 jpeg) for click-to-inspect popups (contract v1.1.0). */
export interface PillarVisuals {
  centering?: string | null
  edges?: string | null
  surface?: string | null
  corners?: Partial<Record<'TL' | 'TR' | 'BR' | 'BL', string>> | null
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
