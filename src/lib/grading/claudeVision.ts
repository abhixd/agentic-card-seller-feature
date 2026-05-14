/**
 * claudeVision.ts
 *
 * Replaces the Python MLP backend for grade estimation.
 * Sends card images to Claude Vision and parses a structured
 * JSON response that matches the existing AnalyzeListingResponse schema.
 */

import Anthropic from '@anthropic-ai/sdk'

// ── Types ─────────────────────────────────────────────────────────

export interface CardIdentity {
  name:   string
  set:    string
  year:   string
  number: string
}

export interface GradeEstimate {
  grade_range:  string
  confidence:   'high' | 'medium' | 'low'
  distribution: Record<string, number>  // "1"–"10" → probability
}

export interface ImageQuality {
  status:   'good' | 'fair' | 'poor'
  warnings: string[]
}

export interface ClaudeGradingResult {
  card_identity:  CardIdentity
  grade_estimate: GradeEstimate
  issues:         string[]
  image_quality:  ImageQuality
}

// ── Prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert PSA card grader specializing in Pokémon trading cards.
Your job is to examine card images and estimate what PSA grade the card would receive.

PSA Grade Reference:
- PSA 10 Gem Mint:   Perfect centering (55/45 or better), four razor-sharp corners, no print defects, full original gloss
- PSA 9  Mint:       Near-perfect, slight wear allowed on 1-2 corners, well-centred, minor print spots
- PSA 8  NM-MT:      Light wear on 3+ corners or edges, may have very light scratches
- PSA 7  NM:         Slight corner/edge wear visible, possible light scratches, minor print defects
- PSA 6  EX-MT:      Moderate corner wear, light scratches, slight edge fraying
- PSA 5  EX:         Heavy corner wear, noticeable scratches, obvious edge nicks
- PSA 4  VG-EX:      Obvious wear throughout, possible light crease
- PSA 3  VG:         Heavy wear, possible creases, staining
- PSA 2  Good:       Creases, heavy staining, major defects
- PSA 1  Poor:       Severe damage, missing pieces, heavy creases

Examine these areas in order:
1. CORNERS — check each corner (TL, TR, BL, BR) for whitening, fraying, rounding
2. EDGES   — check all four edges for nicks, chips, whitening
3. CENTERING — estimate left/right and top/bottom split (e.g. "60/40 L/R")
4. SURFACE — scratches, print lines, holo damage, staining, indentations
5. CARD IDENTITY — read the card name, set, year, and collector number from the image

Important notes:
- If only one image is provided assume it is the front; note missing back reduces confidence
- eBay listing photos are often taken at an angle or with slight glare; account for this
- Pokémon cards from 1999-2003 (Base Set through Skyridge) are printed differently from modern cards; adjust expectations accordingly
- Holo cards must have intact holo pattern with no scratches to achieve PSA 9+

Respond ONLY with a single valid JSON object — no markdown, no explanation, no extra text.`

const USER_PROMPT = `Analyze this Pokémon card and return your assessment as JSON with exactly this structure:

{
  "card_identity": {
    "name":   "Charizard",
    "set":    "Base Set",
    "year":   "1999",
    "number": "4"
  },
  "grade_estimate": {
    "grade_range":  "PSA 7-8",
    "confidence":   "high",
    "distribution": {
      "1": 0.00, "2": 0.00, "3": 0.01, "4": 0.02, "5": 0.04,
      "6": 0.08, "7": 0.30, "8": 0.40, "9": 0.12, "10": 0.03
    }
  },
  "issues": [
    "Light corner whitening on top-left and top-right",
    "Minor edge nick on right edge"
  ],
  "image_quality": {
    "status":   "good",
    "warnings": []
  }
}

Rules:
- distribution values must sum to 1.0 (±0.01)
- confidence is "high" when top-2 PSA grades account for >60% probability
- confidence is "medium" when top-2 grades account for 40-60%
- confidence is "low" when image is blurry, small, or too angled to assess
- issues should be specific and actionable (mention which corner/edge)
- if the back image is missing add "back image missing — confidence reduced" to warnings
- if you cannot read the card identity from the image use empty strings`

// ── Main function ─────────────────────────────────────────────────

export async function gradeWithClaude(
  imageUrls: string[],
  title:     string,
): Promise<ClaudeGradingResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const client = new Anthropic({ apiKey })

  // Build image content blocks — Claude accepts up to 20 images
  const imageBlocks: Anthropic.ImageBlockParam[] = imageUrls
    .slice(0, 6)
    .map(url => ({
      type:   'image',
      source: { type: 'url', url },
    }))

  // Include the listing title as a hint for card identity
  const textHint: Anthropic.TextBlockParam = {
    type: 'text',
    text: `Listing title (use as identity hint, but trust the image over the title): "${title}"\n\n${USER_PROMPT}`,
  }

  const response = await client.messages.create({
    model:      'claude-haiku-4-5',
    max_tokens: 1024,
    system:     SYSTEM_PROMPT,
    messages: [
      {
        role:    'user',
        content: [...imageBlocks, textHint],
      },
    ],
  })

  const raw = response.content
    .filter(b => b.type === 'text')
    .map(b => (b as Anthropic.TextBlock).text)
    .join('')
    .trim()

  // Strip accidental markdown code fences
  const json = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()

  let parsed: ClaudeGradingResult
  try {
    parsed = JSON.parse(json)
  } catch {
    throw new Error(`Claude returned non-JSON response: ${raw.slice(0, 200)}`)
  }

  // Normalise distribution so it sums to exactly 1.0
  const dist  = parsed.grade_estimate.distribution
  const total = Object.values(dist).reduce((s, v) => s + v, 0)
  if (total > 0 && Math.abs(total - 1) > 0.02) {
    for (const k of Object.keys(dist)) dist[k] = dist[k] / total
  }

  return parsed
}
