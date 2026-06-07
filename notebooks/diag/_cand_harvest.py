import os,sys; os.environ["CARD_DETECTOR"]="seg"
sys.path.insert(0,"/Users/srinivasdoddi/srini/agentic-card-seller-os/notebooks")
sys.path.insert(0,"/Users/srinivasdoddi/srini/agentic-card-seller-os/backend")
from dotenv import load_dotenv
load_dotenv("/Users/srinivasdoddi/srini/agentic-card-seller-os/.env.local",override=True)
load_dotenv("/Users/srinivasdoddi/srini/agentic-card-seller-os/backend/.env",override=False)
import cv2, numpy as np
import warp_cache as WC, nonvlm_cv as N

DIAG="/Users/srinivasdoddi/srini/agentic-card-seller-os/notebooks/diag"
BASE="feature_extraction_dataset/10"

# Harvest MANY candidate inner-boundary offsets per side using a 1-D edge-strength
# profile from MULTIPLE cues, then list local maxima. Goal: does a near-symmetric
# candidate EXIST on the bad side? (the premise of model-selection)

def side_profiles(warped, cb):
    """Return per-side 1-D 'frame-line strength' profiles vs inset depth (px from cut edge inward),
    aggregated across the span (median over the side, corners excluded)."""
    h,w=warped.shape[:2]
    x1,y1,x2,y2=[int(round(v*d)) for v,d in zip(cb,[w,h,w,h])]
    iw,ih=x2-x1,y2-y1
    gray=cv2.cvtColor(warped,cv2.COLOR_BGR2GRAY).astype(np.float32)
    lab=cv2.cvtColor(warped,cv2.COLOR_BGR2LAB).astype(np.float32)
    # gradient magnitude
    gx=cv2.Sobel(gray,cv2.CV_32F,1,0,ksize=3)
    gy=cv2.Sobel(gray,cv2.CV_32F,0,1,ksize=3)
    CE=0.18  # corner exclude
    cx,cy=int(iw*CE),int(ih*CE)
    maxd_h=int(iw*0.14); maxd_v=int(ih*0.14)
    out={}
    # LEFT: scan columns x1..x1+maxd_h, vertical-line strength = |gx| averaged over rows (span)
    span_y=slice(y1+cy,y2-cy)
    cols=slice(x1,x1+maxd_h)
    gxL=np.abs(gx[span_y,cols])              # (rows, depth)
    out["L"]=np.median(gxL,axis=0)           # median over span -> robust to artwork
    # RIGHT: columns x2-maxd_h..x2, reversed so index0 = at cut edge
    colsR=slice(x2-maxd_h,x2)
    gxR=np.abs(gx[span_y,colsR])[:,::-1]
    out["R"]=np.median(gxR,axis=0)
    # TOP: rows y1..y1+maxd_v, horizontal-line strength=|gy| over cols span
    span_x=slice(x1+cx,x2-cx)
    rows=slice(y1,y1+maxd_v)
    gyT=np.abs(gy[rows,span_x])
    out["T"]=np.median(gyT,axis=1)
    rowsB=slice(y2-maxd_v,y2)
    gyB=np.abs(gy[rowsB,span_x])[::-1,:]
    out["B"]=np.median(gyB,axis=1)
    return out,(x1,y1,x2,y2),(iw,ih)

def local_maxima(p, k=7, topn=6):
    p=np.convolve(p,np.ones(5)/5,mode="same")
    idx=[]
    for i in range(2,len(p)-2):
        lo=max(0,i-k); hi=min(len(p),i+k+1)
        if p[i]==p[lo:hi].max() and p[i]>0:
            idx.append(i)
    idx=sorted(idx,key=lambda i:-p[i])[:topn]
    return sorted(idx),p

cards=["scraped_023","scraped_115","scraped_164","scraped_011","scraped_013"]
for name in cards:
    path=f"{BASE}/{name}_front.jpeg"
    det=WC.get_det(path); warped=det["warped"]; cb=det["cb"]
    prof,(x1,y1,x2,y2),(iw,ih)=side_profiles(warped,cb)
    print(f"\n=== {name}  iw={iw} ih={ih} ===")
    for s in "LRTB":
        peaks,ps=local_maxima(prof[s])
        # report peak depth (px) and strength
        info=[(int(d),round(float(ps[d]),1)) for d in peaks]
        print(f"  {s}: peaks(depth_px,strength)={info}")
print("\nDONE")
