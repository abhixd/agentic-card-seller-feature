"""GO/NO-GO signal test: does a frozen DINOv2 embedding of the warped card predict
PSA grade? Compares DINO features (global CLS + patch-pooled) to the 44% hand-crafted
baseline, and to their concatenation. Also tests the user's original hypothesis
directly: does cosine-distance to the PSA10 prototype correlate with grade?

Embeddings cached to dino_embeddings.npz (aligned to cv_raw.csv rows). Reuses warp cache."""
import os, sys, glob, time
sys.path.insert(0, "."); sys.path.insert(0, "../backend")
os.environ["CARD_DETECTOR"] = "seg"
from dotenv import load_dotenv
load_dotenv("../.env.local", override=True); load_dotenv("../backend/.env", override=False)
import numpy as np, pandas as pd, torch, timm, cv2, xgboost as xgb
import warp_cache as WC
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import accuracy_score
from scipy.stats import spearmanr

BASE = "feature_extraction_dataset"
EMB = f"{BASE}/dino_embeddings.npz"
SEED = 7; TIER_MAP = {5: 0, 6: 0, 7: 1, 8: 1, 9: 2, 10: 3}; SHORT = ["≤6", "7–8", "P9", "P10"]
XGB = dict(objective="multi:softprob", num_class=4, n_estimators=500, learning_rate=0.05,
           max_depth=4, subsample=0.8, colsample_bytree=0.8, min_child_weight=3,
           eval_metric="mlogloss", random_state=SEED, verbosity=0)

df = pd.read_csv(f"{BASE}/cv_raw.csv")
df = df[df["actual_psa"].isin(TIER_MAP)].reset_index(drop=True)
paths = df["path"].tolist()
y = np.array([TIER_MAP[int(g)] for g in df["actual_psa"]])

# ── 1) embed every warp with DINOv2 (cached) ────────────────────────────────
if os.path.exists(EMB) and list(np.load(EMB, allow_pickle=True)["paths"]) == paths:
    z = np.load(EMB, allow_pickle=True)
    CLS, PMEAN, PSTD, PMAX = z["cls"], z["pmean"], z["pstd"], z["pmax"]
    print(f"loaded cached embeddings {CLS.shape}")
else:
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    model = timm.create_model("vit_small_patch14_dinov2.lvd142m", pretrained=True, num_classes=0,
                              img_size=224, dynamic_img_size=True).eval().to(dev)
    cfg = timm.data.resolve_model_data_config(model)
    mean = np.array(cfg["mean"], np.float32); std = np.array(cfg["std"], np.float32)
    def prep(bgr):
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB); rgb = cv2.resize(rgb, (224, 224)).astype(np.float32) / 255.
        return torch.from_numpy(((rgb - mean) / std).transpose(2, 0, 1))
    cls, pm, ps, px = [], [], [], []; B = 16; t0 = time.time()
    with torch.no_grad():
        for s in range(0, len(paths), B):
            chunk = paths[s:s + B]
            x = torch.stack([prep(WC.load_warp(p)["warped"]) for p in chunk]).to(dev)
            tok = model.forward_features(x); c = tok[:, 0]; pat = tok[:, 1:]
            cls.append(c.cpu().numpy()); pm.append(pat.mean(1).cpu().numpy())
            ps.append(pat.std(1).cpu().numpy()); px.append(pat.amax(1).cpu().numpy())
            print(f"  embedded {min(s + B, len(paths))}/{len(paths)}", flush=True)
    CLS = np.concatenate(cls); PMEAN = np.concatenate(pm); PSTD = np.concatenate(ps); PMAX = np.concatenate(px)
    np.savez(EMB, cls=CLS, pmean=PMEAN, pstd=PSTD, pmax=PMAX, paths=np.array(paths, object))
    print(f"embedded {len(paths)} cards in {time.time()-t0:.0f}s -> {EMB}")

# ── 2) train + compare (same 4-tier XGBoost, 5-fold) ────────────────────────
hand = df[[c for c in df.columns if c.startswith(("m.", "mag.", "conf.", "cen."))]].apply(
    pd.to_numeric, errors="coerce").fillna(0).values
PATCH = np.concatenate([PMEAN, PSTD, PMAX], 1)

def cv_eval(name, X):
    skf = StratifiedKFold(5, shuffle=True, random_state=SEED); oof = np.zeros((len(y), 4))
    for tr, te in skf.split(X, y):
        oof[te] = xgb.XGBClassifier(**XGB).fit(X[tr], y[tr]).predict_proba(X[te])
    m = oof.argmax(1)
    pt = [round(100 * accuracy_score(y[y == t], m[y == t]), 1) for t in range(4)]
    print(f"{name:34s} feats={X.shape[1]:4d}  EXACT={100*accuracy_score(y,m):4.1f}%  "
          f"w1={100*np.mean(np.abs(m-y)<=1):4.1f}%   per-tier {pt}")

print(f"\nVARIANTS (n={len(y)}, 5-fold CV, SEED={SEED}):")
cv_eval("hand-crafted (baseline)", hand)
cv_eval("DINO cls", CLS)
cv_eval("DINO patch mean+std+max", PATCH)
cv_eval("DINO cls + patch", np.concatenate([CLS, PATCH], 1))
cv_eval("hand-crafted + DINO", np.concatenate([hand, CLS, PATCH], 1))

# ── 3) the original hypothesis: distance-to-PSA10-prototype vs grade ─────────
def cosdist_to_proto(F):
    proto = F[df.actual_psa == 10].mean(0)
    fn = F / (np.linalg.norm(F, axis=1, keepdims=True) + 1e-9)
    return 1 - fn @ (proto / (np.linalg.norm(proto) + 1e-9))
print("\nUSER'S HYPOTHESIS — cosine distance to PSA10 prototype vs PSA grade:")
for nm, F in [("CLS", CLS), ("patch-mean", PMEAN)]:
    d = cosdist_to_proto(F); rho, p = spearmanr(d, df.actual_psa)
    print(f"  {nm:10s} Spearman rho={rho:+.3f} (p={p:.1e})   "
          f"[want strongly NEGATIVE: closer to PSA10 ⇒ higher grade]")
