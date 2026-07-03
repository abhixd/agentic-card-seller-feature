# Onboarding — agentic-card-seller-os

> **How to use this doc:** you're a new engineer (or Claude, working for one) picking up this codebase.
> Read this top to bottom once, then keep it open. It tells you what the product is, how it's wired, how to
> run everything locally, the rules that keep the two work streams from colliding, and where to add a feature.
> Upload this file to Claude at the start of a session so it has the whole map.

---

## 1. What we're building

A **collectible-card grading + seller platform** (Pokémon TCG first). A user uploads a photo of a raw card;
we return an **estimated PSA grade** (overall + per-pillar: centering, corners, edges, surface), the **defects
we found** (drawn on the card), an **identity match** (which card it is), and a **worth-grading verdict** with
dollar figures. Two front-ends consume the same grading engine:

- **Web app** (`apps/web`) — the consumer product at [agentic-card-seller-os.vercel.app](https://agentic-card-seller-os.vercel.app). The `/grade` page is the flagship.
- **Chrome extension** (`apps/extension`) — grades cards directly on eBay listings.

The grading engine is a **classical-CV + ML pipeline** (SAM3 segmentation → perspective warp → centering →
RF-DETR defect detectors → XGBoost grade). It runs as a Python service, with the GPU-heavy vision steps
offloaded to a serverless Modal container.

---

## 2. Get the code

```bash
git clone git@github.com:srdoddi/agentic-card-seller-os.git
cd agentic-card-seller-os
git checkout main          # always branch off main
npm install                # monorepo: npm workspaces + turbo (npm@11.16.0, Node 20+)
```

`main` is the source of truth for both streams. Latest work is at the top of `git log`. **Branch per
feature** (`feat/...`, `fix/...`); never commit straight to `main`.

---

## 3. Architecture at a glance

Two independent work streams that meet at ONE typed contract. This is the most important thing to understand
— it's why two people can build in parallel without blocking each other.

```
  PRODUCT STREAM                        THE CONTRACT                    GRADING STREAM
  ──────────────                        ────────────                   ──────────────
  apps/web        (Next.js, Vercel)                                    services/grading-api  (Python/FastAPI)
  apps/extension  (Chrome MV3)   ──►  @acs/grading-contract   ──►        → Railway (Dockerfile.grading)
  packages/*      (shared TS)          gradeCard() + types                → offloads vision to Modal (GPU)
                                       (packages/grading-contract)        research/  (CV lab, gitignored)
```

- The product **only** talks to grading through `gradeCard(baseUrl, { image })` from `@acs/grading-contract`.
  It never imports Python, never hits Railway internals. `baseUrl` (an env var) selects the backend:
  Railway `production`, a `dev` deploy, or a local **mock**.
- The grading stream **only** changes the response shape by bumping the contract (see §7). It never touches
  `apps/`.
- Full rules: [`/CONTRACT.md`](../CONTRACT.md). Per-stream scope: [`apps/CLAUDE.md`](../apps/CLAUDE.md) and
  [`services/grading-api/CLAUDE.md`](../services/grading-api/CLAUDE.md). **Read your stream's CLAUDE.md before
  editing — they encode hard-won rules.**

---

## 4. Repo map

```
apps/
  web/                 @acs/web — Next.js consumer app (Vercel). Grade page: src/app/(app)/grade/page.tsx
                       Grade UI components: src/components/grading/*  (GradeResultCompact, DefectsPanel, …)
                       The single grading proxy: src/app/api/grade/route.ts
                       Plain-language helpers: src/lib/grading/  (plain.ts, score.ts, defects.ts, types.ts)
  extension/           Chrome MV3 extension (vanilla JS, no build). sidepanel.{html,js,css}, background.js
packages/
  grading-contract/    @acs/grading-contract — gradeCard() + GradeResponse types. THE boundary. Ships raw TS.
services/
  grading-api/         Python FastAPI grading service. Deployed on Railway via /Dockerfile.grading.
                       Key modules: main.py (API), grader.py (pipeline entry: detect_and_grade),
                       card_segmenter.py (SAM3 contour → quad + crop-bypass), cv_grader.py (warp → centering
                       → defect_boxes → XGBoost grade), per_side_selector.py (centering), scratch_detect.py +
                       ec_detect.py (RF-DETR defect detectors), contract.py (response schema — mirrors the TS).
  forecast/, optimize/ other services (not the grading path).
research/                CV lab: ground truth, warp cache, Streamlit diagnostic apps. GITIGNORED, not deployed.
                       research/modal/vision_service.py — the Modal GPU deployment (also gitignored).
                       research/rfdetr_scratch/ec_app.py — the "8524" pipeline viewer (see §11).
CONTRACT.md            the boundary + versioning rules.
Dockerfile.grading     builds the grading service (Railway). Explicit per-file COPY — see gotcha in §14.
railway.toml           Railway config (path-scoped: only rebuilds when services/grading-api/** changes).
turbo.json             monorepo task graph.
```

---

## 5. Run it locally

### Web app (`apps/web`)
```bash
npm run dev              # turbo → next dev --turbopack, http://localhost:3000
# grade page: http://localhost:3000/grade
```
By default the app grades against **production** grading. To develop the UI without the Python service, use
the **mock**: set `GRADING_API_URL=mock` (canned, contract-shaped responses) — see `/CONTRACT.md` §Mock.

### Chrome extension (`apps/extension`)
No build step — the files *are* the extension.
```
chrome://extensions → Developer mode → Load unpacked → select apps/extension/
```
After editing, click **reload** on the extension. It calls the Railway `/grade` endpoint (see host_permissions
in `manifest.json`), so it uses live prod grading automatically.

### Grading service (`services/grading-api`) — only if you're on the grading stream
```bash
cd services/grading-api
# use the committed venv, or create one from requirements.txt
venv/bin/python -m uvicorn main:app --reload --port 8000
# then point the web app at it: GRADING_API_URL=http://localhost:8000
```
Local grading runs the full CV pipeline on CPU (slower; ~seconds/card). To match prod exactly, run through
Modal instead (see §9). Lab Python: always `services/grading-api/venv/bin/python`.

### The CV lab viewer ("8524") — the fastest way to see the grading pipeline
```bash
services/grading-api/venv/bin/python -m streamlit run research/rfdetr_scratch/ec_app.py --server.port 8524
```
See §11 — this renders every stage of the deployed pipeline on any card.

---

## 6. The grading pipeline (the crown jewel)

Entry point: `grader.detect_and_grade(img_bgr, api_key, zoom)` in `services/grading-api/grader.py`. It returns
the full response dict (`_warped_jpeg_b64`, `centering`, `defect_boxes`, pillar scores, `overall_score`,
`psa_equivalent`, `_card_boundary`, `_cropped`, …). Flow:

1. **Segment** (`card_segmenter.segment_card`) — **SAM3** (Meta's promptable segmentation, prompt "card")
   produces the card contour. In prod this runs on Modal; locally it can run on CPU.
2. **Quad** — turn the contour into a 4-corner quad for the perspective warp:
   - **Circumscribing quad** (`SEG_QUAD_MODE=circumscribe`, the default) — supporting-line fit that HUGS the
     contour and *cannot cut the card* (each side rests tangent to the contour). Replaced the old
     `edge_intersection` regression-line fit that cut corners.
   - **Crop-bypass** (`SEG_CROP_BYPASS=1`) — if the image is already cropped tight to the card border
     (`is_cropped_to_border`), skip the warp entirely (the image *is* the card) to avoid warp looseness.
3. **Warp** — perspective-rectify to a **630×880** canvas (`_warp_card`), then mask background to the contour.
4. **Centering** (`cv_grader._perside_inner_frame` → `per_side_selector`) — a learned **per-side inner-frame
   selector** finds the printed border on each side; `left_right` / `top_bottom` ratios + a **confidence**.
   Guarded by `_plausibility_repick` (rejects physically-impossible near-zero borders).
5. **Defects** — two fine-tuned **RF-DETR** detectors: `scratch_detect.py` (surface) and `ec_detect.py`
   (edges + corners) → `defect_boxes` (normalized [x1,y1,x2,y2] + conf), drawn on the card in both UIs.
6. **Grade** — an **XGBoost** model turns CV features into the 4-tier overall grade → `overall_score` +
   `psa_equivalent`.

**The rule that matters:** the per-side centering selector is the fragile link. Validate any centering change
on the **production path** (raw image → segment → warp → cb → select), never on cached lab warps — lab≠prod
has bitten us repeatedly. Harnesses live in `research/`.

---

## 7. The contract (how to change the API boundary)

`@acs/grading-contract` (`packages/grading-contract`) is the typed boundary. Current `CONTRACT_VERSION` = **1.3.0**
(`packages/grading-contract/src/index.ts`), mirrored by `contract.py` `CONTRACT_VERSION` on the Python side.

To change the `/grade` response shape:
- **Add an optional field** → backwards-compatible → **bump MINOR**, ship the two sides independently.
- **Rename / remove / retype a field** → BREAKING → **bump MAJOR**, update BOTH streams in the same PR.
- Update `contract.py` (source of truth for the schema), run `python export_openapi.py`, and bump both
  `CONTRACT_VERSION`s in lockstep.
- The web app keeps its own mirror in `apps/web/src/lib/grading/types.ts` — it adopts new optional fields when
  ready. `_`-prefixed keys (e.g. `_card_boundary`, `_warped_jpeg_b64`) are internal/opaque — don't build public
  features on them without promoting them into the contract.

Full rules + branching workflow: [`/CONTRACT.md`](../CONTRACT.md).

---

## 8. Conventions & guardrails

- **Stay in your stream.** Product stream = `apps/`, `packages/*` (consume, don't author, grading-contract).
  Grading stream = `services/grading-api/`, `research/`, `Dockerfile.grading`, `railway.toml`, `contract.py`.
  Cross-stream needs go through a contract bump — flag it, don't reach across. (See the two CLAUDE.md files.)
- **Never break centering silently.** Don't change the shape of `centering`, pillar scores, `overall_score`,
  or `psa_equivalent` without a contract bump + coordination.
- **Validate on the prod path**, not cached warps (grading stream). Flag-gate risky grading changes with an
  env var (default = current behaviour) so revert is a config change, not a code change.
- **Secrets** live in env on Railway (`ANTHROPIC_API_KEY`, `ROBOFLOW_API_KEY`, `POKEMON_PRICE_TRACKER_TOKEN`,
  eBay creds) and Vercel (`NEXT_PUBLIC_SUPABASE_*`). Never commit `.env.local`; never paste secret values.
- **Commits:** conventional style (`feat(scope): …`, `fix(scope): …`), imperative, explain the *why*.
- **Numbers on screen** get rounded; **prose over jargon** in the consumer UI (see `lib/grading/plain.ts` —
  we translate `L/R 45/55 · conf 0.95` into "near perfect · high confidence").

---

## 9. Deploy topology

| Surface | Where | How it deploys |
|---|---|---|
| Web (`apps/web`) | Vercel (project `yokri`, [agentic-card-seller-os.vercel.app](https://agentic-card-seller-os.vercel.app)) | **Auto** on push to `main` (turbo-ignore skips grading-only pushes). |
| Grading API (`services/grading-api`) | Railway ([card-grader-api-production.up.railway.app](https://card-grader-api-production.up.railway.app)) | **Auto** on push to `main` when `services/grading-api/**` changes (path-scoped `watchPatterns`). Railway proxies the heavy grade to Modal (`GRADE_BACKEND=modal`). |
| Vision (SAM3 + RF-DETR + warp) | **Modal** (serverless L4 GPU) — `research/modal/vision_service.py` (gitignored) | **Manual:** `modal deploy`. ⚠️ **Drain first** or you test a stale container: `modal app stop card-vision --yes` then `.venv/bin/modal deploy vision_service.py`. Endpoint: `srini--card-vision-vision-fullgrade.modal.run`. |
| Extension (`apps/extension`) | User's Chrome (unpacked) | **Manual reload** in `chrome://extensions`. Grading changes are server-side → picked up automatically. |

The real prod grade path: **web/extension → Railway `/grade` → Modal `/fullgrade` → the CV pipeline.** Railway
delegates the vision work to Modal (the same code, deployed via `modal deploy`, which copies the local tree).

---

## 10. Environment variables & feature flags

Grading-stream flags (set on Modal / Railway; sensible defaults in code):

| Flag | Purpose | Prod value |
|---|---|---|
| `SEG_QUAD_MODE` | `circumscribe` (hug contour, no cut) / `edges` (legacy) / `corners` | `circumscribe` |
| `SEG_CROP_BYPASS` | skip warp for already-cropped inputs | `1` |
| `PERSIDE_CENTERING` | per-side inner-frame centering selector | `1` |
| `PERSIDE_REPICK` | reject impossible near-zero-border centering reads | `1` |
| `GRADER_BACKEND` | `cv` (XGBoost, default) / `vlm` (Claude, legacy) | `cv` |
| `GRADE_BACKEND` | `modal` (Railway → Modal) / `local` | `modal` on Railway, `local` in the lab |
| `DETECT_BACKEND` | RF-DETR detectors `local` / `modal` | `local` |
| `SCRATCH_THRESHOLD` | surface-defect confidence cutoff | **⚠️ currently `0.2`** (a temporary review setting — default is `0.6`; expect many low-conf surface boxes until reverted) |
| `SEG_REFINE` | sub-pixel photometric quad refine (superseded by circumscribe; inert in that mode) | `1` (inert) |

Product-stream: `GRADING_API_URL` (selects grading backend / mock), `NEXT_PUBLIC_SUPABASE_*`.

---

## 11. The lab: 8524 pipeline viewer + research/

`research/rfdetr_scratch/ec_app.py` (port **8524**) is a Streamlit app that runs **`detect_and_grade` — the exact
prod entry — and renders its response**. It cannot drift from prod (no reimplementation). It shows: the crop
verdict, the input with SAM3 contour + circumscribing quad + (optional) old YOLO-OBB quad overlays, the final
warp, the inner-border/centering overlays, and the defect_boxes with a click-to-zoom table. Use it to eyeball
any card before/after a grading change.

```bash
services/grading-api/venv/bin/python -m streamlit run research/rfdetr_scratch/ec_app.py --server.port 8524
```

`research/` is gitignored CV lab space (ground truth, warp caches, training notebooks, diagnostic apps). It is
**not** deployed. Detector weights live in HF (`sdoddi/card-scratch-rfdetr-large`, `sdoddi/card-edge-corner-rfdetr-large`)
and locally under `services/grading-api/models/`.

---

## 12. What's built so far (recent, so you don't redo it)

- **Circumscribing warp quad** + **crop-bypass** for already-cropped inputs + **clean cropped warp** (no black
  ring) + tightened bypass so background-margin cards don't false-fire.
- **Plausibility re-pick** for centering edges that lock onto the card edge (vintage cards with text on the border).
- **B2C grade reveal** (web + extension): drop-to-grade, grade badge, dollar verdict, plain-language pillars,
  defect-box overlay with zoom, "adjust borders" manual centering correction, extension close button.
- **RF-DETR defect detectors** (surface + edge/corner) feeding `defect_boxes`; contract 1.3.0.
- **Modal GPU deploy** of the whole vision pipeline.

Open follow-ups worth knowing: the **per-side centering selector** is the fragile link — each recent centering
fix is a targeted guard; a proper retune/retrain of that selector is the durable next project. And a
**capture-quality gate** (warn on glare / dim / fuzzy-background photos) is unbuilt and is the honest lever for
images no algorithm can fully fix.

---

## 13. How to add a feature (playbooks)

**A product-only feature (web or extension)** — e.g. a new way to display or act on the grade:
1. Build in `apps/web` (or `apps/extension`) against `@acs/grading-contract` types (or the mock).
2. If you need a new field from grading, request it via a contract bump (§7) — don't scrape `_`-prefixed keys.
3. Web deploys on push to `main`; reload the extension manually.

**A grading feature** — e.g. a new detector, a centering improvement, a new response field:
1. Work in `services/grading-api/`. Prototype/measure in `research/` (use the 8524 viewer).
2. Flag-gate it (env var, default off/current) so revert is a config change.
3. **Validate on the prod path** (raw image → pipeline), not cached warps.
4. If it changes the response shape, bump the contract (§7) and update `contract.py` + `export_openapi.py`.
5. Commit → push `main` (Railway auto-rebuilds grading) → **`modal deploy`** the vision side (drain first).
6. Verify live via Railway `/grade` on a few real cards.

**When unsure what a change will affect:** open the 8524 viewer, grade a handful of cards from the test folders
(`rohan_feedback/`, `research/rfdetr_scratch/user_cases/`), and compare before/after.

---

## 14. Gotchas (hard-won — read before you debug for an hour)

- **Modal serves stale code** unless you drain before deploying: `modal app stop card-vision --yes` THEN
  `modal deploy`. Verifying against a warm stale container is the #1 time-sink here.
- **`Dockerfile.grading` uses explicit per-file `COPY`.** A new Python module in `services/grading-api/` is
  **silently absent from the Railway image** unless you add it to the COPY list. (Modal, by contrast, copies
  the whole dir via `add_local_dir`.)
- **`defect_boxes` are visual boxes only**, not the pillar scores. The XGBoost model + per-side selector set
  the scores; the boxes are for display.
- **`_warped_jpeg_b64` is the MASKED warp** (background blacked out) except on the crop-bypass path (where the
  card fills the frame). Both UIs decode this directly.
- **Centering is sensitive.** A tiny input change can flip the per-side selector on hard cards (white borders,
  low contrast, holo full-art). Trust the `confidence` field over adding more CV.
- **Local ≠ prod for grading.** The Python code is identical, but always confirm a grading change through the
  real Railway `/grade` path before calling it done.
- **SSH push on this machine can corrupt packs** — if `git push` errors with "bad object/inflate", retry with
  `GIT_SSH_COMMAND='ssh -o Ciphers=chacha20-poly1305@openssh.com' git push`.

---

*Questions this doc doesn't answer? The two `CLAUDE.md` files (`apps/`, `services/grading-api/`) and
`/CONTRACT.md` are the next stop. When working with Claude, paste this file in first.*
