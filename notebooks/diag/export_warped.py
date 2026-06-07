"""Export all warped full-card crops (Model C = card-detector 'seg' output, perspective-corrected
edge-to-edge, border preserved) into cropped_warped/<grade>/<id>.png. Grade folder is kept in the
path because basenames collide across grade folders (scraped_023 exists in 5,6,7,8,9,10)."""
import os, sys, glob; os.environ["CARD_DETECTOR"] = "seg"
sys.path.insert(0, "."); sys.path.insert(0, "../backend")
from dotenv import load_dotenv; load_dotenv("../.env.local", override=True); load_dotenv("../backend/.env", override=False)
import cv2, warp_cache as WC

OUT = "cropped_warped"
paths = sorted(glob.glob("feature_extraction_dataset/*/scraped_*.jpeg") +
               glob.glob("feature_extraction_dataset/*/scraped_*.jpg") +
               glob.glob("feature_extraction_dataset/*/scraped_*.png"))
n_ok = {}; n_err = 0
for p in paths:
    grade = p.split("/feature_extraction_dataset/")[-1].split("/")[0] if "/feature_extraction_dataset/" in p \
            else os.path.basename(os.path.dirname(p))
    try:
        det = WC.get_det(p)
        w = det["warped"]
    except Exception:
        n_err += 1; continue
    d = os.path.join(OUT, grade); os.makedirs(d, exist_ok=True)
    name = os.path.splitext(os.path.basename(p))[0] + ".png"
    cv2.imwrite(os.path.join(d, name), w)
    n_ok[grade] = n_ok.get(grade, 0) + 1
print(f"exported warped crops to {OUT}/  (errors skipped: {n_err})")
for g in sorted(n_ok, key=lambda x: (len(x), x)):
    print(f"  grade {g}: {n_ok[g]}")
print(f"  TOTAL: {sum(n_ok.values())}")
