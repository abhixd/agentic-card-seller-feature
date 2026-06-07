"""
CV Grading Inspector — Streamlit app for deep analysis of the classical-CV card grader.

Pick a card → see the prediction + severity heatmap → CLICK a heatmap cell to highlight
that defect on the card and zoom into it → toggle the detected boundaries on/off.

Run:  cd notebooks && ../backend/venv/bin/streamlit run cv_inspector.py
"""
import os, sys, glob
os.environ.setdefault("CARD_DETECTOR", "seg")
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE); sys.path.insert(0, os.path.join(_HERE, "..", "backend"))
from dotenv import load_dotenv
load_dotenv(os.path.join(_HERE, "..", ".env.local"), override=True)
load_dotenv(os.path.join(_HERE, "..", "backend", ".env"), override=False)

import numpy as np, cv2, joblib, xgboost as xgb, pandas as pd
from pathlib import Path
from PIL import Image, ImageDraw, ImageFont
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
from matplotlib import font_manager
import streamlit as st
from streamlit_image_coordinates import streamlit_image_coordinates
import nonvlm_cv as N
import warp_cache as WC
import inner_frame as IF

BASE = Path(_HERE) / "feature_extraction_dataset"
MODELS = Path(_HERE) / "models"
SEV_COLORS = ["#3a3f47", "#fdd835", "#fb8c00", "#f4511e", "#e53935"]  # none(dk gray)→heavy(red), for dark bg
SEV_TXT = ["·", "trace", "minor", "mod", "HEAVY"]
# per-defect overlay colour (RGB) when the exact defect PIXELS are localized
DEFECT_COLOR = {"whitening": (235, 40, 40), "nick": (255, 145, 0), "chip": (255, 0, 150),
                "fraying": (180, 235, 0), "scratches": (0, 210, 235), "print_lines": (80, 160, 255),
                "creases": (170, 80, 255), "dents": (210, 140, 40), "stains": (0, 200, 120),
                "holo_disruption": (255, 90, 170)}
REGION_FALLBACK = (255, 120, 40)   # dim orange = "whole region" (no pixel-level localization / none found)
CK = {"top_left": "TL", "top_right": "TR", "bottom_right": "BR", "bottom_left": "BL"}
# region of each pillar/location on the warped card (x0,y0,x1,y1 as fractions)
BB = {("corners", "top_left"): (0, 0, .24, .24), ("corners", "top_right"): (.76, 0, 1, .24),
      ("corners", "bottom_right"): (.76, .76, 1, 1), ("corners", "bottom_left"): (0, .76, .24, 1),
      ("edges", "top"): (0, 0, 1, .14), ("edges", "bottom"): (0, .86, 1, 1),
      ("edges", "left"): (0, 0, .14, 1), ("edges", "right"): (.86, 0, 1, 1),
      ("surface", "surface"): (.02, .02, .98, .98)}
_FONT = font_manager.findfont("DejaVu Sans")

st.set_page_config(layout="wide", page_title="CV Grading Inspector", page_icon="🔍")


# ── pipeline (cached) ────────────────────────────────────────────────────────
@st.cache_resource
def load_model(kind):
    return joblib.load(MODELS / f"cv_xgb_{kind}.pkl")


@st.cache_resource
def psa10_background(_b, n=30):
    """Feature rows of the most archetypal PSA10s — the reference baseline for 'why not a 10'
    (so the SHAP baseline is 'a typical PSA10', not the training-average that gives ghost positives)."""
    df = pd.read_csv(BASE / "cv_raw.csv"); p10 = df[df["actual_psa"] == 10]
    cols = _b["feature_cols"]
    Xbg = np.array([[float(r.get(c, 0.0)) for c in cols] for _, r in p10.iterrows()], np.float32)
    m = _b["model"].get_booster().predict(xgb.DMatrix(Xbg), output_margin=True)[:, _b["tier_map"][10]]
    return Xbg[np.argsort(-m)[:n]]


@st.cache_data(show_spinner="Detecting card + extracting features…")
def analyze(img_bytes, src_path=None, det_cap=0.10):
    arr = cv2.imdecode(np.frombuffer(img_bytes, np.uint8), cv2.IMREAD_COLOR)
    if src_path:                                               # dataset card → reuse cached seg warp (no API)
        det = WC.get_det(src_path, out_size=N.CV_WARP_SIZE)
    else:
        det = N.detect_and_warp(arr, detector="seg", out_size=N.CV_WARP_SIZE)
    cen = N.compute_centering_hybrid(det["warped"], det["cb"])
    cr = cen["content_region"]                                  # kept for condition/defect extraction
    inn = IF.find_inner_frame(det["warped"], det["cb"], max_inset=det_cap)  # CoherentFrame = PRIMARY centering (cap = det_cap)
    _x1, _y1, _x2, _y2 = inn["cb_px"]; _iw = max(_x2 - _x1, 1); _ih = max(_y2 - _y1, 1)
    inset_pct = {"L": 100 * inn["insets_px"]["L"] / _iw, "R": 100 * inn["insets_px"]["R"] / _iw,
                 "T": 100 * inn["insets_px"]["T"] / _ih, "B": 100 * inn["insets_px"]["B"] / _ih}
    cond, raw = N.cv_extract_conditions(det, cr=cr)            # uses ORIGINAL warp (boundary-conf needs bg)
    cw = np.asarray(det["cw"]) if det.get("cw") is not None else None
    mask = N.card_mask_warped(det) > 0
    warped_disp = det["warped"].copy()                         # display = card only: black out everything outside cyan
    warped_disp[~mask] = 18
    orig = cv2.cvtColor(arr, cv2.COLOR_BGR2RGB)                 # original uploaded image
    oh, ow = orig.shape[:2]; s = 560.0 / max(oh, ow)
    if s < 1.0:
        orig = cv2.resize(orig, (int(ow * s), int(oh * s)))
    return {"warped": warped_disp, "cw": cw, "cb": det["cb"], "original": orig,
            "mask": mask,
            "seg_conf": float(det.get("seg_conf", 0)), "crops": N.corner_crops(det),
            "cond": cond, "raw": raw, "cr": cr,
            "lr": inn["left_right"], "tb": inn["top_bottom"],
            "border_type": cen.get("border_type", "?"), "reliable": bool(inn["reliable"]),
            "cb_px": inn["cb_px"], "inset_pct": inset_pct, "manual": False,
            "lr_old": cen["left_right"], "tb_old": cen["top_bottom"], "det": det}


