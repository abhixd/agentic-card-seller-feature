"""Multi-seed robustness check for the cheap accuracy knobs (class weights + ignore
fraying/wear). Averages 5-fold CV exact% across 5 seeds so we don't cherry-pick a
lucky split. CV-raw features only."""
import numpy as np, pandas as pd, xgboost as xgb, fnmatch
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import accuracy_score

TIER_MAP = {5: 0, 6: 0, 7: 1, 8: 1, 9: 2, 10: 3}
SHORT = ["≤6", "7–8", "PSA9", "PSA10"]
SEEDS = [7, 1, 13, 21, 33]
df = pd.read_csv("feature_extraction_dataset/cv_raw.csv")
df = df[df["actual_psa"].isin(TIER_MAP)]
y = np.array([TIER_MAP[int(g)] for g in df["actual_psa"]])
allcols = [c for c in df.columns if c.startswith(("m.", "mag.", "conf.", "cen."))]

def params(seed):
    return dict(objective="multi:softprob", num_class=4, n_estimators=500, learning_rate=0.05,
                max_depth=4, subsample=0.8, colsample_bytree=0.8, min_child_weight=3,
                eval_metric="mlogloss", random_state=seed, verbosity=0)

def weights(scheme):
    cnt = np.bincount(y, minlength=4)
    if scheme == "none": return None
    w = len(y) / (4 * cnt[y]) if scheme == "balanced" else np.sqrt(len(y) / cnt[y])
    return w / w.mean()

def drop(pats): return [c for c in allcols if not any(fnmatch.fnmatch(c, p) for p in pats)]

def cv_once(cols, scheme, seed):
    X = df[cols].apply(pd.to_numeric, errors="coerce").fillna(0).values
    w = weights(scheme)
    skf = StratifiedKFold(5, shuffle=True, random_state=seed); oof = np.zeros((len(y), 4))
    for tr, te in skf.split(X, y):
        sw = w[tr] if w is not None else None
        oof[te] = xgb.XGBClassifier(**params(seed)).fit(X[tr], y[tr], sample_weight=sw).predict_proba(X[te])
    m = oof.argmax(1)
    return (100 * accuracy_score(y, m), 100 * np.mean(np.abs(m - y) <= 1),
            np.array([100 * accuracy_score(y[y == t], m[y == t]) for t in range(4)]))

CONFIGS = [
    ("baseline (none, 230)",        "none",     []),
    ("balanced",                    "balanced", []),
    ("balanced, -fraying",          "balanced", ["*fraying*"]),
    ("balanced, -fraying-whitening","balanced", ["*fraying*", "*whitening*"]),
    ("balanced, -all wear",         "balanced", ["*fraying*", "*whitening*", "*nick*", "*chip*"]),
    ("sqrt, -fraying",              "sqrt",     ["*fraying*"]),
]
print(f"avg over {len(SEEDS)} seeds {SEEDS}\n")
print(f"{'config':32s} {'exact':>12s} {'w1':>6s}   per-tier mean [≤6 7–8 P9 P10]")
for name, scheme, pats in CONFIGS:
    cols = drop(pats)
    rs = [cv_once(cols, scheme, s) for s in SEEDS]
    ex = np.array([r[0] for r in rs]); w1 = np.array([r[1] for r in rs])
    pt = np.mean([r[2] for r in rs], axis=0)
    print(f"{name:32s} {ex.mean():5.1f}±{ex.std():3.1f} {w1.mean():6.1f}   "
          f"[{pt[0]:.0f} {pt[1]:.0f} {pt[2]:.0f} {pt[3]:.0f}]  (n={len(cols)})")
