/**
 * score.ts — client-side recompute of the grade when the user corrects centering, so the
 * numbers move the instant a border handle is dragged (no round-trip / re-grade).
 *
 * These mirror the server EXACTLY (services/grading-api):
 *   - centering ladder  → cv_grader._centering_score
 *   - overall linear model + PSA label → aggregator.aggregate_overall / psa_label
 * Keep them in sync if the Python changes (they're stable; weights live in grade_model.json).
 */

export type Box = { x1: number; y1: number; x2: number; y2: number }
export type Pillars = { centering: number; corners: number; edges: number; surface: number }

// Stage-B linear model from grade_model.json (pillar scores → overall 1–10).
const OVERALL_INTERCEPT = 3.027174
const OVERALL_WEIGHTS: Pillars = { centering: 0.384737, corners: 0.158582, edges: 0.296989, surface: -0.1087 }
const PSA_NAMES: Record<number, string> = {
  10: 'Gem Mint', 9: 'Mint', 8: 'NM-MT', 7: 'NM', 6: 'EX-MT', 5: 'EX', 4: 'VG-EX', 3: 'VG', 2: 'Good', 1: 'Poor',
}

/** Left/Right + Top/Bottom integer percentages from an inner box vs the card boundary. */
export function ratiosFromBox(cr: Box, cb: number[]): { lr: number; tb: number } {
  const lw = cr.x1 - cb[0], rw = cb[2] - cr.x2
  const tw = cr.y1 - cb[1], bw = cb[3] - cr.y2
  const lr = lw + rw > 1e-6 ? Math.round((lw / (lw + rw)) * 100) : 50
  const tb = tw + bw > 1e-6 ? Math.round((tw / (tw + bw)) * 100) : 50
  return { lr, tb }
}

/** Worst-axis deviation → 1–10 centering score (matches cv_grader._centering_score). */
export function centeringScore(lr: number, tb: number): number {
  const worst = Math.max(Math.abs(lr - 50), Math.abs(tb - 50))
  const ladder: [number, number][] = [[5, 10], [10, 9], [15, 8], [20, 7], [25, 6], [30, 5], [35, 4], [40, 3], [45, 2]]
  for (const [thr, s] of ladder) if (worst <= thr) return s
  return 1
}

/** Pillar scores → overall 1–10 (matches aggregator.aggregate_overall). */
export function overallScore(p: Pillars): number {
  let g = OVERALL_INTERCEPT
  ;(Object.keys(OVERALL_WEIGHTS) as (keyof Pillars)[]).forEach((k) => { g += OVERALL_WEIGHTS[k] * p[k] })
  return Math.max(1, Math.min(10, Math.round(g * 10) / 10))
}

/** Overall → "PSA 9 Mint" (matches aggregator.psa_label). */
export function psaLabel(overall: number): string {
  const g = Math.max(1, Math.min(10, Math.round(overall)))
  return `PSA ${g} ${PSA_NAMES[g] ?? ''}`.trim()
}
