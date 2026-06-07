import os,sys; os.environ["CARD_DETECTOR"]="seg"
sys.path.insert(0,"."); sys.path.insert(0,"../backend")
from dotenv import load_dotenv; load_dotenv("../.env.local",override=True); load_dotenv("../backend/.env",override=False)
import cv2, numpy as np, warp_cache as WC, nonvlm_cv as N

DIAG="/Users/srinivasdoddi/srini/agentic-card-seller-os/notebooks/diag"
os.makedirs(DIAG,exist_ok=True)

CARDS = {
  "scraped_023":"feature_extraction_dataset/10/scraped_023_front.jpeg",  # full-art foil, RIGHT broken
  "scraped_011":"feature_extraction_dataset/10/scraped_011_front.jpeg",  # clean control
  "scraped_115":"feature_extraction_dataset/10/scraped_115_front.jpeg",  # T/B 80/20 noisy
}

def edge_profiles(warped, cb):
    """For each side, build a 1D profile of gradient energy vs inset depth,
    using a LONG span (most of the side) so a LOCAL artwork edge can't dominate.
    Key cue: a true frame line is a STRAIGHT, FULL-SPAN ridge -> high fraction
    of rows/cols agree on that inset. Artwork edge -> only a few agree."""
    h,w = warped.shape[:2]
    x1,y1,x2,y2 = [int(round(v*d)) for v,d in zip(cb,[w,h,w,h])]
    iw,ih = x2-x1, y2-y1
    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx = cv2.Sobel(gray,cv2.CV_32F,1,0,ksize=3)
    gy = cv2.Sobel(gray,cv2.CV_32F,0,1,ksize=3)
    # search band: from 0.4% to 16% of the dimension inward
    out={}
    # --- RIGHT side: scan inset from right edge; want a vertical line => strong |gx| spanning rows ---
    def vline_scan(side):
        # returns (depths, mean_energy, span_fraction_at_each_depth)
        corner = int(ih*0.15)
        rows = slice(y1+corner, y2-corner)
        max_d = int(iw*0.16)
        eng=[]; spanfrac=[]
        col_energy = np.abs(gx)[rows]  # (R, W)
        # normalize per-row to be robust to local bright art
        for d in range(2,max_d):
            if side=="L": cols = x1+d
            else: cols = x2-d
            colvals = col_energy[:, cols]   # (R,)
            eng.append(colvals.mean())
            # span: fraction of rows where this column is a LOCAL ridge (above row's 85th pct)
            thr = np.percentile(col_energy[:, max(x1, cols-1):cols+2].max(axis=1), 0)  # placeholder
            spanfrac.append(0)
        return np.array(eng)
    def hline_scan(side):
        corner = int(iw*0.15)
        cols = slice(x1+corner, x2-corner)
        max_d = int(ih*0.16)
        row_energy = np.abs(gy)[:, cols]   # (H, C)
        eng=[]
        for d in range(2,max_d):
            if side=="T": r = y1+d
            else: r = y2-d
            eng.append(row_energy[r,:].mean())
        return np.array(eng)
    out["R"]=vline_scan("R"); out["L"]=vline_scan("L")
    out["T"]=hline_scan("T"); out["B"]=hline_scan("B")
    return out, (x1,y1,x2,y2,iw,ih)