@st.cache_data(show_spinner="Re-extracting edge features inside the manual boundary…")
def reextract(_det, card_key, cr_tuple):
    """Re-run condition extraction with a manually-corrected inner boundary cr. Edge features
    (strip cb→cr) change; surface/corners are decoupled. Cached per (card, boundary)."""
    cr = {"x1": cr_tuple[0], "y1": cr_tuple[1], "x2": cr_tuple[2], "y2": cr_tuple[3]}
    return N.cv_extract_conditions(_det, cr=cr)


def predict(A, kind, cen_lr=None, cen_tb=None):
    b = load_model(kind)
    if b["source"] == "raw":
        feat = N.raw_to_vector(A["cond"], A["raw"])
    else:
        feat = {f"cv.{k}": v for k, v in N.features_to_vector(A["cond"]).items()}
    # default: model centering features use the OLD detector it was TRAINED on (no train/serve skew).
    # On a manual rerun, the human-corrected centering is passed in and used instead.
    _lr = cen_lr if cen_lr is not None else A["lr_old"]
    _tb = cen_tb if cen_tb is not None else A["tb_old"]
    feat["cen.lr_deviation"] = abs(int(_lr.split("/")[0]) - 50)
    feat["cen.tb_deviation"] = abs(int(_tb.split("/")[0]) - 50)
    X = np.array([[float(feat.get(c, 0.0)) for c in b["feature_cols"]]], np.float32)
    return b, b["model"].predict_proba(X)[0], X


def pretty_feat(col):
    """Human-readable feature label (pillar/loc · measure)."""
    if col.startswith("cen."):
        return "centering · " + col.split(".", 1)[1].replace("_", " ")
    fam, *rest = col.split(".")
    tag = {"mag": " (mag)", "conf": " (conf)"}.get(fam, "")
    if rest[0] == "surface":
        return "surface · " + ".".join(rest[1:]) + tag
    return f"{rest[0]}/{rest[1]} · " + ".".join(rest[2:]) + tag


def explain(b, X, pidx, topn=12):
    """Per-image TreeSHAP: top feature contributions to the PREDICTED tier's margin.
    Returns ([(label, contribution, raw_value), …] sorted by |contribution|, bias)."""
    contribs = np.asarray(b["model"].get_booster().predict(xgb.DMatrix(np.asarray(X, np.float32)),
                                                           pred_contribs=True))
    row = contribs[0, pidx] if contribs.ndim == 3 else contribs[0]   # multiclass → (n_feat+1,)
    c, bias = row[:-1], float(row[-1])
    cols = b["feature_cols"]
    order = np.argsort(-np.abs(c))[:topn]
    return [(pretty_feat(cols[i]), float(c[i]), float(X[0][i])) for i in order], bias


def _concept(feat):
    """Map a raw feature name → a user-meaningful condition concept (plain English)."""
    if feat.startswith("cen."):
        return "centering"
    parts = feat.split("."); pillar = parts[1] if len(parts) > 1 else feat; key = parts[-1].lower()
    if pillar == "corners":
        if "whiten" in key or "tip" in key: return "corner whitening"
        if any(k in key for k in ("fray", "curve", "deform", "bend")): return "corner wear / shape"
        if any(k in key for k in ("colorstd", "uniformity", "valid")): return "scan/measurement quality"
        return "corner condition"
    if pillar == "edges":
        if "whiten" in key: return "edge whitening"
        if any(k in key for k in ("nick", "notch", "chip")): return "edge nicks / chips"
        if any(k in key for k in ("fray", "fiber", "jagged", "frequency")): return "edge fraying"
        if any(k in key for k in ("boundary", "conf", "geom", "px", "colorstd", "uniformity", "strip", "border", "band")):
            return "scan/measurement quality"
        return "edge condition"
    if pillar == "surface":
        if "scratch" in key: return "surface scratches"
        if "print" in key: return "surface print lines"
        if "crease" in key: return "surface creases"
        if "dent" in key: return "surface dents"
        if "stain" in key or "deltae" in key: return "surface stains / discoloration"
        if "holo" in key: return "holo / foil disruption"
        if "anomaly" in key: return "surface anomalies"
        return "surface condition"
    return pillar


def interpret_per_tier(b, X, proba, thr=0.03):
    """Per-grade plain-English drivers: for EACH tier, which condition concepts pushed its
    probability UP vs DOWN — per-class TreeSHAP aggregated to user concepts. Answers
    'why 70% for PSA10, 20% for PSA9, …' in human terms."""
    from collections import defaultdict
    C = np.asarray(b["model"].get_booster().predict(xgb.DMatrix(np.asarray(X, np.float32)), pred_contribs=True))
    cols = b["feature_cols"]; short = b["tier_short"]; out = []
    for t in range(len(short)):
        c = C[0, t, :-1] if C.ndim == 3 else C[0, :-1]
        agg = defaultdict(float)
        for i, v in enumerate(c):
            agg[_concept(cols[i])] += float(v)
        agg.pop("scan/measurement quality", None)     # measurement confidence, not a condition reason
        pos = [k for k, v in sorted(agg.items(), key=lambda kv: -kv[1]) if v > thr][:3]
        neg = [k for k, v in sorted(agg.items(), key=lambda kv: kv[1]) if v < -thr][:3]
        out.append({"tier": short[t], "prob": float(proba[t]), "for": pos, "against": neg})
    return sorted(out, key=lambda d: -d["prob"])


