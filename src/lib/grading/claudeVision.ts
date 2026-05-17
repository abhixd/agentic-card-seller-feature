/**
 * claudeVision.ts
 *
 * Phase 1 CV-assisted grading pipeline:
 *
 *  1. runCVDetectors()   — download first image, compute blur/glare/brightness
 *  2. fetchResized()     — download + sharp-resize first image to ≤1024px
 *     (runs in parallel with step 1 — same network cost, no extra round-trip)
 *  3. Build Claude prompt — CV measurements injected before grading instructions
 *  4. gradeWithClaude()  — Claude Haiku sees CV data + image, returns structured JSON
 *
 * Why resize?
 *   Anthropic caps images at 1568px internally; eBay photos are often 1600–3000px.
 *   Resizing to ≤1024px cuts input tokens ~50–70% with no grading-relevant detail loss.
 *
 * Why not white-balance?
 *   Gray-world WB destroys diagnostic colour info (yellowing, fading, staining).
 *   Claude should see the card's actual colour, not a normalised version.
 */

import Anthropic from '@anthropic-ai/sdk'
import sharp from 'sharp'
import { runCVDetectors, formatCVSection } from './cvDetectors'

// ── Types ─────────────────────────────────────────────────────────

export interface CardIdentity {
  name:       string | null
  set:        string | null
  year:       string | null
  number:     string | null
  confidence: 'high' | 'medium' | 'low'
}

export interface GradeEstimate {
  grade_range:      string
  confidence:       'high' | 'medium' | 'low'
  distribution:     Record<string, number>  // "1"–"10" → probability
  limiting_factor:  'front_only' | 'image_quality' | 'visible_damage' | null
}

export interface ImageQuality {
  status:            'good' | 'partial' | 'poor'
  warnings:          string[]
  front_present:     boolean
  back_present:      boolean
  centering_visible: boolean
  corners_visible:   boolean
  edges_visible:     boolean
  surface_visible:   boolean
}

export interface CardIssues {
  centering: string[]
  corners:   string[]
  edges:     string[]
  surface:   string[]
  other:     string[]
}

/** Issues and centering assessment for one side of the card. */
export interface SideAnalysis {
  assessable: boolean        // false when images for this side are absent/unusable
  centering:  string | null  // e.g. "58/42 L/R, 54/46 T/B"; null if not visible
  issues:     CardIssues
}

export interface GradingDecision {
  gradable_candidate: 'yes' | 'maybe' | 'no'
  reason:             string
  caveats:            string[]  // explicit warnings, e.g. "back image missing"
}

export interface ClaudeGradingResult {
  analysis_mode:    'front_only' | 'front_back'
  card_identity:    CardIdentity
  image_quality:    ImageQuality
  front_analysis:   SideAnalysis
  back_analysis:    SideAnalysis
  grade_estimate:   GradeEstimate
  issues:           CardIssues   // combined worst-case from front + back
  grading_decision: GradingDecision
}

// ── Prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert PSA pre-grading assistant specializing in Pokémon trading cards.

Your task is to estimate the plausible PSA grade range supported by the visible evidence. You are not guaranteeing a final PSA grade.

Core principles:
- Base your assessment only on what is actually visible in the images.
- Never assume unseen areas are clean.
- If glare, blur, angle, cropping, sleeve reflections, compression, or low resolution hide details, reduce confidence and mention the limitation.
- When evidence is incomplete, prefer a wider grade range and lower confidence.
- Distinguish between: (1) visible defects and (2) unknowns caused by image limitations.

Evaluate in this order:
1. IMAGE CLASSIFICATION — label each image as "front", "back", or "other" based on visible content. The front shows the card artwork; the back shows the Pokémon logo / back design.
2. FRONT ANALYSIS — if a front image is present, assess separately:
   - Centering: estimate L/R and T/B border split
   - Corners: TL, TR, BL, BR — whitening, fraying, rounding
   - Edges: top, bottom, left, right — nicks, chips, whitening
   - Surface: scratches, print lines, holo damage, staining, gloss loss
3. BACK ANALYSIS — if a back image is present, assess separately:
   - Centering: estimate L/R and T/B border split
   - Corners: TL, TR, BL, BR
   - Edges: top, bottom, left, right
   - Surface: print quality, scratches, staining
4. COMBINED GRADE — derive the final grade_estimate and combined issues from the worst-case evidence across both sides.
5. CARD IDENTITY — identify name/set/year/number from the front image only.