def straightness_scan(warped, cb, side):
    """The decisive cue. For a given side, at each candidate inset d, measure
    what FRACTION of the side's length has a strong perpendicular-gradient ridge
    at that exact inset (within +-2px). A real frame line -> ridge spans ~full
    side -> high fraction at one consistent d. An artwork edge (sphere) -> ridge
    only over a short arc -> low fraction, and the peak d varies."""
    h,w = warped.shape[:2]
    x1,y1,x2,y2 = [int(round(v*d)) for v,d in zip(cb,[w,h,w,h])]
    iw,ih = x2-x1, y2-y1
    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx = np.abs(cv2.Sobel(gray,cv2.CV_32F,1,0,ksize=3))
    gy = np.abs(cv2.Sobel(gray,cv2.CV_32F,0,1,ksize=3))
    if side in "LR":
        corner=int(ih*0.12); rows=np.arange(y1+corner,y2-corner)
        max_d=int(iw*0.16)
        # for each row, find local-max column within search band near edge
        band = gx[rows]  # (R,W)
        depths=[];
        for r in range(band.shape[0]):
            if side=="R":
                seg = band[r, x2-max_d:x2-2][::-1]   # index 0 = near edge
            else:
                seg = band[r, x1+2:x1+max_d]
            if seg.max() < 1e-6: depths.append(-1); continue
            depths.append(int(np.argmax(seg))+2)
        depths=np.array(depths)
        valid=depths[depths>=0]
        return depths, valid, max_d
    else:
        corner=int(iw*0.12); cols=np.arange(x1+corner,x2-corner)
        max_d=int(ih*0.16)
        band = gy[:,cols]  # (H,C)
        depths=[]
        for c in range(band.shape[1]):
            if side=="B":
                seg = band[y2-max_d:y2-2, c][::-1]
            else:
                seg = band[y1+2:y1+max_d, c]
            if seg.max()<1e-6: depths.append(-1); continue
            depths.append(int(np.argmax(seg))+2)
        depths=np.array(depths)
        valid=depths[depths>=0]
        return depths, valid, max_d

for name,path in CARDS.items():
    det = WC.get_det(path); warped=det["warped"]; cb=det["cb"]
    cen = N.compute_centering_hybrid(warped, cb)
    h,w=warped.shape[:2]
    cr=cen["content_region"]
    print(f"\n=== {name}  warp {w}x{h} ===")
    print(f"  current LR={cen['left_right']} TB={cen['top_bottom']} reliable={cen['reliable']} src={cen['source']} bt={cen['border_type']}")
    crpx=[int(round(cr['x1']*w)),int(round(cr['y1']*h)),int(round(cr['x2']*w)),int(round(cr['y2']*h))]
    x1,y1,x2,y2=[int(round(v*d)) for v,d in zip(cb,[w,h,w,h])]
    print(f"  cb px: ({x1},{y1})-({x2},{y2})   cr px: {crpx}")
    print(f"  current insets px  L={crpx[0]-x1} R={x2-crpx[2]} T={crpx[1]-y1} B={y2-crpx[3]}")
    # straightness-based candidate for each side: mode of per-line argmax depth + how concentrated
    cand={}
    for side in "LRTB":
        depths,valid,max_d=straightness_scan(warped,cb,side)
        if len(valid)==0:
            cand[side]=(None,0); continue
        # histogram of depths; mode + fraction within +-2 of mode
        hist=np.bincount(valid,minlength=max_d+1)
        # smooth
        hk=np.convolve(hist,np.ones(3),mode="same")
        mode_d=int(np.argmax(hk))
        frac=valid[(valid>=mode_d-2)&(valid<=mode_d+2)].size/valid.size
        cand[side]=(mode_d,frac)
        print(f"  [{side}] straightness-mode inset={mode_d}px  span_consensus={frac:.2f}  (n={valid.size})")
    # build candidate cr from straightness modes
    def ins(side):
        return cand[side][0] if cand[side][0] is not None else 0
    sx1,sy1=x1+ins("L"), y1+ins("T")
    sx2,sy2=x2-ins("R"), y2-ins("B")
    def split(a,b): return f"{int(round(a/(a+b)*100))}/{int(round(b/(a+b)*100))}" if a+b>0 else "50/50"
    print(f"  STRAIGHTNESS cr px: ({sx1},{sy1})-({sx2},{sy2})")
    print(f"  STRAIGHTNESS LR={split(ins('L'),ins('R'))}  TB={split(ins('T'),ins('B'))}")
    # viz
    viz=warped.copy()
    cv2.rectangle(viz,(x1,y1),(x2,y2),(255,255,0),3)        # cyan = cb (cut edge)
    cv2.rectangle(viz,(crpx[0],crpx[1]),(crpx[2],crpx[3]),(0,0,255),3)  # red = current (wrong)
    cv2.rectangle(viz,(sx1,sy1),(sx2,sy2),(0,255,0),3)      # green = straightness candidate
    cv2.imwrite(f"{DIAG}/probe_{name}.png",viz)
    print(f"  wrote diag/probe_{name}.png  (cyan=cut red=current green=straightness)")