def conf_color(c):
    """0→1 confidence to a red(low)→amber→green(high) hex, normalized over the 0.2–0.85 range."""
    t = float(np.clip((c - 0.2) / 0.65, 0, 1))
    r, g, bl = (int(225 - 185 * t), int(70 + 130 * t), int(55 + 40 * t))
    return f"#{r:02x}{g:02x}{bl:02x}"


# ── detection-overlay helpers ────────────────────────────────────────────────
def place_edge(v, mask, H, W):
    """Map a sub-strip mask (white/nick/chip/fraying, in the rotated strip frame)
    back into warped-card coordinates."""
    k = v["k"]; ce = v["ce"]; x1, y1, x2, y2 = v["x1"], v["y1"], v["x2"], v["y2"]
    mask = np.asarray(mask, np.uint8)
    sh = ((y2 - y1), (x2 - x1)) if k % 2 == 0 else ((x2 - x1), (y2 - y1))
    full = np.zeros(sh, np.uint8); full[:, ce:sh[1] - ce] = mask[:sh[0], :sh[1] - 2 * ce]
    out = np.zeros((H, W), np.uint8); out[y1:y2, x1:x2] = np.rot90(full, (4 - k) % 4)[:y2 - y1, :x2 - x1]
    return out > 0


def hl_mask(A, pillar, loc, defect, H, W):
    """(bool mask, RGB colour, pixel_precise?). Highlights the EXACT defect pixels
    where the extractor localizes them; otherwise the ACTUAL analyzed strip / ROI
    (not the loose pillar box). pixel_precise=False ⇒ a 'whole region' fallback."""
    raw = A["raw"]; col = DEFECT_COLOR.get(defect, REGION_FALLBACK)
    # ---- EDGES: per-defect sub-strip mask (whitening / nick / chip / fraying) ----
    if pillar == "edges":
        v = raw["edges"].get(loc, {}).get("_viz")
        mk = {"whitening": "white_mask", "nick": "nick_mask",
              "chip": "chip_mask", "fraying": "fraying_mask"}.get(defect)
        if v and mk and v.get(mk) is not None and np.asarray(v[mk]).any():
            m = place_edge(v, v[mk], H, W)
            if m.any():
                return m, col, True
        rect = edge_strip_rect(A, loc)                       # fallback = the analyzed strip (tight)
        if rect:
            a0, b0, a1, b1 = rect; m = np.zeros((H, W), bool); m[b0:b1, a0:a1] = True
            return m, REGION_FALLBACK, False
    # ---- SURFACE: per-defect segments / component boxes ----
    if pillar == "surface":
        sv = raw["surface"].get("_viz", {}); reg = sv.get("region")
        if reg:
            mm = int(N.SURFACE_EDGE_MARGIN * min(H, W))
            ox = int(round(reg["x1"] * W)) + mm; oy = int(round(reg["y1"] * H)) + mm
            m = np.zeros((H, W), np.uint8)
            seg = {"scratches": "scratch_segments", "print_lines": "print_line_segments",
                   "creases": "crease_segments"}.get(defect)
            box = {"dents": "dent_boxes", "stains": "stain_boxes"}.get(defect)
            if seg:
                for s in sv.get(seg, []):
                    cv2.line(m, (ox + int(s[0]), oy + int(s[1])), (ox + int(s[2]), oy + int(s[3])), 255, 3)
            elif box:
                for (x, y, w, h) in sv.get(box, []):
                    cv2.rectangle(m, (ox + int(x), oy + int(y)), (ox + int(x + w), oy + int(y + h)), 255, -1)
            if m.any():
                return m > 0, col, True
            x2 = int(round(reg["x2"] * W)) - mm; y2 = int(round(reg["y2"] * H)) - mm
            mr = np.zeros((H, W), bool); mr[oy:max(oy + 1, y2), ox:max(ox + 1, x2)] = True   # fallback = surface ROI
            return mr, REGION_FALLBACK, False
    # ---- CORNERS: whitening localizes (crop white_mask); shape defects are whole-corner ----
    bb = BB[(pillar, loc) if (pillar, loc) in BB else ("surface", "surface")]
    bx0, by0, bx1, by1 = int(bb[0] * W), int(bb[1] * H), int(bb[2] * W), int(bb[3] * H)
    if pillar == "corners" and defect == "whitening" and bx1 > bx0 and by1 > by0:
        wm = raw["corners"].get(loc, {}).get("_viz", {}).get("white_mask")
        if wm is not None and np.asarray(wm).any():
            wmr = cv2.resize(np.asarray(wm, np.uint8), (bx1 - bx0, by1 - by0), interpolation=cv2.INTER_NEAREST)
            m = np.zeros((H, W), bool); m[by0:by1, bx0:bx1] = wmr > 0
            if m.any():
                return m, col, True
    m = np.zeros((H, W), bool); m[by0:by1, bx0:bx1] = True
    return m, REGION_FALLBACK, False


def edge_strip_rect(A, side):
    """Warped-px rect (x0,y0,x1,y1) of the ANALYZED edge strip on this side, or None.
    Anchored at the true card edge (cw bbox), matching cv_edge_features."""
    H, W = A["warped"].shape[:2]
    cw = np.asarray(A["cw"], float)
    if cw.ndim == 2 and len(cw) >= 3:
        x1, y1 = int(cw[:, 0].min() * W), int(cw[:, 1].min() * H)
        x2, y2 = int(cw[:, 0].max() * W), int(cw[:, 1].max() * H)
    else:
        x1, y1, x2, y2 = [int(round(v * d)) for v, d in zip(A["cb"], [W, H, W, H])]
    r = A["raw"]["edges"].get(side, {})
    cut = int(r.get("cut_px", 0)); strip = int(r.get("strip_px", 0))
    if strip <= 0:
        return None
    ce = 0.12
    if side in ("top", "bottom"):
        a0, a1 = x1 + int(ce * (x2 - x1)), x2 - int(ce * (x2 - x1))
        return (a0, y1 + cut, a1, y1 + cut + strip) if side == "top" else (a0, y2 - cut - strip, a1, y2 - cut)
    d0, d1 = y1 + int(ce * (y2 - y1)), y2 - int(ce * (y2 - y1))
    return (x1 + cut, d0, x1 + cut + strip, d1) if side == "left" else (x2 - cut - strip, d0, x2 - cut, d1)


