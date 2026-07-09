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
import cv2                          # used by the per-pillar visual overlays
import joblib

import grader                      # co-located: shared detection/warp helpers
import nonvlm_cv as N
import inner_frame as IF

_HERE = os.path.dirname(os.path.abspath(__file__))
_MODEL_PATH = os.path.join(_HERE, "models", "cv_xgb_raw.pkl")

# ── per-side inner-frame selector (flag-guarded; falls back to coherence on ANY failure) ────────────
# Activate by setting env PERSIDE_CENTERING=1 (Railway). Default OFF = production behaviour unchanged.
_PERSIDE_ENABLED = os.environ.get("PERSIDE_CENTERING", "").strip().lower() in ("1", "true", "yes", "on")
# Plausibility guard: re-pick a side that locked onto a physically-impossible near-zero border. Default ON;
# set PERSIDE_REPICK=0 to disable.
_REPICK_ENABLED = os.environ.get("PERSIDE_REPICK", "1").strip().lower() in ("1", "true", "yes", "on")
_perside_cache = {}


def _plausibility_repick(ctx, cand, sel, chosen):
    """A card always has a border, so an inner-edge inset at ~0 is a detection failure, not real centering
    (e.g. vintage cards with evolution text ON the top border fool the variance detector into locking to the
    card edge). If a side's inset is both essentially zero (<1.2% of the card) AND a severe outlier vs the
    other three, re-pick that side's best-scoring candidate within a plausible inset band derived from them.
    Real off-centering (thin but nonzero border) never trips this."""
    import per_side_selector as PS
    try:
        ins = {s: PS.inset_frac(ctx, s, chosen[s][1]) for s in "LRTB"}
    except Exception:
        return chosen
    for s in "LRTB":
        others = [ins[o] for o in "LRTB" if o != s]
        med = float(np.median(others)) if others else 0.0
        if med <= 0 or not (ins[s] < 0.012 and ins[s] < 0.4 * med):
            continue
        lo, hi = 0.4 * med, 2.5 * med
        try:
            scores = sel.score([fv for _, _, fv in cand[s]])
        except Exception:
            continue
        best = None
        for (dname, pos, fv), sc in zip(cand[s], scores):
            if lo <= PS.inset_frac(ctx, s, pos) <= hi and (best is None or sc > best[2]):
                best = (dname, pos, float(sc))
        if best is not None:
            chosen[s] = best
    return chosen

def _perside_selector():
    if "sel" not in _perside_cache:
        _perside_cache["sel"] = None
        try:
            import per_side_selector as PS, io
            blob = None; config = None
            try:                                              # durable model + config from Supabase model_artifacts
                import model_store
                art = model_store.latest_artifact()
                if art and art.get("model"):
                    blob = joblib.load(io.BytesIO(art["model"])); config = art.get("config")
            except Exception:
                blob = None
            if blob is None:                                  # fallback: baked-in model → default detector settings
                blob = joblib.load(os.path.join(_HERE, "perside_lr.joblib"))
                PS.reset_detector_params()
            else:                                             # match the deployed model's detector settings
                PS.apply_config(config)
            sel = PS.PerSideSelector(); sel.model = blob["model"]
            _perside_cache["sel"] = sel
        except Exception:
            _perside_cache["sel"] = None
    return _perside_cache["sel"]


def swap_perside_selector(sel, config=None):
    """Hot-swap the live per-side selector in memory (single uvicorn worker → effective for every
    subsequent grade immediately). Pass `config` to also apply that checkpoint's detector settings so
    Phase-1-tuned settings go live with the model. Durable across restarts via model_artifacts."""
    if config is not None:
        try:
            import per_side_selector as PS
            PS.apply_config(config)
        except Exception:
            pass
    _perside_cache["sel"] = sel