PSA grade guidance:
- PSA 10 Gem Mint: near-perfect, centering ~55/45 or better on front, four sharp corners, no visible defects, full gloss
- PSA 9  Mint: slight visible wear allowed, minor issues possible, strong overall presentation
- PSA 8  NM-MT: light corner/edge wear, possible very light scratches or print issues
- PSA 7  NM: visible but not severe corner/edge wear, possible light scratches or minor print defects
- PSA 6  EX-MT and below: increasingly obvious wear, scratches, edge damage, staining, creasing, or major defects

Front-only rule (CRITICAL):
- If no back image is identifiable, set analysis_mode to "front_only"
- Set back_analysis.assessable to false and leave all back_analysis issue arrays empty
- Set grade_estimate.confidence to "low" regardless of front image quality
- Set grade_estimate.limiting_factor to "front_only"
- Add exactly this string to grading_decision.caveats: "Back image not provided — rear corner whitening, edge wear, and back centering cannot be assessed. Grade confidence is limited to low."
- Do NOT speculate about the back condition

Other special instructions:
- Do not double-count the same defect across front and back.
- Vintage Pokémon cards (1999–2003) should be judged with awareness of era, but never use era to override visible evidence.
- Holo surface must be treated conservatively when glare or angle prevents reliable inspection.
- Do not overclaim PSA 9 or PSA 10 when image quality is limited.

Respond ONLY with one valid JSON object. No markdown, no prose outside JSON.

Every "issues" object must use exactly these keys: centering, corners, edges, surface, other.
Each maps to an array of strings. Use [] when nothing is visible for that category.

Allowed values:
- "analysis_mode": "front_only" or "front_back"
- "image_quality.status": "good", "partial", or "poor"
- "card_identity.confidence": "high", "medium", or "low"
- "grade_estimate.confidence": "high", "medium", or "low"
- "grade_estimate.limiting_factor": "front_only", "image_quality", "visible_damage", or null
- "grading_decision.gradable_candidate": "yes", "maybe", or "no"
- "front_analysis.assessable" / "back_analysis.assessable": true or false

If a card_identity field is uncertain, use null rather than guessing.`

const USER_PROMPT = `Analyze this Pokémon card from the provided image set and return JSON with EXACTLY this structure.

Example when both front and back are present:
{
  "analysis_mode": "front_back",
  "card_identity": {
    "name":       "Charizard",
    "set":        "Base Set",
    "year":       "1999",
    "number":     "4",
    "confidence": "high"
  },
  "image_quality": {
    "status":            "good",
    "warnings":          [],
    "front_present":     true,
    "back_present":      true,
    "centering_visible": true,
    "corners_visible":   true,
    "edges_visible":     true,
    "surface_visible":   true
  },
  "front_analysis": {
    "assessable": true,
    "centering":  "58/42 L/R, 54/46 T/B",
    "issues": {
      "centering": ["Slightly left-heavy, approximately 58/42 L/R"],
      "corners":   ["Light whitening on top-right corner"],
      "edges":     [],
      "surface":   ["Faint holo scratches visible at angle"],
      "other":     []
    }
  },
  "back_analysis": {
    "assessable": true,
    "centering":  "50/50 L/R, 51/49 T/B",
    "issues": {
      "centering": [],
      "corners":   [],
      "edges":     ["Minor whitening on bottom edge"],
      "surface":   [],
      "other":     []
    }
  },
  "grade_estimate": {
    "grade_range":     "PSA 7-8",
    "confidence":      "high",
    "limiting_factor": "visible_damage",
    "distribution": {
      "1": 0.00, "2": 0.00, "3": 0.01, "4": 0.02, "5": 0.04,
      "6": 0.08, "7": 0.30, "8": 0.40, "9": 0.12, "10": 0.03
    }
  },
  "issues": {
    "centering": ["Slightly left-heavy front (58/42 L/R)"],
    "corners":   ["Light whitening on top-right corner (front)"],
    "edges":     ["Minor whitening on bottom edge (back)"],
    "surface":   ["Faint holo scratches visible at angle (front)"],
    "other":     []
  },
  "grading_decision": {
    "gradable_candidate": "maybe",
    "reason": "Card shows light wear consistent with PSA 7-8. Holo scratches are the primary concern.",
    "caveats": []
  }
}