def render_card(A, sel, show_outer=False, show_inner=False, show_strip=False):
    rgb = cv2.cvtColor(A["warped"], cv2.COLOR_BGR2RGB).copy(); H, W = rgb.shape[:2]
    if sel:
        m, col, px = hl_mask(A, *sel, H, W)
        a = 0.62 if px else 0.42                    # pixel-precise = stronger; region = lighter tint
        rgb[m] = ((1 - a) * rgb[m] + a * np.array(col)).astype(np.uint8)
    if show_strip:                                  # dark magenta — analyzed border strip per side
        for side in N.EDGE_LOCS:
            rect = edge_strip_rect(A, side)
            if rect:
                a0, b0, a1, b1 = rect
                sub = rgb[b0:b1, a0:a1]
                rgb[b0:b1, a0:a1] = (0.45 * sub + np.array([70, 0, 70])).clip(0, 255).astype(np.uint8)
                cv2.rectangle(rgb, (a0, b0), (a1, b1), (130, 0, 130), 2)
    if show_outer and A["cw"] is not None and len(A["cw"]) > 2:  # cyan — outer Model-C boundary
        cv2.polylines(rgb, [(A["cw"] * [W, H]).astype(np.int32)], True, (34, 211, 238), 3)
    if show_inner:                                              # green — CoherentFrame inner frame (reflects manual override)
        ip = A.get("inset_pct"); cbp = A.get("cb_px")
        if ip and cbp:
            x1, y1, x2, y2 = cbp; iw = max(x2 - x1, 1); ih = max(y2 - y1, 1)
            L = x1 + int(ip["L"] / 100 * iw); R = x2 - int(ip["R"] / 100 * iw)
            T = y1 + int(ip["T"] / 100 * ih); B = y2 - int(ip["B"] / 100 * ih)
            cv2.rectangle(rgb, (L, T), (R, B), (0, 230, 0), 3)
        else:
            cr = A["cr"]
            cv2.rectangle(rgb, (int(cr["x1"] * W), int(cr["y1"] * H)),
                          (int(cr["x2"] * W), int(cr["y2"] * H)), (30, 144, 255), 3)
    return rgb


def render_zoom(A, sel, px=460):
    H, W = A["warped"].shape[:2]
    if not sel:
        z = cv2.cvtColor(A["warped"], cv2.COLOR_BGR2RGB)
    else:
        pillar, loc, defect = sel
        if pillar == "corners":
            z = cv2.cvtColor(A["crops"][CK[loc]], cv2.COLOR_BGR2RGB).copy()
            wm = A["raw"]["corners"][loc].get("_viz", {}).get("white_mask")
            if defect == "whitening" and wm is not None and wm.shape[:2] == z.shape[:2]:
                z[wm > 0] = [235, 40, 40]
        else:
            card = render_card(A, sel)
            bb = BB[(pillar, loc) if pillar == "edges" else ("surface", "surface")]
            z = card[int(bb[1] * H):int(bb[3] * H), int(bb[0] * W):int(bb[2] * W)]
    ch, cw = z.shape[:2]; sk = px / max(cw, ch)
    return cv2.resize(z, (max(1, int(cw * sk)), max(1, int(ch * sk))), interpolation=cv2.INTER_NEAREST)


# ── clickable heatmap (drawn with PIL, exact cell bboxes) ────────────────────
def draw_heatmap(cond):
    LW, CW, CH, pad, titleH, headH = 96, 74, 32, 8, 24, 20
    CFW, GAP = 58, 16                                  # per-location confidence column
    blocks = [("corners", N.CORNER_LOCS, N.CORNER_DEFECTS),
              ("edges", N.EDGE_LOCS, N.EDGE_DEFECTS),
              ("surface", [None], N.SURFACE_DEFECTS)]
    CFX = LW + 6 * CW + GAP                             # conf column left edge
    width = CFX + CFW + 2 * pad
    height = pad + sum(titleH + headH + (len(locs)) * CH + pad for _, locs, _ in blocks)
    img = Image.new("RGB", (width, height), "#0e1117"); d = ImageDraw.Draw(img)
    f = ImageFont.truetype(_FONT, 12); fb = ImageFont.truetype(_FONT, 13)
    bboxes = []; y = pad
    for pillar, locs, defects in blocks:
        d.text((pad, y), pillar.title(), fill="#fafafa", font=fb); y += titleH
        for j, df in enumerate(defects):
            d.text((LW + j * CW + 3, y), df[:7], fill="#c8ccd2", font=f)
        d.text((CFX + 6, y), "conf", fill="#9aa0a6", font=f)       # confidence column header
        y += headH
        for loc in locs:
            d.text((pad, y + 9), (loc or "surface").replace("_", " ")[:12], fill="#e8eaed", font=f)
            for j, df in enumerate(defects):
                sev = int(N._sev(cond[pillar][loc][df])) if loc else int(N._sev(cond[pillar][df]))
                x0, y0, x1, y1 = LW + j * CW, y, LW + j * CW + CW - 4, y + CH - 4
                d.rectangle([x0, y0, x1, y1], fill=SEV_COLORS[sev], outline="#6b7682", width=1)
                txt = SEV_TXT[sev]
                tcol = "white" if sev >= 4 else ("#9aa0a6" if sev == 0 else "#1a1d23")
                d.text((x0 + 6, y0 + 9), txt, fill=tcol, font=f)
                bboxes.append((x0, y0, x1, y1, pillar, loc, df))
            cf = float((cond[pillar][loc] if loc else cond[pillar]).get("confidence", 0.0))  # reliability of this row
            d.rectangle([CFX, y, CFX + CFW - 4, y + CH - 4], fill=conf_color(cf), outline="#6b7682", width=1)
            d.text((CFX + 7, y + 9), f"{cf:.2f}", fill="#0e1117", font=f)
            y += CH
        y += pad
    return img, bboxes


