"""
cv_grader.py — classical-CV grading backend (replaces the Claude Sonnet VLM path).

Produces the SAME response dict shape as grader.grade_card() so the extension and
all downstream (Stage-B aggregator, economics, front/back merge) keep working with
no changes. Pillars come from the CV severity detectors, centering from CoherentFrame
(inner_frame), and the OVERALL grade from the trained 4-tier XGBoost model
(cv_xgb_raw.pkl — 44.9% exact / 87% within-1, beats the Haiku VLM at 31%).

Detection/warp is shared with grader.py (same Roboflow Model C seg + _warp_card), so
this matches exactly what the model was trained on. Selected at runtime by the
GRADER_BACKEND env var in grader.detect_and_grade ("cv" default, "vlm" to revert).
"""
from __future__ import annotations
import os, json
import numpy as np
import joblib

import grader                      # co-located: shared detection/warp helpers
import nonvlm_cv as N
import inner_frame as IF

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODEL_PATH = os.path.join(_HERE, "models", "cv_xgb_raw.pkl")

# ── per-side inner-frame selector (flag-guarded; falls back to coherence on ANY failure) ────────────
# Activate by setting env PERSIDE_CENTERING=1 (Railway). Default OFF = production behaviour unchanged.
_PERSIDE_ENABLED = os.environ.get("PERSIDE_CENTERING", "").strip().lower() in ("1", "true", "yes", "on")
_perside_cache = {}

def _perside_selector():
    if "sel" not in _perside_cache:
        _perside_cache["sel"] = None
        try:
            import per_side_selector as PS, io
            blob = None
            try:                                              # durable model from Supabase model_artifacts
                import model_store
                raw = model_store.latest_model_bytes()
                if raw:
                    blob = joblib.load(io.BytesIO(raw))
            except Exception:
                blob = None
            if blob is None:                                  # fallback: baked-in model
                blob = joblib.load(os.path.join(_HERE, "perside_lr.joblib"))
            sel = PS.PerSideSelector(); sel.model = blob["model"]
            _perside_cache["sel"] = sel
        except Exception:
            _perside_cache["sel"] = None
    return _perside_cache["sel"]


def swap_perside_selector(sel):
    """P2b hot-swap — replace the live per-side selector in memory. The grading-api runs a single
    uvicorn worker, so this takes effect for every subsequent grade immediately. NOT durable: a
    restart/redeploy reverts to the baked-in perside_lr.joblib (durable persistence is the next step)."""
    _perside_cache["sel"] = sel

def _perside_inner_frame(warped_cen, cb_center):
    """Return a coherence-shaped centering dict from the per-side selector, or None to fall back."""
    if not _PERSIDE_ENABLED:
        return None
    sel = _perside_selector()
    if sel is None:
        return None
    try:
        import per_side_selector as PS
        ctx = PS.make_ctx(warped_cen, None, cb_center)        # already masked; cb_center is fractional
        if ctx is None:
            return None
        chosen = sel.select(PS.candidates(ctx))
        if not all(s in chosen for s in "LRTB"):
            return None
        L, T, R, B = (chosen["L"][1], chosen["T"][1], chosen["R"][1], chosen["B"][1])
        x1, y1, x2, y2 = ctx["cb"]
        iL, iR, iT, iB = L - x1, x2 - R, T - y1, y2 - B
        if min(iL, iR, iT, iB) <= 0:                           # geometric sanity -> fall back
            return None
        lr = iL / (iL + iR) * 100.0; tb = iT / (iT + iB) * 100.0
        conf = float(np.mean([chosen[s][2] for s in "LRTB"]))
        return {"left_right": f"{int(round(lr))}/{100 - int(round(lr))}",
                "top_bottom": f"{int(round(tb))}/{100 - int(round(tb))}",
                "reliable": bool(conf >= 0.5),
                "frame_px": (int(L), int(T), int(R), int(B)),
                "cb_px": (x1, y1, x2, y2), "_source": "perside"}
    except Exception:
        return None

# defect keys that count toward a pillar's display score (exclude confidence/geom/raw)
_CORNER_DEFECTS = ("whitening", "nick", "chip", "fraying", "bending", "deformation")
_EDGE_DEFECTS   = ("whitening", "nick", "chip", "fraying")
_SURFACE_DEFECTS = ("scratches", "print_lines", "dents", "creases", "stains", "holo_disruption")
# severity (0=none .. 4=heavy) -> 1-10 pillar display score
_SEV_TO_SCORE = {0: 10.0, 1: 9.0, 2: 7.0, 3: 5.0, 4: 3.0}
# 4-tier index -> representative overall grade + label
_TIER_GRADE = {0: 6.0, 1: 7.5, 2: 9.0, 3: 10.0}
_TIER_PSA   = {0: "≤ PSA 6", 1: "PSA 7-8", 2: "PSA 9 MINT", 3: "PSA 10 GEM-MT"}

_bundle = None
def _model():
    global _bundle
    if _bundle is None:
        _bundle = joblib.load(_MODEL_PATH)
    return _bundle


