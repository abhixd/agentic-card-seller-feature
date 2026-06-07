"""Train-only (NO torch import → avoids the torch+xgboost OpenMP segfault on macOS).
Loads the cached DINOv2 embeddings + cv_raw.csv, trains the 4-tier XGBoost on each
feature variant, and tests the prototype-distance hypothesis."""
import os
os.environ["KMP_DUPLICATE_LIB_OK"] = "TRUE"
import numpy as np, pandas as pd, xgboost as xgb
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import accuracy_score
from scipy.stats import spearmanr

BASE = "feature_extraction_dataset"
SEED = 7; TIER_MAP = {5: 0, 6: 0, 7: 1, 8: 1, 9: 2, 10: 3}
XGB = dict(objective="multi:softprob", num_class=4, n_estimators=500, learning_rate=0.05,
           max_depth=4, subsample=0.8, colsample_bytree=0.8, min_child_weight=3,
           eval_metric="mlogloss", random_state=SEED, verbosity=0)

df = pd.read_csv(f"{BASE}/cv_raw.csv")
df = df[df["actual_psa"].isin(TIER_MAP)].reset_index(drop=True)
y = np.array([TIER_MAP[int(g)] for g in df["actual_psa"]])
z = np.load(f"{BASE}/dino_embeddings.npz", allow_pickle=True)
assert list(z["paths"]) == df["path"].tolist(), "embedding/CSV row mismatch"
CLS, PMEAN, PSTD, PMAX = z["cls"], z["pmean"], z["pstd"], z["pmax"]
PATCH = np.concatenate([PMEAN, PSTD, PMAX], 1)
hand = df[[c for c in df.columns if c.startswith(("m.", "mag.", "conf.", "cen."))]].apply(
    pd.to_numeric, errors="coerce").fillna(0).values
print(f"n={len(y)}  DINO cls={CLS.shape[1]}  patch-pooled={PATCH.shape[1]}  hand-crafted={hand.shape[1]}")

def cv_eval(name, X):
    skf = StratifiedKFold(5, shuffle=True, random_state=SEED); oof = np.zeros((len(y), 4))
    for tr, te in skf.split(X, y):
        oof[te] = xgb.XGBClassifier(**XGB).fit(X[tr], y[tr]).predict_proba(X[te])
    m = oof.argmax(1)
    pt = [round(100 * accuracy_score(y[y == t], m[y == t]), 1) for t in range(4)]
    print(f"{name:30s} feats={X.shape[1]:4d}  EXACT={100*accuracy_score(y,m):4.1f}%  "
          f"w1={100*np.mean(np.abs(m-y)<=1):4.1f}%   per-tier[≤6 7-8 P9 P10] {pt}")

print(f"\nVARIANTS (5-fold CV, SEED={SEED}):")
cv_eval("hand-crafted (baseline)", hand)
cv_eval("DINO cls", CLS)
cv_eval("DINO patch mean+std+max", PATCH)
cv_eval("DINO cls + patch", np.concatenate([CLS, PATCH], 1))
cv_eval("hand-crafted + DINO", np.concatenate([hand, CLS, PATCH], 1))

def cosdist_to_proto(F):
    proto = F[df.actual_psa == 10].mean(0)
    fn = F / (np.linalg.norm(F, axis=1, keepdims=True) + 1e-9)
    return 1 - fn @ (proto / (np.linalg.norm(proto) + 1e-9))
print("\nUSER'S HYPOTHESIS — cosine distance to PSA10 prototype vs PSA grade")
print("  (want strongly NEGATIVE rho: closer to PSA10 ⇒ higher grade):")
for nm, F in [("CLS", CLS), ("patch-mean", PMEAN)]:
    d = cosdist_to_proto(F); rho, p = spearmanr(d, df.actual_psa)
    print(f"  {nm:10s} Spearman rho={rho:+.3f}  (p={p:.1e})")
