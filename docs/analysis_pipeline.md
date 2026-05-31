# Card Grading Analysis Pipeline

End-to-end flow from the moment a user clicks **Analyze** in the Chrome extension
to the final Buy / Maybe / Skip decision displayed in the side panel.

---

## Flowchart

```mermaid
flowchart TD
    %% ── EXTENSION ────────────────────────────────────────────────────────────
    subgraph EXT["🌐 Browser — Chrome Extension (sidepanel.js)"]
        A([User clicks Analyze]) --> B[Scrape listing:\ntitle · price · shipping\nimage URLs from eBay DOM]
        B --> C["Fetch each image URL → base64\n(browser has CDN access;\nserver-side is blocked)"]
        C --> D[POST /api/grade/analyze\n{ title, price, shipping,\n  image_urls, image_data }]
    end

    %% ── API ROUTE ────────────────────────────────────────────────────────────
    subgraph ROUTE["⚙️ Next.js API Route  —  /api/grade/analyze"]
        D --> E{Validate:\ntitle + price\n+ image_urls}
        E -- invalid --> ERR1([400 Bad Request])
        E -- valid --> F[["gradeWithClaude()\nsee §Claude Pipeline"]]
        E -- valid --> G[["fetchEbayComps()\neBay completed sales\n(if EBAY_APP_ID set)"]]
        F --> H[sanitiseInference\nEnforce front-only rules\nBoth-sides-bad rules]
        G --> I[computeGradePrices\nParse PSA grade from titles\nMedian per bucket:\nraw / PSA8 / PSA9 / PSA10]
        H --> J[computeROI\nEV = Σ P·salePrice·(1−12.95%)−$25\nMax buy price for PSA8/9 targets]
        I --> J
        J --> K[computeDecision\nBuy · Maybe · Skip]
        K --> L([JSON response\nto extension])
    end

    %% ── CLAUDE PIPELINE ──────────────────────────────────────────────────────
    subgraph CV_PIPE["🤖 gradeWithClaude()  —  claudeVision.ts"]
        F --> S1["Step 1 — Build buffers\nbase64 → Buffer  ← fast path\nfetchBuffer(url)  ← fallback"]
        S1 --> S1B["Step 1b — Crop card from background\ndetectCardBounds() per buffer\n→ see §Crop Detector"]
        S1B --> S2["Step 2 — CV detectors\nanalyseBuffer(croppedBuf)\n→ see §CV Detectors"]
        S1B --> S3["Step 3 — Resize for Claude\nsharp → ≤1024px JPEG q85\nbase64 encode"]
        S2 --> S4["Step 4 — Build prompt\nCV measurements as text\n+ image count note\n+ listing title\n+ grading rubric + JSON schema"]
        S3 --> S4
        S4 --> S5["Step 5 — Call Claude Haiku\nwithRetry():\n  up to 3 attempts\n  2s → 4s backoff on HTTP 529"]
        S5 -- overloaded --> S5
        S5 --> S6["Step 6 — Normalize distribution\nrescale to 1.0 if off > 2%"]
        S6 --> S7["Step 7 — Sanity guard\n2+ images + front_only\n→ fix to front_back"]
        S7 --> S8([return claudeResult + _cv])
        S8 --> H
    end

    %% ── CARD CROP DETECTOR ───────────────────────────────────────────────────
    subgraph CROP["✂️ detectCardBounds()  —  cvDetectors.ts"]
        S1B --> C1["Downsample to ≤256×256\n(keep aspect ratio)"]
        C1 --> C2["Sample four 12×12 corner patches\n→ median R/G/B per patch\n→ average → background colour"]
        C2 --> C3["Threshold foreground:\nEuclidean RGB distance > 35"]
        C3 --> C4["Bounding box of foreground pixels\n+ expand 8% for card white border"]
        C4 --> C5{Sanity checks}
        C5 -- "FG < 5%\nor crop < 25%\nor crop > 92%" --> C6([return null\nuse full image])
        C5 -- pass --> C7([return left/top/width/height\nin original pixel coords])
        C6 --> S1B
        C7 --> S1B
    end

    %% ── CV DETECTORS ─────────────────────────────────────────────────────────
    subgraph CV["📐 analyseBuffer()  —  cvDetectors.ts"]
        S2 --> CV0["Resize to 384×544 grayscale\n(canonical size for all detectors)"]

        CV0 --> CV1["Phase 1 — Image Quality\nBlur: Laplacian variance\n  < 40 = blurry\nGlare: fraction ≥ 245 px\n  > 5% = problematic\nBrightness: mean + std dev"]

        CV0 --> CV2["Corner Analysis\n4 patches: TL / TR / BL / BR\neach 46×55 px\nwhite_fraction > 7% → whitening\n→ corner_boxes[] with x/y pct"]

        CV0 --> CV3["Detector A — Border Irregularity\nSobel in 55px/70px border band\nPer-side stats (corner-exclusive)\nConnected components on anomaly map\nScore → none/light/moderate/heavy\n→ edge_bands[] with x/y pct"]

        CV0 --> CV4["Detector B — Surface Lines\nSobel in card interior\nDirectional energy: H/V/diagonal\nEnergy imbalance\nScore → severity + confidence"]

        CV0 --> CV5["Detector C — Surface Grid\n4 cols × 6 rows interior cells\nPer-cell directional Sobel\nGlare-mask flag\nOnly hot cells emitted\n→ surface_grid[] with x/y pct"]

        CV1 --> CV6([return CVMeasurements])
        CV2 --> CV6
        CV3 --> CV6
        CV4 --> CV6
        CV5 --> CV6
        CV6 --> S2
    end

    %% ── EXTENSION RENDER ─────────────────────────────────────────────────────
    subgraph RENDER["🖥️ Extension — Render Result (sidepanel.js)"]
        L --> R1["Card identity + grade range\nDistribution bar\nBuy / Maybe / Skip badge"]
        L --> R2["Issue list\nCorners · Edges · Surface · Centering\nSeverity dots on thumbnails"]
        L --> R3["Economics panel\nEV · PSA8/9 estimates\nMax buy prices"]
        R2 --> R4["Tap issue → focused mode\nbuildCVEvidenceSVG()\n  corner_boxes for corner zones\n  edge_bands for edge zones\n  surface_grid for surface zone\nSVG overlay on card image"]
    end
```

