import type { RecommendationInput, RecommendationOutput } from '@/types/analysis'

// Thresholds — centralised so tests and the service use the same values
export const THRESHOLDS = {
  MIN_ID_CONFIDENCE:   0.5,   // below this → INSUFFICIENT_CONFIDENCE
  MIN_COMP_CONFIDENCE: 0.3,   // below this → INSUFFICIENT_CONFIDENCE
  MIN_COMP_COUNT:      3,     // below this → INSUFFICIENT_CONFIDENCE
  STALE_DAYS:          90,    // above this with sparse comps → HOLD
  STALE_MIN_COMPS:     8,     // comp count considered "sparse" for staleness check
  MIN_VALUE_FOR_GRADE: 20,    // below this raw estimate → SELL_RAW regardless
  LOW_VALUE_CEILING:   15,    // below this → definitely SELL_RAW
  MIN_CONDITION_GRADE: 16,    // condition score (4–20) needed to recommend grading
  MARGINAL_GRADE_MIN:  30,    // min raw estimate for marginal grade recommendation
}

export function generateRecommendation(input: RecommendationInput): RecommendationOutput {
  const {
    identificationConfidence,
    compsConfidence,
    compCount,
    rawEstimate,
    netProceedsRaw,
    conditionScore,
    bestGradingScenario,
    daysOfData,
  } = input

  // ── Gate 1: Card identification quality ─────────────────────────────────
  if (identificationConfidence < THRESHOLDS.MIN_ID_CONFIDENCE) {
    return {
      type: 'INSUFFICIENT_CONFIDENCE',
      rationale:
        'Card identification confidence is too low to generate a reliable recommendation. ' +
        'Try a clearer image or use manual search.',
    }
  }

  // ── Gate 2: Market data quality ──────────────────────────────────────────
  if (compCount < THRESHOLDS.MIN_COMP_COUNT || compsConfidence < THRESHOLDS.MIN_COMP_CONFIDENCE) {
    return {
      type: 'INSUFFICIENT_CONFIDENCE',
      rationale:
        `Only ${compCount} recent sale${compCount === 1 ? '' : 's'} found. ` +
        'Not enough market data to make a confident recommendation.',
    }
  }

  // ── Gate 3: Stale / sparse market → HOLD ────────────────────────────────
  if (daysOfData > THRESHOLDS.STALE_DAYS && compCount < THRESHOLDS.STALE_MIN_COMPS) {
    return {
      type: 'HOLD',
      rationale:
        `Sales data is sparse (${compCount} comps over ${daysOfData} days). ` +
        'Market conditions may be shifting — wait for fresher price signals.',
    }
  }

  // ── Gate 4: Very low value — grading is never economical ─────────────────
  if (rawEstimate < THRESHOLDS.LOW_VALUE_CEILING) {
    return {
      type: 'SELL_RAW',
      rationale:
        `Raw estimate of $${rawEstimate.toFixed(2)} is below the minimum grading fee threshold. ` +
        'Selling raw now is the best option.',
    }
  }

  // ── Gate 5: GRADE — strong case ─────────────────────────────────────────
  const effectiveCondition  = conditionScore ?? 14
  const conditionOk         = effectiveCondition >= THRESHOLDS.MIN_CONDITION_GRADE
  const conditionWarning    = conditionScore === null
    ? ' (Condition not entered — verify before submitting.)'
    : ''

  if (
    bestGradingScenario?.recommendation === 'strong' &&
    conditionOk &&
    rawEstimate >= THRESHOLDS.MIN_VALUE_FOR_GRADE
  ) {
    const upside = bestGradingScenario.netUpsideVsRawSell
    return {
      type: 'GRADE',
      rationale:
        `Strong condition (${effectiveCondition}/20) and ~$${upside.toFixed(0)} net upside after ` +
        `grading fees make submitting for ${bestGradingScenario.tierLabel} worthwhile.${conditionWarning}`,
    }
  }

  // ── Gate 6: GRADE — marginal case ───────────────────────────────────────
  if (
    bestGradingScenario?.recommendation === 'marginal' &&
    conditionOk &&
    rawEstimate >= THRESHOLDS.MARGINAL_GRADE_MIN
  ) {
    const upside = bestGradingScenario.netUpsideVsRawSell
    return {
      type: 'GRADE',
      rationale:
        `Condition (${effectiveCondition}/20) and marginal ~$${upside.toFixed(0)} upside suggest ` +
        'grading may be worthwhile — verify condition carefully before submitting.',
    }
  }

  // ── Default: SELL_RAW ────────────────────────────────────────────────────
  const priceNote =
    rawEstimate > 0
      ? ` Raw comps estimate $${rawEstimate.toFixed(2)}, net ~$${netProceedsRaw.toFixed(2)} after fees.`
      : ''

  const gradingNote =
    bestGradingScenario?.recommendation === 'negative'
      ? ' Grading upside does not justify the cost at this price point.'
      : conditionScore !== null && conditionScore < THRESHOLDS.MIN_CONDITION_GRADE
      ? ' Condition score does not support a grading attempt.'
      : ''

  return {
    type: 'SELL_RAW',
    rationale: (priceNote + gradingNote).trim() || 'Sell raw is the best action based on current market data.',
  }
}
