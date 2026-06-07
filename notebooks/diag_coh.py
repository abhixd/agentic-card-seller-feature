import os,sys; os.environ["CARD_DETECTOR"]="seg"
sys.path.insert(0,"."); sys.path.insert(0,"../backend")
from dotenv import load_dotenv; load_dotenv("../.env.local",override=True); load_dotenv("../backend/.env",override=False)
import cv2, numpy as np, warp_cache as WC, nonvlm_cv as N

DIAG="/Users/srinivasdoddi/srini/agentic-card-seller-os/notebooks/diag"
os.makedirs(DIAG,exist_ok=True)

# ----- the coherent-structure channel -----------------------------------------
def coherence_edges(warped):
    """Return (Vmap, Hmap): per-pixel COHERENT vertical-edge and horizontal-edge
    energy. Structure-tensor orientation coherence suppresses holo sparkle (whose
    gradient orientation is locally incoherent) while preserving long printed lines
    (locally coherent orientation). Works on low-freq luminance to kill foil shimmer."""
    g = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY).astype(np.float32)
    g = cv2.GaussianBlur(g,(0,0),1.5)              # kill foil high-freq sparkle
    gx = cv2.Sobel(g, cv2.CV_32F,1,0,ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F,0,1,ksize=3)
    # structure tensor, smoothed over a window
    Jxx = cv2.GaussianBlur(gx*gx,(0,0),3.0)
    Jyy = cv2.GaussianBlur(gy*gy,(0,0),3.0)
    Jxy = cv2.GaussianBlur(gx*gy,(0,0),3.0)
    # eigen-decomp of 2x2 sym tensor
    tr = Jxx+Jyy
    det = Jxx*Jyy - Jxy*Jxy
    tmp = np.sqrt(np.maximum((Jxx-Jyy)**2 + 4*Jxy*Jxy, 0))
    l1 = 0.5*(tr+tmp)  # larger eigenvalue
    l2 = 0.5*(tr-tmp)
    coh = (l1-l2)/(l1+l2+1e-6)            # 0..1 anisotropy; ~1 for a clean line, ~0 sparkle/flat
    # dominant gradient orientation: angle of eigenvector for l1
    theta = 0.5*np.arctan2(2*Jxy, (Jxx-Jyy))   # gradient direction; vertical edge -> grad horizontal
    mag = np.sqrt(l1)
    # vertical edge: gradient points horizontally => cos^2(theta) high
    Vmap = mag * coh * (np.cos(theta)**2)
    Hmap = mag * coh * (np.sin(theta)**2)
    return Vmap, Hmap, coh

def cb_px(warped, cb):
    H,W = warped.shape[:2]
    x1,y1,x2,y2 = cb
    return int(x1*W),int(y1*H),int(x2*W),int(y2*H)

def _pick_pair(scoreA, offA, scoreB, offB, dim, lo_pct=0.01, hi_pct=0.14):
    """Pick opposite-side frame lines JOINTLY using a near-symmetric-inset prior.
    scoreA = inset-from-low-edge score (e.g. LEFT), scoreB = inset-from-high-edge
    score (e.g. RIGHT), both indexed by distance INWARD from their cut edge.
    The frame is near-concentric so insetA ~= insetB. We score every (a,b) pair by
    geometric mean of the two coherent-line scores times a Gaussian symmetry prior
    on |insetA-insetB|, restricted to plausible border widths."""
    lo = int(lo_pct*dim); hi = int(hi_pct*dim)
    a_idx = np.arange(len(scoreA)); b_idx = np.arange(len(scoreB))
    sa = scoreA / (scoreA.max()+1e-9); sb = scoreB / (scoreB.max()+1e-9)
    # candidate insets within [lo,hi]
    aa = np.where((a_idx>=lo)&(a_idx<=hi))[0]
    bb = np.where((b_idx>=lo)&(b_idx<=hi))[0]
    if len(aa)==0 or len(bb)==0:
        return offA+int(np.argmax(scoreA)), offB+int(np.argmax(scoreB))
    A = aa[:,None]; B = bb[None,:]
    sym = np.exp(-((A-B)/(0.04*dim))**2)          # symmetry prior, sigma=4% of dim
    M = np.sqrt(sa[aa][:,None]*sb[bb][None,:]) * sym
    ia,ib = np.unravel_index(np.argmax(M), M.shape)
    return offA+int(aa[ia]), offB+int(bb[ib])