---

## Stage Descriptions

### Stage 1 — Browser Pre-fetch (Extension)

**File:** `extension/sidepanel.js`

The extension runs in the browser where eBay's image CDN is accessible. It scrapes the listing DOM for title, price, shipping, and image URLs, then downloads each image as a base64 string **before** posting anything to the server. Server-side URL fetching is unreliable — eBay CDN blocks requests by IP and referrer — so this pre-fetch step is essential.

---

### Stage 2 — API Route

**File:** `src/app/api/grade/analyze/route.ts`

The route validates the incoming request and fans out two independent jobs:

| Job | Description |
|-----|-------------|
| `gradeWithClaude()` | Full Claude Vision pipeline (stages 3–5) |
| `fetchEbayComps()` | eBay completed-sales lookup via Finding API |

After both finish, the route runs three sequential steps:

1. **`sanitiseInference()`** — server-side sanity guard that enforces front-only rules and catches contradictions Claude occasionally returns despite prompt instructions.
2. **`computeGradePrices()`** — parses PSA grade from each eBay sale title using regex, then computes the median sold price per grade bucket (raw / PSA 8 / PSA 9 / PSA 10).
3. **`computeROI()` + `computeDecision()`** — expected value calculation, max buy prices at 20% target margin, and a final Buy / Maybe / Skip label with a plain-English reason string.

---

### Stage 3 — Card Boundary Detection (Crop)

**File:** `src/lib/grading/cvDetectors.ts` → `detectCardBounds()`

eBay photos show cards surrounded by mats, hands, and holders. Without cropping, all CV detectors measure the background rather than the card — corner patches land on the table, edge bands straddle the photo edge, and the surface grid covers open air.

| Step | Detail |
|------|--------|
| Downsample | Resize to ≤256×256 (keep aspect ratio) for a fast pixel scan |
| Background colour | Four 12×12 corner patches → median R/G/B → average to single background estimate |
| Foreground mask | Euclidean RGB distance > 35 from background = foreground pixel |
| Bounding box | Min/max row and column of all foreground pixels |
| Border expansion | Expand 8% on each side to include the card's white border |
| Sanity checks | Return `null` (use full image) when: FG < 5%, crop < 25% of image, or crop > 92% of image |
| Scale back | Convert detected bounds from 256×256 space to original pixel coordinates |

When `null` is returned, the full buffer is used — the degradation is safe.

---

### Stage 4 — CV Detectors

