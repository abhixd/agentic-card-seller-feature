import os,sys; os.environ["CARD_DETECTOR"]="seg"
sys.path.insert(0,"."); sys.path.insert(0,"../backend")
from dotenv import load_dotenv; load_dotenv("../.env.local",override=True); load_dotenv("../backend/.env",override=False)
import cv2, numpy as np, warp_cache as WC, nonvlm_cv as N
from scipy.signal import find_peaks

DIAG="/Users/srinivasdoddi/srini/agentic-card-seller-os/notebooks/diag"
NOISY=["scraped_023","scraped_115","scraped_164","scraped_113","scraped_161"]
CLEAN=["scraped_011","scraped_013","scraped_037","scraped_047","scraped_060"]
def path(n): return f"feature_extraction_dataset/10/{n}_front.jpeg"

MINF,MAXF,SPAN=0.004,0.16,0.18

def cov_profile(emap,axis,span_lo,span_hi,band_lo,band_hi):
    if axis=="v":
        sub=emap[span_lo:span_hi,band_lo:band_hi]
        rm=sub.max(axis=1,keepdims=True)+1e-6
        cov=(sub>=0.5*rm).mean(axis=0)
    else:
        sub=emap[band_lo:band_hi,span_lo:span_hi]
        cm=sub.max(axis=0,keepdims=True)+1e-6
        cov=(sub>=0.5*cm).mean(axis=1)
    return np.convolve(cov,np.ones(3)/3,mode="same")

def peaks_as_insets(cov, outer_at_end, band_px, dim):
    """Return list of (inset_frac, coverage) for each peak. outer_at_end: True if
    band index increases toward OUTER edge (R/B); inset measured from outer edge."""
    pk,props=find_peaks(cov,height=0.18,distance=4,prominence=0.08)
    out=[]
    for i,p in enumerate(pk):
        # position from outer edge in px:
        if outer_at_end:
            inset_px = (len(cov)-1-p) + int(dim*MINF)
        else:
            inset_px = p + int(dim*MINF)
        out.append((inset_px/dim, float(cov[p])))
    return out

def detect(warped,cb,viz=None):
    h,w=warped.shape[:2]
    gray=cv2.GaussianBlur(cv2.cvtColor(warped,cv2.COLOR_BGR2GRAY),(3,3),0)
    x1,y1,x2,y2=[int(round(v*d)) for v,d in zip(cb,[w,h,w,h])]
    iw,ih=x2-x1,y2-y1
    emV=np.abs(cv2.Sobel(gray,cv2.CV_32F,1,0,ksize=3))
    emH=np.abs(cv2.Sobel(gray,cv2.CV_32F,0,1,ksize=3))
    slv,shv=y1+int(ih*SPAN),y2-int(ih*SPAN)
    slh,shh=x1+int(iw*SPAN),x2-int(iw*SPAN)
    bands={
      "L":(emV,"v",slv,shv,x1+int(iw*MINF),x1+int(iw*MAXF),False,iw),
      "R":(emV,"v",slv,shv,x2-int(iw*MAXF),x2-int(iw*MINF),True ,iw),
      "T":(emH,"h",slh,shh,y1+int(ih*MINF),y1+int(ih*MAXF),False,ih),
      "B":(emH,"h",slh,shh,y2-int(ih*MAXF),y2-int(ih*MINF),True ,ih),
    }
    cand={}
    for k,(em,ax,sl,sh,bl,bh,oe,dim) in bands.items():
        cov=cov_profile(em,ax,sl,sh,bl,bh)
        pl=peaks_as_insets(cov,oe,bh-bl,dim)
        if not pl:  # no frame line on this side (full-bleed) -> sentinel
            pl=[(None,0.0)]
        cand[k]=pl

    # RECTANGLE PRIOR: choose one cand per axis-pair maximizing symmetry+coverage.
    def best_pair(A,B):
        best=None
        for ia,(ina,ca) in enumerate(A):
            for ib,(inb,cb_) in enumerate(B):
                if ina is None and inb is None:
                    score=0.0; sa=sb=None
                elif ina is None:
                    score=cb_-0.5; sa=inb; sb=inb   # mirror
                elif inb is None:
                    score=ca-0.5; sa=ina; sb=ina
                else:
                    sym=abs(ina-inb)               # 0 = perfectly concentric widths
                    score=(ca+cb_) - 6.0*sym       # reward coverage, penalize asymmetry
                    sa,sb=ina,inb
                if best is None or score>best[0]:
                    best=(score,sa,sb)
        return best[1],best[2]
    Li,Ri=best_pair(cand["L"],cand["R"])
    Ti,Bi=best_pair(cand["T"],cand["B"])

    # fallback if a side truly has no line: use opposing inset (concentric prior)
    if Li is None and Ri is None: Li=Ri=None
    fx1 = x1+int(Li*iw) if Li is not None else None
    fx2 = x2-int(Ri*iw) if Ri is not None else None
    fy1 = y1+int(Ti*ih) if Ti is not None else None
    fy2 = y2-int(Bi*ih) if Bi is not None else None

    lr = int(round(Li/(Li+Ri)*100)) if (Li is not None and Ri is not None and Li+Ri>1e-9) else 50
    tb = int(round(Ti/(Ti+Bi)*100)) if (Ti is not None and Bi is not None and Ti+Bi>1e-9) else 50

    if viz:
        vis=warped.copy()
        cv2.rectangle(vis,(x1,y1),(x2,y2),(0,0,255),2)
        a=fx1 if fx1 else x1; b=fy1 if fy1 else y1; c=fx2 if fx2 else x2; d=fy2 if fy2 else y2
        cv2.rectangle(vis,(a,b),(c,d),(0,255,0),2)
        cv2.putText(vis,f"LR {lr}/{100-lr} TB {tb}/{100-tb}",(30,50),
                    cv2.FONT_HERSHEY_SIMPLEX,1.2,(0,255,255),3)
        cv2.imwrite(f"{DIAG}/{viz}",vis)
    return lr,tb,cand

print(f"{'card':14s} {'OLD':14s} {'NEW(rect)':14s}  candidate insets (L/R/T/B)")
for grp,names in [("NOISY",NOISY),("CLEAN",CLEAN)]:
    print(f"--- {grp} ---")
    for nm in names:
        det=WC.get_det(path(nm)); warped=det["warped"]; cb=det["cb"]
        cen=N.compute_centering_hybrid(warped,cb)
        lr,tb,cand=detect(warped,cb,viz=f"rect2_{nm}.jpg")
        def fmt(pl): return ",".join(f"{(p[0]*100):.1f}@{p[1]:.2f}" if p[0] is not None else "none" for p in pl)
        print(f"{nm:14s} {cen['left_right']+' '+cen['top_bottom']:14s} "
              f"{str(lr)+'/'+str(100-lr)+' '+str(tb)+'/'+str(100-tb):14s}  "
              f"L[{fmt(cand['L'])}] R[{fmt(cand['R'])}] T[{fmt(cand['T'])}] B[{fmt(cand['B'])}]")
print("viz ->",DIAG)
