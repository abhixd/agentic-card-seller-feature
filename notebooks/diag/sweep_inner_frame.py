"""Regression sweep: new CoherentFrame inner-boundary vs old compute_centering_hybrid, on all
679 cached cards. Split by border-uniformity (LAB chroma-std of the inner ring): on UNIFORM
borders the OLD detector is trustworthy, so NEW must AGREE (no regression); on FOIL/full-art
the OLD was unreliable, so divergence = where the fix matters."""
import os, sys; os.environ["CARD_DETECTOR"] = "seg"
sys.path.insert(0, "."); sys.path.insert(0, "../backend")
from dotenv import load_dotenv; load_dotenv("../.env.local", override=True); load_dotenv("../backend/.env", override=False)
import numpy as np, pandas as pd, cv2, warp_cache as WC, nonvlm_cv as N, inner_frame as IF

def chroma_std(warped, cb):
    H, W = warped.shape[:2]; x1, y1, x2, y2 = [int(round(v * d)) for v, d in zip(cb, [W, H, W, H])]
    iw, ih = x2 - x1, y2 - y1; d = int(0.05 * min(iw, ih))
    ring = warped[y1:y2, x1:x2].copy()
    inner = ring[d:-d, d:-d]
    lab = cv2.cvtColor(ring, cv2.COLOR_BGR2LAB).astype(np.float32)
    labi = cv2.cvtColor(inner, cv2.COLOR_BGR2LAB).astype(np.float32) if inner.size else lab
    # ring = ring minus inner (just the border band)
    mask = np.ones(ring.shape[:2], bool); mask[d:-d, d:-d] = False
    a, b = lab[..., 1][mask], lab[..., 2][mask]
    return float(np.hypot(a.std(), b.std()))

def lr(s): return int(s.split("/")[0])
df = pd.read_csv("feature_extraction_dataset/cv_raw.csv")
rows = []
for _, r in df.iterrows():
    det = WC.load_warp(r["path"])
    if det is None: continue
    try:
        old = N.compute_centering_hybrid(det["warped"], det["cb"])
        new = IF.find_inner_frame(det["warped"], det["cb"])
        cs = chroma_std(det["warped"], det["cb"])
    except Exception:
        continue
    rows.append({"file": r["file"], "psa": r["actual_psa"], "chroma": cs,
                 "old_lr": lr(old["left_right"]), "old_tb": lr(old["top_bottom"]),
                 "new_lr": lr(new["left_right"]), "new_tb": lr(new["top_bottom"]),
                 "new_reliable": new["reliable"]})
D = pd.DataFrame(rows)
D["dlr"] = (D.new_lr - D.old_lr).abs(); D["dtb"] = (D.new_tb - D.old_tb).abs()
uni = D[D.chroma < 8]; foil = D[D.chroma >= 8]
print(f"swept {len(D)} cards  | uniform-border={len(uni)}  foil/full-art={len(foil)}\n")
print("=== UNIFORM borders (OLD is trustworthy → NEW must AGREE = no regression) ===")
print(f"  L/R agree within ±5: {100*(uni.dlr<=5).mean():.0f}%   within ±10: {100*(uni.dlr<=10).mean():.0f}%   median |Δ|={uni.dlr.median():.0f}")
print(f"  T/B agree within ±5: {100*(uni.dtb<=5).mean():.0f}%   within ±10: {100*(uni.dtb<=10).mean():.0f}%   median |Δ|={uni.dtb.median():.0f}")
# explicit regressions: old said centered (40-60) but new says off (>±15 from 50)
reg = uni[(uni.old_lr.between(42,58)) & (~uni.new_lr.between(35,65))]
regt = uni[(uni.old_tb.between(42,58)) & (~uni.new_tb.between(35,65))]
print(f"  L/R REGRESSIONS (old centered → new off): {len(reg)}/{len(uni)}  ({100*len(reg)/max(len(uni),1):.0f}%)")
print(f"  T/B REGRESSIONS (old centered → new off): {len(regt)}/{len(uni)}  ({100*len(regt)/max(len(uni),1):.0f}%)")
if len(reg): print("   examples:", reg.sort_values("dlr",ascending=False).head(5)[["file","psa","old_lr","new_lr"]].to_dict("records"))
print("\n=== FOIL / full-art (OLD unreliable → divergence = the fix) ===")
print(f"  L/R diverges >10 from old: {100*(foil.dlr>10).mean():.0f}%   T/B diverges >10: {100*(foil.dtb>10).mean():.0f}%")
print(f"  new_reliable rate: uniform={100*uni.new_reliable.mean():.0f}%  foil={100*foil.new_reliable.mean():.0f}%")
D.to_csv("diag/inner_frame_sweep.csv", index=False)
print("\nsaved diag/inner_frame_sweep.csv")
