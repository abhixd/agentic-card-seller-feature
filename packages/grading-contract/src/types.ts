// Types for the grading service /grade response — the boundary between the product and grading streams.
// Hand-authored to mirror services/grading-api/contract.py (the source of truth). Regenerate/verify with
// `npm run generate` (json-schema-to-typescript over schema/grade-response.schema.json) and diff.
// Internal `_`-prefixed keys exist on the wire but are NOT part of the contract — hence the index signatures.

export interface ContentRegion {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

/**
 * Test–retest stability probe (grade called with ?stability=1): the card is graded a second time on a
 * label-preserving perturbation (98% resize + JPEG re-encode); delta_pts = the largest centering
 * margin-share move in points. Stable reads ≈1pt; fragile reads (faint sleeve edges) flip 3–29pt while
 * LOOKING confident. `confidence` (0..1 ramp of delta_pts) is already MIN-combined into
 * Centering.confidence — use this block for display/triage detail.
 */
export interface Stability {
  /** null when the probe read was unusable (see error) */
  delta_pts?: number | null;
  confidence?: number | null;
  /** the perturbed read, for display/debugging */
  probe_left_right?: string | null;
  probe_top_bottom?: string | null;
  error?: string | null;
}

export interface Centering {
  /** 1..10 display score */
  score: number;
  /** card-edge → inner-border ratio, e.g. "49/51" */
  left_right: string;
  /** e.g. "60/40" */
  top_bottom: string;
  /** detector self-report; prefer `confidence` once populated */
  reliable: boolean;
  notes?: string;
  content_region?: ContentRegion | null;
  /** 0..1 read reliability (faint-edge / thin-border aware). null until the grading side fills it in. */
  confidence?: number | null;
  /** present only when the grade was requested with ?stability=1 */
  stability?: Stability | null;
  /** present only when PRINT_REG=1 on the grading service and a card identity resolved */
  registration?: Registration | null;
  [internal: string]: unknown;
}

/** Print-registration read (PRINT_REG=1): the identified card's official render SIFT-registered against
 *  the die-cut warp. accepted=true → left_right/top_bottom/content_region come from the registered print
 *  position (sub-pixel; solves full-arts with no detectable inner frame); false → selector read kept. */
export interface Registration {
  accepted: boolean;
  inliers?: number | null;
  matches?: number | null;
  resid_px?: number | null;
  scale?: number | null;
  /** matched pokemontcg.io card id, e.g. "sv3-22" */
  ref_id?: string | null;
  /** why not accepted (gate / vintage / no match / ...) */
  reason?: string | null;
  /** which acceptance gate passed (secondary / rescue-verify) */
  gate?: string | null;
  /** per-candidate attempt log ("cid:ok" / "cid:gate(...)") */
  tried?: string[] | null;
  /** true = outer-anchor rescue relocated the die-cut (cased/sleeved card) */
  outer_corrected?: boolean | null;
  /** per-side (T/B/L/R) photometric confirmability of the rescued cut line, 0..1; low = extrapolated → low confidence */
  cut_edge_support?: Record<string, number> | null;
  /** sides moved inward (px) by the anchored sleeve-overhang tightener (PRINT_REG_TIGHTEN=1) */
  outer_tightened?: Record<string, number> | null;
  /** render-detected print-frame depth per axis (x/y, fractions) — the datum margins are measured from */
  frame_insets?: Record<string, number> | null;
  /** RAG+registration-verified catalog card (id, name, number, set, image) — authoritative identity when accepted */
  ref_card?: Record<string, unknown> | null;
  /** sides moved inward (px) by the gray-zone recovery (1-3% oversize warp, tighten + full re-verify) */
  gray_zone_tightened?: Record<string, number> | null;
  /** bad-warp diagnosis on a failed registration: homography-corrected corners + deviation px */
  rewarp?: Record<string, unknown> | null;
  /** set on an accepted registration produced by the re-warp loop (dev_px corrected, ref_id) */
  rewarped?: Record<string, unknown> | null;
}

export interface Pillar {
  /** 1..10 display score */
  score: number;
  /** 0 none .. 4 heavy */
  worst_severity?: number | null;
}

export interface Issues {
  corners: string[];
  edges: string[];
  surface: string[];
  centering: string[];
}

export interface Defect {
  /** [x, y, w, h] as FRACTIONS of the warped card (0..1, origin top-left) */
  box?: number[] | null;
  /** detector confidence (RF-DETR scratches); may be absent for VLM-detected defects */
  conf?: number | null;
  /** short label, e.g. "scratch" / "whitening" */
  type?: string | null;
  /** artifact | trace | minor | heavy */
  category?: string | null;
  /** region, e.g. "top" / "TL" / "surface" */
  area?: string | null;
  [internal: string]: unknown;
}

export interface DefectBoxes {
  edges: Defect[];
  corners: Defect[];
  surface: Defect[];
}

export interface GradeResponse {
  overall_score?: number | null;
  psa_equivalent?: string | null;
  summary?: string | null;
  centering: Centering;
  corners: Pillar;
  edges: Pillar;
  surface: Pillar;
  issues?: Issues | null;
  /** overall grade confidence */
  confidence?: "low" | "medium" | "high" | null;
  /** per-pillar visual overlays (base64) for click-to-inspect popups:
   *  { centering, edges, surface: string; corners: { TL, TR, BR, BL: string } } */
  pillar_visuals?: {
    centering?: string | null;
    edges?: string | null;
    surface?: string | null;
    corners?: Record<"TL" | "TR" | "BR" | "BL", string> | null;
  } | null;
  /** high-res zoomed close-ups of detected problem areas (present only when /grade is called with
   *  ?zoom=1) — clean crops for the buyer to verify defects before purchase. */
  pillar_zooms?: {
    edges?: Record<string, { crop_b64: string; flagged?: string[] }>;
    surface?: { scratches?: { crop_b64: string; count?: number } };
    corners?: Record<"TL" | "TR" | "BR" | "BL", string> | null;
  } | null;
  /** per-pillar detected defects → outline rectangles over the warped card; box = [x,y,w,h] fractions 0..1.
   *  Sonnet backend fills all pillars (Opus detector); CV backend fills `surface` (RF-DETR scratches). */
  defect_boxes?: DefectBoxes | null;
  /** present when a title/identity is supplied; shape still evolving — treat as opaque for now */
  economics?: Record<string, unknown> | null;
  decision?: Record<string, unknown> | null;
  [internal: string]: unknown;
}