def cell_at(x, y, bboxes):
    for (x0, y0, x1, y1, p, l, df) in bboxes:
        if x0 <= x <= x1 and y0 <= y <= y1:
            return (p, l, df)
    return None


def problems(A):
    """all detected defects (sev>=trace), ranked, with raw magnitude + FP flag."""
    raw = A["raw"]; out = []
    for pillar, locs, defects in (("corners", N.CORNER_LOCS, N.CORNER_DEFECTS),
                                  ("edges", N.EDGE_LOCS, N.EDGE_DEFECTS),
                                  ("surface", [None], N.SURFACE_DEFECTS)):
        for loc in locs:
            node = raw[pillar][loc] if loc else raw[pillar]
            cnode = A["cond"][pillar][loc] if loc else A["cond"][pillar]
            mag = node.get("_mag", {})
            for df in defects:
                sev = int(N._sev(cnode[df]))
                if sev < 1:
                    continue
                uw = node.get("uniformity_weight", 1.0)
                fp = (pillar in ("edges", "corners") and df in ("whitening", "nick", "chip", "fraying")
                      and uw < 0.5)
                out.append({"pillar": pillar, "loc": loc or "surface", "defect": df, "sev": sev,
                            "mag": float(mag.get(df, 0.0)), "uw": uw, "fp": fp})
    out.sort(key=lambda r: -r["sev"])
    return out


# ════════════════════════════════════════════════════════════════════════════
# UI
# ════════════════════════════════════════════════════════════════════════════
st.title("🔍 CV Grading Inspector")

with st.sidebar:
    st.header("Card")
    src = st.radio("Source", ["Dataset", "Upload"], horizontal=True)
    img_bytes, true_psa, name, src_path = None, None, None, None
    if src == "Dataset":
        grades = sorted(int(p.name) for p in BASE.iterdir() if p.is_dir() and p.name.isdigit())
        g = st.selectbox("PSA grade folder", grades, index=min(len(grades) - 1, grades.index(10) if 10 in grades else 0))
        cards = sorted(glob.glob(str(BASE / str(g) / "*_front.jpeg")))
        if cards:
            c = st.selectbox("Card", cards, format_func=lambda p: os.path.basename(p))
            img_bytes = open(c, "rb").read(); true_psa = g; name = os.path.basename(c); src_path = c
    else:
        up = st.file_uploader("Card image (front)", type=["jpg", "jpeg", "png"])
        if up:
            img_bytes = up.getvalue(); name = up.name
    st.divider()
    model_kind = st.radio("Model", ["raw", "processed"],
                          help="raw = continuous measurements (best, 44.9% exact); processed = 0–4 severities")
    det_cap = st.slider("Inner-boundary max inset (%)", 4, 16, int(round(IF.MAX_INSET * 100)), 1,
                        help="Hard cap on how far the inner boundary may sit from the cut edge. Lower = forced "
                             "nearer the edge (kills interior-snap on full-arts); higher = allows wide vintage "
                             "borders. Changing this re-detects live.") / 100.0
    st.markdown("**Overlays**")
    show_outer = st.checkbox("Outer boundary (Model-C)", help="cyan — detected card outline")
    show_inner = st.checkbox("Inner boundary (content)", help="green — CoherentFrame inner frame (follows the manual override below)")
    show_strip = st.checkbox("Edge strips", help="dark magenta — the analyzed border strip per side (where edge features are measured)")
    if st.button("Clear selection"):
        st.session_state["sel"] = None
    st.divider()
    img_w = st.slider("Image size (px)", 160, 640, 260, 20,
                      help="small = fits one screen; drag up to inspect detail")

if img_bytes is None:
    st.info("Pick a dataset card or upload a card image (front) in the sidebar.")
    st.stop()

try:
    A = analyze(img_bytes, src_path, det_cap)
except Exception as e:
    st.error(f"Detection/extraction failed: {e}")
    st.stop()

st.session_state.setdefault("sel", None)
sel = st.session_state["sel"]

# ── manual inner-boundary override + rerun (mitigates full-art T/B snap onto internal bars) ──
def _split(a, c):
    p = int(round(100 * a / (a + c + 1e-9)))
    return f"{p}/{100 - p}"
_ip = A["inset_pct"]
_clamp = lambda v: float(min(20.0, max(0.0, round(float(v), 1))))
_ckey = src_path or name
with st.sidebar:
    st.divider()
    ov_on = st.checkbox("✏️ Manual inner boundary", value=False,
                        help="Override the auto-detected inner frame when it snaps to an internal bar "
                             "(the full-art T/B failure mode). Sliders = border inset from each cut edge, % of card. "
                             "The sliders live-preview the centering gate; the button re-extracts edge features "
                             "inside the corrected boundary and re-runs the model.")
    if ov_on:
        cL = st.slider("Left inset %", 0.0, 20.0, _clamp(_ip["L"]), 0.1)
        cR = st.slider("Right inset %", 0.0, 20.0, _clamp(_ip["R"]), 0.1)
        cT = st.slider("Top inset %", 0.0, 20.0, _clamp(_ip["T"]), 0.1)
        cB = st.slider("Bottom inset %", 0.0, 20.0, _clamp(_ip["B"]), 0.1)
        if st.button("🔄 Rerun prediction with manual boundary", type="primary",
                     help="Re-extract the edge features inside your corrected boundary, then re-run the model + grade call."):
            st.session_state["manual_pred"] = {"key": _ckey, "insets": (cL, cR, cT, cB)}
    else:
        cL, cR, cT, cB = _ip["L"], _ip["R"], _ip["T"], _ip["B"]
        st.session_state.pop("manual_pred", None)

