"""Fuse the CORAL learned scalar (diag/coral_oof.csv) with the 230 CV features → 4-tier XGBoost.
Separate process (NO torch) to avoid the torch+xgboost OpenMP segfault."""
import pandas as pd, numpy as np, xgboost as xgb
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import accuracy_score
TIER = {5: 0, 6: 0, 7: 1, 8: 1, 9: 2, 10: 3}
oof = pd.read_csv("diag/coral_oof.csv")
df = pd.read_csv("feature_extraction_dataset/cv_raw.csv")
df = df[df.actual_psa.isin(TIER)].reset_index(drop=True)
m = df.merge(oof[["file", "actual_psa", "oof_s"]], on=["file", "actual_psa"], how="inner")
cols = [c for c in df.columns if c.startswith(("m.", "mag.", "conf.", "cen."))]
y = np.array([TIER[int(g)] for g in m.actual_psa])
Xcv = m[cols].apply(pd.to_numeric, errors="coerce").fillna(0).values
P = dict(objective="multi:softprob", num_class=4, n_estimators=500, learning_rate=0.05, max_depth=4,
         subsample=0.8, colsample_bytree=0.8, min_child_weight=3, random_state=7, verbosity=0)
print(f"fused on {len(m)} cards (merged CORAL scalar ↔ CV rows)")
for name, X in [("CV-only (230)", Xcv), ("CV + learned s (231)", np.column_stack([Xcv, m.oof_s.values]))]:
    oofp = cross_val_predict(xgb.XGBClassifier(**P), X, y, cv=StratifiedKFold(5, shuffle=True, random_state=7), method="predict_proba")
    mm = oofp.argmax(1)
    print(f"  {name:22s} EXACT={100*accuracy_score(y, mm):.1f}%  within-1={100*np.mean(np.abs(mm-y)<=1):.1f}%")
