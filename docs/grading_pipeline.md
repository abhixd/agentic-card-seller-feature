# Card Grading Pipeline

End-to-end documentation of how the Chrome extension grades a card — from the
eBay listing scrape to the rendered PSA grade, pillar visuals, and economics.

> **Architecture in one line:**
> eBay scrape → YOLO OBB detect → edge-refine → perspective warp (630×880) →
> palette centering hint → 5-image multicrop → Claude Sonnet → geometric
> centering override → eBay comps + ROI → render (grade + pillar visuals + economics).

---

## Components

| Component | Location | Role |
|-----------|----------|------|
| Chrome extension | `agentic-card-seller-os/extension/` | Scrapes listing, calls grading server, renders results |
| Grading server | `card-solutoin-testing/grading_server/` | FastAPI service (port 8000) running the YOLO + Claude pipeline |
| `grader.py` | grading_server | Detection → warp → Claude grading |
| `comps.py` | grading_server | eBay sold/active comps + ROI + buy/maybe/skip decision |
| `server.py` | grading_server | FastAPI `/grade`, `/health`, `/config` endpoints |

The extension's **main "Analyze listing"** flow targets the **Python grading
server**, not the Next.js `/api/grade/analyze` route (Next.js / Vercel cannot run
the YOLO + OpenCV pipeline — OpenCV WASM hangs in the Lambda runtime).

The pipeline was ported from the research notebook
`card-solutoin-testing/psa_grading_eval.ipynb`.

---

## Stage 0 — Capture (Chrome extension)

- `content.js` scrapes the eBay listing page: **title, price, shipping, image
  URLs**. Image URLs are upgraded to `s-l1600` (max resolution).
- On **Analyze**, `background.js → analyzeListing()` takes the **front image**
  (fetched in-page via the content script's `FETCH_IMAGE_DATA` so eBay's CDN is
  reachable from the page context), then POSTs it multipart to `POST /grade`
  with `title` / `price` / `shipping` form fields.

---

## The grading server — `detect_and_grade()` (`grader.py`)

### Stage 1 — Card detection (YOLO OBB)
- A trained YOLO **oriented-bounding-box** model (`best.pt`) detects the card and
  returns a rotated quad (`obb.xyxyxyxy`), handling angled photos.
- `_order_corners()` sorts the 4 points into **TL / TR / BR / BL** for *any*
  rotation (centroid-angle sort + short/long edge pairing — robust beyond ±45°,
  unlike the naive sum/diff method).

### Stage 2 — Edge refinement + adaptive padding
- `refine_quad_to_edges()` snaps each quad edge to the strongest **Canny** edge in
  a thin perpendicular band, weighted by:
  - **gradient alignment** — up-weights edges whose Sobel gradient is parallel to
    the edge normal (true card edges; rejects random artwork edges), and
  - a **Gaussian distance prior** — biases toward small offsets so it doesn't jump
    to shadows / table edges / sleeve seams.
  - A sanity check (aspect ratio ≈ 0.55–0.85, area preserved) rejects degenerate
    refinements and falls back to the raw YOLO quad.
- `adaptive_padding()` expands the quad outward by a fraction (3%) of the card's
  longer side to include the white border.

### Stage 3 — Perspective warp
- `_warp_card()` warps the **padded** quad to an upright **630×880** canvas via
  `cv2.getPerspectiveTransform` + `warpPerspective` (Lanczos).
- `card_boundary_analytical()` projects the **un-padded** quad through the same
  transform → the exact **physical card edge** in warped space, normalized
  `(x1, y1, x2, y2)`. This is the **green box** in the centering audit.

### Stage 4 — Palette-based centering hint
- `analytical_centering()` samples a thin perimeter strip (corners excluded) and
  matches it against a **Pokémon type → border-colour HSV palette**
  (grass=green, fire=red, water=blue, lightning=yellow, …).
  - **Palette match** → build a colour mask, scan inward until per-row/col coverage
    drops below threshold → that's the inner printed-border edge.
  - **No match** (foil / Full Art / SIR) → fall back to **colour-uniformity**
    scanning from interior side strips.
- Produces a `border_type` hint + a deterministic centering estimate. Passed to
  Claude as an **anchor / hint** — explicitly *not* treated as ground truth.

### Stage 5 — Multi-crop assembly
- `_build_corner_crops()` warps each of the 4 corners to a high-res **800×800**
  square from the **native-resolution** source (far sharper than the full card).
- Claude receives **5 images**: the full warped card + TL / TR / BR / BL zooms.

