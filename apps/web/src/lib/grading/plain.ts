/**
 * plain.ts — the jargon-translation layer for the B2C grade reveal.
 *
 * Consumers ask "what grade / what's it worth / should I grade it" — these helpers turn the
 * grader's raw numbers (ratios, confidence floats, defect boxes) into the plain-language answers
 * the redesigned Grade screens show. Exact numbers stay available as tooltips, not headlines.
 */
import type { GradeResult, CardComps, DefectBoxes } from './types'

/** "45/55" + "48/52" → a human read of how centered the card is. */
export function centeringPhrase(leftRight?: string, topBottom?: string): string {
  const dev = (s?: string) => {
    const p = (s ?? '').split('/').map((n) => parseInt(n, 10))
    return p.length === 2 && !p.some(Number.isNaN) ? Math.abs(p[0] - 50) : 0
  }
  const d = Math.max(dev(leftRight), dev(topBottom))
  if (d <= 3) return 'dead centered'
  if (d <= 7) return 'near perfect'
  if (d <= 12) return 'slightly off-center'
  if (d <= 20) return 'noticeably off-center'
  return 'heavily off-center'
}

/** Selector confidence float → a label + tone the UI can color by. */
export function confidencePhrase(conf?: number | null, reliable?: boolean | null): { label: string; tone: 'good' | 'ok' | 'low' } {
  if (reliable === false || (conf != null && conf < 0.6)) return { label: 'low confidence — try a brighter, straight-on photo', tone: 'low' }
  if (conf != null && conf < 0.85) return { label: 'medium confidence', tone: 'ok' }
  return { label: 'high confidence', tone: 'good' }
}

/** One short note per pillar, from the score + what the detectors actually found. */
export function pillarNote(pillar: 'centering' | 'corners' | 'edges' | 'surface', result: GradeResult, liveCentering?: string): string {
  const boxes: DefectBoxes = result.defect_boxes ?? {}
  const n = (a?: unknown[]) => (a ?? []).length
  if (pillar === 'centering') return liveCentering ?? centeringPhrase(result.centering.left_right, result.centering.top_bottom)
  if (pillar === 'corners') {
    const c = n(boxes.corners)
    if (c > 0) return c === 1 ? 'wear on one corner' : `wear on ${c} corners`
    return result.corners.score >= 9 ? 'sharp, all four' : result.corners.score >= 8 ? 'minor softness' : 'wear visible'
  }
  if (pillar === 'edges') {
    const e = n(boxes.edges)
    if (e > 0) return e === 1 ? 'light wear, one spot' : `light wear, ${e} spots`
    return result.edges.score >= 9 ? 'clean all around' : result.edges.score >= 8 ? 'minor whitening' : 'wear visible'
  }
  const s = n(boxes.surface)
  if (s > 0) return s === 1 ? 'one faint mark' : `${s} faint marks`
  return result.surface.score >= 9 ? 'clean' : result.surface.score >= 8 ? 'minor marks' : 'marks visible'
}

export interface Verdict {
  tone: 'success' | 'warning' | 'danger'
  title: string
  detail: string
  gradedValue: number | null
  rawValue: number | null
}

/** PSA Value-tier fee — keep in sync with the GradingReference table. */
export const PSA_FEE = 18

/**
 * The money sentence. With comps: real dollars (graded value at this grade − raw − fee).
 * Without comps: honest qualitative guidance from the grade + confidence alone.
 */
export function verdict(grade: number, conf: number | null | undefined, comps?: CardComps | null): Verdict {
  const g = comps?.grades?.[String(grade)]
  const gradedValue = g?.smartPrice ?? g?.medianPrice ?? g?.marketPrice7Day ?? null
  const rawValue = comps?.raw?.market ?? null

  if (gradedValue != null && rawValue != null) {
    const net = Math.round(gradedValue - rawValue - PSA_FEE)
    if (net >= 15) return { tone: 'success', title: 'Worth grading.', detail: `About +$${net} after PSA's $${PSA_FEE} fee.`, gradedValue, rawValue }
    if (net >= 0) return { tone: 'warning', title: 'Borderline.', detail: `Roughly breaks even after PSA's $${PSA_FEE} fee.`, gradedValue, rawValue }
    return { tone: 'danger', title: 'Skip grading.', detail: `Fees likely exceed the value bump (${net >= 0 ? '+' : '−'}$${Math.abs(net)}).`, gradedValue, rawValue }
  }

  if (grade >= 9) return { tone: 'success', title: 'Strong grading candidate.', detail: `High grade — cards like this usually clear the $${PSA_FEE} fee.`, gradedValue, rawValue }
  if (grade >= 7) return { tone: 'warning', title: 'Borderline.', detail: `At PSA ${grade}, the grading fee may outweigh the value bump.`, gradedValue, rawValue }
  return { tone: 'danger', title: 'Skip grading.', detail: 'Condition caps the grade — fees likely exceed the bump.', gradedValue, rawValue }
}

/** "PSA 9 GEM-MT"-style label → the short badge word under the big number. */
export function badgeWord(grade: number): string {
  if (grade >= 10) return 'GEM MINT'
  if (grade >= 9) return 'MINT'
  if (grade >= 8) return 'NM-MT'
  if (grade >= 7) return 'NEAR MINT'
  if (grade >= 6) return 'EX-MT'
  if (grade >= 5) return 'EXCELLENT'
  return 'PLAYED'
}