def find_inner_frame(warped, cb, frac=0.25, viz_prefix=None):
    """Find inner design-frame by COHERENT full-span line voting.
    For each side, scan a search band from the cut edge inward (up to `frac` of the
    dimension). The frame line = the position whose COHERENT edge energy, summed
    ONLY over rows/cols where a coherent edge is actually present (span support),
    is maximal AND spans most of the side. This rejects the local artwork sphere
    (short span) in favor of the full-width printed frame."""
    H,W = warped.shape[:2]
    Vmap,Hmap,coh = coherence_edges(warped)
    x1,y1,x2,y2 = cb_px(warped,cb)
    iw,ih = x2-x1, y2-y1
    out={}
    spans={}
    profiles={}
    # vertical frame lines (LEFT, RIGHT) from Vmap, projected to columns over interior rows
    ry1,ry2 = y1+int(0.10*ih), y2-int(0.10*ih)   # avoid corner rounding
    rx1,rx2 = x1+int(0.10*iw), x2-int(0.10*iw)
    def side_scan(emap, axis, lo, hi, sstart, send):
        # axis=0: scan columns (vertical lines), reduce over rows [sstart,send]
        # returns (col_idx -> energy), (col_idx -> span fraction)
        if axis==0:
            sub = emap[sstart:send, lo:hi]
            # per column: total energy AND fraction of rows with a strong coherent edge
            colE = sub.sum(axis=0)
            thr = np.percentile(sub, 75) + 1e-6
            span = (sub > thr).mean(axis=0)
            return colE, span, lo
        else:
            sub = emap[lo:hi, sstart:send]
            rowE = sub.sum(axis=1)
            thr = np.percentile(sub, 75)+1e-6
            span = (sub > thr).mean(axis=1)
            return rowE, span, lo

    # search bands (inward from cut edge), capped
    bandV = int(frac*iw); bandH = int(frac*ih)
    guard=int(0.015*iw); guardH=int(0.015*ih)
    # ---- LEFT (inset from x1, increasing inward) ----
    cE,cS,off = side_scan(Vmap,0, x1, x1+bandV, ry1,ry2)
    scoreL = cE*np.clip(cS,0,1)**2; scoreL[:guard]=0
    # ---- RIGHT (build as inset from x2: reverse so index = distance inward) ----
    cE,cS,off = side_scan(Vmap,0, x2-bandV, x2, ry1,ry2)
    scoreR_raw = (cE*np.clip(cS,0,1)**2)[::-1]; scoreR_raw[:guard]=0   # idx0 = at x2
    # joint symmetric pick for L/R (insets from their own cut edges)
    insL, insR = _pick_pair(scoreL, 0, scoreR_raw, 0, iw)
    L = x1+insL; R = x2-insR
    out["L"]=L; out["R"]=R
    spans["L"]=float((Vmap[ry1:ry2, L] > np.percentile(Vmap[ry1:ry2, x1:x1+bandV],75)).mean())
    spans["R"]=float((Vmap[ry1:ry2, R] > np.percentile(Vmap[ry1:ry2, x2-bandV:x2],75)).mean())
    # ---- TOP / BOTTOM ----
    rE,rS,off = side_scan(Hmap,1, y1, y1+bandH, rx1,rx2)
    scoreT = rE*np.clip(rS,0,1)**2; scoreT[:guardH]=0
    rE,rS,off = side_scan(Hmap,1, y2-bandH, y2, rx1,rx2)
    scoreB_raw = (rE*np.clip(rS,0,1)**2)[::-1]; scoreB_raw[:guardH]=0
    insT, insB = _pick_pair(scoreT, 0, scoreB_raw, 0, ih)
    T = y1+insT; B = y2-insB
    out["T"]=T; out["B"]=B
    spans["T"]=float((Hmap[T, rx1:rx2] > np.percentile(Hmap[y1:y1+bandH, rx1:rx2],75)).mean())
    spans["B"]=float((Hmap[B, rx1:rx2] > np.percentile(Hmap[y2-bandH:y2, rx1:rx2],75)).mean())

    lr = (out["L"]-x1)/((out["L"]-x1)+(x2-out["R"])+1e-6)*100
    tb = (out["T"]-y1)/((out["T"]-y1)+(y2-out["B"])+1e-6)*100
    res = {"frame":out,"cb_px":(x1,y1,x2,y2),"spans":spans,
           "left_right":f"{int(round(lr))}/{100-int(round(lr))}",
           "top_bottom":f"{int(round(tb))}/{100-int(round(tb))}"}
    if viz_prefix:
        viz = warped.copy()
        cv2.rectangle(viz,(x1,y1),(x2,y2),(255,0,0),3)        # cb (cut edge) blue
        cv2.rectangle(viz,(out["L"],out["T"]),(out["R"],out["B"]),(0,255,0),3)  # coherent frame green
        cv2.imwrite(f"{DIAG}/{viz_prefix}_coh.jpg",viz)
        cv2.imwrite(f"{DIAG}/{viz_prefix}_coh_Vmap.jpg",(np.clip(Vmap/ (Vmap.max()+1e-6)*255,0,255)).astype(np.uint8))
        cv2.imwrite(f"{DIAG}/{viz_prefix}_coh_Hmap.jpg",(np.clip(Hmap/ (Hmap.max()+1e-6)*255,0,255)).astype(np.uint8))
    return res

CARDS = {
 "scraped_023":"NOISY full-art foil (R deep in content, was 16/84 LR)",
 "scraped_115":"NOISY (T/B 80/20)",
 "scraped_164":"NOISY fire border (T/B 23/77)",
 "scraped_113":"NOISY (79/21 T/B)",
 "scraped_161":"NOISY (T/B 23/77)",
 "scraped_011":"CLEAN ~50/50",
 "scraped_013":"CLEAN",
 "scraped_037":"CLEAN",
 "scraped_047":"CLEAN",
 "scraped_060":"CLEAN",
}
print(f"{'card':14s} {'old LR':>8s} {'old TB':>8s} | {'new LR':>8s} {'new TB':>8s} | spans(L,R,T,B)")
for c,desc in CARDS.items():
    p=f"feature_extraction_dataset/10/{c}_front.jpeg"
    det=WC.get_det(p); warped=det["warped"]; cb=det["cb"]
    cen=N.compute_centering_hybrid(warped,cb)
    viz = c if c in ("scraped_023","scraped_011") else None
    r=find_inner_frame(warped,cb,viz_prefix=viz)
    sp=r["spans"]
    print(f"{c:14s} {cen['left_right']:>8s} {cen['top_bottom']:>8s} | {r['left_right']:>8s} {r['top_bottom']:>8s} | "
          f"{sp['L']:.2f},{sp['R']:.2f},{sp['T']:.2f},{sp['B']:.2f}  {desc}")