### Stage 6 — Claude vision grading (`claude-sonnet-4-5`)
- `grade_card()` sends the 5 images plus a user message containing `card_boundary`
  and the `border_type` hint, under the **expert PSA system prompt** (20+ yr PSA
  grader persona; 10× magnification standard; per-pillar rubrics; PSA 1–10 anchors).
- Claude returns a single JSON object:
  - **4 pillars** — `centering`, `corners`, `edges`, `surface`, each a 1–10 score
    plus per-side descriptors (e.g. corners: `sharp | slight_wear | moderate_wear |
    heavy_wear | bent`).
  - `overall_score`, `psa_equivalent` (e.g. "PSA 8 NM-MT"), `summary`.
  - For **centering**, a **`content_region`** rectangle `(x1,y1,x2,y2)` marking the
    inner printed-border edge, verified against each corner zoom (per-corner
    verification rules in the prompt).
- Retries on Anthropic 529 (overloaded) with exponential backoff.

### Stage 7 — Deterministic centering override
- The server recomputes centering **geometrically** from Claude's `content_region`
  vs `card_boundary`:
  - border widths `L/R/T/B` → ratios (`53/47`, …) → worst-axis deviation from
    50/50 → 1–10 score.
  - **"The geometry of the `content_region` box IS the score."**
- Cross-checks Claude's *stated* ratio against the geometric one
  (`_centering_self_consistent`, tolerance ±5pp) and records
  `_centering_borders_px`.

### Stage 8 — Comps + ROI + decision (`comps.py`)
`compute_economics(title, price, shipping, overall_score)`:

1. **Keyword** = listing title minus the `PSA N` tag.
2. **Comps lookup** (eBay Finding API), with fallback chain:
   - `fetch_ebay_comps()` → **sold** listings (`findCompletedItems`), then
   - `find_active_items()` → **active** asking prices (`findItemsAdvanced`, higher
     quota; labelled as asking-price estimates), then
   - nothing.
3. `compute_grade_prices()` — median sold price per grade (raw / PSA 8 / 9 / 10),
   parsing grades out of comp titles.
4. `distribution_from_overall()` — the grader returns a single `overall_score`, so
   this synthesises a small probability distribution peaked on the rounded grade to
   feed the expected-value maths.
5. `compute_roi()` — expected value and max-buy prices.
   Constants: `GRADING_FEE = $25`, `SELL_FEE = 12.95%`, `TARGET_MARGIN = 20%`.
6. `compute_decision()` → **buy / maybe / skip**, or **unknown ("NO DATA")** when
   no usable prices exist. When prices came from active listings, the reason is
   prefixed "Asking-price estimate —".

> ⚠️ **Current eBay status:** the Finding API is **zero-quota / decommissioned**
> for the configured `EBAY_APP_ID` — both `findCompletedItems` and
> `findItemsAdvanced` return `errorId 10001 RateLimiter`. So economics currently
> resolve to **"NO DATA"**. The durable fix is the eBay **Browse API**
> (OAuth client-credentials), which needs **production** OAuth credentials
> (the current `EBAY_CLIENT_SECRET` / `EBAY_CERT_ID` are sandbox `SBX-`).

### Stage 9 — Response
`POST /grade` returns the grade JSON plus:
- `economics`, `decision`, `_comps_source`, `_comps_basis`
- **`_warped_jpeg_b64`** — the perspective-corrected card, and
  **`_corner_crops_b64`** — the 4 corner zooms.

These images are in the **same coordinate space** as `card_boundary` /
`content_region`, so the client overlays render exactly.

---

## Stage 10 — Render (extension `sidepanel.js`)

- `renderPSAResult()` — decision banner (buy / maybe / skip / **NO DATA**), the
  warped card as the trust anchor, per-pillar score badges, PSA equivalent, and the
  economics block (with an "asking-price estimate" caveat when applicable).
- Click a pillar → `openPillarDetailPsa()`:
  - **Centering** — the warped card with the green **card boundary** + gold
    **content region** + **L/R/T/B border-width labels** (the notebook's exact
    centering audit). **Interactive:** drag the edge handles on either rectangle
    to refine the outer (card) / inner (content) boundaries; L/R · T/B · score
    recompute live (`centeringScore()` mirrors the server thresholds). A **Reset**
    button restores the auto-detected boundaries.
  - **Corners** — the 4 high-res corner crops, each labelled with its severity.
  - **Edges** — the warped card with the four sides tinted by severity.
  - **Surface** — scratch / print-line / stain / crease findings.

- **Zoom / pan** (`attachZoomPan()`): every detail image (warped card + corner
  crops) supports scroll-to-zoom (toward the cursor), drag-to-pan, and
  double-click reset. The image and its SVG overlay share one transform layer so
  they stay aligned at any zoom; boundary handles still edit (not pan) because
  `getScreenCTM()` accounts for the zoom transform.

