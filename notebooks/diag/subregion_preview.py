"""Validate per-defect subregion highlighting end-to-end (no Streamlit).
Replicates the app's place_edge + hl_mask placement on a real card and renders one
panel per localized defect so the isolated pixels can be checked against the card."""
import os, sys, glob
sys.path.insert(0, "."); sys.path.insert(0, "../backend")
os.environ["CARD_DETECTOR"] = "seg"
from dotenv import load_dotenv
load_dotenv("../.env.local", override=True); load_dotenv("../backend/.env", override=False)
import numpy as np, cv2, warp_cache as WC, nonvlm_cv as N

DEFECT_COLOR = {"whitening": (235, 40, 40), "nick": (255, 145, 0), "chip": (255, 0, 150),
                "fraying": (180, 235, 0), "scratches": (0, 210, 235), "print_lines": (80, 160, 255),
                "creases": (170, 80, 255), "dents": (210, 140, 40), "stains": (0, 200, 120)}

def place_edge(v, mask, H, W):
    k = v["k"]; ce = v["ce"]; x1, y1, x2, y2 = v["x1"], v["y1"], v["x2"], v["y2"]
    mask = np.asarray(mask, np.uint8)
    sh = ((y2 - y1), (x2 - x1)) if k % 2 == 0 else ((x2 - x1), (y2 - y1))
    full = np.zeros(sh, np.uint8); full[:, ce:sh[1] - ce] = mask[:sh[0], :sh[1] - 2 * ce]
    out = np.zeros((H, W), np.uint8); out[y1:y2, x1:x2] = np.rot90(full, (4 - k) % 4)[:y2 - y1, :x2 - x1]
    return out > 0

def edge_mask(raw, side, defect, H, W):
    v = raw["edges"].get(side, {}).get("_viz")
    mk = {"whitening": "white_mask", "nick": "nick_mask", "chip": "chip_mask", "fraying": "fraying_mask"}[defect]
    if v and v.get(mk) is not None and np.asarray(v[mk]).any():
        return place_edge(v, v[mk], H, W)
    return None

def surface_mask(raw, defect, H, W):
    sv = raw["surface"].get("_viz", {}); reg = sv.get("region")
    if not reg: return None
    mm = int(N.SURFACE_EDGE_MARGIN * min(H, W)); ox = int(round(reg["x1"] * W)) + mm; oy = int(round(reg["y1"] * H)) + mm
    m = np.zeros((H, W), np.uint8)
    seg = {"scratches": "scratch_segments", "print_lines": "print_line_segments", "creases": "crease_segments"}.get(defect)
    box = {"dents": "dent_boxes", "stains": "stain_boxes"}.get(defect)
    if seg:
        for s in sv.get(seg, []): cv2.line(m, (ox + int(s[0]), oy + int(s[1])), (ox + int(s[2]), oy + int(s[3])), 255, 3)
    elif box:
        for (x, y, w, h) in sv.get(box, []): cv2.rectangle(m, (ox + int(x), oy + int(y)), (ox + int(x + w), oy + int(y + h)), 255, -1)
    return m > 0 if m.any() else None

def panel(warped, mask, color, label):
    rgb = cv2.cvtColor(warped, cv2.COLOR_BGR2RGB).copy()
    rgb[mask] = (0.38 * rgb[mask] + 0.62 * np.array(color)).astype(np.uint8)
    rgb = cv2.resize(rgb, (int(rgb.shape[1] * 360 / rgb.shape[0]), 360))
    head = np.zeros((30, rgb.shape[1], 3), np.uint8)
    cv2.putText(head, label, (6, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.55, (255, 255, 255), 1, cv2.LINE_AA)
    return np.vstack([head, cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)])

# pick a low-grade card and collect its localized defects
cand = sorted(glob.glob("feature_extraction_dataset/5/*_front.jpeg")) + sorted(glob.glob("feature_extraction_dataset/6/*_front.jpeg"))
panels = None
for p in cand:
    det = WC.get_det(p, out_size=N.CV_WARP_SIZE)
    cen = N.compute_centering_hybrid(det["warped"], det["cb"]); cr = cen["content_region"]
    cond, raw = N.cv_extract_conditions(det, cr=cr)
    H, W = det["warped"].shape[:2]; found = []
    for side in N.EDGE_LOCS:
        for dfc in ["whitening", "nick", "chip", "fraying"]:
            m = edge_mask(raw, side, dfc, H, W)
            if m is not None: found.append((m, DEFECT_COLOR[dfc], f"edge/{side}/{dfc}  ({int(m.sum())}px)"))
    for dfc in ["scratches", "print_lines", "creases", "dents", "stains"]:
        m = surface_mask(raw, dfc, H, W)
        if m is not None: found.append((m, DEFECT_COLOR[dfc], f"surface/{dfc}  ({int(m.sum())}px)"))
    if len(found) >= 6:
        print(f"card: {os.path.basename(p)}  localized defects: {len(found)}")
        cols = [panel(det["warped"], m, c, l) for m, c, l in found[:8]]
        h = max(x.shape[0] for x in cols)
        cols = [np.vstack([x, np.full((h - x.shape[0], x.shape[1], 3), 25, np.uint8)]) for x in cols]
        # 4 per row
        rows = [np.hstack(cols[i:i + 4]) for i in range(0, len(cols), 4)]
        wmax = max(r.shape[1] for r in rows)
        rows = [np.hstack([r, np.full((r.shape[0], wmax - r.shape[1], 3), 25, np.uint8)]) for r in rows]
        panels = np.vstack(rows); break
if panels is not None:
    cv2.imwrite("diag/subregion_preview.png", panels); print("saved diag/subregion_preview.png", panels.shape)
else:
    print("no card with >=6 localized defects found")
