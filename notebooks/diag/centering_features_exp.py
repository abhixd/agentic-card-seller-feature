"""Test the user's idea: encode centering as PSA-grade-BAND features (per axis) and let XGBoost
learn their weight, vs the current 2 continuous deviation features. All via 5-fold OOF on 679 cards.
Centering measured with CoherentFrame (inner_frame) — the production source."""
import os, sys; os.environ["CARD_DETECTOR"] = "seg"
sys.path.insert(0, "."); sys.path.insert(0, "../backend")
from dotenv import load_dotenv; load_dotenv("../.env.local", override=True); load_dotenv("../backend/.env", override=False)
import numpy as np, pandas as pd, joblib, xgboost as xgb
from sklearn.model_selection import StratifiedKFold, cross_val_predict
import warp_cache as WC, inner_frame as IF

TIER_MAP = {5: 0, 6: 0, 7: 1, 8: 1, 9: 2, 10: 3}; SEED = 42
XGB = dict(objective="multi:softprob", num_class=4, n_estimators=500, learning_rate=0.05,
           max_depth=4, subsample=0.8, colsample_bytree=0.8, min_child_weight=3,
           eval_metric="mlogloss", random_state=SEED, verbosity=0)
df = pd.read_csv("feature_extraction_dataset/cv_raw.csv")
y = np.array([TIER_MAP[int(g)] for g in df["actual_psa"]])
fc = joblib.load("models/cv_xgb_raw.pkl")["feature_cols"]
base = [c for c in fc if not c.startswith("cen.")]          # 228 non-centering raw features
Xbase = df[base].apply(pd.to_numeric, errors="coerce").fillna(0).values

# ── CoherentFrame centering per card (cache to csv) ──
cache = "diag/coh_centering.csv"
if os.path.exists(cache):
    cc = pd.read_csv(cache); lrd = cc["lr_dev"].values; tbd = cc["tb_dev"].values
else:
    print("computing CoherentFrame centering per card…")
    lrd = np.full(len(df), np.nan); tbd = np.full(len(df), np.nan)
    for i, p in enumerate(df["path"]):
        try:
            det = WC.load_warp(p)
            if det is None: continue
            inn = IF.find_inner_frame(det["warped"], det["cb"])
            lrd[i] = abs(int(inn["left_right"].split("/")[0]) - 50)
            tbd[i] = abs(int(inn["top_bottom"].split("/")[0]) - 50)
        except Exception: pass
    pd.DataFrame({"lr_dev": lrd, "tb_dev": tbd}).to_csv(cache, index=False)
lrd = np.nan_to_num(lrd, nan=np.nanmedian(lrd)); tbd = np.nan_to_num(tbd, nan=np.nanmedian(tbd))

# hybrid (current) centering features straight from cv_raw
hyb = df[["cen.lr_deviation", "cen.tb_deviation"]].apply(pd.to_numeric, errors="coerce").fillna(0).values

def bands(dev):  # one-hot PSA centering bands per axis: [10,9,8,7,6,lo]
    edges = [5, 10, 15, 20, 25]
    out = np.zeros((len(dev), 6))
    for i, d in enumerate(dev):
        b = next((k for k, e in enumerate(edges) if d <= e), 5)
        out[i, b] = 1.0
    return out
def implied(dev):  # ordinal PSA grade implied by centering on this axis
    return np.array([10 if d <= 5 else 9 if d <= 10 else 8 if d <= 15 else 7 if d <= 20 else 6 if d <= 25 else 5 for d in dev], float)

coh_cont = np.column_stack([lrd, tbd])
coh_band = np.column_stack([bands(lrd), bands(tbd)])           # 12 one-hot
coh_ord  = np.column_stack([implied(lrd), implied(tbd)])       # 2 ordinal

variants = {
    "base ONLY (no centering)":                 Xbase,
    "base + hybrid cont (CURRENT baseline)":    np.column_stack([Xbase, hyb]),
    "base + CoherentFrame cont":                np.column_stack([Xbase, coh_cont]),
    "base + CoherentFrame ordinal-grade":       np.column_stack([Xbase, coh_ord]),
    "base + CoherentFrame one-hot BANDS":       np.column_stack([Xbase, coh_band]),
    "base + CoherentFrame cont + bands":        np.column_stack([Xbase, coh_cont, coh_band]),
}
skf = StratifiedKFold(5, shuffle=True, random_state=SEED)
print(f"\n{'feature set':42s} {'exact%':>7s} {'within1%':>9s}  Δexact")
print("-" * 74)
baseex = None
for name, Xv in variants.items():
    oof = cross_val_predict(xgb.XGBClassifier(**XGB), Xv, y, cv=skf, method="predict_proba")
    m = oof.argmax(1); e = 100 * np.mean(m == y); w = 100 * np.mean(np.abs(m - y) <= 1)
    if "CURRENT" in name: baseex = e
    d = "" if baseex is None else f"  {e-baseex:+.1f}"
    print(f"{name:42s} {e:>7.1f} {w:>9.1f}{d}")
print("-" * 74)
# centering feature importance in the best band model
m = xgb.XGBClassifier(**XGB).fit(np.column_stack([Xbase, coh_cont, coh_band]), y)
imp = m.feature_importances_; n = Xbase.shape[1]
print(f"centering features' share of total importance: {100*imp[n:].sum():.1f}%  (cont+12 bands)")