---

## Stage B — pillar scores → overall grade (aggregator)

Stage A (YOLO → warp → Claude) judges the four pillars. **Stage B** combines them
into the overall PSA grade. This is a **linear model** (`train_aggregator.py` →
`grade_model.js`), small enough to run **client-side**, so a manual boundary
adjustment re-grades instantly with **no Claude call**.

- `aggregateGrade({centering, corners, edges, surface})` = `intercept + Σ wᵢ·pillarᵢ`,
  clamped 1–10. Falls back to a plain mean if the model file is absent.
- Trained on `df_psa_claude.pkl` (92 rows, PSA 8/9/10): **CV MAE 0.70, within-1
  97.8%** — beats Claude's own overall (0.92) and weakest-link (1.20).
- Stage A is untouched; only the pillars→overall blend is learned.

### "Apply adjustment" flow (no Claude)
After dragging the green/gold boxes, **Apply adjustment**:
1. recomputes centering from the boxes (`centeringScore()`, geometry only),
2. re-aggregates the overall grade across **all four pillars** via `aggregateGrade()`,
3. writes the new centering + overall back into `currentResult` (marked `✎ adjusted`),
   re-renders the summary, and
4. POSTs the correction to the server for collection (below).

A full Claude re-grade (Stage A) is **only** needed when the crop itself was wrong —
not implemented as the default path.

### Calibration note
`grade_model.js` is Phase-1 (trained on Claude's centering score). For production,
`regenerate_training_data.py` rebuilds the table with the *geometric* centering score
actually served, then `train_aggregator.py df_psa_geometric.pkl` retrains. ~186 Claude
calls — run deliberately.

---

## Data collection for YOLO retraining

The corrected **outer (green) box** is YOLO's detection target. On **Apply
adjustment** the extension sends a record to **`POST /feedback`**
(`background.js → saveAdjustment`), appended to `grading_server/feedback/adjustments.jsonl`
with the warped image saved under `feedback/images/`. Each record carries the warp
context (`quad_padded`, `orig_dims`) needed to map the warped-space correction back
to the original image.

`feedback_to_yolo.py` converts collected corrections into **YOLO OBB labels**:
inverse-warps the corrected box to original-image coordinates, downloads the source
image, and writes `feedback/yolo_dataset/{images,labels}/` (class `0` + 8 normalized
quad coords) — ready to fold into the next YOLO training run.

---

## Running it

```bash
cd card-solutoin-testing/grading_server
export ANTHROPIC_API_KEY=sk-ant-...          # valid key (Next.js .env.local has one)
export EBAY_APP_ID=...                        # optional; enables comps when quota allows
export EBAY_FINDING_API_BASE_URL="https://svcs.ebay.com/services/search/FindingService/v1"
./start.sh                                    # uvicorn server:app on 127.0.0.1:8000
```

Verify: `curl -s http://127.0.0.1:8000/config | python3 -m json.tool`
(note: `api_key_set` only checks non-empty, not validity).

### Environment variables

| Variable | Default | Notes |
|----------|---------|-------|
| `ANTHROPIC_API_KEY` | *(required)* | Must be a valid `sk-ant-…` key |
| `CLAUDE_MODEL` | `claude-sonnet-4-5` | |
| `YOLO_WEIGHTS` | `/opt/homebrew/runs/obb/.../best.pt` | OBB model |
| `YOLO_CONF` | `0.25` | Detection confidence threshold |
| `EBAY_APP_ID` | *(optional)* | Production app id (not `SBX`); enables comps |
| `EBAY_FINDING_API_BASE_URL` | production Finding API | |

---

## Failure modes & graceful degradation

| Failure | Behaviour |
|---------|-----------|
| No card detected (YOLO) | `422` "No card detected" |
| Edge refinement degenerate | Falls back to raw YOLO quad |
| Borderless / Full-Art card | Palette match fails → uniformity fallback; centering may be `unavailable` |
| Invalid `ANTHROPIC_API_KEY` | `500` `AuthenticationError: invalid x-api-key` |
| eBay rate-limited / no comps | Economics omitted/null; decision = **unknown ("NO DATA")** — not a false "skip" |
| Sharp/OpenCV unavailable | (Next.js path only) — not applicable to the Python server |

---

## Related docs
- `analysis_pipeline.md` — the original Next.js analysis flow
- `centering_panel_redesign_spec.docx` — centering UI spec
- `crop_rectification_subsystem_design.docx` — warp/crop design
- `grading_server/README.md` — server setup + endpoints
