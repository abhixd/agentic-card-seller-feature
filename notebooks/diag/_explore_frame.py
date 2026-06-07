import os,sys; os.environ["CARD_DETECTOR"]="seg"
sys.path.insert(0,"."); sys.path.insert(0,"..")
sys.path.insert(0,"/Users/srinivasdoddi/srini/agentic-card-seller-os/notebooks")
sys.path.insert(0,"/Users/srinivasdoddi/srini/agentic-card-seller-os/backend")
from dotenv import load_dotenv
load_dotenv("/Users/srinivasdoddi/srini/agentic-card-seller-os/.env.local",override=True)
load_dotenv("/Users/srinivasdoddi/srini/agentic-card-seller-os/backend/.env",override=False)
import cv2, numpy as np
import warp_cache as WC, nonvlm_cv as N

DIAG="/Users/srinivasdoddi/srini/agentic-card-seller-os/notebooks/diag"
BASE="feature_extraction_dataset/10"

cards = {
  "scraped_023":"NOISY full-art R-deep",
  "scraped_115":"NOISY T/B 80/20",
  "scraped_164":"NOISY T/B 23/77 fire",
  "scraped_011":"CLEAN",
  "scraped_013":"CLEAN",
}

for name,desc in cards.items():
    path=f"{BASE}/{name}_front.jpeg"
    det=WC.get_det(path); warped=det["warped"]; cb=det["cb"]
    h,w=warped.shape[:2]
    cen=N.compute_centering_hybrid(warped, cb)
    cr=cen["content_region"]
    x1,y1,x2,y2=[int(round(v*d)) for v,d in zip(cb,[w,h,w,h])]
    print(f"\n=== {name} ({desc}) ===")
    print(f"  warped {w}x{h}  cb_px=({x1},{y1},{x2},{y2})  iw={x2-x1} ih={y2-y1}")
    print(f"  current L/R={cen['left_right']} T/B={cen['top_bottom']} reliable={cen['reliable']} border_type={cen['border_type']}")
    print(f"  source={cen['source']}")
    # current cr in px
    crx1,cry1,crx2,cry2=[int(round(cr[k]*d)) for k,d in zip(['x1','y1','x2','y2'],[w,h,w,h])]
    print(f"  cr_px=({crx1},{cry1},{crx2},{cry2})  insets L={crx1-x1} R={x2-crx2} T={cry1-y1} B={y2-cry2}")
print("\nDONE")