Aeff = dict(A)
Aeff["lr"], Aeff["tb"] = _split(cL, cR), _split(cT, cB)
Aeff["reliable"] = True if ov_on else A["reliable"]
Aeff["manual"] = ov_on
Aeff["inset_pct"] = {"L": cL, "R": cR, "T": cT, "B": cB}

# apply a requested rerun: re-extract edge features inside the manual boundary, predict with manual centering
_mp = st.session_state.get("manual_pred")
_use_manual = bool(ov_on and _mp and _mp["key"] == _ckey)
_stale = bool(_use_manual and _mp["insets"] != (cL, cR, cT, cB))
_reran = False
if _use_manual and not _stale:
    _x1, _y1, _x2, _y2 = A["cb_px"]; _Hd, _Wd = A["warped"].shape[:2]
    _iw, _ih = _x2 - _x1, _y2 - _y1
    _cr = ((_x1 + cL / 100 * _iw) / _Wd, (_y1 + cT / 100 * _ih) / _Hd,
           (_x2 - cR / 100 * _iw) / _Wd, (_y2 - cB / 100 * _ih) / _Hd)
    A = dict(A)
    A["cond"], A["raw"] = reextract(A["det"], _ckey, _cr)
    A["cr"] = {"x1": _cr[0], "y1": _cr[1], "x2": _cr[2], "y2": _cr[3]}
    A["lr"], A["tb"], A["reliable"], A["manual"], A["inset_pct"] = Aeff["lr"], Aeff["tb"], True, True, Aeff["inset_pct"]
    Aeff = A
    b, proba, Xfeat = predict(A, model_kind, Aeff["lr"], Aeff["tb"])
    _reran = True
else:
    b, proba, Xfeat = predict(A, model_kind)
pidx = int(proba.argmax())
if _stale:
    with st.sidebar:
        st.caption("⚠️ boundary changed since last rerun — click **Rerun** to update the prediction")

# header line
correct = (true_psa is not None and b["tier_map"].get(int(true_psa)) == pidx)
hdr = f"**{name}**  ·  detector seg ({A['seg_conf']:.0%})  ·  "
hdr += f"prediction → **{b['tier_labels'][pidx]}** ({proba[pidx]:.0%})"
if true_psa is not None:
    hdr += f"  ·  true PSA {true_psa}  " + ("✅" if correct else "❌")
st.markdown(hdr)

# ── CONFORM-CARD grade call: point + likely within-1 band + confidence flag ──
def grade_call(proba, b):
    short = b["tier_short"]; pi = int(proba.argmax()); conf = float(proba[pi]); lo = hi = pi; cum = conf
    while cum < 0.85 and (lo > 0 or hi < len(short) - 1):
        left = proba[lo - 1] if lo > 0 else -1.0
        right = proba[hi + 1] if hi < len(short) - 1 else -1.0
        if right >= left and hi < len(short) - 1:
            hi += 1; cum += proba[hi]
        elif lo > 0:
            lo -= 1; cum += proba[lo]
        else:
            break
    band = short[lo] if lo == hi else f"{short[lo]}–{short[hi]}"
    flag = "✅ confident" if conf >= 0.6 else ("⚠️ submit to confirm" if conf < 0.45 else "~ likely")
    return short[pi], band, conf, flag


def interpret_why_not_10(b, X, Xbg, thr=0.05):
    """PSA10-anchored, REFERENCE-based explanation: per-feature SHAP on the PSA10 margin, differenced
    against a pristine-PSA10 background (phi = card − typical-10). Most-negative concepts = 'what's
    keeping it off a 10' (exact-additive to the card's distance-from-a-10); positives = 'supports a 10'.
    Fixes the wrong-class + wrong-(training-average)-baseline problem of the old predicted-class SHAP."""
    from collections import defaultdict
    P10 = b["tier_map"][10]; bst = b["model"].get_booster()
    C = np.asarray(bst.predict(xgb.DMatrix(np.asarray(X, np.float32)), pred_contribs=True))[0, P10, :-1]
    Cbg = np.asarray(bst.predict(xgb.DMatrix(np.asarray(Xbg, np.float32)), pred_contribs=True))[:, P10, :-1].mean(0)
    agg = defaultdict(float); cols = b["feature_cols"]
    for i, v in enumerate(C - Cbg):
        agg[_concept(cols[i])] += float(v)
    agg.pop("scan/measurement quality", None)
    why_not = [k for k, v in sorted(agg.items(), key=lambda kv: kv[1]) if v < -thr][:5]
    supports = [k for k, v in sorted(agg.items(), key=lambda kv: -kv[1]) if v > thr][:3]
    return why_not, supports


def centering_factor(A, b):
    """Deterministic PSA centering gate (the model under-uses centering, so we enforce the published
    front tolerances explicitly). Worst-axis split → implied max grade; reliability-flagged + shown
    TRANSPARENTLY (never a silent override — our centering read is a known weak spot)."""
    lr_dev = abs(int(A["lr"].split("/")[0]) - 50); tb_dev = abs(int(A["tb"].split("/")[0]) - 50)
    dev = max(lr_dev, tb_dev); worst = A["lr"] if lr_dev >= tb_dev else A["tb"]
    axis = "L/R" if lr_dev >= tb_dev else "T/B"
    g = 10 if dev <= 5 else (9 if dev <= 10 else (8 if dev <= 15 else (7 if dev <= 20 else 6)))  # PSA front tol
    # manual override => human-verified boundary => trust it regardless of border type
    reliable = bool(A.get("manual")) or (bool(A.get("reliable")) and A.get("border_type") not in ("foil", "full_art", "holo"))
    return {"split": worst, "axis": axis, "dev": dev, "grade": g, "cap": b["tier_map"][g], "reliable": reliable}


