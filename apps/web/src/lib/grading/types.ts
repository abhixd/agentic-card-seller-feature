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
