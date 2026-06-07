#!/usr/bin/env python3
"""
scripts/diagnose_centering.py

Run the EXACT notebook centering pipeline on a single image and print
detailed diagnostics + save an annotated visualization.

Usage:
    python3 scripts/diagnose_centering.py <image_path>

Prints per-side insets for analytical_centering, color_vote_wide, and the
hybrid choice, plus the LAB distance profile for each side so we can see
exactly where the border→artwork transition is detected.

Output image: /tmp/centering_diag.jpg
  red   = outer card boundary
  blue  = chosen content_region (hybrid)
  green = analytical_centering result
  yellow= color_vote_wide result
"""
import os, sys, cv2, json
import numpy as np
from pathlib import Path

if len(sys.argv) < 2:
    print("Usage: python3 scripts/diagnose_centering.py <image_path>")
    sys.exit(1)

IMG_PATH = sys.argv[1]
ROOT = Path(__file__).parent.parent

# ── env + grader ────────────────────────────────────────────────────────────
os.environ["CARD_DETECTOR"] = "seg"
for line in (ROOT/".env.local").read_text().splitlines():
    line = line.strip()
    if line and not line.startswith("#") and "=" in line:
        k,_,v = line.partition("="); os.environ.setdefault(k.strip(), v.strip().strip('"'))
sys.path.insert(0, str(ROOT/"backend"))
import grader

# ── pull the notebook's current centering functions (cells 3,7,9) ────────────
nb = json.load(open(ROOT/"notebooks/17_final_pipeline-feature-extraction.ipynb"))
ns = {"np": np, "cv2": cv2, "grader": grader}
for i, cell in enumerate(nb["cells"]):
    if cell["cell_type"] != "code": continue
    src = "".join(cell["source"])
    if ("color_vote_wide" in src and "def color_vote_wide" in src) \
       or "def compute_centering_hybrid" in src \
       or ("MIN_LR" in src and "CV_THRESHOLD_FRAC" in src and "def " not in src):
        try: exec(src, ns)
        except Exception as e: print(f"(skipped cell {i}: {e})")

color_vote_wide          = ns["color_vote_wide"]
compute_centering_hybrid = ns["compute_centering_hybrid"]

# ── detect + warp ────────────────────────────────────────────────────────────
img = cv2.imread(IMG_PATH)
if img is None:
    print(f"Could not read {IMG_PATH}"); sys.exit(1)

qr, contour, meta = grader._detect_seg(img)
pad = grader.adaptive_padding(qr, padding_frac=grader.PADDING_FRAC)
c = qr.mean(0); d = qr - c
qp = qr + (d/np.linalg.norm(d,axis=1,keepdims=True).clip(min=1))*pad
warped = grader._warp_card(img, qp)
_, cb = grader.card_boundary_analytical(qr, qp)
h, w = warped.shape[:2]
x1,y1,x2,y2 = [int(round(v*dd)) for v,dd in zip(cb,[w,h,w,h])]
iw, ih = x2-x1, y2-y1

print(f"\nImage : {IMG_PATH}")
print(f"warped: {warped.shape}  seg_conf={meta.get('_seg_conf',0):.3f}")
print(f"cb px : x1={x1} y1={y1} x2={x2} y2={y2}  iw={iw} ih={ih}\n")

def insets(cr):
    return (dict(L=(cr['x1']-cb[0])*w, R=(cb[2]-cr['x2'])*w,
                 T=(cr['y1']-cb[1])*h, B=(cb[3]-cr['y2'])*h))

def show(name, cr):
    bi = insets(cr)
    print(f"{name}:")
    print(f"  L={bi['L']:5.1f}px ({bi['L']/iw*100:4.1f}%)  R={bi['R']:5.1f}px ({bi['R']/iw*100:4.1f}%)  "
          f"T={bi['T']:5.1f}px ({bi['T']/ih*100:4.1f}%)  B={bi['B']:5.1f}px ({bi['B']/ih*100:4.1f}%)")

# ── analytical ────────────────────────────────────────────────────────────────
an = grader.analytical_centering(warped, cb)
cr_an = an["content_region"] if an else None
if an:
    print(f"[analytical]  border_type={an['border_type']}")
    show("  insets", cr_an)
    print(f"  notes: {an['notes'][:110]}\n")

# ── color_vote_wide ──────────────────────────────────────────────────────────
cr_cv = color_vote_wide(warped, cb)
print("[color_vote_wide]")
show("  insets", cr_cv)
print()

# ── hybrid choice ────────────────────────────────────────────────────────────
cen = compute_centering_hybrid(warped, cb)
cr  = cen["content_region"]
print(f"[HYBRID CHOSEN]  source={cen['source']}  reliable={cen.get('reliable')}")
show("  insets", cr)
print(f"  L/R={cen['left_right']}  T/B={cen['top_bottom']}\n")

# ── LAB profile for each side (where is the transition?) ─────────────────────
lab = cv2.cvtColor(warped, cv2.COLOR_BGR2LAB).astype(np.float32)
def profile(side):
    cx,cy = int(iw*0.18), int(ih*0.18)
    band  = int(iw*0.15)
    if   side=="L": strip = lab[y1+cy:y2-cy, x1:x1+band].transpose(1,0,2)
    elif side=="R": strip = lab[y1+cy:y2-cy, x2-band:x2][:,::-1].transpose(1,0,2)
    elif side=="T": strip = lab[y1:y1+band, x1+cx:x2-cx]
    else:           strip = lab[y2-band:y2, x1+cx:x2-cx][::-1]
    ref = strip[:3].mean(axis=(0,1))
    return [float(np.linalg.norm(strip[i].mean(axis=0)-ref)) for i in range(len(strip))]

for side in ["L","R","T","B"]:
    p = profile(side)
    print(f"  {side} LAB dist (every 4px to 15%): {[round(v) for v in p[::4]]}")

# ── annotate + save ──────────────────────────────────────────────────────────
vis = warped.copy()
def rect(cr, color, th):
    a,b,c2,d2 = [int(round(v*dd)) for v,dd in zip([cr['x1'],cr['y1'],cr['x2'],cr['y2']],[w,h,w,h])]
    cv2.rectangle(vis,(a,b),(c2,d2),color,th)
cv2.rectangle(vis,(x1,y1),(x2,y2),(0,0,255),3)        # red outer
if cr_an: rect(cr_an,(0,200,0),2)                      # green analytical
rect(cr_cv,(0,255,255),2)                              # yellow color_vote
rect(cr,(255,0,0),3)                                   # blue chosen
cv2.imwrite("/tmp/centering_diag.jpg", vis)
print("\nSaved /tmp/centering_diag.jpg  (red=outer, blue=chosen, green=analytical, yellow=color_vote)")
