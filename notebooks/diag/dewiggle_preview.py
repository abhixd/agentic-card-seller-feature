"""Preview SEG_SIGMA de-wiggle on the WIGGLIEST cached cards (no API).
1) Scores every cached card by residual wiggle (cw vs its sigma=10 smooth), reading
   only the lightweight cw array (not the warp PNG) so the scan is fast.
2) For the top-N wiggliest, zooms on the worst segment and overlays 3 smoothing levels:
   RED = sigma 2.5 (current/shipped) · GREEN = 6 · CYAN = 10."""
import os, sys, glob, math
sys.path.insert(0, "."); sys.path.insert(0, "../backend")
import numpy as np, cv2, pandas as pd
import warp_cache as WC
import card_segmenter as CS
import nonvlm_cv as N

BASE = "feature_extraction_dataset"
W, H = N.CV_WARP_SIZE                       # cached warps all built at this size
LEVELS = [(2.5, (0, 0, 255), "2.5 current"), (6.0, (0, 200, 0), "6"), (10.0, (255, 230, 0), "10")]
BASE_SIGMA, TOPN = 2.5, 3

def smooth(cw, total):
    extra = math.sqrt(max(0.0, total**2 - BASE_SIGMA**2))
    return cw.copy() if extra == 0 else np.asarray(CS.gaussian_smooth_closed(cw.copy(), extra), np.float32)

def load_cw_only(path):
    p = WC.WARP_DIR / (WC._key(path) + ".npz")
    if not p.exists():
        return None
    cw = np.load(p, allow_pickle=False)["cw"]
    return cw if cw.ndim == 2 and len(cw) >= 100 else None   # skip full-frame fallback (4-pt box)

def turning_deg(cw, d=5):
    """Per-point turning angle (deg) — large at corners, ~0 on straight edges."""
    P = cw * [W, H]
    prev = P - np.roll(P, d, axis=0)
    nxt = np.roll(P, -d, axis=0) - P
    a1 = np.arctan2(prev[:, 1], prev[:, 0]); a2 = np.arctan2(nxt[:, 1], nxt[:, 0])
    return np.degrees(np.abs(((a2 - a1 + np.pi) % (2 * np.pi)) - np.pi))

def perim_ratio(cw):
    P = (cw * [W, H]).astype(np.float32)
    per = float(np.sum(np.hypot(*(np.diff(np.vstack([P, P[:1]]), axis=0).T))))
    bb = 2 * ((P[:, 0].max() - P[:, 0].min()) + (P[:, 1].max() - P[:, 1].min()))
    return per / max(bb, 1)        # ~0.97 clean rectangle; >1.1 => looping/broken contour

df = pd.read_csv(f"{BASE}/feature_dataset.csv")
df = df[df["error"].isna() | (df["error"].astype(str).str.strip() == "")]
paths = [p for p in df["path"].tolist() if isinstance(p, str)]

# ── 1) score STAIRCASE wiggle: residual of cw vs sigma=6 smooth, measured only
#       on STRAIGHT edge points (turning angle < 18°) so corners don't dominate ─
scored = []
for p in paths:
    cw = load_cw_only(p)
    if cw is None:
        continue
    if perim_ratio(cw) > 1.05:                          # exclude the ~1% broken/looping contours
        continue
    sm = smooth(cw, 6.0)
    res = np.hypot((cw[:, 0] - sm[:, 0]) * W, (cw[:, 1] - sm[:, 1]) * H)
    edge = turning_deg(cw) < 18.0                       # straight runs only
    if edge.sum() < 40:
        continue
    res_edge = np.where(edge, res, 0.0)                 # 0 at corners → argmax stays on an edge
    scored.append((float(np.percentile(res[edge], 90)), p, cw, res_edge))
scored.sort(key=lambda t: -t[0])
print(f"scored {len(scored)} cached cards; edge-wiggle p90 range "
      f"{scored[-1][0]:.2f}..{scored[0][0]:.2f}px; top:")

PAIR = [(2.5, (0, 0, 255), "2.5 current"), (8.0, (255, 230, 0), "8")]   # full-card outline comparison
rows = []
for score, p, cw, res in scored[:TOPN]:
    det = WC.load_warp(p)                 # now decode the warp PNG (only for the chosen few)
    disp = det["warped"].copy()
    m = np.zeros((H, W), np.uint8); cv2.fillPoly(m, [(cw * [W, H]).astype(np.int32)], 255)
    disp[m == 0] = 18
    full = disp.copy()
    for total, color, _ in PAIR:
        cv2.polylines(full, [(smooth(cw, total) * [W, H]).astype(np.int32)], True, color, 3, cv2.LINE_AA)
    full = cv2.resize(full, (int(W * 760 / H), 760))            # whole-card context
    # zoom on the worst straight-edge point (3x)
    k = int(np.argmax(res)); cx, cy = int(cw[k, 0] * W), int(cw[k, 1] * H)
    x0, x1 = max(0, cx - 110), min(W, cx + 110); y0, y1 = max(0, cy - 130), min(H, cy + 130)
    zimg = disp.copy()
    for total, color, _ in PAIR:
        cv2.polylines(zimg, [(smooth(cw, total) * [W, H]).astype(np.int32)], True, color, 2, cv2.LINE_AA)
    zoom = cv2.resize(zimg[y0:y1, x0:x1], None, fx=3, fy=3, interpolation=cv2.INTER_NEAREST)
    cv2.rectangle(full, (int(x0 * full.shape[1] / W), int(y0 * 760 / H)),
                  (int(x1 * full.shape[1] / W), int(y1 * 760 / H)), (255, 255, 255), 1)
    pad = max(full.shape[0], zoom.shape[0])
    full = cv2.copyMakeBorder(full, 0, pad - full.shape[0], 0, 0, cv2.BORDER_CONSTANT, value=(30, 30, 30))
    zoom = cv2.copyMakeBorder(zoom, 0, pad - zoom.shape[0], 0, 0, cv2.BORDER_CONSTANT, value=(30, 30, 30))
    panel = np.hstack([full, np.full((pad, 6, 3), 70, np.uint8), zoom])
    head = np.zeros((84, panel.shape[1], 3), np.uint8)
    cv2.putText(head, f"PSA{int(df[df.path==p].actual_psa.iloc[0])}  edge-wiggle p90={score:.1f}px   (full card | worst spot x3)",
                (10, 32), cv2.FONT_HERSHEY_SIMPLEX, 0.78, (255, 255, 255), 2, cv2.LINE_AA)
    lx = 10
    for _, color, name in PAIR:
        cv2.line(head, (lx, 62), (lx + 34, 62), color, 4)
        cv2.putText(head, f"sig {name}", (lx + 40, 68), cv2.FONT_HERSHEY_SIMPLEX, 0.62, (235, 235, 235), 1, cv2.LINE_AA)
        lx += 64 + 12 * len(f"sig {name}")
    rows.append(np.vstack([head, panel]))
    print(f"  p90={score:5.2f}px  {os.path.basename(p)}  worst@({cx},{cy})")

if rows:
    wmax = max(r.shape[1] for r in rows)
    rows = [np.hstack([r, np.full((r.shape[0], wmax - r.shape[1], 3), 30, np.uint8)]) if r.shape[1] < wmax else r for r in rows]
    vsep = np.full((10, wmax, 3), 70, np.uint8)
    out = rows[0]
    for r in rows[1:]:
        out = np.vstack([out, vsep, r])
    op = "diag/dewiggle_sigma_preview.png"
    cv2.imwrite(op, out); print("saved", op, out.shape)
