# Centering / `cb`-Geometry Investigation & Fixes

_Last updated: 2026-06-17_

Reference notes for the inner-boundary (centering) pipeline. Captures the root-cause analysis, the
fix that landed, and — importantly — the approaches that were **validated dead-ends** so they aren't
re-chased. Read this before touching `cb` derivation, `refine_cb_in_warped`, or the variance detector.

---

## TL;DR

- **Symptom:** the variance/centering detectors picked edges *inside the content region* instead of
  the true inner boundary, even when the true boundary had good contrast.
- **Root cause:** it was **not** the detector cost — it was **`cb` (the outer card boundary)
  UNDERSHOOTING**. `cb` landed too tight (inside the real card edge), often asymmetrically, so the
  true inner boundary fell *outside* the detector's inward search band and it could only grab the next
  edge further in.
- **Origin of the undershoot:** `quad_from_contour` (`services/grading-api/card_segmenter.py`) reduces
  the seg contour to 4 corners with `approxPolyDP`, which **inscribes** the corners *inside* the
  rounded/angled card outline. So `cb` (derived from that quad) is systematically a bit tight, and the
  amount varies per side.
- **Fix:** `_balance_cb_padding` in `services/grading-api/grader.py` — make the four `cb` paddings
  **symmetric** by pulling each side to the smallest (most-accurate) side's padding, with a tolerance
  `margin = 0.006`.
- **Result:** variance centering-ratio error on the 39-card GT set **12.71 → 5.84** (a 54% reduction);
  full-art cards (e.g. Team Rocket's Mewtwo ex) now align on all four sides.
- **Consequence for `w_seed`:** the outer-prior (`SEED_W`) was *masking* this undershoot. With the
  geometry fixed, `SEED_W = 0` is correct — the detector finds the outer boundary on its own.

---

## The symptom (what the user reported)

In the lab, the blue **variance** box would settle on a strong edge *inside* the card content (an
art-window edge, a title bar, a stat/rule box) rather than on the well-contrasted true inner frame
line. Examples seen: the Chinese Charizard (`card_00`) top, and **Team Rocket's Mewtwo ex**
(`datasets/embeddings/test1/image2.webp`) bottom + top.

## Root-cause analysis (how we proved it)

1. Instrumented the per-inset cost profile (`α·CumVar + β·exp(−gain·g)`) for the failing edges. The
   argmin landed on a deep strong edge; the outer boundary's gradient was weaker *or* the cost was a
   near-tie. That looked like a detector-weighting problem.
2. But measuring `cb` directly showed the real issue: e.g. Mewtwo `cb = [.023, .036, .976, **.949**]`
   — the bottom padding was **5.1%** vs ~2.3% on the other sides. The true silver frame (~2%) sat
   *below* `cb.y2`, **outside** the search band, so variance physically could not reach it.
3. Confirmed across the set: most cards undershoot a little (~2.3%, the normal `PADDING_FRAC`), and a
   handful undershoot a lot on one side (card_22 bottom 9.2%, Mewtwo bottom 5.1%, top 3.6%).

## The fix: symmetric `cb`-padding balance

`grader._balance_cb_padding(warped, cb, margin=0.006)`, called at the end of `refine_cb_in_warped`
(so it runs everywhere `cb` is produced — lab, labeler, and **production `cv_grader`**).

- Each side's "padding" = gap between `cb` and the warp edge (`L=cb[0]`, `R=1−cb[2]`, `T=cb[1]`,
  `B=1−cb[3]`). For an accurate quad this is a constant ~`PADDING_FRAC` on all four sides.
- A quad-undershoot inflates the padding on the affected side(s). We pull every side whose padding
  exceeds the **minimum** side's by more than `margin` out to that minimum, restoring symmetry.
- **Pure geometry, no image gate.** An earlier version gated on "is the strip just outside `cb` the
  same colour as just inside" (to confirm card-continues-past-`cb`). That gate **blocked the fix** —
  card content varies across `cb`, so it falsely read "not card." Removing the gate is what works.

### Why `margin = 0.006` (and why smaller is NOT safer)

Clean margin sweep on 39 GT cards (balance disabled inside `refine` first, then applied fresh):

| margin | GT mean | median | # cards regressed vs no-balance |
|---|---|---|---|
| no balance | 12.71 | 10.6 | 0 |
| 0.000 | 5.61 | 4.3 | **7** |
| 0.002 | 5.55 | 4.4 | 6 |
| 0.004 | 5.89 | 4.4 | 5 |
| **0.006** | **5.84** | 5.0 | **4** |
| 0.010 | 7.34 | 5.6 | 3 |

The **mean is flat** from 0–0.006 (≈5.6–5.9, noise), but the **regression count climbs as the margin
shrinks**. The margin is a *tolerance for legitimate small asymmetry* (slight miscuts, residual warp
perspective, the "min side" itself being a pixel or two of noise). `margin→0` forces all four sides to
*exactly* the min and over-tightens those cards. `0.006` corrects the real undershoots (Mewtwo 1.3%,
card_22 9.2%) while leaving natural ~2–3px asymmetry alone → **best mean AND fewest regressions**.

> Do not lower the margin "to be safe" — it is the opposite of safe (more regressions, no mean gain).

---

## Validated DEAD-ENDS (do not re-chase)

These were each implemented and validated against GT + failing cases, and **rejected**. They remain
in the code as off-by-default params with the negative result documented, so the experiment is
reproducible.

