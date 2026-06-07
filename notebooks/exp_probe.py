import os,sys; os.environ["CARD_DETECTOR"]="seg"
sys.path.insert(0,"."); sys.path.insert(0,"../backend")
from dotenv import load_dotenv; load_dotenv("../.env.local",override=True); load_dotenv("../backend/.env",override=False)
import cv2, numpy as np, warp_cache as WC, nonvlm_cv as N

DIAG="/Users/srinivasdoddi/srini/agentic-card-seller-os/notebooks/diag"

def path(n): return f"feature_extraction_dataset/10/{n}_front.jpeg"

def probe(nm):
    det=WC.get_det(path(nm)); warped=det["warped"]; cb=det["cb"]
    h,w=warped.shape[:2]
    gray=cv2.GaussianBlur(cv2.cvtColor(warped,cv2.COLOR_BGR2GRAY),(3,3),0)
    x1,y1,x2,y2=[int(round(v*d)) for v,d in zip(cb,[w,h,w,h])]
    iw,ih=x2-x1,y2-y1
    MINF,MAXF,SPAN=0.004,0.16,0.18
    emV=np.abs(cv2.Sobel(gray,cv2.CV_32F,1,0,ksize=3))
    # RIGHT side coverage profile (the one that broke on 023)
    sl,sh=y1+int(ih*SPAN),y2-int(ih*SPAN)
    bl2,bh2=x2-int(iw*MAXF),x2-int(iw*MINF)
    sub=emV[sl:sh, bl2:bh2]
    rowmax=sub.max(axis=1,keepdims=True)+1e-6
    cov=(sub>=0.5*rowmax).mean(axis=0)   # per band col, left=inner ... right=outer? bl2 is inner side
    # bl2 = x2-MAXF (deeper in), bh2 = x2-MINF (near outer). band index 0 -> deep, last -> near edge
    strg=sub.mean(axis=0)
    print(f"\n=== {nm} RIGHT band (idx0=deep art .. last=near cut edge), width={bh2-bl2}px ===")
    # print coverage every few px with the x-position
    for i in range(0,len(cov),3):
        xpos=bl2+i
        inset_pct=(x2-xpos)/iw*100
        bar="#"*int(cov[i]*40)
        print(f" x={xpos:5d} inset={inset_pct:5.1f}%  cov={cov[i]:.2f} strg={strg[i]:6.0f} {bar}")

for nm in ["scraped_023","scraped_037","scraped_047"]:
    probe(nm)