**File:** `src/lib/grading/cvDetectors.ts` → `analyseBuffer()`

Runs entirely on Sharp pixel data. No network calls. Input is the cropped buffer (card only). All analysis runs at a canonical 384×544 grayscale resolution.

#### Phase 1 — Image Quality

| Detector | Method | Threshold |
|----------|--------|-----------|
| Blur | Laplacian variance | < 40 = blurry |
| Glare | Fraction of pixels ≥ 245 | > 5% = problematic |
| Brightness | Mean + std dev | < 50 = too dark; > 220 + no glare = overexposed |

#### Phase 2 — Card Structure

| Detector | Region | Method | Output |
|----------|--------|--------|--------|
| Corner Analysis | Four 46×55 px corner patches | White fraction (> 7% = whitening) | `corner_boxes[]` — percentage coords for SVG overlay |
| Detector A — Border Irregularity | 55 px (W) / 70 px (H) border band, corner-exclusive per side | Sobel gradient + connected components | `edge_bands[]` — severity: none / light / moderate / heavy |
| Detector B — Surface Lines | Card interior (inside border margin) | Directional Sobel: H / V / diagonal energy fractions | Severity + confidence (reduced when glare > 5%) |
| Detector C — Surface Grid | 4 × 6 cell grid over interior | Per-cell directional Sobel + glare mask flag | `surface_grid[]` — only hot cells with x/y pct coords |

All overlay entries (`corner_boxes`, `edge_bands`, `surface_grid`) use percentage coordinates on a 0–100 scale, matching the SVG `viewBox="0 0 100 100"` used in the extension panel.

---

### Stage 5 — Claude Vision Pipeline

**File:** `src/lib/grading/claudeVision.ts` → `gradeWithClaude()`

| Step | Description |
|------|-------------|
| Step 1 | Build raw buffers from base64 (fast path) or URL download (fallback) |
| Step 1b | `detectCardBounds()` → crop each buffer in parallel |
| Step 2 | `analyseBuffer()` on first cropped buffer → CV measurements |
| Step 3 | `resizeBuffer()` → resize each cropped buffer to ≤1024px JPEG q85, base64 |
| Step 4 | Assemble prompt: CV measurements as structured text + image count note + listing title + grading rubric |
| Step 5 | `withRetry(client.messages.create(...))` — up to 3 attempts, 2 s → 4 s backoff on HTTP 529 (overloaded) |
| Step 6 | Normalize grade distribution to sum = 1.0 |
| Step 7 | Sanity guard: 2+ images sent + `front_only` result → fix to `front_back` |

Claude Haiku receives the sorted images (user-selected order: first pick = likely front, second = likely back) alongside the CV measurements injected as structured text at the top of the user prompt.

---

### Stage 6 — Extension Render

**File:** `extension/sidepanel.js`

The JSON response is rendered in three areas:

| Area | Content |
|------|---------|
| Header | Card identity, grade range, distribution bar, Buy / Maybe / Skip badge with reason |
| Issue list | Per-zone defects (corners · edges · surface · centering) with severity dots on thumbnails |
| Economics | Expected value, PSA 8 / 9 / 10 price estimates, max buy prices at target margin |

**Focused mode** — when the user taps an issue in the list, `buildCVEvidenceSVG()` draws a single targeted SVG overlay matching that zone:
- Corner zone → `corner_boxes` entry for that corner
- Edge zone → `edge_bands` entry for that side
- Surface zone → all hot `surface_grid` cells
- Claude zone annotation rendered on top for context

Overlays are hidden in the default (unfocused) view to avoid visual clutter.

---

## Key Design Decisions

| Decision | Rationale |
|----------|-----------|
| Images pre-fetched in browser | eBay CDN blocks server-side IP fetches; browser has full CDN access |
| Card cropped before all analysis | CV detectors assume card fills frame; eBay photos include backgrounds |
| CV runs before Claude | Pixel measurements are injected into the prompt — Claude uses them to calibrate confidence rather than guessing from image alone |
| Canonical 384×544 for CV | Fixed size means all constants (corner patch sizes, border band widths) are stable regardless of source image resolution |
| Percentage coords for overlays | SVG `viewBox="0 0 100 100"` + `preserveAspectRatio="none"` → percentage coords map directly to card image without any coordinate conversion in JS |
| Retry on HTTP 529 | Anthropic occasionally returns overloaded errors under load; exponential backoff (2 s → 4 s) resolves them without user-visible failure |