def baked_in_model_blob():
    """The ORIGINAL baked-in model ({"model": pipeline}), bypassing the durable store — used by
    'restore baseline' so you can always roll back to a known-good version after a bad deploy."""
    return joblib.load(os.path.join(_HERE, "perside_lr.joblib"))

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
        cand = PS.candidates(ctx)
        chosen = sel.select(cand)
        if not all(s in chosen for s in "LRTB"):
            return None
        if _REPICK_ENABLED:
            chosen = _plausibility_repick(ctx, cand, sel, chosen)
        L, T, R, B = (chosen["L"][1], chosen["T"][1], chosen["R"][1], chosen["B"][1])
        x1, y1, x2, y2 = ctx["cb"]
        iL, iR, iT, iB = L - x1, x2 - R, T - y1, y2 - B
        if min(iL, iR, iT, iB) <= 0:                           # geometric sanity -> fall back
            return None
        lr = iL / (iL + iR) * 100.0; tb = iT / (iT + iB) * 100.0
        ps = [chosen[s][2] for s in "LRTB"]
        conf = float(np.mean(ps))
        # centering CONFIDENCE: the MIN per-side P (the weakest side gates trust). Validated as the only
        # signal that tracks centering error (Spearman -0.67 vs |detected-GT|); image contrast / border-
        # thinness do NOT predict error. Graded 0..1; the confidently-wrong full-art tail is the residual.
        confidence = float(min(ps))
        return {"left_right": f"{int(round(lr))}/{100 - int(round(lr))}",
                "top_bottom": f"{int(round(tb))}/{100 - int(round(tb))}",
                "reliable": bool(conf >= 0.5), "confidence": round(confidence, 3),
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


# ── per-pillar VISUAL overlays (base64) — so the product UI can pop a "why" image per pillar ──
_EDGE_OVL = {"white_mask": (255, 255, 0), "nick_mask": (0, 0, 255), "chip_mask": (0, 165, 255), "fraying_mask": (0, 255, 255)}


def _viz_centering(warped, cb, frame_px):
    ov = warped.copy(); H, W = ov.shape[:2]
    cv2.rectangle(ov, (int(cb[0]*W), int(cb[1]*H)), (int(cb[2]*W), int(cb[3]*H)), (0, 255, 0), 2)   # outer cb
    if frame_px:
        try:
            L, T, R, B = [int(c) for c in frame_px]
            cv2.rectangle(ov, (L, T), (R, B), (0, 200, 255), 2)                                     # inner frame
        except Exception:
            pass
    return grader.encode_image(ov)["data"]


def _viz_surface(warped, raw_surface):
    ov = warped.copy()
    for seg in ((raw_surface.get("_viz") or {}).get("scratch_segments", []) or []):
        try:
            cv2.line(ov, (int(seg[0]), int(seg[1])), (int(seg[2]), int(seg[3])), (0, 0, 255), 2, cv2.LINE_AA)
        except Exception:
            continue
    return grader.encode_image(ov)["data"]


def _viz_edges(warped, raw_edges):
    """Composite of the 4 edge strips with the detector's defect masks overlaid + labelled."""
    strips = []
    for side in ("top", "right", "bottom", "left"):
        v = (raw_edges.get(side, {}) or {}).get("_viz")
        if not v:
            continue
        x1, y1, x2, y2, k, ce, band = v["x1"], v["y1"], v["x2"], v["y2"], v["k"], v["ce"], v["band"]
        sub = np.rot90(warped[y1:y2, x1:x2], k)
        sub = np.ascontiguousarray(sub[:, ce:sub.shape[1] - ce])
        ov = sub.copy()
        for key, col in _EDGE_OVL.items():
            m = v.get(key)
            if m is not None and m.shape[:2] == sub.shape[:2]:
                ov[m > 0] = (0.5 * np.array(col) + 0.5 * ov[m > 0]).astype(np.uint8)
        crop = int(min(max(band * 3, 30), ov.shape[0]))
        ov = ov[:crop]
        if ov.shape[1] != 760:
            ov = cv2.resize(ov, (760, max(1, int(ov.shape[0] * 760 / ov.shape[1]))))
        cv2.rectangle(ov, (0, 0), (90, 22), (25, 25, 25), -1)
        cv2.putText(ov, side, (6, 16), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
        strips.append(cv2.copyMakeBorder(ov, 0, 3, 0, 0, cv2.BORDER_CONSTANT, value=(20, 20, 20)))
    return grader.encode_image(np.vstack(strips))["data"] if strips else None


ZOOM_WARP_SIZE = (1260, 1760)   # 2x the feature warp (630x880) → crisp defect close-ups for the buyer


def _edge_defects_flagged(v, min_frac=0.004):
    """Edge defects (whitening/nick/chip/fraying) the detector flagged over MORE than min_frac of the
    strip — a speckle filter so a clean edge isn't labelled with all four. Advisory only; the buyer
    judges from the clean high-res crop."""
    out = []
    for key in _EDGE_OVL:
        m = v.get(key)
        if m is not None and m.size and int(np.count_nonzero(m)) / float(m.size) > min_frac:
            out.append(key.replace("_mask", ""))
    return out


def extract_pillar_zooms(img_bgr, quad_padded, raw, corner_crops_b64):
    """High-resolution zoomed close-ups of detected problem areas, so a buyer can verify defects
    before purchase. Crops from a 2x warp (ZOOM_WARP_SIZE) using the SAME defect locations the CV
    detectors already produce — it mirrors the shipped _viz_edges / _viz_surface decoding (no
    inverse-perspective, so no new coordinate risk). Returns:
        {edges:{side:{crop_b64,defects[]}}, surface:{scratches:{crop_b64,count}}, corners:{TL..BL:b64}}
    Every section is independent + best-effort; a failure in one never drops the others."""
    out = {}
    if corner_crops_b64:                          # the 800px source corner crops are already high-res zooms
        out["corners"] = corner_crops_b64
    if quad_padded is None:
        return out
    ZW, ZH = ZOOM_WARP_SIZE
    try:
        hw = grader._warp_card(img_bgr, quad_padded, out_w=ZW, out_h=ZH)
    except Exception:
        return out
    sx, sy = ZW / N.LEGACY_WARP_SIZE[0], ZH / N.LEGACY_WARP_SIZE[1]   # 630x880 → 1260x1760 (=2x)

    # EDGES — a clean, crisp high-res strip per side. All 4 are "potential problem areas" the buyer
    # should inspect, so we always emit them; the crop is UN-annotated so the buyer judges the actual
    # pixels (whitening is what they came to verify). `flagged` is an advisory list of what our scan
    # thinks it saw. Geometry mirrors _viz_edges (rotate by k, corner-exclude ce), scaled to the 2x warp.
    edges = {}
    for side in ("top", "right", "bottom", "left"):
        v = (raw.get("edges", {}).get(side, {}) or {}).get("_viz")
        if not v:
            continue
        try:
            x1, y1 = int(round(v["x1"] * sx)), int(round(v["y1"] * sy))
            x2, y2 = int(round(v["x2"] * sx)), int(round(v["y2"] * sy))
            k, band, ce = v["k"], v["band"], int(round(v["ce"] * sx))
            sub = np.rot90(hw[y1:y2, x1:x2], k)
            sub = np.ascontiguousarray(sub[:, ce:max(ce + 1, sub.shape[1] - ce)])
            crop_h = int(min(max(band * sy * 3, 60), sub.shape[0]))   # band + a little context
            sub = sub[:crop_h]
            if sub.size:
                edges[side] = {"crop_b64": grader.encode_image(sub)["data"], "flagged": _edge_defects_flagged(v)}
        except Exception:
            continue
    if edges:
        out["edges"] = edges

    # SURFACE — zoom on the scratch cluster (segments are in 630x880 warp coords, like _viz_surface)
    try:
        segs = ((raw.get("surface", {}).get("_viz") or {}).get("scratch_segments")) or []
        if segs:
            xs = [p for s in segs for p in (s[0], s[2])]
            ys = [p for s in segs for p in (s[1], s[3])]
            bx1, by1, bx2, by2 = min(xs) * sx, min(ys) * sy, max(xs) * sx, max(ys) * sy
            mx, my = (bx2 - bx1) * 0.4 + 40, (by2 - by1) * 0.4 + 40        # margin around the cluster
            cx1, cy1 = int(max(0, bx1 - mx)), int(max(0, by1 - my))
            cx2, cy2 = int(min(ZW, bx2 + mx)), int(min(ZH, by2 + my))
            sc = hw[cy1:cy2, cx1:cx2]
            if sc.size:                                # clean zoom on the scratch cluster — buyer judges
                out["surface"] = {"scratches": {"crop_b64": grader.encode_image(sc)["data"], "count": len(segs)}}
    except Exception:
        pass
    return out


def grade_card_cv(img_bgr, quad_raw=None, quad_padded=None, contour=None, zoom=False, cropped=False, **_ignore) -> dict:
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
        # Crop-bypass: the image IS the card (fills the frame), so the outer die-cut edge = the image edge.
        # refine_cb_in_warped searches inward and can latch onto a strong CONTENT edge (e.g. the title row) →
        # undershoots the outer top (card_030: top pulled to ~3% → centering 43/57 vs the true ~55/45). On a
        # cropped input, trust the image edge for the centering/display boundary. (cb_feat is left untouched so
        # the grading-feature model is unaffected.)
        cb_center = ([0.0, 0.0, 1.0, 1.0] if cropped
                     else grader.refine_cb_in_warped(warped, cb0, balance=True,        # centering: balance + contour-expand
                                                      cw=(cw if contour is not None else None)))
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
    # Cropped inputs fill the frame (no background to mask) → skip masking so the displayed warp has no black
    # ring. Non-cropped: mask the table background to the card contour so remnants don't contaminate the read.
    warped_cen = warped if cropped else grader.mask_background_to_contour(warped, cw)
    inn = _perside_inner_frame(warped_cen, cb_center) or IF.find_inner_frame(warped_cen, cb_center)
    # ── RECT_CHECK=1: post-warp rectification check — a MIN-only geometric veto on centering confidence. ──
    # Measures the physical die-cut edge in the UNMASKED warp against the output-inset invariant (card must sit
    # at [PF,1-PF] with zero tilt). Can only LOWER confidence / clear reliable; never moves a ratio or grade.
    # Structurally blind to true print off-centering (a real miscut still has a rectangular die-cut → passes).
    _rc = None
    _rcor = None
    if not cropped:
        try:
            import rect_check as RC
            if RC.ENABLED:
                _rc = RC.check(warped, grader.PADDING_FRAC)     # `warped` = unmasked padded warp
                g = float(_rc["g_geom"])
                if inn.get("confidence") is not None:
                    inn["confidence"] = round(min(float(inn["confidence"]), g), 3)
                if g < 0.5:
                    inn["reliable"] = False                     # fires the product's low-confidence note
        except Exception:
            _rc = None                                          # the check must never break a grade
        # ── SEG_RECT_CORRECT=shadow: run the tapered-correction DECISION pipeline, log it, serve nothing. ──
        # Measures decision mix / verify-failure / slab rates on real traffic before any flip. The served
        # grade is untouched by construction (no output of this block feeds the response ratios).
        try:
            import rect_correct as RCOR
            if RCOR.MODE == "shadow" and quad_raw is not None:
                o = RCOR.correct_quad_tapered(img_bgr, quad_raw, grader.PADDING_FRAC,
                                              warp0=warped, qp=quad_padded, rc0=_rc)
                _rcor = {"mode": "shadow", "decision": o.get("decision"), "w": o.get("w"),
                         "end_dev": o.get("end_dev"), "shift_full": o.get("shift_full"),
                         "rc1_max_ang": (o.get("rc1") or {}).get("max_ang"),
                         "slab_sides": (o.get("slab") or {}).get("n_coherent")}
                print(f"[rect_correct shadow] {_rcor}", flush=True)
        except Exception as _e:
            print(f"[rect_correct shadow] skipped: {type(_e).__name__}: {_e}", flush=True)
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
                      "confidence": inn.get("confidence"),   # graded 0..1 (perside only; None on coherentframe fallback)
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
    if _rc is not None:
        result["_rect_check"] = _rc        # per-side ang/pos + g_geom (debug; RECT_CHECK=1 only)
    if _rcor is not None:
        result["_rect_correct"] = _rcor    # shadow-mode decision log (SEG_RECT_CORRECT=shadow only)
    try:
        result["_warped_jpeg_b64"] = grader.encode_image(warped_cen)["data"]
        if quad_raw is not None:
            crops = grader._build_corner_crops(img_bgr, quad_raw, out_size=800)
            result["_corner_crops_b64"] = {k: grader.encode_image(crops[k])["data"]
                                           for k in ("TL", "TR", "BR", "BL")}
    except Exception:
        pass
    if cropped:
        # Cropped cards fill the frame → the true OUTER boundary is the frame (cb_center). The SAM3 contour
        # undershoots ~5% inward on cropped inputs (traces inside the yellow border, landing on the content
        # border), so emitting it would make consumers draw the outer edge ON TOP of the inner border. Emit a
        # frame rectangle instead so the card boundary renders at the true outer edge.
        x1, y1, x2, y2 = cb_center
        result["_card_contour_warped"] = [[x1, y1], [x2, y1], [x2, y2], [x1, y2]]
        H0, W0 = img_bgr.shape[:2]
        result["_card_contour_orig"]   = [[0.0, 0.0], [float(W0), 0.0], [float(W0), float(H0)], [0.0, float(H0)]]
    elif contour is not None and quad_padded is not None:
        wc = grader._contour_to_warped_norm(contour, quad_padded)
        if wc is not None:
            result["_card_contour_warped"] = np.asarray(wc, float).round(5).tolist()
            result["_card_contour_orig"]   = np.asarray(contour, float).round(2).tolist()

    # ── per-pillar visual overlays (base64) for the product's click-to-inspect popups ──
    try:
        result["pillar_visuals"] = {
            "centering": _viz_centering(warped, cb_center, inn.get("frame_px")),
            "edges":     _viz_edges(warped, raw.get("edges", {})),
            "surface":   _viz_surface(warped, raw.get("surface", {})),
            "corners":   result.get("_corner_crops_b64"),   # the 4 corner crops
        }
    except Exception:
        pass

    # ── high-res zoomed defect close-ups (gated; the buyer-verification view) ──
    if zoom:
        try:
            result["pillar_zooms"] = extract_pillar_zooms(
                img_bgr, quad_padded, raw, result.get("_corner_crops_b64"))
        except Exception:
            pass

    # ── RF-DETR defect boxes — the primary defect detectors for all 3 pillars. Non-fatal. ──
    #    scratch model → surface ;  edge/corner model → edges + corners.  (scores still come from CV for now)
    #    DETECT_BACKEND=modal offloads the (CPU-slow) inference to the Modal GPU /detect endpoint; the result
    #    shape is identical, so the contract is unchanged either way.
    try:
        if os.environ.get("DETECT_BACKEND", "local").lower() == "modal":
            import remote_detect
            result["defect_boxes"] = remote_detect.defect_boxes(warped_cen)
        else:
            import scratch_detect, ec_detect
            db = scratch_detect.defect_boxes(warped_cen)       # {edges:[], corners:[], surface:[scratches]}
            ec = ec_detect.defect_boxes(warped_cen)            # {edges:[...], corners:[...], surface:[]}
            db["edges"], db["corners"] = ec["edges"], ec["corners"]
            result["defect_boxes"] = db
    except Exception:
        pass
    return result
