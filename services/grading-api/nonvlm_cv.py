"""
nonvlm_cv.py — Deterministic (non-VLM) card condition feature extractor.

Implements the classical computer-vision pipeline described in
    docs/Non-VLM Card Condition Analysis Framework.docx

The whole point of this module is *comparability*: it emits the SAME locked
feature schema that the Haiku VLM extractor produces
(notebooks/17_final_pipeline-feature-extraction.ipynb / backend/grader.py), so a
non-LLM CV estimate and a VLM estimate of the same card can be diffed
defect-by-defect.

Schema (per card), mirroring the VLM CONDITION_PROMPT:
    corners[top_left|top_right|bottom_right|bottom_left]
            .{whitening, fraying, bending, deformation}   severity 0..4
            .confidence                                    float 0..1
    edges[top|right|bottom|left]
            .{whitening, nick, chip, fraying}              severity 0..4
            .confidence                                    float 0..1
    surface.{scratches, print_lines, dents, creases, holo_disruption, stains}
                                                           severity 0..4
    surface.confidence                                     float 0..1

Severity ordinal:  none=0  trace=1  minor=2  moderate=3  heavy=4

Each detector computes interpretable *raw* measurements (whitening_area_ratio,
blob counts, line counts, circle-fit residuals, ...) exactly as the framework
specifies, then maps the raw magnitude onto the 0..4 ordinal via the tunable
thresholds in CV_THRESHOLDS so it lines up with the VLM's scale.

Centering is fully deterministic in BOTH pipelines (the VLM is explicitly told
not to assess it), so it is treated as a shared front-end here, not part of the
CV-vs-VLM defect comparison.

Honest limitations (single-image, classical CV):
  * whitening / edge wear  -> strong, reliable colour signal (best agreement)
  * bending / deformation  -> single image is a weak proxy (shadow/highlight);
                              multi-light capture is needed for real accuracy
  * surface scratches/lines -> artwork edges masquerade as defects; this is the
                              hardest pillar and the framework recommends an
                              anomaly model (PatchCore/PaDiM) which is out of
                              scope for this classical-CV v1.
These are surfaced in the per-region `confidence` values and documented in the
comparison notebook.
"""

import os
import re
import json
import base64

import numpy as np
import cv2


# ════════════════════════════════════════════════════════════════════════════
# 1. LOCKED FEATURE SCHEMA + VECTORIZER  (identical to the VLM pipeline)
# ════════════════════════════════════════════════════════════════════════════

SEVERITY_MAP = {"none": 0, "trace": 1, "minor": 2, "moderate": 3, "heavy": 4}
SEV_NAME = {v: k for k, v in SEVERITY_MAP.items()}

CORNER_LOCS = ["top_left", "top_right", "bottom_right", "bottom_left"]
CORNER_DEFECTS = ["whitening", "fraying", "bending", "deformation"]
EDGE_LOCS = ["top", "right", "bottom", "left"]
EDGE_DEFECTS = ["whitening", "nick", "chip", "fraying"]
SURFACE_DEFECTS = ["scratches", "print_lines", "dents", "creases",
                   "holo_disruption", "stains"]

# crop name (TL/TR/BR/BL) -> schema corner location
CROP_TO_LOC = {"TL": "top_left", "TR": "top_right",
               "BR": "bottom_right", "BL": "bottom_left"}


def _sev(v):
    """Coerce a severity value (string label OR number) to a float 0..4."""
    if isinstance(v, (int, float)):
        return float(v)
    return float(SEVERITY_MAP.get(str(v).strip().lower(), 0))


def _asdict(x):
    return x if isinstance(x, dict) else {}


def _conf(node, default=0.5):
    try:
        return float(_asdict(node).get("confidence", default))
    except Exception:
        return default


def features_to_vector(cond):
    """Flatten a condition dict (CV or VLM) into the canonical flat numeric row.

    Encoding matches backend/grader.py + notebook 17 exactly:
      - per-defect severity ordinal 0..4
      - per-region confidence as its own column
      - per-pillar aggregates: <pillar>.max, .sum, .n_minor_plus
    Missing/garbled fields default to severity 0 / confidence 0.5, so every row
    is full-width with no NaNs. Pass {} to get the canonical zero-vector / column
    order.
    """
    feat = {}
    for pillar, locs, defects in (("corners", CORNER_LOCS, CORNER_DEFECTS),
                                  ("edges", EDGE_LOCS, EDGE_DEFECTS)):
        block = _asdict(cond.get(pillar))
        vals = []
        for loc in locs:
            node = _asdict(block.get(loc))
            for d in defects:
                s = _sev(node.get(d, "none"))
                feat[f"{pillar}.{loc}.{d}"] = s
                vals.append(s)
            feat[f"{pillar}.{loc}.confidence"] = _conf(node)
        feat[f"{pillar}.max"] = max(vals) if vals else 0.0
        feat[f"{pillar}.sum"] = float(sum(vals))
        feat[f"{pillar}.n_minor_plus"] = float(sum(1 for s in vals if s >= 2))

    surf = _asdict(cond.get("surface"))
    svals = []
    for d in SURFACE_DEFECTS:
        s = _sev(surf.get(d, "none"))
        feat[f"surface.{d}"] = s
        svals.append(s)
    feat["surface.confidence"] = _conf(surf)
    feat["surface.max"] = max(svals) if svals else 0.0
    feat["surface.sum"] = float(sum(svals))
    feat["surface.n_minor_plus"] = float(sum(1 for s in svals if s >= 2))
    return feat


FEATURE_COLUMNS = list(features_to_vector({}).keys())
CENTERING_COLUMNS = ["cen.lr_deviation", "cen.tb_deviation"]

# flat list of every comparable (pillar, location, defect) triple
DEFECT_TRIPLES = (
    [("corners", loc, d) for loc in CORNER_LOCS for d in CORNER_DEFECTS]
    + [("edges", loc, d) for loc in EDGE_LOCS for d in EDGE_DEFECTS]
    + [("surface", None, d) for d in SURFACE_DEFECTS]
)


# ════════════════════════════════════════════════════════════════════════════
# 2. SEVERITY THRESHOLDS  (tunable — map a raw CV magnitude -> ordinal 0..4)
# ════════════════════════════════════════════════════════════════════════════
# Each tuple is (t1, t2, t3, t4) ascending:  m<t1 -> 0(none), <t2 -> 1(trace),
# <t3 -> 2(minor), <t4 -> 3(moderate), else 4(heavy).
# These defaults are heuristic. Use calibrate_thresholds() / the correlation
# analysis in the notebook to tune them against actual PSA grades.
CV_THRESHOLDS = {
    # ── Tuned per "CV Feature Extraction Improvements Specification" (Change 8) ──
    # corners (operate on the 600x600 masked corner crops)
    "corner_whitening":   (0.015, 0.040, 0.090, 0.180),  # MORE sensitive: catch tip whitening
    "corner_fraying":     (0.100, 0.180, 0.300, 0.480),  # pixel-based fraying magnitude
    "corner_deformation": (0.070, 0.120, 0.200, 0.320),  # circle-fit residual / radius
    "corner_bending":     (0.300, 0.420, 0.560, 0.700),  # luminance asymmetry (weak cue)
    # edges (operate on the per-side strips)
    "edge_whitening":     (0.020, 0.060, 0.130, 0.250),  # white area ratio in strip band
    "edge_nick":          (1.0,   3.0,   6.0,   10.0),    # max(white-blob, contour-notch) count
    "edge_chip":          (1.0,   3.0,   6.0,   12.0),    # max(white-blob, contour-missing) count
    "edge_fraying":       (0.080, 0.160, 0.280, 0.450),  # pixel-based fraying magnitude
    # surface (operate on the entire card face)
    "surface_scratches":  (6.0,   14.0,  28.0,  50.0),   # raised: fewer artwork false positives
    "surface_print_lines":(4.0,   9.0,   18.0,  30.0),   # axis-aligned long line count
    "surface_dents":      (2.0,   4.0,   8.0,   14.0),    # dark concavity blob count
    "surface_creases":    (1.0,   2.0,   4.0,   6.0),     # very-long line count
    "surface_stains":     (1.0,   2.0,   4.0,   7.0),     # LAB colour-anomaly blob count
    "surface_holo_disruption": (4.0, 10.0, 20.0, 36.0),  # raised: fewer foil-texture false positives
}


def to_sev(m, t):
    """Map raw magnitude m onto an ordinal severity 0..4 using ascending cuts t."""
    if m < t[0]:
        return 0
    if m < t[1]:
        return 1
    if m < t[2]:
        return 2
    if m < t[3]:
        return 3
    return 4


def thr_key(pillar, defect):
    """(pillar, defect) -> CV_THRESHOLDS key, e.g. ('corners','whitening')->'corner_whitening'."""
    return {"corners": "corner", "edges": "edge", "surface": "surface"}[pillar] + "_" + defect


def vlm_marginal_rates(cache):
    """Per-defect 'none' rate of the cached VLM features -> {thr_key: none_fraction}.

    This is the calibration target: the fraction of cards Haiku reports as
    defect-free for each defect. Calibrating CV cuts to match these rates makes
    the two pipelines comparable at the same base rate.
    """
    import numpy as _np
    counts = {}
    for cond in cache.values():
        for pillar, loc, d in DEFECT_TRIPLES:
            node = cond.get(pillar, {})
            if loc:
                node = node.get(loc, {})
            counts.setdefault(thr_key(pillar, d), []).append(_sev(node.get(d, "none")) == 0)
    return {k: float(_np.mean(v)) for k, v in counts.items()}


def calibrate_thresholds(mags_by_key, none_rate_by_key, tail=(0.40, 0.70, 0.90)):
    """Set per-defect severity cuts from observed CV magnitudes.

    For each defect, t1 is placed at the none_rate percentile of that defect's CV
    magnitude distribution (so CV's none-rate matches the VLM's), and t2..t4 are
    placed across the remaining tail. Defects with no positive magnitude variation
    keep their default cuts.

    Args:
        mags_by_key     : {thr_key: [raw magnitudes over the sample]}
        none_rate_by_key: {thr_key: fraction the VLM calls 'none'} (see vlm_marginal_rates)
    Returns a new thresholds dict (does not mutate CV_THRESHOLDS).
    """
    import numpy as _np
    out = dict(CV_THRESHOLDS)
    for key, mags in mags_by_key.items():
        m = _np.asarray([x for x in mags if x is not None], float)
        if m.size < 8 or _np.allclose(m.max(), m.min()):
            continue
        p0 = 100.0 * float(none_rate_by_key.get(key, 0.85))
        p0 = min(max(p0, 50.0), 99.0)
        cuts = [float(_np.percentile(m, p0))]
        for f in tail:
            cuts.append(float(_np.percentile(m, p0 + (100.0 - p0) * f)))
        # enforce strictly increasing
        for i in range(1, 4):
            if cuts[i] <= cuts[i - 1]:
                cuts[i] = cuts[i - 1] + 1e-4
        out[key] = tuple(cuts)
    return out


