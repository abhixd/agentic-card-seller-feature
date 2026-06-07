import os,sys; os.environ["CARD_DETECTOR"]="seg"
sys.path.insert(0,"."); sys.path.insert(0,"../backend")
from dotenv import load_dotenv; load_dotenv("../.env.local",override=True); load_dotenv("../backend/.env",override=False)
import cv2, numpy as np, warp_cache as WC, nonvlm_cv as N

DIAG = "/Users/srinivasdoddi/srini/agentic-card-seller-os/notebooks/diag"

NOISY  = ["scraped_023","scraped_115","scraped_164","scraped_113","scraped_161"]
CLEAN  = ["scraped_011","scraped_013","scraped_037","scraped_047","scraped_060"]

def path(name): return f"feature_extraction_dataset/10/{name}_front.jpeg"

# ----------------------------------------------------------------------------
# ROBUST RECTANGLE / LINE FIT for the inner printed design-frame.
#
# Core idea: the inner frame is 4 long, straight, axis-aligned lines forming a
# concentric rectangle. We do NOT scan for "where the border color ends".
# Instead we collect EDGE ENERGY per row / per column inside a search band on
# each side, and pick the location whose edge structure SPANS the whole side
# (a true frame line is long; an artwork edge like the sphere is local).
#
# Implementation of the "spans the side" prior without full LSD bookkeeping:
#   - For the LEFT side: look at the vertical-gradient-strong edge map, and for
#     each candidate column x in the search band, compute the FRACTION OF ROWS
#     (over the central span of the card) where there is a strong vertical edge
#     near column x. A true frame line -> high coverage (line spans the side).
#     An artwork edge (sphere) -> low coverage (only covers part of the height).
#   - The frame column is the one with high coverage AND closest to the outer
#     edge (the innermost-art-edge is rejected because it doesn't span).
# Then apply concentricity + symmetry priors to reconcile the 4 sides.
# ----------------------------------------------------------------------------

def side_edgemap(gray, axis):
    # axis="v" -> we want VERTICAL lines (left/right frame): strong dI/dx
    # axis="h" -> we want HORIZONTAL lines (top/bottom frame): strong dI/dy
    if axis == "v":
        g = cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)
    else:
        g = cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)
    return np.abs(g)

def coverage_profile(emap, axis, span_lo, span_hi, band_lo, band_hi):
    """For each position in [band_lo,band_hi] along the cross axis, what fraction
    of the spanning rows/cols have a strong edge there (relative to a local max).
    Returns (positions, coverage[0..1], strength)."""
    if axis == "v":   # vertical line: position = column x, span over rows y
        sub = emap[span_lo:span_hi, band_lo:band_hi]   # rows x cols(band)
        # per row, normalize; strong edge = >0.5 of that row's max within band
        rowmax = sub.max(axis=1, keepdims=True) + 1e-6
        strong = sub >= (0.5 * rowmax)
        cov = strong.mean(axis=0)        # over rows -> per band column
        strength = sub.mean(axis=0)
    else:             # horizontal line: position = row y, span over cols x
        sub = emap[band_lo:band_hi, span_lo:span_hi]   # rows(band) x cols
        colmax = sub.max(axis=0, keepdims=True) + 1e-6
        strong = sub >= (0.5 * colmax)
        cov = strong.mean(axis=1)        # over cols -> per band row
        strength = sub.mean(axis=1)
    return cov, strength

def pick_frame_pos(cov, strength, from_inner):
    """Pick the frame position: the one with high coverage, preferring the side
    nearest the OUTER edge (i.e. small inset). cov indexed from outer->inner if
    from_inner=False else reversed already. We return index into the band."""
    cov_s = np.convolve(cov, np.ones(5)/5, mode="same")
    cov_max = cov_s.max()
    if cov_max < 1e-6:
        return None, 0.0
    # candidates: positions where coverage is within 80% of the best AND > 0.45
    thresh = max(0.45, 0.8*cov_max)
    cand = np.where(cov_s >= thresh)[0]
    if len(cand)==0:
        cand = np.where(cov_s >= 0.8*cov_max)[0]
    # among candidates choose the one closest to the OUTER edge (smallest index,
    # since band is ordered outer->inner) -> the printed frame, not deep art
    pos = int(cand.min())
    return pos, float(cov_s[pos])

