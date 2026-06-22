import type { GradeResponse } from "@acs/grading-contract";

/**
 * Canned, contract-shaped grading fixture so the product can be developed without
 * the (heavy Python/CV) grading service. Importing the type means this mock cannot
 * drift from the contract. Selected via `GRADING_API_URL=mock` in the /grade route.
 */
export function mockGrade(): GradeResponse {
  return {
    overall_score: 9,
    psa_equivalent: "PSA 9 MINT",
    summary: "mock",
    centering: { score: 7, left_right: "52/48", top_bottom: "60/40", reliable: true, confidence: 0.8 },
    corners: { score: 9, worst_severity: 1 },
    edges: { score: 9, worst_severity: 1 },
    surface: { score: 10, worst_severity: 0 },
    issues: { corners: [], edges: [], surface: [], centering: [] },
    confidence: "high",
  };
}