# ════════════════════════════════════════════════════════════════════════════
# 3. SHARED GEOMETRY  (card detection + perspective warp, via backend/grader.py)
# ════════════════════════════════════════════════════════════════════════════
# These reuse the EXACT detection/warp the VLM pipeline used, so the CV estimate
# and the (cached) VLM estimate are computed on identical geometry. Requires the
# notebook to have run `sys.path.insert(0, "../backend")` first.

def _grader():
    import grader  # lazy: only needed when detecting real cards
    return grader


_FULL_FRAME_CW = np.array([[0., 0.], [1., 0.], [1., 1.], [0., 1.]], np.float32)

# Canonical warp size for the CV pipeline. CV is free (no token cost), so we
# keep the card near its native resolution instead of the legacy 630x880 that
# was chosen to cut Haiku image tokens. Native PSA-slab photos are ~1200x1600,
# so 1260x1760 (2x of 630x880, same 5:7 aspect) preserves detail with no
# downsampling, while staying FIXED across cards so feature scale is comparable.
# The Haiku pipeline still resizes to 315x440 internally for token cost — that
# is independent of this and unchanged.
CV_WARP_SIZE = (1260, 1760)        # (width, height) for opencv/yolo/resize CV warps
LEGACY_WARP_SIZE = (630, 880)      # seg path keeps this to match cached Haiku geometry

_REF_AREA = float(LEGACY_WARP_SIZE[0] * LEGACY_WARP_SIZE[1])   # 630*880 reference


def _area_scale(h, w):
    """Pixel-area of an image relative to the legacy 630x880 reference.

    Count/blob/line detectors compute on the full-resolution warp for precision,
    but their absolute-pixel floors are multiplied by this factor so the
    resulting counts stay on the SAME scale as the legacy 630x880 pipeline.
    That keeps CV_THRESHOLDS valid and features comparable across resolutions.
    """
    return max(1e-6, (float(h) * float(w)) / _REF_AREA)


# Surface analysis covers the ENTIRE card face (border/frame + content), excluding
# only this thin physical cut-edge margin. It is keyed to the CARD boundary (cb),
# NOT the inner content border — so editing the inner border / centering does not
# change surface features.
SURFACE_EDGE_MARGIN = 0.02   # fraction of card dimension trimmed at the cut edge

# Edge analysis strip = the printed border/frame, anchored at the OUTER boundary (cb)
# and clamped at the content boundary (cr) so it never crosses into the artwork.
# It uses as much border as available, capped at this fraction of the card's min
# dimension; thin borders → smaller strip + lower confidence (see cv_edge_features).
EDGE_STRIP_MAX_FRAC = 0.05   # card-size-scaled max strip depth
EDGE_CUT_SKIP_FRAC = 0.0     # the edge strip TOUCHES the outer boundary (cb) so the
                             # actual physical edge IS analyzed — that's where edge wear
                             # lives. Slab/cut-edge artifacts are handled by the boundary-
                             # confidence features + uniformity_weight at training time,
                             # NOT by skipping the edge. (Set >0 to re-introduce a skip.)


def _find_card_opencv(img):
    """Pure-OpenCV card/slab finder. Returns (quad_4x2, area_fraction) or (None, 0).

    Finds the largest roughly-rectangular object in the photo using edge
    detection + contour analysis. Works for PSA slab photos against most
    backgrounds. No YOLO, no PyTorch — runs in ~20-50ms.

    The returned quad is ordered TL→TR→BR→BL in source pixel coords.
    """
    h, w = img.shape[:2]
    gray  = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    blur  = cv2.GaussianBlur(gray, (5, 5), 0)

    best_quad = None
    best_area = 0.0

    # try several Canny thresholds so we catch cards against any background
    for lo, hi in [(15, 50), (25, 75), (40, 110), (60, 150)]:
        edges = cv2.Canny(blur, lo, hi)
        edges = cv2.dilate(edges, np.ones((3, 3), np.uint8), iterations=2)
        cnts, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)

        for cnt in sorted(cnts, key=cv2.contourArea, reverse=True)[:10]:
            area = cv2.contourArea(cnt)
            if area < 0.08 * h * w:     # must cover ≥ 8% of image
                continue
            if area < best_area:        # already found something bigger
                continue

            hull   = cv2.convexHull(cnt)
            peri   = cv2.arcLength(hull, True)
            approx = cv2.approxPolyDP(hull, 0.025 * peri, True)

            # accept 4-8 sided shapes (perspective distortion can add corners)
            if not (4 <= len(approx) <= 8):
                continue

            # minimum-area bounding rectangle → clean 4 corners
            rect = cv2.minAreaRect(cnt)
            box  = cv2.boxPoints(rect).astype(np.float32)
            s0   = np.linalg.norm(box[0] - box[1])
            s1   = np.linalg.norm(box[1] - box[2])
            if max(s0, s1) < 1e-6:
                continue
            ar = min(s0, s1) / max(s0, s1)
            if ar < 0.35:               # too thin (e.g. a table edge)
                continue

            best_quad = box
            best_area = area

    if best_quad is None:
        return None, 0.0

    # order corners: TL (min sum) → TR (max diff) → BR (max sum) → BL (min diff)
    sums  = best_quad.sum(axis=1)
    diffs = best_quad[:, 0] - best_quad[:, 1]
    ordered = np.array([
        best_quad[np.argmin(sums)],
        best_quad[np.argmax(diffs)],
        best_quad[np.argmax(sums)],
        best_quad[np.argmin(diffs)],
    ], dtype=np.float32)

    return ordered, float(best_area / (h * w))


def detect_and_warp(img, detector=None, out_size=None):
    """Detect + perspective-warp a card. Returns a det dict.

    detector options:
      "opencv"  — pure-OpenCV contour detection (~50ms, no ML). Finds the
                  largest rectangular object (card or PSA slab). Best choice
                  for unprocessed card photos with a contrasting background.
                  Falls back to "resize" if detection fails.
      "resize"  — instant: just resize. Only use when the card already fills
                  the entire frame with no background.
      "yolo"    — local YOLO weights. First call triggers 2–5 min PyTorch JIT.
      "seg"     — Roboflow Model C API call. Matches the cached VLM warps.
    Defaults to env CARD_DETECTOR or "seg".

    out_size: (width, height) of the warped card. If None, the CV detectors
      (opencv/resize/yolo) use full-resolution CV_WARP_SIZE; the seg detector
      uses LEGACY_WARP_SIZE (630x880) to stay aligned with the cached Haiku run.
    """
    detector = (detector or os.environ.get("CARD_DETECTOR", "seg")).lower()
    # CV paths default to full resolution; seg keeps the legacy Haiku geometry
    cv_w, cv_h = out_size or CV_WARP_SIZE

    # ── "opencv" detector: contour-based, no ML ──────────────────────────
    if detector == "opencv":
        quad, area_frac = _find_card_opencv(img)
        if quad is not None:
            target = np.array([[0, 0], [cv_w - 1, 0], [cv_w - 1, cv_h - 1],
                               [0, cv_h - 1]], dtype=np.float32)
            M      = cv2.getPerspectiveTransform(quad, target)
            warped = cv2.warpPerspective(img, M, (cv_w, cv_h),
                                          flags=cv2.INTER_LANCZOS4)
            h_in, w_in = img.shape[:2]
            cw = (quad / np.array([w_in, h_in], dtype=np.float32)
                  ).clip(0, 1).astype(np.float32)
            return {"orig": img, "contour_orig": quad,
                    "warped": warped, "cb": [0.0, 0.0, 1.0, 1.0], "cw": cw,
                    "quad_raw": quad, "quad_padded": quad,
                    "detector": "opencv", "seg_conf": round(area_frac, 3)}
        import warnings
        warnings.warn("OpenCV card detection failed — falling back to resize. "
                      "Check that the card occupies a reasonable portion of the photo.")
        detector = "resize"

    # ── "resize" fast path: no ML, no YOLO, instant ──────────────────────
    if detector == "resize":
        h_in, w_in = img.shape[:2]
        warped = cv2.resize(img, (cv_w, cv_h), interpolation=cv2.INTER_LANCZOS4)
        cb = [0.0, 0.0, 1.0, 1.0]   # card fills the full frame
        return {"orig": img, "contour_orig": np.array(
                    [[0, 0], [w_in, 0], [w_in, h_in], [0, h_in]], float),
                "warped": warped, "cb": cb, "cw": _FULL_FRAME_CW,
                "quad_raw": None, "quad_padded": None,
                "detector": "resize", "seg_conf": 1.0}

    g = _grader()
    is_seg = False
    try:
        if detector == "yolo":
            qr, contour, meta = g._detect_yolo(img)
        else:
            qr, contour, meta = g._detect_seg(img); is_seg = True
    except Exception as exc:
        qr, contour, meta = g._detect_yolo(img); is_seg = False
        meta = {**meta, "_seg_fallback": str(exc)[:80]} if isinstance(meta, dict) else {}

    # seg keeps legacy 630x880 (cached-Haiku geometry); yolo uses full resolution
    out_w, out_h = out_size or (LEGACY_WARP_SIZE if is_seg else CV_WARP_SIZE)
    pad = g.adaptive_padding(qr, padding_frac=g.PADDING_FRAC)
    c = qr.mean(0)
    d = qr - c
    qp = qr + (d / np.linalg.norm(d, axis=1, keepdims=True).clip(min=1)) * pad
    warped = g._warp_card(img, qp, out_w=out_w, out_h=out_h)
    _, cb = g.card_boundary_analytical(qr, qp)
    # YOLO has no contour: the warped card fills the frame, so use a full-frame
    # rectangle (mask = whole card, corner crops centred on the frame corners).
    cw = g._contour_to_warped_norm(contour, qp) if contour is not None else _FULL_FRAME_CW
    return {"orig": img, "contour_orig": np.asarray(contour if contour is not None else qr, float),
            "warped": warped, "cb": cb, "cw": cw,
            "quad_raw": qr, "quad_padded": qp,
            "detector": meta.get("_detector", detector),
            "seg_conf": meta.get("_seg_conf", meta.get("_yolo_conf", 0))}


def corner_crops(det, out_size=600, crop_frac=0.22):
    """4 masked corner crops (TL/TR/BR/BL) centred on the true rounded corners."""
    return _grader()._build_corner_crops_from_contour(
        det["warped"], det["cw"], det["cb"], out_size=out_size, crop_frac=crop_frac)


def card_mask_warped(det):
    """Binary mask (255 = on-card) of the seg contour in warped space."""
    h, w = det["warped"].shape[:2]
    m = np.zeros((h, w), np.uint8)
    cw = np.asarray(det.get("cw"), np.float32)
    if cw.ndim == 2 and len(cw) >= 3:
        cv2.fillPoly(m, [(cw * [w, h]).astype(np.int32)], 255)
    else:
        x1, y1, x2, y2 = [int(round(v * d)) for v, d in zip(det["cb"], [w, h, w, h])]
        m[y1:y2, x1:x2] = 255
    return m