def _sev_of(v):
    """Coerce a defect reading to a 0-4 severity. cond values are already severities;
    clamp/round defensively in case a continuous magnitude slips through."""
    try:
        return int(max(0, min(4, round(float(v)))))
    except Exception:
        return 0


def _pillar_score(node, defects):
    """Worst-defect severity across all locations in a pillar -> 1-10 display score."""
    worst = 0
    def walk(d):
        nonlocal worst
        if isinstance(d, dict):
            for k, val in d.items():
                if k in defects and isinstance(val, (int, float)):
                    worst = max(worst, _sev_of(val))
                elif isinstance(val, dict):
                    walk(val)
    walk(node)
    return _SEV_TO_SCORE[worst], worst


# severity word (matches the extension's severityFromText keyword coloring) + readable defect names
_SEV_WORD = {1: "slight", 2: "minor", 3: "moderate", 4: "heavy"}
_DEFECT_LABEL = {"whitening": "whitening", "nick": "nicks", "chip": "chip", "fraying": "fraying",
                 "bending": "bending", "deformation": "deformation", "scratches": "scratches",
                 "print_lines": "print lines", "dents": "dents", "creases": "creases",
                 "stains": "stains", "holo_disruption": "holo disruption"}


def _pillar_issues(node, defects, min_sev=2):
    """Build human-readable finding strings (severity ≥ min_sev) from the CV detector output,
    so the extension's per-pillar findings panel populates the same way it did for the VLM."""
    out = []
    def emit(loc, defect, sev):
        if sev >= min_sev:
            where = f" ({loc.replace('_', ' ')})" if loc else ""
            out.append(f"{_SEV_WORD[sev]} {_DEFECT_LABEL.get(defect, defect)}{where}")
    nested = any(isinstance(v, dict) for v in node.values()) if node else False
    if nested:                                  # corners/edges: {loc: {defect: sev}}
        for loc, dd in node.items():
            if isinstance(dd, dict):
                for d in defects:
                    if d in dd: emit(loc, d, _sev_of(dd[d]))
    else:                                       # surface: flat {defect: sev}
        for d in defects:
            if d in node: emit(None, d, _sev_of(node[d]))
    return out


def _centering_score(lr, tb):
    """grader-style worst-axis deviation -> 1-10 (matches grade_card's geo_score ladder)."""
    lr_dev = abs(int(lr.split("/")[0]) - 50)
    tb_dev = abs(int(tb.split("/")[0]) - 50)
    worst = max(lr_dev, tb_dev)
    ladder = [(5, 10.0), (10, 9.0), (15, 8.0), (20, 7.0), (25, 6.0),
              (30, 5.0), (35, 4.0), (40, 3.0), (45, 2.0)]
    for thr, s in ladder:
        if worst <= thr:
            return s
    return 1.0


