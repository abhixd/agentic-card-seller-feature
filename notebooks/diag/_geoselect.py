import os,sys; os.environ["CARD_DETECTOR"]="seg"
sys.path.insert(0,"/Users/srinivasdoddi/srini/agentic-card-seller-os/notebooks")
sys.path.insert(0,"/Users/srinivasdoddi/srini/agentic-card-seller-os/backend")
from dotenv import load_dotenv
load_dotenv("/Users/srinivasdoddi/srini/agentic-card-seller-os/.env.local",override=True)
load_dotenv("/Users/srinivasdoddi/srini/agentic-card-seller-os/backend/.env",override=False)
import cv2, numpy as np, itertools
import warp_cache as WC, nonvlm_cv as N

DIAG="/Users/srinivasdoddi/srini/agentic-card-seller-os/notebooks/diag"
BASE="feature_extraction_dataset/10"

# ---------- candidate harvesting (multi-cue, robust over the span) ----------
def harvest(warped, cb):
    h,w=warped.shape[:2]
    x1,y1,x2,y2=[int(round(v*d)) for v,d in zip(cb,[w,h,w,h])]
    iw,ih=x2-x1,y2-y1
    gray=cv2.cvtColor(warped,cv2.COLOR_BGR2GRAY).astype(np.float32)
    lab=cv2.cvtColor(warped,cv2.COLOR_BGR2LAB).astype(np.float32)
    gx=cv2.Sobel(gray,cv2.CV_32F,1,0,ksize=3); gy=cv2.Sobel(gray,cv2.CV_32F,0,1,ksize=3)
    CE=0.18; cx,cy=int(iw*CE),int(ih*CE)
    maxd_h=int(iw*0.14); maxd_v=int(ih*0.14)
    mind_h=max(3,int(iw*0.004)); mind_v=max(3,int(ih*0.004))
    sy=slice(y1+cy,y2-cy); sx=slice(x1+cx,x2-cx)
    # cue1: gradient line strength (median over span)
    pL=np.median(np.abs(gx[sy,x1:x1+maxd_h]),axis=0)
    pR=np.median(np.abs(gx[sy,x2-maxd_h:x2])[:,::-1],axis=0)
    pT=np.median(np.abs(gy[y1:y1+maxd_v,sx]),axis=1)
    pB=np.median(np.abs(gy[y2-maxd_v:y2,sx])[::-1,:],axis=1)
    # cue2: color departure from outermost strip (LAB), median over span
    def cdp(strip,axis):  # strip oriented depth along axis0
        ref=strip[:3].mean(axis=(0,1))
        return np.linalg.norm(np.median(strip,axis=1)-ref,axis=1)
    cL=cdp(lab[sy,x1:x1+maxd_h].transpose(1,0,2),0)
    cR=cdp(lab[sy,x2-maxd_h:x2][:,::-1].transpose(1,0,2),0)
    cT=cdp(lab[y1:y1+maxd_v,sx],0)
    cB=cdp(lab[y2-maxd_v:y2,sx][::-1],0)
    sm=lambda a:np.convolve(a,np.ones(5)/5,mode="same")
    prof={"L":(sm(pL),sm(cL)),"R":(sm(pR),sm(cR)),"T":(sm(pT),sm(cT)),"B":(sm(pB),sm(cB))}
    mind={"L":mind_h,"R":mind_h,"T":mind_v,"B":mind_v}
    # candidate depths per side: union of local maxima of grad + first-cross of color
    cands={}
    for s in "LRTB":
        g,c=prof[s]
        depths=set()
        # grad local maxima
        gg=g.copy(); k=9
        for i in range(2,len(gg)-2):
            lo=max(0,i-k); hi=min(len(gg),i+k+1)
            if gg[i]==gg[lo:hi].max() and gg[i]>0.15*gg.max() and i>=mind[s]:
                depths.add(i)
        # color first-crossings (rising edges)
        cc=c-c[:max(1,len(c)//8)].mean()
        rng=cc.max()-cc.min()
        if rng>3:
            th=0.22*cc.max()
            above=cc>=th
            for i in range(1,len(above)):
                if above[i] and not above[i-1] and i>=mind[s]:
                    depths.add(i)
        # color local maxima too
        for i in range(2,len(c)-2):
            lo=max(0,i-k); hi=min(len(c),i+k+1)
            if c[i]==c[lo:hi].max() and c[i]>0.3*c.max() and i>=mind[s]:
                depths.add(i)
        cap=maxd_h if s in "LR" else maxd_v
        depths=sorted(d for d in depths if d<=cap)
        if not depths: depths=[mind[s]]   # fallback: minimal inset (will be fixed by symmetry)
        # strength = max of normalized grad & color at that depth
        gn=g/ (g.max()+1e-6); cn=c/(c.max()+1e-6)
        scored=[(d, float(max(gn[d],cn[d]))) for d in depths]
        cands[s]=scored
    return cands,(x1,y1,x2,y2),(iw,ih)

# ---------- global geometric scoring over 4-tuples ----------
def select(cands,box,dims):
    x1,y1,x2,y2=box; iw,ih=dims
    best=None
    Ls=cands["L"]; Rs=cands["R"]; Ts=cands["T"]; Bs=cands["B"]
    for (dl,sl),(dr,sr),(dt,st),(db,sb) in itertools.product(Ls,Rs,Ts,Bs):
        # insets as fraction of side
        fl,fr=dl/iw,dr/iw; ft,fb=dt/ih,db/ih
        # plausibility gate
        if not all(0.002<=v<=0.16 for v in (fl,fr,ft,fb)): continue
        # symmetry (concentric): L~R, T~B ; allow real off-center but penalize gross
        sym_lr=abs(fl-fr)/(fl+fr+1e-6)
        sym_tb=abs(ft-fb)/(ft+fb+1e-6)
        # cross-axis consistency: border widths similar magnitude across all 4 sides
        ins=np.array([fl,fr,ft,fb]); spread=ins.std()/(ins.mean()+1e-6)
        cue=(sl+sr+st+sb)/4
        # global score: reward cue strength, penalize asym + spread (LIGHT symmetry)
        score=2.0*cue - 0.45*(sym_lr+sym_tb) - 0.35*spread
        if best is None or score>best[0]:
            best=(score,dl,dr,dt,db,sym_lr,sym_tb,spread,cue)
    return best

def geo_centering(warped,cb):
    cands,box,dims=harvest(warped,cb)
    b=select(cands,box,dims)
    x1,y1,x2,y2=box
    _,dl,dr,dt,db,*_=b
    cr={"x1":(x1+dl)/warped.shape[1],"x2":(x2-dr)/warped.shape[1],
        "y1":(y1+dt)/warped.shape[0],"y2":(y2-db)/warped.shape[0]}
    lr=int(round(dl/(dl+dr)*100)); tb=int(round(dt/(dt+db)*100))
    return cr,f"{lr}/{100-lr}",f"{tb}/{100-tb}",b,cands,box

cards={"scraped_023":"NOISY","scraped_115":"NOISY","scraped_164":"NOISY",
       "scraped_113":"NOISY","scraped_161":"NOISY",
       "scraped_011":"CLEAN","scraped_013":"CLEAN","scraped_037":"CLEAN",
       "scraped_047":"CLEAN","scraped_060":"CLEAN"}
montage=[]
for name,tag in cards.items():
    path=f"{BASE}/{name}_front.jpeg"
    det=WC.get_det(path); warped=det["warped"]; cb=det["cb"]
    cen=N.compute_centering_hybrid(warped,cb)
    cr,lr,tb,b,cands,box=geo_centering(warped,cb)
    print(f"{name:14s} {tag:6s} OLD L/R={cen['left_right']:7s} T/B={cen['top_bottom']:7s}  ||  NEW L/R={lr:7s} T/B={tb:7s}  (sym_lr={b[5]:.2f} sym_tb={b[6]:.2f} spread={b[7]:.2f})")
    # viz
    vis=warped.copy()
    x1,y1,x2,y2=box
    cv2.rectangle(vis,(x1,y1),(x2,y2),(0,255,255),2)  # cut edge (yellow)
    # OLD cr red
    ocr=cen["content_region"]; h,w=warped.shape[:2]
    ox1,oy1,ox2,oy2=[int(round(ocr[k]*d)) for k,d in zip(['x1','y1','x2','y2'],[w,h,w,h])]
    cv2.rectangle(vis,(ox1,oy1),(ox2,oy2),(0,0,255),3)   # OLD red
    nx1,ny1,nx2,ny2=[int(round(cr[k]*d)) for k,d in zip(['x1','y1','x2','y2'],[w,h,w,h])]
    cv2.rectangle(vis,(nx1,ny1),(nx2,ny2),(0,255,0),3)   # NEW green
    cv2.putText(vis,f"{name} OLD(R) {cen['left_right']} {cen['top_bottom']}",(20,40),cv2.FONT_HERSHEY_SIMPLEX,1.0,(0,0,255),2)
    cv2.putText(vis,f"NEW(G) {lr} {tb}",(20,80),cv2.FONT_HERSHEY_SIMPLEX,1.0,(0,255,0),2)
    montage.append(cv2.resize(vis,(360,503)))
row1=np.hstack(montage[:5]); row2=np.hstack(montage[5:])
cv2.imwrite(f"{DIAG}/geoselect_montage.png",np.vstack([row1,row2]))
print("\nviz ->",f"{DIAG}/geoselect_montage.png")