# ════════════════════════════════════════════════════════════════════════════
# 4. CENTERING  (deterministic; shared by both pipelines — NOT a VLM defect)
# ════════════════════════════════════════════════════════════════════════════
# Ported from notebook 17 so the CV pipeline is self-contained.

MIN_LR, MAX_LR = 0.003, 0.15
MIN_TB, MAX_TB = 0.003, 0.15
CORNER_EXCL = 0.18
SMOOTH = 10
COLOR_SAMPLE_DEPTH = 3
CV_THRESHOLD_FRAC = 0.22


def color_vote_wide(warped, cb, threshold_frac=CV_THRESHOLD_FRAC):
    """LAB colour-departure scan -> inner printed boundary (border->artwork edge)."""
    h, w = warped.shape[:2]
    lab = cv2.cvtColor(warped, cv2.COLOR_BGR2LAB).astype(np.float32)
    x1, y1, x2, y2 = [int(round(v * d)) for v, d in zip(cb, [w, h, w, h])]
    iw, ih = x2 - x1, y2 - y1
    cx, cy = int(iw * CORNER_EXCL), int(ih * CORNER_EXCL)
    lox, hix = int(iw * MIN_LR), int(iw * MAX_LR)
    loy, hiy = int(ih * MIN_TB), int(ih * MAX_TB)
    sd = max(1, COLOR_SAMPLE_DEPTH)
    sm = lambda a: np.convolve(a, np.ones(max(1, SMOOTH)) / max(1, SMOOTH), mode="same")

    def first_cross(p):
        p = sm(p)
        lo = p[:max(1, len(p) // 8)].mean()
        hi = p.max()
        rng = hi - lo
        if rng > 3.0:
            thresh = lo + max(6.0, threshold_frac * rng)
            hits = np.where(p >= thresh)[0]
            if len(hits):
                return int(hits[0]), p
        grad = np.diff(p)
        k = max(3, len(grad) // 20)
        grad_s = np.convolve(grad, np.ones(k, dtype=np.float32) / k, mode="same")
        limit = max(1, len(grad_s) * 2 // 3)
        peak = int(np.argmax(grad_s[:limit]))
        return max(0, peak + 1), p

    def cdp(s):
        ref = s[:sd].mean(axis=(0, 1))
        return sm(np.linalg.norm(s.mean(axis=1) - ref, axis=1))

    ot, _ = first_cross(cdp(lab[y1 + loy:y1 + hiy, x1 + cx:x2 - cx]))
    ob, _ = first_cross(cdp(lab[y2 - hiy:y2 - loy, x1 + cx:x2 - cx][::-1]))
    ol, _ = first_cross(cdp(lab[y1 + cy:y2 - cy, x1 + lox:x1 + hix].transpose(1, 0, 2)))
    orr, _ = first_cross(cdp(lab[y1 + cy:y2 - cy, x2 - hix:x2 - lox][:, ::-1].transpose(1, 0, 2)))

    max_h = int(iw * 0.13)
    max_v = int(ih * 0.13)
    ol, orr = min(ol, max_h), min(orr, max_h)
    ot, ob = min(ot, max_v), min(ob, max_v)
    return {"x1": (x1 + lox + ol) / w, "y1": (y1 + loy + ot) / h,
            "x2": (x2 - lox - orr) / w, "y2": (y2 - loy - ob) / h}


def _centering_from_cr(cb, cr):
    x1, y1, x2, y2 = cb
    cx1 = max(x1, min(x2, cr["x1"]))
    cx2 = max(x1, min(x2, cr["x2"]))
    cy1 = max(y1, min(y2, cr["y1"]))
    cy2 = max(y1, min(y2, cr["y2"]))
    bl = max(0., cx1 - x1)
    br = max(0., x2 - cx2)
    bt = max(0., cy1 - y1)
    bb = max(0., y2 - cy2)
    lr = int(round(bl / (bl + br) * 100)) if (bl + br) > 1e-6 else 50
    tb = int(round(bt / (bt + bb) * 100)) if (bt + bb) > 1e-6 else 50
    worst = max(abs(50 - lr), abs(50 - tb))
    s = (10 if worst <= 5 else 9 if worst <= 10 else 8 if worst <= 15 else 7 if worst <= 20
         else 6 if worst <= 25 else 5 if worst <= 30 else 4 if worst <= 35 else 3)
    return {"score": float(s), "left_right": f"{lr}/{100 - lr}",
            "top_bottom": f"{tb}/{100 - tb}"}


def _side_insets(cb, cr):
    x1, y1, x2, y2 = cb
    iw, ih = x2 - x1, y2 - y1
    return {"L": max(0., (cr["x1"] - x1)) / iw, "R": max(0., (x2 - cr["x2"])) / iw,
            "T": max(0., (cr["y1"] - y1)) / ih, "B": max(0., (y2 - cr["y2"])) / ih}


def _plausible(cb, cr, min_pct=0.003, max_pct=0.16):
    ins = _side_insets(cb, cr)
    return all(min_pct <= v <= max_pct for v in ins.values())


def _reconcile(cb, cr_an, cr_cv, agree_tol=0.03, min_pct=0.005, max_pct=0.14):
    """Per-side merge of analytical + color_vote (take smaller on disagreement)."""
    x1, y1, x2, y2 = cb
    iw, ih = x2 - x1, y2 - y1
    a = _side_insets(cb, cr_an) if cr_an else None
    c = _side_insets(cb, cr_cv) if cr_cv else None
    if a is None and c is None:
        return None, "none"
    if a is None:
        return dict(cr_cv), "color_vote only"
    if c is None:
        return dict(cr_an), "analytical only"
    merged, notes = {}, {}
    for side in "LRTB":
        av, cv = a[side], c[side]
        a_ok = min_pct <= av <= max_pct
        c_ok = min_pct <= cv <= max_pct
        if a_ok and c_ok:
            merged[side] = min(av, cv) if abs(av - cv) > agree_tol else (av + cv) / 2
            notes[side] = "min" if abs(av - cv) > agree_tol else "avg"
        elif a_ok:
            merged[side] = av; notes[side] = "an"
        elif c_ok:
            merged[side] = cv; notes[side] = "cv"
        else:
            merged[side] = min(av, cv); notes[side] = "min!"
    cr = {"x1": x1 + merged["L"] * iw, "x2": x2 - merged["R"] * iw,
          "y1": y1 + merged["T"] * ih, "y2": y2 - merged["B"] * ih}
    return cr, " ".join(f"{k}:{notes[k]}" for k in "LRTB")


def _overextension_guard(cb, cr, mult=3.0, abs_min=0.07):
    """Catch single-side over-extension on low-contrast / gradual borders.

    The colour-departure scan can run past a gradual border into the artwork on
    ONE side (e.g. vintage cream→yellow→content edges), giving an inset many
    times larger than the other three sides. A real printed frame is roughly the
    same width on all sides (centering shifts it, but rarely by 3x+), so a side
    whose inset exceeds BOTH mult*median(other sides) AND abs_min is almost
    certainly an over-extension error. We clamp it toward a plausible bound and
    flag the card so downstream grading down-weights it.

    Conservative by design: triggers ONLY on gross outliers, so well-centered
    and normally off-centre cards (all sides similar) are never touched.
    Returns (content_region, flagged).
    """
    x1, y1, x2, y2 = cb
    iw, ih = x2 - x1, y2 - y1
    ins = _side_insets(cb, cr)
    new = dict(ins)
    flagged = False
    for side in "LRTB":
        others = [ins[s] for s in "LRTB" if s != side]
        med = float(np.median(others))
        if ins[side] > max(mult * med, abs_min):
            new[side] = max(2.0 * med, med + 0.02)   # bring in line, keep some asymmetry
            flagged = True
    if not flagged:
        return cr, False
    cr2 = {"x1": x1 + new["L"] * iw, "x2": x2 - new["R"] * iw,
           "y1": y1 + new["T"] * ih, "y2": y2 - new["B"] * ih}
    return cr2, True


def compute_centering_hybrid(warped, cb):
    """Hybrid analytical + color_vote centering with per-side reconciliation."""
    g = _grader()
    try:
        an = g.analytical_centering(warped, cb)
    except Exception:
        an = None
    bt = (an or {}).get("border_type", "unknown")
    cr_an = an.get("content_region") if an else None
    cr_cv = color_vote_wide(warped, cb)
    cr, side_note = _reconcile(cb, cr_an, cr_cv)
    if cr is None:
        cr, side_note = cr_cv, "fallback color_vote"
    # guard against single-side over-extension on gradual/low-contrast borders
    cr, overext = _overextension_guard(cb, cr)
    if overext:
        side_note += " +oguard"
    geo = _centering_from_cr(cb, cr)
    return {**geo, "content_region": cr, "source": f"reconciled ({side_note})",
            "border_type": bt, "reliable": _plausible(cb, cr) and not overext,
            "overextension_guard": overext,
            "_cr_analytical": cr_an,   # palette-match inner border (may be None)
            "_cr_color_vote": cr_cv,   # LAB color-vote inner border
            "_an_score": an.get("score") if an else None}


# ════════════════════════════════════════════════════════════════════════════
# 5. NON-VLM CV DETECTORS
# ════════════════════════════════════════════════════════════════════════════

def _white_mask(bgr):
    """Absolute worn-cardstock mask: bright + low-saturation (white/gray)."""
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV)
    V = hsv[:, :, 2]
    S = hsv[:, :, 1]
    return (((V > 175) & (S < 45)) | ((V > 150) & (S < 28))).astype(np.uint8)


def _relative_whitening(bgr, edge_mask, ref_mask):
    """Whitening RELATIVE to the intact border just inward.

    Worn cardstock exposed at the physical edge is lighter (higher L) and less
    saturated (lower S) than the card's own intact border a little further in.
    Measuring the edge against that local reference naturally yields ~0 when the
    border itself is white/silver — which fixes the dominant classical-CV false
    positive (a white printed border read as heavy whitening). Returns
    (area_ratio, largest_blob_ratio, white_mask).
    """
    edge_mask = edge_mask.astype(bool)
    ref_mask = ref_mask.astype(bool)
    if edge_mask.sum() < 20 or ref_mask.sum() < 20:
        return 0.0, 0.0, np.zeros(bgr.shape[:2], np.uint8)
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    hsv = cv2.cvtColor(bgr, cv2.COLOR_BGR2HSV).astype(np.float32)
    L, S = lab[:, :, 0], hsv[:, :, 1]
    refL = float(np.median(L[ref_mask]))
    refS = float(np.median(S[ref_mask]))
    # worn cardstock is (a) MARKEDLY lighter + less saturated than the intact
    # border AND (b) absolutely bright/near-white. The large relative jump stops
    # a white border's edge-lighting gradient from reading as whitening; the
    # absolute floor stops a light rim against dark full-art edges.
    white = edge_mask & (L > refL + 18) & (L > 165) & (S < max(refS * 0.6, 25.0))
    wb = white.astype(np.uint8)
    area = float(edge_mask.sum()) or 1.0
    wr = float(wb.sum()) / area
    n, _, st, _ = cv2.connectedComponentsWithStats(wb, 8)
    largest = (float(st[1:, cv2.CC_STAT_AREA].max()) / area) if n > 1 else 0.0
    return wr, largest, wb


def _band_colorstd(bgr, band_mask):
    """Mean LAB std within the edge band — a full-art / foil-confound discriminator.

    A uniform printed border has low colour variance in its edge band; full-art or
    foil that runs to the edge has high variance. Whitening can only be reliably
    measured against a uniform border, so its magnitude is discounted where this
    is high (see cv_edge_features / cv_corner_features). Returns LAB std (0..~40).
    """
    m = band_mask.astype(bool)
    if int(m.sum()) < 30:
        return 0.0
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB).astype(np.float32)
    return float(lab[m].std(axis=0).mean())


def _uniformity_weight(colorstd, lo=8.0, span=16.0, floor=0.05):
    """Whitening discount: 1.0 for a uniform border (low std), → floor for full-art
    (high std). lo=where discount starts, span=full-discount range above lo.
    Tuned so a clean border (std≈7) keeps full weight while full-art/foil edges
    (std≳24) are suppressed to ~floor."""
    return float(np.clip(1.0 - max(0.0, colorstd - lo) / span, floor, 1.0))


# ---- Module 2: Corners -------------------------------------------------------

def _corner_circle_residual(mask, name):
    """Fit a circle to the rounded-corner contour near the tip; return residual/radius."""
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts:
        return 0.0
    c = max(cnts, key=cv2.contourArea).reshape(-1, 2).astype(np.float32)
    H, W = mask.shape
    tx = 0 if "L" in name else W
    ty = 0 if "T" in name else H
    d = np.hypot(c[:, 0] - tx, c[:, 1] - ty)
    k = max(8, len(c) // 4)
    pts = c[np.argsort(d)[:k]]
    if len(pts) < 6:
        return 0.0
    x, y = pts[:, 0], pts[:, 1]
    A = np.c_[2 * x, 2 * y, np.ones(len(x))]
    b = x * x + y * y
    try:
        sol, *_ = np.linalg.lstsq(A, b, rcond=None)
        cx, cy, c0 = sol
        r = np.sqrt(max(c0 + cx * cx + cy * cy, 0.0))
    except Exception:
        return 0.0
    if not np.isfinite(r) or r < 1:
        return 0.0
    resid = np.abs(np.hypot(x - cx, y - cy) - r)
    return float(np.clip(resid.mean() / (r + 1e-6), 0, 1))


def _corner_bend_score(gray, mask, name):
    """Single-image bend proxy: luminance ASYMMETRY between the two edge arms.

    A flat (unbent) corner has near-uniform border luminance, so the horizontal
    arm (top/bottom edge band) and the vertical arm (left/right edge band) read
    similarly. A bent corner catches light or casts a shadow on one arm, breaking
    that symmetry. This is a weak single-image cue — multi-light capture is needed
    for reliable bending detection (see framework Module 2) — so it is paired with
    conservative thresholds and low confidence.
    """
    H, W = gray.shape
    band = max(6, int(0.12 * min(H, W)))
    g = gray.astype(np.float32)
    harm = (g[:band, :], mask[:band, :] > 0) if "T" in name else (g[H - band:, :], mask[H - band:, :] > 0)
    varm = (g[:, :band], mask[:, :band] > 0) if "L" in name else (g[:, W - band:], mask[:, W - band:] > 0)
    if harm[1].sum() < 30 or varm[1].sum() < 30:
        return 0.0
    return float(np.clip(abs(harm[0][harm[1]].mean() - varm[0][varm[1]].mean()) / 255.0, 0, 1))


def _contour_roughness(mask):
    """Roughness of the silhouette contour: mean residual from its smoothed self,
    normalized so 1% of the crop diagonal == 1.0. ~0 for a clean/smooth edge.

    NB: the corner crops are masked with the Roboflow-SMOOTHED seg contour, so
    fiber-level fraying is largely smoothed away here — CV will under-report
    fraying. Reliable fraying detection needs unmasked high-resolution edge pixels.
    """
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    if not cnts:
        return 0.0
    c = max(cnts, key=cv2.contourArea).reshape(-1, 2).astype(np.float32)
    if len(c) < 30:
        return 0.0
    k = max(5, len(c) // 40)
    ker = np.ones(k) / k
    # circular smoothing (the contour is closed) to avoid end artifacts
    xp = np.r_[c[-k:, 0], c[:, 0], c[:k, 0]]
    yp = np.r_[c[-k:, 1], c[:, 1], c[:k, 1]]
    sx = np.convolve(xp, ker, "same")[k:-k]
    sy = np.convolve(yp, ker, "same")[k:-k]
    resid = np.hypot(c[:, 0] - sx, c[:, 1] - sy)
    diag = float(np.hypot(*mask.shape))
    return float(np.clip(resid.mean() / (0.01 * diag), 0, 1))


def _band_fraying(gray, band_mask, asc=1.0):
    """Pixel-based fraying from a thin physical-edge band (spec Change 4).

    Replaces smoothed-segmentation-contour roughness — which cannot see
    fiber-level fuzz — with the high-frequency roughness of the actual IMAGE edge
    line (Canny), measured in the band just inside the physical edge. A clean,
    straight printed edge gives a flat edge line -> ~0; fraying makes the edge
    line wiggle at fiber scale -> high. (Raw Canny *density* alone is a poor cue
    because the clean straight edge itself is a strong continuous Canny response.)
    Returns (fraying_mag 0-1, fiber_count, edge_jaggedness_px, edge_high_freq_energy).
    """
    bm = band_mask.astype(bool)
    area = int(bm.sum())
    vmask = np.zeros(bm.shape, np.uint8)              # localized fraying pixels (fibers + wavy edge line)
    if area < 30:
        return 0.0, 0, 0.0, 0.0, vmask
    g = gray if gray.dtype == np.uint8 else np.clip(gray, 0, 255).astype(np.uint8)
    edges = (cv2.Canny(cv2.GaussianBlur(g, (3, 3), 0), 40, 120) > 0) & bm
    hf_energy = float(edges.sum()) / area
    sc = float(np.sqrt(asc))
    # fiber_count = small isolated Canny components (paper fuzz / protrusions)
    n, lbl, st, _ = cv2.connectedComponentsWithStats(edges.astype(np.uint8), 8)
    hi = max(6, int(round(20 * asc)))
    fiber_ids = [i for i in range(1, n) if 2 <= st[i, cv2.CC_STAT_AREA] <= hi]
    fiber_count = len(fiber_ids)
    if fiber_ids:
        vmask |= np.isin(lbl, fiber_ids).astype(np.uint8)   # the fuzz/protrusion blobs
    # image edge line = topmost Canny pixel per column; its high-freq roughness
    active = np.where(edges.any(axis=0))[0]
    if active.size < 8:
        return 0.0, fiber_count, 0.0, round(hf_energy, 4), vmask
    prof = np.argmax(edges[:, active], axis=0).astype(np.float32)
    k = max(3, len(prof) // 30)
    sm = np.convolve(prof, np.ones(k, np.float32) / k, mode="same")
    dev = np.abs(prof - sm)
    jag = float(np.std(prof - sm))                    # px high-freq roughness of the edge line
    wavy = active[dev > max(0.95 * sc, 1.0)]          # columns where the edge line deviates = wiggle
    vmask[prof[dev > max(0.95 * sc, 1.0)].astype(int).clip(0, bm.shape[0] - 1), wavy] = 1
    # calibrated so a clean straight printed edge -> ~0 (none); fraying -> minor+
    mag = float(np.clip(max(0.0, jag - 0.95 * sc) / (9.0 * sc), 0.0, 1.0))
    return mag, fiber_count, round(jag, 3), round(hf_energy, 4), vmask


def cv_corner_features(crop, name, thr=CV_THRESHOLDS):
    """Deterministic corner condition features for one masked corner crop.

    Returns dict with schema severities {whitening, fraying, bending, deformation,
    confidence} plus a 'raw' sub-dict of the framework's measurements.
    """
    H, W = crop.shape[:2]
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    mask = ((gray > 4).astype(np.uint8)) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    valid_frac = float(mask.mean()) / 255.0

    raw = {"valid_frac": round(valid_frac, 3)}
    if valid_frac < 0.05:
        return {"whitening": 0, "fraying": 0, "bending": 0, "deformation": 0,
                "confidence": 0.2, "raw": raw}

    # edge band = ring just inside the physical edge; ref band = intact border
    # one ring further in (used as the local colour reference for whitening).
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    band_px = max(4, int(0.10 * min(H, W)))
    edge_band = ((dist > 0) & (dist <= band_px)).astype(np.uint8)
    ref_band = ((dist > band_px) & (dist <= 2 * band_px)).astype(np.uint8)
    band_area = int(edge_band.sum()) or 1

    asc_c = _area_scale(H, W)

    # --- whitening, measured relative to the intact border (handles white borders) ---
    wr, largest, wb = _relative_whitening(crop, edge_band > 0, ref_band > 0)
    n_lbl = cv2.connectedComponentsWithStats(wb, 8)[0]
    raw["whitening_area_ratio"] = round(wr, 4)
    raw["largest_whitening_blob"] = round(largest, 4)
    raw["whitening_blob_count"] = int(n_lbl - 1)

    # tip whitening (spec Change 1): whitening right at the physical corner tip is
    # weighted more heavily than whitening further along the edge. Locate the apex
    # from the mask (extreme card pixel in the corner's outward diagonal), then
    # measure the white fraction within ~one band of it.
    ys_c, xs_c = np.where(mask > 0)
    tip_present, tip_frac = False, 0.0
    if xs_c.size:
        # apex = extreme card pixel in the corner's outward diagonal ("L"/"T" in name)
        key = (1 if "L" in name else -1) * xs_c + (1 if "T" in name else -1) * ys_c
        ti = int(np.argmin(key))
        tipx, tipy = int(xs_c[ti]), int(ys_c[ti])
        yy, xx = np.mgrid[0:H, 0:W]
        tip_zone = np.hypot(xx - tipx, yy - tipy) <= band_px
        tz = int(tip_zone.sum()) or 1
        tip_white = int((wb.astype(bool) & tip_zone).sum())
        tip_frac = float(tip_white) / tz
        tip_present = tip_white >= max(3, int(round(2 * asc_c)))
    raw["tip_whitening_present"] = int(tip_present)
    raw["tip_whitening_frac"] = round(tip_frac, 4)

    # full-art/foil guard: whitening can't be told from full-bleed artwork at the
    # corner, so discount it where the edge band is high-variance (artwork-like)
    # rather than a uniform printed border.
    cstd = _band_colorstd(crop, edge_band > 0)
    uw = _uniformity_weight(cstd)
    raw["edge_colorstd"] = round(cstd, 2)
    raw["uniformity_weight"] = round(uw, 3)
    raw["_viz"] = {"white_mask": wb}   # for the verify() overlay (skipped by raw_to_vector)
    # localized worn spots dominate; tip whitening adds a weighted bonus; ×uniformity
    w_mag = (0.6 * largest + 0.4 * min(wr, 0.5) + 0.6 * tip_frac) * uw
    whitening = to_sev(w_mag, thr["corner_whitening"])

    # --- fraying: silhouette-contour roughness. The spec's pixel-edge-band method
    #     (Change 4) models a STRAIGHT edge; a rounded corner's curvature would read
    #     as fraying, so corners keep the contour-roughness measure (with the spec's
    #     raised threshold). Pixel-based fraying is applied to the straight EDGES. ---
    fray = _contour_roughness(mask) * uw   # discount on artwork/foil corners (same guard)
    raw["fraying_score"] = round(fray, 4)
    fraying = to_sev(fray, thr["corner_fraying"])

    # --- deformation (circle-fit residual at the tip) ---
    dev = _corner_circle_residual(mask, name)
    raw["curve_deviation_score"] = round(dev, 4)
    deformation = to_sev(dev, thr["corner_deformation"])

    # --- bending (single-image luminance asymmetry proxy; weak — low confidence) ---
    bend = _corner_bend_score(gray, mask, name)
    raw["bend_shadow_score"] = round(bend, 4)
    bending = to_sev(bend, thr["corner_bending"])

    raw["_mag"] = {"whitening": w_mag, "fraying": fray, "bending": bend, "deformation": dev}
    conf = float(np.clip(0.35 + 0.5 * valid_frac, 0.3, 0.85))
    return {"whitening": whitening, "fraying": fraying, "bending": bending,
            "deformation": deformation, "confidence": round(conf, 2), "raw": raw}


# ---- Module 3: Edges ---------------------------------------------------------

EDGE_ROT = {"top": 0, "right": 1, "bottom": 2, "left": 3}  # np.rot90 k -> side at top


def _edge_boundary_conf(warped, cb, side):
    """Per-side confidence that Model-C's OUTER boundary is a TRUE, well-localized
    card edge (vs a cut-edge/slab artifact or a mislocated seg boundary). Computed
    by straddling the cb line on this side and measuring:
      grad  — luminance contrast across the boundary (real card→slab edge → high)
      sharp — how concentrated that gradient is (crisp step → high)
      jitter— per-column scatter of the gradient peak (straight, consistent → low)
      unif  — uniformity of the region just OUTSIDE cb (clean slab/background → high)
      avail — fraction of the requested outside margin actually present in the warp
    Returns these as raw features (+ a combined boundary_conf). Additive, for the
    model to learn how much to trust this side's edge features.
    """
    H, W = warped.shape[:2]
    x1, y1, x2, y2 = [int(round(v * d)) for v, d in zip(cb, [W, H, W, H])]
    g = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY).astype(np.float32)
    REQ = max(8, int(round(0.012 * min(x2 - x1, y2 - y1))))
    ce = 0.12
    zero = {"boundary_grad": 0.0, "boundary_sharp": 0.0, "boundary_jitter": 1.0,
            "boundary_unif": 0.0, "boundary_avail": 0.0, "boundary_conf": 0.0}
    if side in ("top", "bottom"):
        c0, c1 = x1 + int(ce * (x2 - x1)), x2 - int(ce * (x2 - x1))
        bpos = y1 if side == "top" else y2
        (o0, o1) = (max(0, bpos - REQ), bpos) if side == "top" else (bpos, min(H, bpos + REQ))
        (i0, i1) = (bpos, bpos + REQ) if side == "top" else (bpos - REQ, bpos)
        outside, inside = g[o0:o1, c0:c1], g[i0:i1, c0:c1]
        prof = g[max(0, bpos - REQ):min(H, bpos + REQ), c0:c1]            # (perp, along)
        avail = o1 - o0
    else:
        d0, d1 = y1 + int(ce * (y2 - y1)), y2 - int(ce * (y2 - y1))
        bpos = x1 if side == "left" else x2
        (o0, o1) = (max(0, bpos - REQ), bpos) if side == "left" else (bpos, min(W, bpos + REQ))
        (i0, i1) = (bpos, bpos + REQ) if side == "left" else (bpos - REQ, bpos)
        outside, inside = g[d0:d1, o0:o1], g[d0:d1, i0:i1]
        prof = g[d0:d1, max(0, bpos - REQ):min(W, bpos + REQ)].T          # (perp, along)
        avail = o1 - o0
    if outside.size < 20 or inside.size < 20 or prof.shape[0] < 4 or prof.shape[1] < 10:
        return {**zero, "boundary_avail": round(avail / max(1, REQ), 3)}
    grad = float(np.clip(abs(float(outside.mean()) - float(inside.mean())) / 60.0, 0, 1))
    unif = float(np.clip(1.0 - float(outside.std()) / 40.0, 0, 1))
    dP = np.abs(np.diff(prof, axis=0))
    jitter = float(np.clip(float(np.std(np.argmax(dP, axis=0))) / max(1.0, REQ), 0, 1))
    pk, tot = dP.max(axis=0), dP.sum(axis=0) + 1e-6
    sharp = float(np.clip(float(np.mean(pk / tot)) * prof.shape[0] / 3.0, 0, 1))
    av = float(np.clip(avail / max(1, REQ), 0, 1))
    conf = (0.40 * grad + 0.25 * (1 - jitter) + 0.20 * sharp + 0.15 * unif) * (0.5 + 0.5 * av)
    return {"boundary_grad": round(grad, 3), "boundary_sharp": round(sharp, 3),
            "boundary_jitter": round(jitter, 3), "boundary_unif": round(unif, 3),
            "boundary_avail": round(av, 3), "boundary_conf": round(float(np.clip(conf, 0, 1)), 3)}


def cv_edge_features(warped, mask, cb, cr, side, thr=CV_THRESHOLDS):
    """Deterministic edge condition features for one side strip.

    The analysis strip is the printed border/frame: anchored at the OUTER card
    boundary `cb`, it uses as much border as is available (cb→cr), capped at
    EDGE_STRIP_MAX_FRAC of the card, and NEVER crosses into the content region
    `cr`. Thin borders shrink the strip and lower the confidence; a too-thin /
    borderless edge returns 'none' with low confidence rather than reading artwork.

    Returns {whitening, nick, chip, fraying, confidence, raw}.
    """
    H, W = warped.shape[:2]
    # bbox of the cw-based card MASK bounds the strip region; the band itself FOLLOWS
    # the true card edge per column (below), so the rounded corners / slope / wiggle
    # are respected and the band never overshoots into slab.
    ys_m, xs_m = np.where(mask > 0)
    if xs_m.size < 100:
        return {"whitening": 0, "nick": 0, "chip": 0, "fraying": 0,
                "confidence": 0.3, "raw": {"note": "no card mask"}}
    x1, y1, x2, y2 = int(xs_m.min()), int(ys_m.min()), int(xs_m.max()) + 1, int(ys_m.max()) + 1
    iw, ih = x2 - x1, y2 - y1
    if iw < 20 or ih < 20:
        return {"whitening": 0, "nick": 0, "chip": 0, "fraying": 0,
                "confidence": 0.3, "raw": {}}

    edge_box = [x1 / W, y1 / H, x2 / W, y2 / H]     # normalized TRUE-edge bbox
    bconf = _edge_boundary_conf(warped, edge_box, side)   # boundary quality AT the true edge
    sub = warped[y1:y2, x1:x2]
    msub = (mask[y1:y2, x1:x2] > 0).astype(np.uint8)
    k = EDGE_ROT[side]
    sub = np.ascontiguousarray(np.rot90(sub, k))
    msub = np.ascontiguousarray(np.rot90(msub, k))
    hh, ww = msub.shape

    # ── border-bounded strip: anchored at the OUTER edge (cb), uses as much border
    #    as available (cb→cr), capped at a card-scaled max, NEVER crossing cr. ──────
    crx1, cry1, crx2, cry2 = cr["x1"] * W, cr["y1"] * H, cr["x2"] * W, cr["y2"] * H
    border_px = {"top": cry1 - y1, "bottom": y2 - cry2,
                 "left": crx1 - x1, "right": x2 - crx2}[side]
    border_px = max(0.0, float(border_px))
    cut = int(round(EDGE_CUT_SKIP_FRAC * min(iw, ih)))           # 0 ⇒ strip touches the outer edge (cb)
    max_px = EDGE_STRIP_MAX_FRAC * min(iw, ih)                    # card-size-scaled cap
    usable = border_px - cut                                     # border left after the cut-edge skip
    strip = int(round(min(max(usable, 0.0), max_px)))            # cut+strip ≤ border ⇒ never crosses cr
    strip = min(strip, hh - cut - 2)
    conf_geom = float(np.clip(strip / (max_px + 1e-6), 0.0, 1.0))
    ce = int(0.12 * ww)                                   # drop corner ends (counted by corners)
    sub = sub[:, ce:ww - ce]
    msub = msub[:, ce:ww - ce]
    if strip < 4 or sub.shape[1] < 10:                    # borderless / no usable border after cut skip
        return {"whitening": 0, "nick": 0, "chip": 0, "fraying": 0, "confidence": 0.2,
                "raw": {"border_px": round(border_px, 1), "strip_px": int(strip), "cut_px": cut,
                        "conf_geom": round(conf_geom, 3), "note": "border too thin/absent", **bconf}}

    # analysis region = rows [cut : cut+strip] — skips the outer cut-edge sliver and
    # stays INSIDE the border. edge band = outer ~60% (cut-edge rim of the border);
    # reference = inner ~40% (intact border). Neither reaches the artwork.
    o = cut
    band = max(2, int(round(0.60 * strip)))
    raw = {"band_px": band, "strip_px": int(strip), "border_px": round(border_px, 1),
           "cut_px": cut, "conf_geom": round(conf_geom, 3), "strip_len": sub.shape[1], **bconf}
    edge_mask = np.zeros(msub.shape, bool)
    edge_mask[o:o + band] = msub[o:o + band] > 0
    ref_mask = np.zeros(msub.shape, bool)
    ref_mask[o + band:o + strip] = msub[o + band:o + strip] > 0
    strip_area = int(edge_mask.sum()) or 1

    # --- whitening relative to the intact border (handles white/silver borders) ---
    # full-art/foil guard: discount whitening where the edge band is high-variance
    # (artwork reaching the edge) rather than a uniform printed border.
    cstd = _band_colorstd(sub, edge_mask)
    uw = _uniformity_weight(cstd)
    raw["edge_colorstd"] = round(cstd, 2)
    raw["uniformity_weight"] = round(uw, 3)
    wr, largest, wb = _relative_whitening(sub, edge_mask, ref_mask)
    raw["whitening_area_ratio"] = round(wr, 4)
    w_white = min(wr, 0.5) * uw
    whitening = to_sev(w_white, thr["edge_whitening"])

    # --- (a) white-blob nick/chip from the relative-white blobs hugging the edge ---
    # Resolution-invariance: at higher warp resolution the white regions fragment
    # into more components and tiny specks clear the floor. A scaled morphological
    # close re-merges fragments and the floor scales with area.
    asc = _area_scale(H, W)
    sc = float(np.sqrt(asc))                      # legacy->fullres linear pixel scale
    if asc > 1.5:
        ksz = max(2, int(round(asc ** 0.5)))
        wb = cv2.morphologyEx(wb, cv2.MORPH_CLOSE, np.ones((ksz, ksz), np.uint8))
    nick_white = chip_white = 0
    largest_blob = 0
    nick_mask = np.zeros(msub.shape, np.uint8)        # localized nick / chip pixels (for the app overlay)
    chip_mask = np.zeros(msub.shape, np.uint8)
    n_lbl, lbl_w, stats, _ = cv2.connectedComponentsWithStats(wb, 8)
    for i in range(1, n_lbl):
        area = stats[i, cv2.CC_STAT_AREA]
        h_i = stats[i, cv2.CC_STAT_HEIGHT]
        w_i = stats[i, cv2.CC_STAT_WIDTH]
        if area < 8 * asc:
            continue
        largest_blob = max(largest_blob, int(area))
        if area >= 0.30 * band * band or w_i >= 0.10 * sub.shape[1] or h_i >= 0.8 * band:
            chip_white += 1; chip_mask[lbl_w == i] = 1
        else:
            nick_white += 1; nick_mask[lbl_w == i] = 1
    raw["nick_white_count"] = nick_white
    raw["chip_white_count"] = chip_white
    raw["largest_blob_px"] = largest_blob

    # --- (b) physical-edge contour notch (nick) & missing-material (chip) detection
    #     (spec Changes 2 & 3): catches DARK / compressed damage that exposes no
    #     white cardstock. Fit the ideal straight edge to the first on-card pixel
    #     per column, then measure inward deviation (depth) along the edge. ---
    first = np.full(sub.shape[1], np.nan, np.float32)
    for j in range(sub.shape[1]):
        col = np.where(msub[:, j] > 0)[0]
        if col.size:
            first[j] = col[0]
    valid = ~np.isnan(first)
    notch_count = chip_contour = 0
    largest_notch_depth = largest_notch_width = 0.0
    largest_chip_depth = largest_chip_width = 0.0
    missing_area = 0.0
    if valid.sum() > 10:
        xs = np.where(valid)[0]; ys = first[valid]
        coef = np.polyfit(xs, ys, 1)                       # ideal straight edge (fitLine)
        resid0 = ys - np.polyval(coef, xs)
        base_off = float(np.percentile(resid0, 15))        # line at the un-eaten side
        depth = np.zeros(sub.shape[1], np.float32)
        depth[xs] = np.clip(resid0 - base_off, 0, None)    # >0 = card eaten inward
        d_thr, w_thr = 2.0 * sc, 3.0 * sc                  # spec: depth>2px, width>3px (scaled)
        j, Ncol = 0, depth.shape[0]
        while j < Ncol:
            if depth[j] > d_thr:
                ke = j                                         # edge-walk index (NOT the rotation k)
                while ke < Ncol and depth[ke] > 0.5 * d_thr:
                    ke += 1
                width, md = ke - j, float(depth[j:ke].max())
                if width > w_thr and md > d_thr:
                    missing_area += float(depth[j:ke].sum())
                    sl = (slice(o, o + band), slice(j, ke))    # mark the damaged columns in the band
                    if md >= 0.40 * band or width >= 0.10 * sub.shape[1]:   # large loss -> chip
                        chip_contour += 1
                        largest_chip_depth = max(largest_chip_depth, md)
                        largest_chip_width = max(largest_chip_width, float(width))
                        chip_mask[sl][msub[sl] > 0] = 1
                    else:                                                    # small notch -> nick
                        notch_count += 1
                        largest_notch_depth = max(largest_notch_depth, md)
                        largest_notch_width = max(largest_notch_width, float(width))
                        nick_mask[sl][msub[sl] > 0] = 1
                j = ke
            else:
                j += 1
    chip_missing_area_ratio = float(missing_area) / (band * sub.shape[1] + 1e-6)
    raw["edge_notch_count"] = notch_count
    raw["largest_notch_depth"] = round(largest_notch_depth, 2)
    raw["largest_notch_width"] = round(largest_notch_width, 2)
    raw["chip_contour_count"] = chip_contour
    raw["chip_missing_area_ratio"] = round(chip_missing_area_ratio, 5)
    raw["largest_chip_depth"] = round(largest_chip_depth, 2)
    raw["largest_chip_width"] = round(largest_chip_width, 2)

    # severity = max(white-blob score, contour score)   [spec Changes 2 & 3]
    # full-art/foil guard extends to ALL edge defects: a high-variance (artwork/foil)
    # edge can't be reliably assessed, so nick/chip/fraying are discounted by uw too.
    nick_mag = float(max(nick_white, notch_count)) * uw
    chip_mag = float(max(chip_white, chip_contour)) * uw
    raw["nick_count"] = int(nick_mag)              # combined, kept for inspection
    raw["chip_count"] = int(chip_mag)
    nick = to_sev(nick_mag, thr["edge_nick"])
    chip = to_sev(chip_mag, thr["edge_chip"])

    # --- fraying (pixel-based, spec Change 4): high-freq irregularity in the band
    #     (Canny on actual pixels), not smoothed-contour roughness ---
    band_mask = np.zeros(msub.shape, bool)
    band_mask[o:o + band] = msub[o:o + band] > 0
    gray_sub = cv2.cvtColor(sub, cv2.COLOR_BGR2GRAY)
    fray, fiber_n, jag, hfe, fray_mask = _band_fraying(gray_sub, band_mask, asc)
    fray = fray * uw                       # foil texture reads as fraying → discount on artwork edges
    raw["fraying_score"] = round(fray, 4)
    raw["fiber_count"] = fiber_n
    raw["edge_jaggedness"] = jag
    raw["edge_high_frequency_energy"] = hfe
    fraying = to_sev(fray, thr["edge_fraying"])

    raw["_viz"] = {"white_mask": wb, "k": k, "x1": x1, "y1": y1, "x2": x2, "y2": y2,
                   "ce": ce, "band": band,   # for verify()/app overlays (skipped by raw_to_vector)
                   "nick_mask": nick_mask, "chip_mask": chip_mask, "fraying_mask": fray_mask}
    raw["_mag"] = {"whitening": w_white, "nick": nick_mag,
                   "chip": chip_mag, "fraying": fray}
    # confidence drops for thin borders (conf_geom) as well as low strip coverage
    cover = strip_area / (band * sub.shape[1] + 1e-6)
    conf = float(np.clip((0.35 + 0.45 * cover) * conf_geom * (0.6 + 0.4 * bconf["boundary_conf"]), 0.2, 0.85))
    return {"whitening": whitening, "nick": nick, "chip": chip, "fraying": fraying,
            "confidence": round(conf, 2), "raw": raw}


# ---- Module 4: Surface -------------------------------------------------------

def _line_stats(line_mask, minlen, maxgap=4, ang_lo=None, ang_hi=None):
    """HoughLinesP on a binary mask -> (count, total_len, max_len, angle_entropy)."""
    lines = cv2.HoughLinesP(line_mask, 1, np.pi / 180, threshold=30,
                            minLineLength=int(minlen), maxLineGap=maxgap)
    if lines is None:
        return 0, 0.0, 0.0, 0.0, []
    segs = []
    angles = []
    for x1, y1, x2, y2 in lines[:, 0, :]:
        ln = float(np.hypot(x2 - x1, y2 - y1))
        ang = (np.degrees(np.arctan2(y2 - y1, x2 - x1)) % 180.0)
        if ang_lo is not None:
            near_h = ang < ang_lo or ang > 180 - ang_lo
            near_v = abs(ang - 90) < ang_lo
            if not (near_h or near_v):
                continue
        segs.append((x1, y1, x2, y2, ln))
        angles.append(ang)
    if not segs:
        return 0, 0.0, 0.0, 0.0, []
    lens = np.array([s[4] for s in segs])
    hist, _ = np.histogram(angles, bins=12, range=(0, 180))
    p = hist / hist.sum()
    ent = float(-(p[p > 0] * np.log(p[p > 0])).sum() / np.log(12))
    return len(segs), float(lens.sum()), float(lens.max()), ent, segs


def _filter_artwork_lines(segs, gradmag, g_hi, frac=0.85):
    """Drop line candidates that ride a strong continuous gradient (spec Change 5).

    Artwork boundaries keep a HIGH full-gradient magnitude along their entire
    length; a real scratch is a thin high-pass ridge whose underlying gradient is
    not a strong continuous edge. Keep a segment only if it is on a strong edge
    for less than `frac` of its length. Returns the filtered segment list.
    """
    Hh, Ww = gradmag.shape
    keep = []
    for (x1, y1, x2, y2, ln) in segs:
        n = max(8, int(ln))
        xs = np.clip(np.linspace(x1, x2, n).astype(int), 0, Ww - 1)
        ys = np.clip(np.linspace(y1, y2, n).astype(int), 0, Hh - 1)
        cont = float((gradmag[ys, xs] > g_hi).mean())
        if cont < frac:
            keep.append((x1, y1, x2, y2, ln))
    return keep


def cv_surface_features(warped, mask, region, thr=CV_THRESHOLDS):
    """Deterministic surface condition features over the ENTIRE card face.

    `region` is the CARD boundary {x1,y1,x2,y2} (normalized) — i.e. the whole
    card incl. the printed border/frame — NOT the inner content border. Only a
    thin physical cut-edge margin (SURFACE_EDGE_MARGIN) is trimmed, and the card
    contour mask is eroded to drop that rim (incl. rounded corners). Because the
    ROI is keyed to the card boundary, editing the inner border / centering does
    NOT change surface features.

    Returns {scratches, print_lines, dents, creases, holo_disruption, stains,
    confidence, raw}. This is the framework's hardest pillar: artwork edges
    masquerade as scratches/lines in a single image, so confidence is low and a
    learned anomaly model (PatchCore/PaDiM) is the recommended upgrade.
    """
    H, W = warped.shape[:2]
    x1, y1, x2, y2 = [int(round(v * d)) for v, d in
                      zip([region["x1"], region["y1"], region["x2"], region["y2"]], [W, H, W, H])]
    m = max(1, int(SURFACE_EDGE_MARGIN * min(W, H)))   # exclude only the physical cut edge
    x1, y1, x2, y2 = x1 + m, y1 + m, x2 - m, y2 - m
    raw = {}
    if x2 - x1 < 30 or y2 - y1 < 30:
        return {d: 0 for d in SURFACE_DEFECTS} | {"confidence": 0.3, "raw": raw}

    roi = warped[y1:y2, x1:x2]
    # erode the card mask by the margin so the cut-edge rim (incl. rounded
    # corners) is excluded, then everything inside (border + content) is analyzed
    mask_er = cv2.erode((mask > 0).astype(np.uint8), np.ones((2 * m + 1, 2 * m + 1), np.uint8))
    mroi = mask_er[y1:y2, x1:x2] > 0
    gray = cv2.cvtColor(roi, cv2.COLOR_BGR2GRAY).astype(np.float32)
    h2, w2 = gray.shape
    minlen = max(18, int(0.06 * min(h2, w2)))
    asc = _area_scale(H, W)   # scale absolute blob-area floors to the 630x880 reference

    # band-pass: keep thin/faint structures (scratches, print lines, creases),
    # suppress smooth artwork gradients. Top-percentile -> binary line mask.
    hp = cv2.GaussianBlur(gray, (0, 0), 1.0) - cv2.GaussianBlur(gray, (0, 0), 9.0)
    hp_abs = np.abs(hp)
    inside = hp_abs[mroi]
    thresh = float(np.percentile(inside, 99.0)) if inside.size else 1e9
    line_mask = ((hp_abs > thresh) & mroi).astype(np.uint8) * 255
    raw["anomaly_score"] = round(float(inside.mean() / (gray[mroi].std() + 1e-6)), 4) if inside.size else 0.0

    # full-gradient magnitude + strong-edge level, for the artwork-boundary filter
    gx = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    gradmag = cv2.magnitude(gx, gy)
    g_hi = float(np.percentile(gradmag[mroi], 92)) if mroi.any() else 1e9
    sc_surf = float(np.sqrt(asc))

    # scratches: any-orientation thin lines, with artwork-boundary lines removed
    # (spec Change 5) — a line riding a strong continuous gradient is artwork, not a scratch.
    n_s0, _, _, _, segs_s = _line_stats(line_mask, minlen)
    segs_s = _filter_artwork_lines(segs_s, gradmag, g_hi)
    n_s = len(segs_s)
    if segs_s:
        lens = np.array([s[4] for s in segs_s]); tot_s, max_s = float(lens.sum()), float(lens.max())
        angs = [(np.degrees(np.arctan2(s[3] - s[1], s[2] - s[0])) % 180.0) for s in segs_s]
        hist, _ = np.histogram(angs, bins=12, range=(0, 180)); pp = hist / hist.sum()
        ent_s = float(-(pp[pp > 0] * np.log(pp[pp > 0])).sum() / np.log(12))
    else:
        tot_s = max_s = ent_s = 0.0
    raw["scratch_count_prefilter"] = n_s0
    raw["scratch_count"] = n_s
    raw["largest_scratch_length"] = round(max_s, 1)
    raw["scratch_density"] = round(tot_s / (h2 * w2) * 1e3, 4)
    raw["scratch_orientation_entropy"] = round(ent_s, 3)
    scratches = to_sev(n_s, thr["surface_scratches"])

    # print lines: long lines clustered near horizontal/vertical
    n_p, _, _, _, segs_p = _line_stats(line_mask, max(minlen, int(0.20 * min(h2, w2))),
                                       maxgap=6, ang_lo=10)
    raw["print_line_count"] = n_p
    print_lines = to_sev(n_p, thr["surface_print_lines"])

    # creases: very long lines crossing the card
    crease_segs = [s for s in segs_s if s[4] >= 0.30 * max(h2, w2)]
    n_c = len(crease_segs)
    raw["crease_count"] = n_c
    creases = to_sev(n_c, thr["surface_creases"])

    # dents: compact dark concavities (low-frequency luminance depressions)
    lf = cv2.GaussianBlur(gray, (0, 0), 21.0)
    depress = cv2.GaussianBlur(lf, (0, 0), 9.0) - lf            # >0 where locally darker
    dmask = ((depress > max(6.0, np.std(depress[mroi]) * 2.5)) & mroi).astype(np.uint8)
    nd, _, dstats, _ = cv2.connectedComponentsWithStats(dmask, 8)
    dent_boxes = [tuple(int(dstats[i, c]) for c in (cv2.CC_STAT_LEFT, cv2.CC_STAT_TOP,
                                                    cv2.CC_STAT_WIDTH, cv2.CC_STAT_HEIGHT))
                  for i in range(1, nd) if 30 * asc <= dstats[i, cv2.CC_STAT_AREA] <= 0.02 * h2 * w2]
    dent_count = len(dent_boxes)
    raw["dent_count"] = dent_count
    dents = to_sev(dent_count, thr["surface_dents"])

    # stains: LAB colour anomalies — compact, smooth, well off the local mean.
    # Strict so vivid artwork regions (also "off local mean") are not counted.
    lab = cv2.cvtColor(roi, cv2.COLOR_BGR2LAB).astype(np.float32)
    labblur = cv2.GaussianBlur(lab, (0, 0), 25.0)
    deltaE = np.linalg.norm(lab - labblur, axis=2)
    smooth = cv2.GaussianBlur((hp_abs < thresh).astype(np.float32), (0, 0), 5.0) > 0.7
    cut = max(18.0, np.percentile(deltaE[mroi], 99.8)) if mroi.any() else 1e9
    smask = ((deltaE > cut) & mroi & smooth).astype(np.uint8)
    ns, _, sstats, _ = cv2.connectedComponentsWithStats(smask, 8)
    stain_boxes = [tuple(int(sstats[i, c]) for c in (cv2.CC_STAT_LEFT, cv2.CC_STAT_TOP,
                                                     cv2.CC_STAT_WIDTH, cv2.CC_STAT_HEIGHT))
                   for i in range(1, ns) if 80 * asc <= sstats[i, cv2.CC_STAT_AREA] <= 0.03 * h2 * w2]
    stain_count = len(stain_boxes)
    raw["stain_count"] = stain_count
    raw["max_deltaE"] = round(float(deltaE[mroi].max()), 1) if mroi.any() else 0.0
    stains = to_sev(stain_count, thr["surface_stains"])

    # holo_disruption: scratches restricted to the holo/foil region
    hsv = cv2.cvtColor(roi, cv2.COLOR_BGR2HSV)
    satvar = cv2.GaussianBlur((hsv[:, :, 1].astype(np.float32)) ** 2, (0, 0), 9.0) \
        - cv2.GaussianBlur(hsv[:, :, 1].astype(np.float32), (0, 0), 9.0) ** 2
    holo = (satvar > np.percentile(satvar[mroi], 85)) & mroi if mroi.any() else mroi
    holo_frac = float(holo.mean())
    raw["holo_area_frac"] = round(holo_frac, 3)
    # holo disruption (spec Change 6): only count lines that intersect the holo
    # region AND run continuously for >=20px — ignore isolated foil-texture specks.
    if holo_frac > 0.05:
        holo_lines = (line_mask > 0) & holo
        holo_minlen = max(minlen, int(round(20 * sc_surf)))
        n_h, _, _, _, _ = _line_stats(holo_lines.astype(np.uint8) * 255, holo_minlen, maxgap=2)
    else:
        n_h = 0
    raw["holo_disruption_count"] = n_h
    holo_disruption = to_sev(n_h, thr["surface_holo_disruption"])

    # dynamic confidence (spec Change 7): higher when defects are clearly present
    def _sig(c, t):
        return float(np.clip(c / (t[1] + 1e-6), 0.0, 1.0))
    conf = float(np.clip(0.35 + 0.10 * _sig(n_s, thr["surface_scratches"])
                                + 0.10 * _sig(stain_count, thr["surface_stains"])
                                + 0.10 * _sig(dent_count, thr["surface_dents"]), 0.35, 0.75))

    raw["_mag"] = {"scratches": float(n_s), "print_lines": float(n_p),
                   "dents": float(dent_count), "creases": float(n_c),
                   "holo_disruption": float(n_h), "stains": float(stain_count)}
    return {"scratches": scratches, "print_lines": print_lines, "dents": dents,
            "creases": creases, "holo_disruption": holo_disruption, "stains": stains,
            "confidence": round(conf, 2), "raw": raw, "_scratch_segments": segs_s,
            "_surface_viz": {"scratch_segments": segs_s, "print_line_segments": segs_p,
                             "crease_segments": crease_segs, "dent_boxes": dent_boxes,
                             "stain_boxes": stain_boxes}}


# ---- Assemble the full condition dict (same shape as the VLM output) ---------

def cv_extract_conditions(det, cb=None, cr=None, thr=CV_THRESHOLDS, keep_raw=True):
    """Run all CV modules on a detected/warped card -> VLM-shaped condition dict.

    Args:
        det : dict from detect_and_warp() (warped, cw, cb, ...)
        cb  : outer card boundary (defaults to det['cb'])
        cr  : inner content region; if None, computed via compute_centering_hybrid
    Returns (cond, raw) where `cond` feeds features_to_vector() unchanged.
    """
    cb = cb if cb is not None else det["cb"]
    if cr is None:
        cr = compute_centering_hybrid(det["warped"], cb)["content_region"]
    warped = det["warped"]
    mask = card_mask_warped(det)
    crops = corner_crops(det)

    cond = {"corners": {}, "edges": {}, "surface": {}}
    raw = {"corners": {}, "edges": {}, "surface": {}}

    for crop_name, loc in CROP_TO_LOC.items():
        f = cv_corner_features(crops[crop_name], crop_name, thr)
        raw["corners"][loc] = f.pop("raw", {})
        cond["corners"][loc] = f

    for side in EDGE_LOCS:
        f = cv_edge_features(warped, mask, cb, cr, side, thr)
        raw["edges"][side] = f.pop("raw", {})
        cond["edges"][side] = f

    # surface = ENTIRE card face (inside the card boundary cb), independent of the
    # inner content border cr — so centering edits do not change surface features.
    surf_region = {"x1": cb[0], "y1": cb[1], "x2": cb[2], "y2": cb[3]}
    sf = cv_surface_features(warped, mask, surf_region, thr)
    segs = sf.pop("_scratch_segments", [])
    sviz = sf.pop("_surface_viz", {"scratch_segments": segs})
    raw["surface"] = sf.pop("raw", {})
    raw["surface"]["_viz"] = {**sviz, "region": surf_region}  # for verify()/app overlays
    cond["surface"] = sf

    if not keep_raw:
        return cond
    return cond, raw


# ── Raw-measurement persistence + cheap threshold re-application ──────────────
# Decoupled pipeline (per the raw-vs-processed design):
#   1. extraction persists raw_to_vector(...)  — the EXPENSIVE step, run once
#   2. processed_vector_from_raw(...) re-derives the 56-col severity vector by
#      applying thresholds — CHEAP, re-runnable, so retuning needs no re-extraction
#   3. ignore-lists drop noisy columns at train time (see train_compare.py)
#   4/5. train + compare a raw-measurement model vs a processed-severity model

def raw_to_vector(cond, raw):
    """Flatten all continuous CV raw MEASUREMENTS + pre-threshold magnitudes +
    confidences into one flat row (no thresholding applied). Column families:
        m.<pillar>[.<loc>].<key>    individual raw measurements (raw-model inputs)
        mag.<pillar>[.<loc>].<def>  pre-threshold magnitude  (-> to_sev = processed)
        conf.<pillar>[.<loc>]       detector confidence (not threshold-derived)
    """
    out = {}

    def emit(pillar, loc, node, cnode, defects):
        tag = pillar if loc is None else f"{pillar}.{loc}"
        mag = _asdict(node.get("_mag"))
        for k, v in node.items():
            if k == "_mag" or not isinstance(v, (int, float, bool)):
                continue
            out[f"m.{tag}.{k}"] = float(v)
        for d in defects:
            out[f"mag.{tag}.{d}"] = float(mag.get(d, 0.0))
        out[f"conf.{tag}"] = _conf(cnode)

    for loc in CORNER_LOCS:
        emit("corners", loc, _asdict(raw.get("corners", {}).get(loc)),
             _asdict(cond.get("corners", {}).get(loc)), CORNER_DEFECTS)
    for side in EDGE_LOCS:
        emit("edges", side, _asdict(raw.get("edges", {}).get(side)),
             _asdict(cond.get("edges", {}).get(side)), EDGE_DEFECTS)
    emit("surface", None, _asdict(raw.get("surface")),
         _asdict(cond.get("surface")), SURFACE_DEFECTS)
    return out


def processed_vector_from_raw(row, thr=CV_THRESHOLDS):
    """Re-derive the canonical 56-col processed severity vector from a raw row by
    applying `thr` to the persisted magnitudes — no image processing, so
    thresholds can be retuned without re-extracting. `row` is a dict (or pandas
    row) produced by raw_to_vector()."""
    def g(k, default=0.0):
        try:
            v = row[k]
            return float(v) if v == v else default   # NaN-safe
        except Exception:
            return default

    cond = {"corners": {}, "edges": {}, "surface": {}}
    for loc in CORNER_LOCS:
        cond["corners"][loc] = {d: to_sev(g(f"mag.corners.{loc}.{d}"), thr[thr_key("corners", d)])
                                for d in CORNER_DEFECTS}
        cond["corners"][loc]["confidence"] = g(f"conf.corners.{loc}", 0.5)
    for side in EDGE_LOCS:
        cond["edges"][side] = {d: to_sev(g(f"mag.edges.{side}.{d}"), thr[thr_key("edges", d)])
                               for d in EDGE_DEFECTS}
        cond["edges"][side]["confidence"] = g(f"conf.edges.{side}", 0.5)
    cond["surface"] = {d: to_sev(g(f"mag.surface.{d}"), thr[thr_key("surface", d)])
                       for d in SURFACE_DEFECTS}
    cond["surface"]["confidence"] = g("conf.surface", 0.5)
    return features_to_vector(cond)


# ════════════════════════════════════════════════════════════════════════════
# 6. VLM (Haiku) FEATURE EXTRACTION  (identical prompt/schema to notebook 17)
# ════════════════════════════════════════════════════════════════════════════

EXTRACTION_MODEL = "claude-haiku-4-5"

CONDITION_PROMPT = """You are a professional PSA card inspection assistant.

Your job is NOT to assign grades or scores.
Your job is ONLY to report observable physical condition FEATURES from the images.
Centering has already been measured separately — DO NOT assess centering.

INPUTS
  Image 1: full warped card
  Image 2: top-left corner zoom
  Image 3: top-right corner zoom
  Image 4: bottom-right corner zoom
  Image 5: bottom-left corner zoom
Black pixels = outside the physical card.

DEFECT DEFINITIONS
  whitening      : border color worn away exposing white/gray cardstock
  fraying        : fuzzy or separated card fibers
  bending        : corner no longer lies flat / shape deformation
  nick           : small localized edge damage
  chip           : missing portion of edge or border
  scratches      : linear marks disrupting the surface
  print_lines    : factory printing defect lines on the surface
  dents          : local indentations
  creases        : fold or bend lines
  holo_disruption: scratches/scuffs specifically on the holo/foil layer
  stains         : foreign discoloration

DO NOT REPORT AS DAMAGE
  colored Pokemon borders, factory rounded corners, holo texture, foil sparkle,
  reflections, glare, shadows, JPEG/compression artifacts, printed design elements.

SEVERITY (use EXACTLY one of these strings):
  "none"     not visible
  "trace"    barely visible under close inspection
  "minor"    visible but small
  "moderate" clearly visible
  "heavy"    prominent damage
When uncertain, use "none" and a low confidence. Never infer damage.

CONFIDENCE: a float 0.0-1.0 per region (0.0 = pure guess, 1.0 = clearly visible).

--------------------------------------------------
OUTPUT FORMAT  — return ONLY this JSON object, with EXACTLY these keys:
--------------------------------------------------
{
  "corners": {
    "top_left":     {"whitening": "<severity>", "fraying": "<severity>", "bending": "<severity>", "deformation": "<severity>", "confidence": <0.0-1.0>},
    "top_right":    {"whitening": "<severity>", "fraying": "<severity>", "bending": "<severity>", "deformation": "<severity>", "confidence": <0.0-1.0>},
    "bottom_right": {"whitening": "<severity>", "fraying": "<severity>", "bending": "<severity>", "deformation": "<severity>", "confidence": <0.0-1.0>},
    "bottom_left":  {"whitening": "<severity>", "fraying": "<severity>", "bending": "<severity>", "deformation": "<severity>", "confidence": <0.0-1.0>}
  },
  "edges": {
    "top":    {"whitening": "<severity>", "nick": "<severity>", "chip": "<severity>", "fraying": "<severity>", "confidence": <0.0-1.0>},
    "right":  {"whitening": "<severity>", "nick": "<severity>", "chip": "<severity>", "fraying": "<severity>", "confidence": <0.0-1.0>},
    "bottom": {"whitening": "<severity>", "nick": "<severity>", "chip": "<severity>", "fraying": "<severity>", "confidence": <0.0-1.0>},
    "left":   {"whitening": "<severity>", "nick": "<severity>", "chip": "<severity>", "fraying": "<severity>", "confidence": <0.0-1.0>}
  },
  "surface": {
    "scratches": "<severity>", "print_lines": "<severity>", "dents": "<severity>",
    "creases": "<severity>", "holo_disruption": "<severity>", "stains": "<severity>",
    "confidence": <0.0-1.0>
  }
}
Return ONLY valid JSON. No prose, no markdown fences.
"""


def _encode(img_bgr, quality=92):
    ok, buf = cv2.imencode(".jpg", img_bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("JPEG encode failed")
    return base64.standard_b64encode(buf.tobytes()).decode("ascii")


def _parse_json_robust(raw):
    m = re.search(r"\{.*\}", raw, re.DOTALL)
    if not m:
        return {"error": raw[:300]}
    s = m.group()
    for cand in (s, re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "", s)):
        try:
            return json.loads(cand)
        except json.JSONDecodeError:
            continue
    return {"error": s[:300]}


def grade_conditions(det, model=EXTRACTION_MODEL, api_key=None):
    """Call Claude Haiku on the same 5 images the pipeline uses -> raw feature dict."""
    import anthropic
    api_key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
    warped_small = cv2.resize(det["warped"], (315, 440))
    crops = corner_crops(det)
    imgs = [warped_small] + [cv2.resize(crops[k], (200, 200)) for k in ("TL", "TR", "BR", "BL")]
    content = [{"type": "image", "source": {"type": "base64", "media_type": "image/jpeg",
                                            "data": _encode(im)}} for im in imgs]
    content.append({"type": "text", "text": (
        "Images: 1=full card, 2=TL corner, 3=TR corner, 4=BR corner, 5=BL corner. "
        "Black=outside card.\nReturn ONLY the JSON object with the exact schema given.")})
    client = anthropic.Anthropic(api_key=api_key)
    msg = client.messages.create(model=model, max_tokens=1500,
                                 system=CONDITION_PROMPT,
                                 messages=[{"role": "user", "content": content}])
    return _parse_json_robust(msg.content[0].text.strip())


def load_vlm_cache(jsonl_path):
    """Load cached Haiku features -> {abs_path: condition_dict} from _raw_features."""
    cache = {}
    if not os.path.exists(jsonl_path):
        return cache
    with open(jsonl_path) as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            rf = row.get("_raw_features")
            if not rf:
                continue
            try:
                cond = json.loads(rf) if isinstance(rf, str) else rf
            except json.JSONDecodeError:
                continue
            if isinstance(cond, dict) and "error" not in cond:
                cache[os.path.abspath(row.get("path", ""))] = cond
    return cache


# ════════════════════════════════════════════════════════════════════════════
# 7. VISUALISATION HELPERS  (for the single-card demo in the notebook)
# ════════════════════════════════════════════════════════════════════════════

def corner_overlay(crop, name):
    """Return an RGB crop with the detected edge-band whitening highlighted (red)."""
    gray = cv2.cvtColor(crop, cv2.COLOR_BGR2GRAY)
    mask = ((gray > 4).astype(np.uint8)) * 255
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, np.ones((7, 7), np.uint8))
    H, W = gray.shape
    dist = cv2.distanceTransform(mask, cv2.DIST_L2, 5)
    band_px = max(4, int(0.10 * min(H, W)))
    edge_band = (dist > 0) & (dist <= band_px)
    ref_band = (dist > band_px) & (dist <= 2 * band_px)
    _, _, wb = _relative_whitening(crop, edge_band, ref_band)
    out = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB).copy()
    out[wb > 0] = (255, 40, 40)
    return out


def surface_overlay(warped, region):
    """Return an RGB card-face crop with detected scratch segments drawn (cyan).

    `region` = the card boundary {x1,y1,x2,y2} (whole card face), matching
    cv_surface_features' ROI.
    """
    H, W = warped.shape[:2]
    x1, y1, x2, y2 = [int(round(v * d)) for v, d in
                      zip([region["x1"], region["y1"], region["x2"], region["y2"]], [W, H, W, H])]
    m = max(1, int(SURFACE_EDGE_MARGIN * min(W, H)))
    x1, y1, x2, y2 = x1 + m, y1 + m, x2 - m, y2 - m
    roi = warped[y1:y2, x1:x2]
    sf = cv_surface_features(warped, np.full((H, W), 255, np.uint8), region)
    out = cv2.cvtColor(roi, cv2.COLOR_BGR2RGB).copy()
    for (sx1, sy1, sx2, sy2, ln) in sf.get("_scratch_segments", []):
        cv2.line(out, (sx1, sy1), (sx2, sy2), (0, 220, 255), 1)
    return out, sf