_pt, _band, _conf, _flag = grade_call(proba, b)
_cf = centering_factor(Aeff, b)
_rr = "  ·  ✏️ *re-run on manual boundary*" if _reran else ""
st.markdown(f"### Grade call: **{_pt}**  ·  likely **{_band}**  ·  {_conf:.0%} {_flag}{_rr}")
if _cf["grade"] < 10:
    _adj = b["tier_short"][min(pidx, _cf["cap"])]
    _disagree = f"  →  **centering-adjusted: {_adj}**" if (_cf["cap"] < pidx and _cf["reliable"]) else ""
    _note = "" if _cf["reliable"] else "  *(centering read low-confidence — not applied)*"
    st.markdown(f"### 📐 Centering **{_cf['split']}** ({_cf['axis']}) → PSA tolerance caps at **≤ {b['tier_short'][_cf['cap']]}**{_disagree}{_note}")
st.caption("Grade call = CONFORM-CARD point + within-1 band + confidence. **Centering is a deterministic PSA "
           "rule-gate** (the ML model itself barely uses centering, 0.7% of its weight), shown transparently — "
           "our centering read is approximate (a known weak spot), so it's flagged, not silently forced. "
           "within-1 ~87% / exact ~44%; PSA9-vs-10 is the hard cut (needs RakingLight).")

col_card, col_heat, col_info = st.columns([1.05, 1.0, 1.05])

with col_card:
    oc1, oc2 = st.columns(2)
    with oc1:
        st.markdown("###### Original")
        st.image(A["original"], width=img_w)
    with oc2:
        ov = " · ".join([s for s, on in [("outer", show_outer), ("inner", show_inner), ("strip", show_strip)] if on])
        st.markdown("###### Detected (warped)" + (f" · `{ov}`" if ov else ""))
        st.image(render_card(Aeff, sel, show_outer, show_inner, show_strip), width=img_w)
    st.markdown("##### Zoom" + (f"  ·  `{sel[0]}/{sel[1] or 'surface'}/{sel[2]}`" if sel else "  ·  *click a heatmap cell*"))
    st.image(render_zoom(A, sel), width=img_w)
    if sel:
        _H0, _W0 = A["warped"].shape[:2]
        _px = hl_mask(A, *sel, _H0, _W0)[2]
        st.caption(f"🎯 isolating the **{sel[2]}** pixels"
                   if _px else "▢ no pixel-level localization for this measure (or none found) — showing the analyzed region")

with col_heat:
    st.markdown("##### Severity heatmap — **click a cell**")
    hm, bboxes = draw_heatmap(A["cond"])
    clk = streamlit_image_coordinates(hm, key="hm")
    if clk is not None:
        pt = (clk["x"], clk["y"])
        if st.session_state.get("_lasthm") != pt:
            st.session_state["_lasthm"] = pt
            cell = cell_at(pt[0], pt[1], bboxes)
            if cell is not None:
                st.session_state["sel"] = None if st.session_state.get("sel") == cell else cell
                st.rerun()
    st.caption("· none · 🟨 trace · 🟧 minor · 🟥 mod · 🔴 HEAVY  —  click again to clear.  "
               "**conf** column = reliability of that row's reading (🟥 low → 🟩 high)")

with col_info:
    st.markdown("##### Prediction")
    BG = "#0e1117"
    fig, ax = plt.subplots(figsize=(4.2, 1.9)); fig.patch.set_facecolor(BG); ax.set_facecolor(BG)
    cols = ["#4c9aff" if i == pidx else "#3a3f47" for i in range(len(proba))]
    ax.bar(range(len(proba)), proba, color=cols)
    ax.set_xticks(range(len(proba))); ax.set_xticklabels(b["tier_short"], fontsize=8, color="#e8eaed")
    ax.set_ylim(0, 1); ax.tick_params(labelsize=8, colors="#e8eaed")
    for s in ax.spines.values():
        s.set_color("#3a3f47")
    for i, p in enumerate(proba):
        if p > 0.02:
            ax.text(i, p + 0.02, f"{p:.0%}", ha="center", fontsize=8, fontweight="bold", color="#fafafa")
    if true_psa is not None and int(true_psa) in b["tier_map"]:
        ax.axvline(b["tier_map"][int(true_psa)], color="#9aa0a6", ls="--", lw=1.2, alpha=.8)
    fig.tight_layout(); st.pyplot(fig, width="stretch"); plt.close(fig)

    st.markdown("##### Centering" + ("  ·  ✏️ *manual*" if Aeff["manual"] else "  ·  *CoherentFrame*"))
    lrd = abs(int(Aeff["lr"].split("/")[0]) - 50); tbd = abs(int(Aeff["tb"].split("/")[0]) - 50)
    m1, m2, m3 = st.columns(3)
    m1.metric("L / R", Aeff["lr"], help="left/right border split (50/50 = perfectly centered)")
    m2.metric("T / B", Aeff["tb"], help="top/bottom border split")
    m3.metric("Reliable", "✅ Yes" if Aeff["reliable"] else "⚠️ No",
              help="False when CoherentFrame hit the over-extension guard / is uncertain (auto-abstain). Manual override forces Yes.")
    st.caption(f"deviation L/R **{lrd}** · T/B **{tbd}**  ·  border type **{A['border_type']}**  ·  cap {det_cap:.0%}  ·  seg conf {A['seg_conf']:.0%}"
               + (f"  ·  auto-detected was L/R {A['lr']} · T/B {A['tb']}" if Aeff["manual"] else
                  f"  ·  old detector L/R {A['lr_old']} · T/B {A['tb_old']}"))

    # selected-cell detail
    if sel:
        p_, l_, d_ = sel
        node = A["raw"][p_][l_] if l_ else A["raw"][p_]
        m = float(node.get("_mag", {}).get(d_, 0.0))
        thr = N.CV_THRESHOLDS[N.thr_key(p_, d_)]
        sev = int(N._sev((A["cond"][p_][l_] if l_ else A["cond"][p_])[d_]))
        st.markdown(f"**Selected:** `{p_} / {l_ or 'surface'} / {d_}` → **{SEV_TXT[sev]}**")
        st.markdown(f"magnitude **{m:.3f}** · bins {thr} → none<{thr[0]}≤trace<{thr[1]}≤minor<{thr[2]}≤mod<{thr[3]}≤HEAVY")
        cnode = A["cond"][p_][l_] if l_ else A["cond"][p_]      # reliability of THIS reading + what drives it
        conf = float(cnode.get("confidence", 0.0))
        drv = (f"crop on-card {node.get('valid_frac', 0) * 100:.0f}%" if p_ == "corners"
               else f"border-width conf {node.get('conf_geom', 0):.2f} · true-edge conf {node.get('boundary_conf', 0):.2f}"
               if p_ == "edges" else "higher when scratches/stains/dents clearly fire")
        st.markdown(f"reliability (conf) **{conf:.2f}**  ·  _{drv}_")
        extra = {k: node[k] for k in ("whitening_area_ratio", "largest_whitening_blob",
                 "tip_whitening_present", "edge_colorstd", "uniformity_weight",
                 "edge_notch_count", "chip_missing_area_ratio", "fraying_score",
                 "scratch_count", "dent_count", "stain_count", "holo_disruption_count") if k in node}
        if extra:
            st.json(extra, expanded=False)

    st.markdown("##### Problems identified  *(severity ≥ trace)*")
    probs = problems(A)
    if not probs:
        st.success("No defects detected above 'none'.")
    for r in probs:
        chip = "🔴" if r["sev"] >= 4 else "🟥" if r["sev"] == 3 else "🟧" if r["sev"] == 2 else "🟨"
        flag = "  ⚠️ likely foil/full-art artifact (discounted)" if r["fp"] else ""
        st.write(f"{chip} **{r['loc']} · {r['defect']}** — {SEV_TXT[r['sev']]}  "
                 f"(mag {r['mag']:.2f}, uw {r['uw']:.2f}){flag}")

