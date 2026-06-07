import os,sys; os.environ["CARD_DETECTOR"]="seg"
sys.path.insert(0,"."); sys.path.insert(0,"../backend")
from dotenv import load_dotenv; load_dotenv("../.env.local",override=True); load_dotenv("../backend/.env",override=False)
import cv2, numpy as np, warp_cache as WC, nonvlm_cv as N

DIAG="/Users/srinivasdoddi/srini/agentic-card-seller-os/notebooks/diag"

CARDS = {
  "scraped_023":"feature_extraction_dataset/10/scraped_023_front.jpeg",
  "scraped_115":"feature_extraction_dataset/10/scraped_115_front.jpeg",
  "scraped_164":"feature_extraction_dataset/10/scraped_164_front.jpeg",
  "scraped_113":"feature_extraction_dataset/10/scraped_113_front.jpeg",
  "scraped_161":"feature_extraction_dataset/10/scraped_161_front.jpeg",
  "scraped_011":"feature_extraction_dataset/10/scraped_011_front.jpeg",
  "scraped_013":"feature_extraction_dataset/10/scraped_013_front.jpeg",
  "scraped_037":"feature_extraction_dataset/10/scraped_037_front.jpeg",
  "scraped_047":"feature_extraction_dataset/10/scraped_047_front.jpeg",
  "scraped_060":"feature_extraction_dataset/10/scraped_060_front.jpeg",
}

def projection_frame(warped, cb, max_frac=0.16, corner=0.10):
    """Full-span line accumulator. For each side, scan inset d in [2, max_frac*dim].
    Score(d) = mean over the (corner-trimmed) span of the PERPENDICULAR gradient
    magnitude on the full-span line at inset d.  A real frame line is a full-span
    ridge -> sharp peak. A local artwork edge -> weak in the mean (it only covers
    a short arc of the span).  We pick the peak but PENALIZE distance from a
    concentric prior is left to the joint rectangle step. Return per-side score
    arrays + argmax."""
    h,w=warped.shape[:2]
    x1,y1,x2,y2=[int(round(v*d)) for v,d in zip(cb,[w,h,w,h])]
    iw,ih=x2-x1,y2-y1
    gray=cv2.cvtColor(warped,cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx=np.abs(cv2.Sobel(gray,cv2.CV_32F,1,0,ksize=3))
    gy=np.abs(cv2.Sobel(gray,cv2.CV_32F,0,1,ksize=3))
    res={}
    # vertical lines (L,R) use gx; rows trimmed by corner
    cy=int(ih*corner); rows=slice(y1+cy,y2-cy)
    maxdx=int(iw*max_frac)
    sL=np.array([gx[rows, x1+d].mean() for d in range(2,maxdx)])
    sR=np.array([gx[rows, x2-d].mean() for d in range(2,maxdx)])
    # horizontal lines (T,B) use gy; cols trimmed
    cx=int(iw*corner); cols=slice(x1+cx,x2-cx)
    maxdy=int(ih*max_frac)
    sT=np.array([gy[y1+d, cols].mean() for d in range(2,maxdy)])
    sB=np.array([gy[y2-d, cols].mean() for d in range(2,maxdy)])
    def pick(s):
        # smooth lightly, take the FIRST prominent peak (closest to cut edge),
        # where prominent = >= 0.6*global max and a local max
        ss=np.convolve(s,np.ones(3)/3,mode="same")
        gmax=ss.max()
        peaks=[]
        for i in range(1,len(ss)-1):
            if ss[i]>=ss[i-1] and ss[i]>=ss[i+1] and ss[i]>=0.55*gmax:
                peaks.append(i)
        d = (peaks[0] if peaks else int(np.argmax(ss)))+2
        prom = ss[d-2]/(ss.mean()+1e-6)   # peak-to-mean ratio = "ridge sharpness"
        return d, float(prom), ss
    dL,pL,_=pick(sL); dR,pR,_=pick(sR); dT,pT,_=pick(sT); dB,pB,_=pick(sB)
    return dict(L=(dL,pL),R=(dR,pR),T=(dT,pT),B=(dB,pB)), (x1,y1,x2,y2,iw,ih)

def split(a,b): return f"{int(round(a/(a+b)*100))}/{int(round(b/(a+b)*100))}" if a+b>0 else "50/50"

for name,path in CARDS.items():
    det=WC.get_det(path); warped=det["warped"]; cb=det["cb"]
    cen=N.compute_centering_hybrid(warped,cb)
    h,w=warped.shape[:2]
    pf,(x1,y1,x2,y2,iw,ih)=projection_frame(warped,cb)
    dL,pL=pf["L"]; dR,pR=pf["R"]; dT,pT=pf["T"]; dB,pB=pf["B"]
    # concentricity sanity: are opposite-side ridge proms both decent?
    print(f"\n=== {name} ===  current LR={cen['left_right']} TB={cen['top_bottom']} (reliable={cen['reliable']})")
    print(f"  PROJ insets px: L={dL}(p{pL:.1f}) R={dR}(p{pR:.1f}) T={dT}(p{pT:.1f}) B={dB}(p{pB:.1f})")
    print(f"  PROJ LR={split(dL,dR)}  TB={split(dT,dB)}")
    sx1,sy1,sx2,sy2=x1+dL,y1+dT,x2-dR,y2-dB
    viz=warped.copy()
    cv2.rectangle(viz,(x1,y1),(x2,y2),(255,255,0),2)
    crpx=[int(round(cen['content_region'][k]*d)) for k,d in zip(['x1','y1','x2','y2'],[w,h,w,h])]
    cv2.rectangle(viz,(crpx[0],crpx[1]),(crpx[2],crpx[3]),(0,0,255),2)
    cv2.rectangle(viz,(sx1,sy1),(sx2,sy2),(0,255,0),2)
    cv2.imwrite(f"{DIAG}/proj_{name}.png",viz)