### 1. `SEED_W` — outer-inset prior (`inner_frame_var.py`), default **0**
Adds a convex-budget term pulling the boundary toward the expected ~`SEED_FRAC` inset. It *looked*
like a win on GT (12.7→9.4 at the old additive weight) but that was **overfitting** to the GT cards'
~3% borders; it **regressed held-out full-art cards** (Charizard EX L/R flipped, T/B 48/52→62/38).
It was compensating for the `cb` undershoot, which is now fixed at the source. Keep `SEED_W = 0`.

### 2. `CONTENT_W` — content-gate (`inner_frame_var.py`), default **0**
The docstring always described `exp(−gain·g(d)·content(d))` but the cost was ungated. Implementing the
gate (variance of the strip just *inside* each candidate inset) **regresses GT** (12.7→13.1+) and
**does not fix the latch** — the latched edges (art windows, stat boxes) *have* content behind them,
so the gate can't touch them. The gate only addresses foil-edges-in-the-border, a mode our cards don't
hit. Keep `CONTENT_W = 0`.

### 3. Aggressive `cb` correction (cropping / contour-bbox / gradient edge-snap)
- **Cropping `cb` to remove visible table** → collapses the outer reference; border measures as ~0
  (esp. full-art). The detectors already ignore pixels outside `cb`; don't crop.
- **Deriving `cb` from the contour bbox / percentiles** → regresses GT (12.7→16–19); the warped
  contour is clipped/over-segmented and can't tell "card fills warp" from "table at warp edge."
- **Gradient/scan-from-edge `cb` snapping** → over-expands into the table on full-art cards.

The *symmetric-padding balance* (above) is the approach that holds.

---

## Related fixes from the same investigation

- **Black warp on `card_06`/`card_08`** — `segment_card` picked the **highest-confidence** Roboflow
  prediction; Roboflow sometimes returns a tiny high-confidence speck. Fixed: pick the **largest-area**
  region + reject if the largest is <`SEG_MIN_AREA_FRAC` (5%) of the image. (`card_segmenter.py`)
- **Background masking** — `grader.mask_background_to_contour` blacks out everything outside the card
  to the **convex hull** of the seg contour (hull bridges card-stand / finger notches that would
  otherwise cut into the card). **Centering-only**: validated identical centering on GT, but it shifts
  the grading-model features (model trained on un-masked warps), so it is applied to the centering /
  display path **only**, never to `cv_extract_conditions`.
- **Labeler double-refine bug** — `label_testcards.py:get_card` was re-refining an already-refined
  `cb` (`WC.get_det` refines on load), which *undid* the balance. Fixed to use `det['cb']` directly.

---

## Known open issues / caveats

- **`refine_cb_in_warped` is not idempotent** — the colour/Canny snap (not the balance) makes
  `refine(refine(cb)) ≠ refine(cb)`. Lab upload paths are single-refine (safe); cached-card paths
  (`WC.get_det` re-refines a cache that already stored a refined `cb`) double-refine. Worth cleaning up
  so cached vs upload results can't diverge (store the *analytical* `cb` in the cache, refine once).
- **2–4 GT cards regress slightly** under the balance (≤6.5pt); the net is strongly positive. One
  specific GT card regresses ~+6.5 at *every* margin — a separate label/`cb` issue, not margin-driven.
- **Thin-border full-art cards**: the inner boundary ≈ the card edge, so insets are tiny and the
  centering ratio is inherently noisy; the variance detector correctly flags these `reliable: False`
  (→ route to manual) rather than emitting a confident wrong number.
- **The deeper "real" fix** is to make `quad_from_contour` *extrapolate* the true corners (fit the 4
  edge lines, intersect) instead of inscribing them — but that re-warps everything, which shifts the
  grading-model features and invalidates the current GT labels (they're measured against the current
  `cb`). It's a multi-day rebuild; the symmetric-padding balance is the no-rebuild fix that holds.

---

## Key files & parameters

| What | Where |
|---|---|
| `cb` padding balance (the fix) | `services/grading-api/grader.py` → `_balance_cb_padding` (margin **0.006**) |
| `cb` refinement entry | `services/grading-api/grader.py` → `refine_cb_in_warped` |
| Background masking (centering-only) | `grader.mask_background_to_contour` (convex hull) |
| Quad fitting (undershoot origin) | `services/grading-api/card_segmenter.py` → `quad_from_contour` (`approxPolyDP`) |
| Seg selection by area | `card_segmenter.py` → `segment_card` (`SEG_MIN_AREA_FRAC`) |
| Variance detector | `research/notebooks/inner_frame_var.py` (`SEED_W=0`, `CONTENT_W=0`) |
| Detector lab | `research/notebooks/dp_lab.py` → `:8610` (`./run_dp_lab.sh`) |
| Ground-truth labeler | `research/notebooks/label_testcards.py` → `:8620` (`./run_label.sh`) |
| GT labels | `research/notebooks/inner_gt.jsonl` (39 usable + a few test cards) |

### Validation recipe (how the GT numbers above were produced)
For each GT card: `WC.load_warp` → `mask_background_to_contour` → `refine_cb_in_warped` → run the
detector → compare `insets_px` L/R and T/B **ratios** to the labelled `insets_pct` (mean absolute
ratio error in points, averaged over L/R and T/B). Exclude `testing_new_cards` entries (full-art,
noisy). Baseline variance = 12.71; with the balance fix = **5.84**.