def detect_frame_rectfit(warped, cb, viz_name=None):
    h, w = warped.shape[:2]
    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY)
    gray = cv2.GaussianBlur(gray, (3,3), 0)
    x1, y1, x2, y2 = [int(round(v*d)) for v,d in zip(cb,[w,h,w,h])]
    iw, ih = x2-x1, y2-y1

    # search band: inset between 0.4% and 16% from each outer edge
    MINF, MAXF = 0.004, 0.16
    # central span (exclude corners) where a frame line must be present
    SPAN = 0.18  # exclude 18% at each end

    emV = side_edgemap(gray, "v")
    emH = side_edgemap(gray, "h")

    results = {}
    # LEFT
    sl, sh = y1+int(ih*SPAN), y2-int(ih*SPAN)
    bl, bh = x1+int(iw*MINF), x1+int(iw*MAXF)
    cov, strg = coverage_profile(emV, "v", sl, sh, bl, bh)
    pos, c = pick_frame_pos(cov, strg, False)
    results["L"] = (bl+pos if pos is not None else bl, c, cov)
    # RIGHT (band ordered outer->inner means from x2 inward, so reverse)
    bl2, bh2 = x2-int(iw*MAXF), x2-int(iw*MINF)
    cov, strg = coverage_profile(emV, "v", sl, sh, bl2, bh2)
    cov_r, strg_r = cov[::-1], strg[::-1]   # outer->inner
    pos, c = pick_frame_pos(cov_r, strg_r, False)
    results["R"] = (bh2-pos if pos is not None else bh2, c, cov_r)
    # TOP
    sl, sh = x1+int(iw*SPAN), x2-int(iw*SPAN)
    blt, bht = y1+int(ih*MINF), y1+int(ih*MAXF)
    cov, strg = coverage_profile(emH, "h", sl, sh, blt, bht)
    pos, c = pick_frame_pos(cov, strg, False)
    results["T"] = (blt+pos if pos is not None else blt, c, cov)
    # BOTTOM
    blb, bhb = y2-int(ih*MAXF), y2-int(ih*MINF)
    cov, strg = coverage_profile(emH, "h", sl, sh, blb, bhb)
    cov_b, strg_b = cov[::-1], strg[::-1]
    pos, c = pick_frame_pos(cov_b, strg_b, False)
    results["B"] = (bhb-pos if pos is not None else bhb, c, cov_b)

    fx1, fy1, fx2, fy2 = results["L"][0], results["T"][0], results["R"][0], results["B"][0]
    confs = {k: results[k][1] for k in "LRTB"}

    cr = {"x1":fx1/w, "y1":fy1/h, "x2":fx2/w, "y2":fy2/h}
    # centering
    bl_ = fx1-x1; br_ = x2-fx2; bt_ = fy1-y1; bb_ = y2-fy2
    lr = int(round(bl_/(bl_+br_)*100)) if bl_+br_>1e-6 else 50
    tb = int(round(bt_/(bt_+bb_)*100)) if bt_+bb_>1e-6 else 50

    if viz_name:
        vis = warped.copy()
        cv2.rectangle(vis, (x1,y1),(x2,y2),(0,0,255),2)  # outer (red)
        cv2.rectangle(vis, (fx1,fy1),(fx2,fy2),(0,255,0),2)  # frame (green)
        cv2.putText(vis, f"LR {lr}/{100-lr} TB {tb}/{100-tb}", (30,50),
                    cv2.FONT_HERSHEY_SIMPLEX, 1.2, (0,255,255),3)
        cv2.imwrite(f"{DIAG}/{viz_name}", vis)
    return {"cr":cr, "lr":lr, "tb":tb, "confs":confs}

# ----------------------------------------------------------------------------
print(f"{'card':14s} {'OLD lr/tb':14s} {'NEW lr/tb':14s} {'confLRTB':30s}")
for grp, names in [("NOISY",NOISY),("CLEAN",CLEAN)]:
    print(f"--- {grp} ---")
    for nm in names:
        p = path(nm)
        det = WC.get_det(p); warped=det["warped"]; cb=det["cb"]
        cen = N.compute_centering_hybrid(warped, cb)
        viz = f"rectfit_{nm}.jpg"
        r = detect_frame_rectfit(warped, cb, viz_name=viz)
        cstr = " ".join(f"{k}{r['confs'][k]:.2f}" for k in "LRTB")
        print(f"{nm:14s} {cen['left_right']+' '+cen['top_bottom']:14s} "
              f"{str(r['lr'])+'/'+str(100-r['lr'])+' '+str(r['tb'])+'/'+str(100-r['tb']):14s} {cstr}")
print("viz ->", DIAG)
