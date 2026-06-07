"""QA for the patch-embedding distance: how much of the distance is pipeline error
vs misalignment vs capture vs real condition?

Reference = highest-grade copy of card 5/64 (Kangaskhan). Compares the reference's
patch grid against:
  - ITSELF (identical)              -> sanity, must be ~0
  - itself SHIFTED by k px          -> pure misalignment noise floor (zero condition diff)
  - a SAME-grade (PSA9) copy        -> capture-only (same condition, different photo)
  - LOWER-grade copies              -> condition + capture
Outputs: diag/embed_qa_cards.png (cards side by side) + diag/embed_qa_distrib.png (histograms) + stats."""
import os, sys, re
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
sys.path.insert(0, ".")
from pathlib import Path
import numpy as np, cv2, pandas as pd, torch, timm, warp_cache as WC
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt

BASE = Path("feature_extraction_dataset"); NUM = re.compile(r'\b(\d{1,3}/\d{1,3})\b')
CARD = "5/64"; S = 224; NG = S // 14
m = pd.read_csv(BASE / "metadata.csv"); m = m[m.filename.str.contains("_front")].copy()
m["num"] = m.ebay_title.map(lambda t: (NUM.search(str(t)).group(1) if NUM.search(str(t)) else None))
m["path"] = m.apply(lambda r: str(BASE / str(int(r.actual_psa)) / r.filename), axis=1)
sub = m[m.num == CARD].sort_values("actual_psa", ascending=False).reset_index(drop=True)

dev = "mps" if torch.backends.mps.is_available() else "cpu"
model = timm.create_model("vit_small_patch14_dinov2.lvd142m", pretrained=True, num_classes=0,
                          img_size=S, dynamic_img_size=True).eval().to(dev)
cfg = timm.data.resolve_model_data_config(model)
mean = np.array(cfg["mean"], np.float32); std = np.array(cfg["std"], np.float32)

def embed_rgb(rgb):
    inp = cv2.resize(rgb, (S, S)).astype(np.float32) / 255.
    x = torch.from_numpy(((inp - mean) / std).transpose(2, 0, 1))[None].to(dev)
    with torch.no_grad():
        tok = model.forward_features(x)[0].cpu().numpy()
    return tok[0], tok[1:].reshape(NG, NG, -1)

def warp_rgb(p):
    d = WC.load_warp(p)
    return cv2.cvtColor(d["warped"], cv2.COLOR_BGR2RGB) if d else None

def shift(rgb, k):
    M = np.float32([[1, 0, k], [0, 1, k]])
    return cv2.warpAffine(rgb, M, (rgb.shape[1], rgb.shape[0]), borderMode=cv2.BORDER_REPLICATE)

def pdist(pc, pr):
    a = pc / (np.linalg.norm(pc, axis=2, keepdims=True) + 1e-9)
    b = pr / (np.linalg.norm(pr, axis=2, keepdims=True) + 1e-9)
    return (1 - (a * b).sum(2)).flatten()

def cdist(a, b):
    return float(1 - (a @ b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))

ref_rgb = warp_rgb(sub.iloc[0].path); ref_cls, ref_p = embed_rgb(ref_rgb)
print(f"reference = PSA{int(sub.iloc[0].actual_psa)}  {sub.iloc[0].filename}  (1 warp px ≈ {ref_rgb.shape[1]/NG:.0f}×{ref_rgb.shape[0]/NG:.0f} per patch)\n")

cmp = {}   # label -> (patch_dist_array, cls_dist)
# self + shifts (misalignment noise floor, ZERO condition difference)
for k in [0, 20, 40, 80]:
    c, p = embed_rgb(shift(ref_rgb, k))
    cmp[f"self+shift{k}px"] = (pdist(p, ref_p), cdist(c, ref_cls))
# every copy
for i in range(1, len(sub)):
    r = warp_rgb(sub.iloc[i].path)
    if r is None: continue
    c, p = embed_rgb(r)
    cmp[f"PSA{int(sub.iloc[i].actual_psa)} · {sub.iloc[i].filename[:18]}"] = (pdist(p, ref_p), cdist(c, ref_cls))

print(f"{'comparison':34s} {'patch med':>9s} {'patch mean':>10s} {'p90':>6s} {'CLS':>6s}")
for lab, (pa, cl) in cmp.items():
    print(f"{lab:34s} {np.median(pa):9.3f} {pa.mean():10.3f} {np.percentile(pa,90):6.3f} {cl:6.3f}")

# ── histograms: noise floor (shift) vs condition (grades) ───────────────────
fig, ax = plt.subplots(figsize=(8, 4)); fig.patch.set_facecolor("#0e1117"); ax.set_facecolor("#0e1117")
series = [("self+shift20px", "#7fd1ff", "-"), ("self+shift40px", "#4c9aff", "-"), ("self+shift80px", "#2a6fd6", "-")]
series += [(l, c, "--") for l, c in zip([k for k in cmp if k.startswith("PSA")], ["#3fb37f", "#fdd835", "#fb8c00", "#e5544b", "#b06cff", "#888"])]
for lab, col, ls in series:
    if lab in cmp:
        ax.hist(cmp[lab][0], bins=28, range=(0, 1), histtype="step", lw=1.8, color=col, ls=ls, label=lab)
ax.set_xlabel("per-patch cosine distance", color="#e8eaed"); ax.set_ylabel("# patches", color="#e8eaed")
ax.set_title("solid = self SHIFTED (zero condition diff, pure misalignment) · dashed = real copies",
             color="#e8eaed", fontsize=9)
ax.tick_params(colors="#e8eaed"); ax.legend(fontsize=7, facecolor="#0e1117", labelcolor="#e8eaed", ncol=2)
for s in ax.spines.values(): s.set_color("#3a3f47")
fig.tight_layout(); fig.savefig("diag/embed_qa_distrib.png", dpi=110); plt.close(fig)

# ── cards side by side ──────────────────────────────────────────────────────
def card(p, lab):
    r = warp_rgb(p); h = 460; r = cv2.resize(r, (int(r.shape[1] * h / r.shape[0]), h))
    head = np.zeros((30, r.shape[1], 3), np.uint8); cv2.putText(head, lab, (5, 21), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (255, 255, 255), 2)
    return np.vstack([head, cv2.cvtColor(r, cv2.COLOR_RGB2BGR)])
tiles = [card(sub.iloc[0].path, f"REF PSA{int(sub.iloc[0].actual_psa)}")]
tiles += [card(sub.iloc[i].path, f"PSA{int(sub.iloc[i].actual_psa)}") for i in range(1, len(sub))]
W = max(t.shape[1] for t in tiles); tiles = [np.hstack([t, np.full((t.shape[0], W - t.shape[1], 3), 25, np.uint8)]) if t.shape[1] < W else t for t in tiles]
sep = np.full((tiles[0].shape[0], 6, 3), 70, np.uint8); out = tiles[0]
for t in tiles[1:]: out = np.hstack([out, sep, t])
cv2.imwrite("diag/embed_qa_cards.png", out)
print("\nsaved diag/embed_qa_cards.png  +  diag/embed_qa_distrib.png")
