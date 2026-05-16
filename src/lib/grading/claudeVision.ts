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
  grade_range:  string
  confidence:   'high' | 'medium' | 'low'
  distribution: Record<string, number>  // "1"–"10" → probability
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

export interface GradingDecision {
  gradable_candidate: 'yes' | 'maybe' | 'no'
  reason:             string
}

export interface ClaudeGradingResult {
  analysis_mode:    'front_only' | 'front_back'
  card_identity:    CardIdentity
  image_quality:    ImageQuality
  grade_estimate:   GradeEstimate
  issues:           CardIssues
  grading_decision: GradingDecision
}

// ── Prompt ────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are an expert PSA pre-grading assistant specializing in Pokémon trading cards.

Your task is to estimate the plausible PSA grade range supported by the visible evidence in the provided images. You are not guaranteeing a final PSA grade.

Core principles:
- Base your assessment only on what is actually visible in the images.
- Never assume unseen areas are clean.
- If the back is missing, explicitly note that rear whitening / edge wear / back centering cannot be fully assessed.
- If glare, blur, angle, cropping, sleeve reflections, compression, or low resolution hide details, reduce confidence and mention the limitation.
- When evidence is incomplete, prefer a wider grade range and lower confidence.
- Distinguish between: (1) visible defects and (2) unknowns caused by image limitations.

Evaluate in this order:
1. IMAGE ASSESSABILITY — determine whether front/back are present and whether corners, edges, centering, and surface can be evaluated reliably
2. CORNERS — top-left, top-right, bottom-left, bottom-right for whitening, fraying, rounding
3. EDGES — all four edges for nicks, chips, whitening
4. CENTERING — estimate left/right and top/bottom split only if visible enough
5. SURFACE — scratches, print lines, holo damage, staining, indentations, gloss loss, only if visible enough
6. CARD IDENTITY — identify card name/set/year/number only if reasonably supported by the image

PSA grade guidance:
- PSA 10 Gem Mint: near-perfect visible condition, centering roughly 55/45 or better on front, four sharp corners, no visible print/surface defects, full gloss
- PSA 9  Mint: slight visible wear allowed, minor print/surface issues possible, strong overall presentation
- PSA 8  NM-MT: light visible corner/edge wear, possible very light scratches or print issues
- PSA 7  NM: visible but not severe corner/edge wear, possible light scratches or minor print defects
- PSA 6  EX-MT and below: increasingly obvious wear, scratches, edge damage, staining, creasing, or major defects

Special instructions:
- If only one image is provided, assume it is probably the front unless the image clearly shows the back.
- If multiple images are provided, use all of them but do not double-count the same evidence.
- Vintage Pokémon cards (1999–2003) and modern cards should be judged with awareness of era, but never use era to override visible evidence.
- Holo surface must be treated conservatively when glare or angle prevents reliable inspection.
- Do not overclaim PSA 10 or PSA 9 when image quality is limited.
- If evidence is poor, say so explicitly and lower confidence.

Respond ONLY with one valid JSON object. No markdown, no prose outside JSON.

The "issues" field must be an object with exactly these keys: centering, corners, edges, surface, other.
Each key must map to an array of strings. Use [] when nothing is visible for that category.
Use "warnings" in image_quality for image-level limitations (glare, blur, missing back).
Use "issues.other" for card-level unknowns that don't fit another category.

Allowed values:
- "analysis_mode": "front_only" or "front_back"
- "image_quality.status": "good", "partial", or "poor"
- "card_identity.confidence": "high", "medium", or "low"
- "grade_estimate.confidence": "high", "medium", or "low"
- "grading_decision.gradable_candidate": "yes", "maybe", or "no"

If a card_identity field is uncertain, use null rather than guessing.`

const USER_PROMPT = `Analyze this Pokémon card from the provided image set and return JSON with EXACTLY this structure:

{
  "analysis_mode": "front_only",
  "card_identity": {
    "name":       null,
    "set":        null,
    "year":       null,
    "number":     null,
    "confidence": "low"
  },
  "image_quality": {
    "status":            "partial",
    "warnings":          [],
    "front_present":     true,
    "back_present":      false,
    "centering_visible": true,
    "corners_visible":   true,
    "edges_visible":     true,
    "surface_visible":   false
  },
  "grade_estimate": {
    "grade_range":  "PSA 7-9",
    "confidence":   "low",
    "distribution": {
      "1": 0.00, "2": 0.00, "3": 0.01, "4": 0.02, "5": 0.05,
      "6": 0.10, "7": 0.22, "8": 0.30, "9": 0.22, "10": 0.08
    }
  },
  "issues": {
    "centering": [],
    "corners":   [],
    "edges":     [],
    "surface":   [],
    "other":     []
  },
  "grading_decision": {
    "gradable_candidate": "maybe",
    "reason": "Front appears reasonably strong, but back is missing and surface visibility is limited."
  }
}

Rules:
- Output exactly one JSON object. Use exactly the top-level keys shown above.
- "issues" must use exactly these keys: centering, corners, edges, surface, other. Each maps to an array of strings.
- Do not guess hidden defects. Only report what is actually visible.
- If the back is missing, use "analysis_mode": "front_only" and set "back_present": false.
- If the back is present and usable, use "analysis_mode": "front_back".
- If glare, blur, angle, cropping, or compression limit a category, mention that in "warnings" and/or in issues.surface or issues.other.
- If card identity is uncertain, use null fields and lower confidence.
- Use a wider grade range and lower confidence when evidence is incomplete.
- Be conservative about PSA 9 and PSA 10 if surface visibility is limited.
- The distribution values must be plausible probabilities summing approximately to 1.00.
- confidence is "high" when top-2 PSA grades account for >60% of probability mass.
- confidence is "medium" when top-2 grades account for 40–60%.
- confidence is "low" when image quality is too limited for reliable assessment.`

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
