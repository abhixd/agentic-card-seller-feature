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
  [internal: string]: unknown;
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
  /** present when a title/identity is supplied; shape still evolving — treat as opaque for now */
  economics?: Record<string, unknown> | null;
  decision?: Record<string, unknown> | null;
  [internal: string]: unknown;
}