# ── Is this a PSA 10? — PSA10-anchored, reference-based explanation ───────────
st.divider()
_P10 = b["tier_map"][10]
st.markdown(f"#### 📋 Is this a PSA 10?  ·  model says **{proba[_P10]:.0%}**")
st.caption("Explained from the **PSA 10 perspective** (the grade that drives value), against a **pristine-PSA10 "
           "reference** — not the predicted grade vs the training average. Drivers below are what separate THIS "
           "card from a typical 10.")
why_not, supports = interpret_why_not_10(b, Xfeat, psa10_background(b))
lines = []
if _cf["grade"] < 10:                               # centering: first-class why-not factor (from the gate, not the model)
    _rel = "" if _cf["reliable"] else "  *(low-confidence read)*"
    lines.append(f"📐 **centering** — {_cf['split']} ({_cf['axis']}) → PSA tolerance allows only ≤ {b['tier_short'][_cf['cap']]}{_rel}")
lines += [f"⚠️ {k}" for k in why_not]
st.markdown("**What's keeping it from a 10:**")
for l in (lines[:6] or ["— nothing significant (the model reads this as 10-like)"]):
    st.markdown(f"&nbsp;&nbsp;{l}")
st.markdown("**What supports a 10:**  " + ("*" + " · ".join(supports) + "*" if supports else "—"))
st.caption("Condition drivers = reference-based TreeSHAP on the PSA10 margin (contribution vs a typical PSA10; "
           "exact-additive to the card's 'distance from a 10', so no ghost positives). Centering comes from the "
           "deterministic gate because the model under-uses it. The model is imperfect (~44% exact / 87% within-1).")

with st.expander("Per-grade breakdown — why each grade got its probability"):
    for i, d in enumerate(interpret_per_tier(b, Xfeat, proba)):
        if d["prob"] < 0.05 and i >= 2:
            continue
        st.markdown(f"**{d['tier']} — {d['prob']:.0%}**  \n"
                    f"&nbsp;&nbsp;✅ {' · '.join(d['for']) or '—'}  \n&nbsp;&nbsp;⚠️ {' · '.join(d['against']) or '—'}")

with st.expander("🔬 Technical detail — raw SHAP feature contributions (for the predicted tier)"):
    items, bias = explain(b, Xfeat, pidx, topn=14)
    labels = [f"{lab}   ({val:.3g})" for lab, contr, val in items][::-1]
    vals = [contr for _, contr, _ in items][::-1]
    figc, axc = plt.subplots(figsize=(9, 4.8)); figc.patch.set_facecolor("#0e1117"); axc.set_facecolor("#0e1117")
    axc.barh(range(len(vals)), vals, color=["#3fb37f" if v >= 0 else "#e5544b" for v in vals])
    axc.set_yticks(range(len(vals))); axc.set_yticklabels(labels, fontsize=8, color="#e8eaed")
    axc.axvline(0, color="#6b7682", lw=0.8)
    axc.set_xlabel("← pushes away    contribution to the predicted tier (log-odds)    pushes toward →",
                   fontsize=8, color="#c8ccd2")
    axc.tick_params(labelsize=8, colors="#e8eaed")
    for s in axc.spines.values():
        s.set_color("#3a3f47")
    figc.tight_layout(); st.pyplot(figc, width="stretch"); plt.close(figc)
    st.caption(f"🟩 toward **{b['tier_short'][pidx]}** · 🟥 away.  baseline {bias:.2f} + all contributions "
               f"→ softmax {proba[pidx]:.0%}.  parens = this card's measured values.")