Example when only the front is present (front_only):
{
  "analysis_mode": "front_only",
  "card_identity": { "name": null, "set": null, "year": null, "number": null, "confidence": "low" },
  "image_quality": {
    "status": "partial", "warnings": [], "front_present": true, "back_present": false,
    "centering_visible": true, "corners_visible": true, "edges_visible": true, "surface_visible": false
  },
  "front_analysis": {
    "assessable": true,
    "centering": "55/45 L/R, 53/47 T/B",
    "issues": { "centering": [], "corners": [], "edges": [], "surface": [], "other": [] }
  },
  "back_analysis": {
    "assessable": false,
    "centering": null,
    "issues": { "centering": [], "corners": [], "edges": [], "surface": [], "other": [] }
  },
  "grade_estimate": {
    "grade_range": "PSA 7-9", "confidence": "low", "limiting_factor": "front_only",
    "distribution": {
      "1": 0.00, "2": 0.00, "3": 0.01, "4": 0.02, "5": 0.05,
      "6": 0.10, "7": 0.22, "8": 0.30, "9": 0.22, "10": 0.08
    }
  },
  "issues": { "centering": [], "corners": [], "edges": [], "surface": [], "other": [] },
  "grading_decision": {
    "gradable_candidate": "maybe",
    "reason": "Front appears reasonably clean but back is not available for assessment.",
    "caveats": ["Back image not provided — rear corner whitening, edge wear, and back centering cannot be assessed. Grade confidence is limited to low."]
  }
}

Rules:
- Output exactly one JSON object. Use exactly the top-level keys shown above.
- front_analysis and back_analysis each have their own "issues" object for per-side defects.
- "issues" at the top level is the COMBINED worst-case from both sides. Tag each item with "(front)" or "(back)".
- Do not guess hidden defects. Only report what is actually visible.
- If the back is missing: set analysis_mode "front_only", back_analysis.assessable false, grade confidence "low", limiting_factor "front_only", and add the caveat string exactly as shown.
- If glare/blur/angle limits visibility, mention in image_quality.warnings and the relevant side analysis.
- Use a wider grade range and lower confidence when evidence is incomplete.
- Be conservative about PSA 9 and PSA 10 if surface or back visibility is limited.
- Distribution values must sum approximately to 1.00.
- confidence "high": top-2 PSA grades >60% of mass. "medium": 40–60%. "low": image too limited.`

// ── Image fetch + resize helper ───────────────────────────────────

/**
 * Download one image URL and resize to ≤1024px (longest edge), JPEG q85.
 * Returns null on any failure — caller falls back to passing the URL to Claude.
 *
 * Why not white-balance: see module docstring.
 * Why not aspect-pad: adds black bars, wastes tokens, assumes card is cropped.
 */
async function fetchResized(url: string): Promise<{ base64: string; mimeType: 'image/jpeg' } | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(8_000) })
    if (!res.ok) return null
    const raw     = Buffer.from(await res.arrayBuffer())
    const resized = await sharp(raw)
      .resize(1024, 1024, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer()
    return { base64: resized.toString('base64'), mimeType: 'image/jpeg' }
  } catch {
    return null
  }
}

// ── Main function ─────────────────────────────────────────────────

export async function gradeWithClaude(
  imageUrls: string[],
  title:     string,
): Promise<ClaudeGradingResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set')

  const client = new Anthropic({ apiKey })

  // ── Step 1 + 2: CV detectors & image resize run in parallel ──────
  // Both need to download image[0]; running concurrently avoids a second
  // sequential network round-trip.
  const [cv, resized] = await Promise.all([
    runCVDetectors(imageUrls),
    fetchResized(imageUrls[0]),
  ])

  // ── Step 3: Build image content blocks ───────────────────────────
  // Image 0: use resized base64 if available (fewer tokens), else URL.
  // Images 1-5: pass as URLs (Claude resizes them internally).
  const imageBlocks: Anthropic.ImageBlockParam[] = []

  if (resized) {
    imageBlocks.push({
      type:   'image',
      source: { type: 'base64', media_type: resized.mimeType, data: resized.base64 },
    })
  } else if (imageUrls[0]) {
    imageBlocks.push({
      type:   'image',
      source: { type: 'url', url: imageUrls[0] },
    })
  }

  for (const url of imageUrls.slice(1, 6)) {
    imageBlocks.push({ type: 'image', source: { type: 'url', url } })
  }

  // ── Step 4: Build prompt — CV section prepended ───────────────────
  // formatCVSection() returns '' when cv is null (soft failure), so the
  // prompt degrades gracefully with no CV data.
  const cvSection = formatCVSection(cv)

  const textHint: Anthropic.TextBlockParam = {
    type: 'text',
    text: `${cvSection}Listing title (use as identity hint, but trust the image over the title): "${title}"\n\n${USER_PROMPT}`,
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