def grade_card_cv(img_bgr, quad_raw=None, quad_padded=None, contour=None, **_ignore) -> dict:
    """Grade a card with the classical-CV pipeline. Same signature/return shape as
    grader.grade_card() (minus the api_key — no VLM call)."""
    if quad_padded is None and quad_raw is not None:
        quad_padded = quad_raw

    # ── build the warp + det exactly like grader/detect_and_warp (seg → 630x880) ──
    # TWO cb's: `cb_feat` (refine WITHOUT the symmetric-padding balance) feeds the grading-feature
    # extractor, because the cv_xgb model was trained on un-balanced cb — using the balanced cb there
    # would shift features and change grades (an unvalidated skew). `cb_center` (WITH balance) is the
    # corrected outer boundary used only for CENTERING + the displayed boundary.
    if quad_padded is not None:
        warped = grader._warp_card(img_bgr, quad_padded, out_w=N.LEGACY_WARP_SIZE[0],
                                   out_h=N.LEGACY_WARP_SIZE[1])
        _, cb0 = grader.card_boundary_analytical(
            quad_raw if quad_raw is not None else quad_padded, quad_padded)
        cw = (grader._contour_to_warped_norm(contour, quad_padded)
              if (contour is not None and quad_padded is not None) else N._FULL_FRAME_CW)
        cb_feat   = grader.refine_cb_in_warped(warped, cb0, balance=False)            # grading features (model-matched; no expand)
        cb_center = grader.refine_cb_in_warped(warped, cb0, balance=True,             # centering: balance + contour-expand to true edge
                                               cw=(cw if contour is not None else None))
    else:
        warped = grader._warp_card(img_bgr, None) if False else img_bgr.copy()
        cb_feat = cb_center = [0.0, 0.0, 1.0, 1.0]
        cw = N._FULL_FRAME_CW
    det = {"orig": img_bgr,
           "contour_orig": np.asarray(contour if contour is not None else quad_raw, float)
                           if (contour is not None or quad_raw is not None) else None,
           "warped": warped, "cb": cb_feat, "cw": cw,
           "quad_raw": quad_raw, "quad_padded": quad_padded, "detector": "seg"}

    # ── CV condition features → 4-tier XGBoost overall grade ──
    # NB: features run on the UN-masked warp + UN-balanced cb (the model was trained that way).
    cond, raw = N.cv_extract_conditions(det)
    b = _model()
    feat = N.raw_to_vector(cond, raw)
    X = np.array([[float(feat.get(c, 0.0)) for c in b["feature_cols"]]], np.float32)
    proba = b["model"].predict_proba(X)[0]
    tier = int(np.argmax(proba))
    conf = float(proba[tier])
    overall = _TIER_GRADE[tier]
    psa_equiv = _TIER_PSA[tier]
    distribution = {b["tier_short"][i]: round(float(p), 4) for i, p in enumerate(proba)}

    # ── centering via CoherentFrame (inner_frame), display-scored ──
    # Mask table background to the card contour so no remnant (corner wedges, edge
    # slivers) contaminates the centering read. Metric-safe (validated identical on GT);
    # masked copy is centering-only — grading features above used the un-masked warp.
    warped_cen = grader.mask_background_to_contour(warped, cw)
    inn = _perside_inner_frame(warped_cen, cb_center) or IF.find_inner_frame(warped_cen, cb_center)
    lr, tb = inn["left_right"], inn["top_bottom"]
    H, W = warped.shape[:2]
    L, T, R, Bx = inn["frame_px"]
    content_region = {"x1": L / W, "y1": T / H, "x2": R / W, "y2": Bx / H}
    cen_score = _centering_score(lr, tb)

    # ── pillar display scores from severities ──
    corners_s, corners_w = _pillar_score(cond.get("corners", {}), _CORNER_DEFECTS)
    edges_s,   edges_w   = _pillar_score(cond.get("edges", {}),   _EDGE_DEFECTS)
    surface_s, surface_w = _pillar_score(cond.get("surface", {}), _SURFACE_DEFECTS)

    worst_pillar = min(
        [("centering", cen_score), ("corners", corners_s),
         ("edges", edges_s), ("surface", surface_s)], key=lambda kv: kv[1])
    summary = (f"Classical-CV grade: {b['tier_labels'][tier]} "
               f"({conf*100:.0f}% confidence). Centering {lr} L/R · {tb} T/B. "
               f"Strongest concern: {worst_pillar[0]} (score {worst_pillar[1]:.1f}/10).")

    # CV-derived findings (per-pillar) → populates the extension's findings panel
    lr_dev = abs(int(lr.split("/")[0]) - 50); tb_dev = abs(int(tb.split("/")[0]) - 50)
    issues = {"corners":   _pillar_issues(cond.get("corners", {}), _CORNER_DEFECTS),
              "edges":     _pillar_issues(cond.get("edges", {}),   _EDGE_DEFECTS),
              "surface":   _pillar_issues(cond.get("surface", {}), _SURFACE_DEFECTS),
              "centering": []}
    if lr_dev > 10: issues["centering"].append(f"off-center {lr} L/R")
    if tb_dev > 10: issues["centering"].append(f"off-center {tb} T/B")
    cen_note = f"L/R {lr} · T/B {tb}" + ("" if inn["reliable"] else "  (low-confidence read)")

    result = {
        "centering": {"score": cen_score, "left_right": lr, "top_bottom": tb,
                      "content_region": content_region, "reliable": bool(inn["reliable"]),
                      "notes": cen_note, "_source": inn.get("_source", "coherentframe")},
        "corners": {"score": corners_s, "worst_severity": corners_w},
        "edges":   {"score": edges_s,   "worst_severity": edges_w},
        "surface": {"score": surface_s, "worst_severity": surface_w},
        "issues": issues,
        "overall_score": overall,
        "psa_equivalent": psa_equiv,
        "summary": summary,
        # CV-specific extras (harmless to the extension; useful for debugging/UI)
        "_grader_backend": "cv",
        "_model": "cv-xgb-raw",
        "_tier": tier,
        "_tier_distribution": distribution,
        "_confidence": "high" if conf >= 0.6 else ("low" if conf < 0.45 else "medium"),
        "_centering_reliable": bool(inn["reliable"]),
        "_border_type": N.compute_centering_hybrid(warped, cb_center).get("border_type", "?"),
    }

    # ── visual payload (same keys the extension already consumes) ──
    # Show the background-masked warp so the extension UI has no table remnants either.
    result["_card_boundary"] = list(cb_center)
    try:
        result["_warped_jpeg_b64"] = grader.encode_image(warped_cen)["data"]
        if quad_raw is not None:
            crops = grader._build_corner_crops(img_bgr, quad_raw, out_size=800)
            result["_corner_crops_b64"] = {k: grader.encode_image(crops[k])["data"]
                                           for k in ("TL", "TR", "BR", "BL")}
    except Exception:
        pass
    if contour is not None and quad_padded is not None:
        wc = grader._contour_to_warped_norm(contour, quad_padded)
        if wc is not None:
            result["_card_contour_warped"] = np.asarray(wc, float).round(5).tolist()
            result["_card_contour_orig"]   = np.asarray(contour, float).round(2).tolist()
    return result
