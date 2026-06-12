"""Per-pillar XGBoost experiment (user's redesign): 3 pillar models (corners/edges/surface),
each predicting the 4-tier grade from ONLY its features; combine the 3 distributions; then
final = min(centering, combined). Evaluate combine rules × centering-cap variants vs the
current single all-features model, all on honest 5-fold OOF predictions."""
import os, sys, glob; os.environ["CARD_DETECTOR"] = "seg"
sys.path.insert(0, "."); sys.path.insert(0, "../backend")
from dotenv import load_dotenv; load_dotenv("../.env.local", override=True); load_dotenv("../backend/.env", override=False)
import numpy as np, pandas as pd, joblib, xgboost as xgb
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from pathlib import Path
import warp_cache as WC, inner_frame as IF

TIER_MAP = {5: 0, 6: 0, 7: 1, 8: 1, 9: 2, 10: 3}
TIER_SHORT = ["≤6", "7–8", "PSA 9", "PSA 10"]
G = np.array([6.0, 7.5, 9.0, 10.0])          # representative grade per tier (for expected grade)
SEED = 42
XGB = dict(objective="multi:softprob", num_class=4, n_estimators=500, learning_rate=0.05,
           max_depth=4, subsample=0.8, colsample_bytree=0.8, min_child_weight=3,
           eval_metric="mlogloss", random_state=SEED, verbosity=0)
MODELS = Path("models")

df = pd.read_csv("feature_extraction_dataset/cv_raw.csv")
y = np.array([TIER_MAP[int(g)] for g in df["actual_psa"]])
fc = joblib.load("models/cv_xgb_raw.pkl")["feature_cols"]
cols = {"corners": [c for c in fc if ".corners." in c],
        "edges":   [c for c in fc if ".edges." in c],
        "surface": [c for c in fc if ".surface." in c]}
allcols = fc
skf = StratifiedKFold(5, shuffle=True, random_state=SEED)
def X(c): return df[c].apply(pd.to_numeric, errors="coerce").fillna(0).values
def oof(c): return cross_val_predict(xgb.XGBClassifier(**XGB), X(c), y, cv=skf, method="predict_proba")
def ex(pred): return 100 * np.mean(pred == y)
def w1(pred): return 100 * np.mean(np.abs(pred - y) <= 1)
def to_tier(s): return np.where(s >= 9.5, 3, np.where(s >= 8.5, 2, np.where(s >= 6.5, 1, 0)))

print("training OOF (5-fold)…")
oof_all = oof(allcols)
P = {k: oof(c) for k, c in cols.items()}            # pillar OOF distributions
E = {k: P[k] @ G for k in P}                         # pillar expected grades
for k in cols: print(f"  {k:8s}: {len(cols[k]):3d} feats  standalone exact={ex(P[k].argmax(1)):.1f}% within1={w1(P[k].argmax(1)):.1f}%")

# ── centering per card (inner_frame on cached warps) ──
print("computing centering per card…")
cen_score = np.full(len(df), 10.0); cen_reliable = np.zeros(len(df), bool)
def ladder(dev):
    for thr, s in [(5,10),(10,9),(15,8),(20,7),(25,6),(30,5),(35,4),(40,3),(45,2)]:
        if dev <= thr: return float(s)
    return 1.0
for i, p in enumerate(df["path"]):
    try:
        det = WC.load_warp(p)
        if det is None: continue
        inn = IF.find_inner_frame(det["warped"], det["cb"])
        dev = max(abs(int(inn["left_right"].split("/")[0]) - 50), abs(int(inn["top_bottom"].split("/")[0]) - 50))
        cen_score[i] = ladder(dev); cen_reliable[i] = bool(inn["reliable"])
    except Exception:
        pass

combos = {
    "min_E (weakest-link)": np.minimum.reduce([E["corners"], E["edges"], E["surface"]]),
    "mean_E":               np.mean([E["corners"], E["edges"], E["surface"]], axis=0),
    "mean_dist→E":          ((P["corners"] + P["edges"] + P["surface"]) / 3) @ G,
}
print("\n" + "=" * 78)
print(f"{'approach':42s} {'exact%':>7s} {'within1%':>9s}")
print("-" * 78)
print(f"{'SINGLE all-features model (current, baseline)':42s} {ex(oof_all.argmax(1)):>7.1f} {w1(oof_all.argmax(1)):>9.1f}")
print("-" * 78)
best = None
for name, comb in combos.items():
    t = to_tier(comb); e = ex(t)
    print(f"{'combined: '+name:42s} {e:>7.1f} {w1(t):>9.1f}")
    if best is None or e > best[1]: best = (name, e, comb)
print(f"\nbest combined = {best[0]} ({best[1]:.1f}%). Now apply centering cap to it:")
print("-" * 78)
comb = best[2]
raw_cap   = np.minimum(cen_score, comb)
gate_cap  = np.where(cen_reliable, np.minimum(cen_score, comb), comb)
for name, final in [("no cap", comb), ("min(centering, combined)  RAW", raw_cap),
                    ("min(centering, combined)  RELIABILITY-GATED", gate_cap)]:
    t = to_tier(final); print(f"{name:42s} {ex(t):>7.1f} {w1(t):>9.1f}")
print("=" * 78)
print(f"centering: reliable on {100*cen_reliable.mean():.0f}% of cards; "
      f"raw cap lowers {100*np.mean(np.minimum(cen_score,comb)<comb-0.01):.0f}% of cards' scores")

# ── save the 3 pillar models (fit on all data) ──
for k, c in cols.items():
    m = xgb.XGBClassifier(**XGB).fit(X(c), y)
    joblib.dump({"model": m, "feature_cols": c, "source": f"pillar_{k}", "pillar": k,
                 "tier_map": TIER_MAP, "tier_short": TIER_SHORT, "n_tiers": 4,
                 "grades": G.tolist()}, MODELS / f"cv_xgb_pillar_{k}.pkl")
print(f"saved 3 pillar models → models/cv_xgb_pillar_{{corners,edges,surface}}.pkl")
