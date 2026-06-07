"""
retrain_models.py — retrain the 4-tier XGBoost grade classifiers.

Trains BOTH models from their cached feature CSVs and saves bundles that
GradePredictor (18_nonvlm_te) loads:
    models/cv_xgb.pkl     ← from cv_features.csv     (full-res CV features)
    models/haiku_xgb.pkl  ← from haiku_features.csv  (unchanged Haiku features)

4-tier scheme:  ≤6 · 7-8 · PSA 9 · PSA 10

Run: cd notebooks && ../backend/venv/bin/python retrain_models.py
"""
import os, sys, warnings
import numpy as np, pandas as pd
from pathlib import Path
from scipy.stats import pearsonr
from sklearn.feature_selection import mutual_info_classif
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import log_loss, accuracy_score
import xgboost as xgb
import joblib

warnings.filterwarnings("ignore")
sys.path.insert(0, "."); sys.path.insert(0, "../backend")
import nonvlm_cv as N

BASE   = Path("feature_extraction_dataset")
MODELS = Path("models"); MODELS.mkdir(exist_ok=True)
SEED   = 7

TIER_MAP    = {5: 0, 6: 0, 7: 1, 8: 1, 9: 2, 10: 3}
TIER_LABELS = ["Don't grade  (≤6)", "Consider  (7–8)",
               "PSA 9  (Near Mint)", "PSA 10  (Gem Mint)"]
TIER_SHORT  = ["≤6", "7–8", "PSA 9", "PSA 10"]
N_TIERS     = 4
CEN         = ["cen.lr_deviation", "cen.tb_deviation"]
N_TOP       = 15

XGB_PARAMS = dict(objective="multi:softprob", num_class=N_TIERS,
                  n_estimators=500, learning_rate=0.05, max_depth=4,
                  subsample=0.8, colsample_bytree=0.8, min_child_weight=3,
                  eval_metric="mlogloss", random_state=SEED, verbosity=0)


def train(source, csv_path):
    print(f"\n{'='*60}\n{source.upper()} model  ←  {csv_path.name}\n{'='*60}")
    df = pd.read_csv(csv_path)
    df = df[df.get("error", pd.Series("", index=df.index)).isna() |
            (df.get("error", pd.Series("", index=df.index)).astype(str).str.strip() == "")]
    df = df.reset_index(drop=True)

    y = np.array([TIER_MAP[int(g)] for g in df["actual_psa"]])
    print(f"  cards: {len(df)}")
    for t, lbl in enumerate(TIER_LABELS):
        print(f"    {lbl:24} {int((y==t).sum()):4d}  ({100*(y==t).mean():.0f}%)")

    # feature columns by source
    if source == "cv":
        feat_cols = [c for c in df.columns if c.startswith("cv.")]
    else:
        feat_cols = [c for c in N.FEATURE_COLUMNS if c in df.columns]
    feat_cols = feat_cols + [c for c in CEN if c in df.columns]

    X_all = df[feat_cols].apply(pd.to_numeric, errors="coerce").fillna(0)

    # top-N by mutual information (always keep centering)
    mi = mutual_info_classif(X_all.values, y, random_state=SEED)
    ranked = pd.Series(mi, index=feat_cols).sort_values(ascending=False)
    selected = ranked.head(N_TOP).index.tolist()
    for c in CEN:
        if c in df.columns and c not in selected:
            selected.append(c)
    print(f"  selected {len(selected)} features (top-{N_TOP} MI + centering)")

    X = df[selected].apply(pd.to_numeric, errors="coerce").fillna(0).values

    # cross-validated metrics
    n_folds = min(5, int(pd.Series(y).value_counts().min()))
    skf = StratifiedKFold(n_folds, shuffle=True, random_state=SEED)
    oof = cross_val_predict(xgb.XGBClassifier(**XGB_PARAMS), X, y, cv=skf,
                            method="predict_proba")
    mode = oof.argmax(1)
    per_tier = {TIER_SHORT[t]: round(100*accuracy_score(y[y==t], mode[y==t]), 1)
                for t in range(N_TIERS)}
    metrics = {"source": source, "n_cards": len(df), "n_features": len(selected),
               "n_folds": n_folds, "log_loss": round(log_loss(y, oof), 3),
               "exact%": round(100*accuracy_score(y, mode), 1),
               "within1%": round(100*np.mean(np.abs(mode - y) <= 1), 1),
               **{f"acc_{k}%": v for k, v in per_tier.items()}}
    print(f"  {n_folds}-fold CV: log-loss={metrics['log_loss']}  "
          f"exact={metrics['exact%']}%  within-1={metrics['within1%']}%")
    for t in range(N_TIERS):
        print(f"    {TIER_LABELS[t]:24} acc={per_tier[TIER_SHORT[t]]}%")

    # final model on all data
    model = xgb.XGBClassifier(**XGB_PARAMS)
    model.fit(X, y)

    bundle = {"model": model, "feature_cols": selected, "source": source,
              "tier_map": TIER_MAP, "tier_labels": TIER_LABELS,
              "tier_short": TIER_SHORT, "n_tiers": N_TIERS, "cv_metrics": metrics}
    out = MODELS / f"{source}_xgb.pkl"
    joblib.dump(bundle, out)
    print(f"  saved → {out}")
    return metrics


if __name__ == "__main__":
    results = []
    results.append(train("cv",    BASE / "cv_features.csv"))
    results.append(train("haiku", BASE / "haiku_features.csv"))

    print(f"\n{'='*60}\nCOMPARISON (4-tier, full-res CV vs Haiku)\n{'='*60}")
    comp = pd.DataFrame(results).set_index("source")
    cols = ["n_cards", "n_features", "log_loss", "exact%", "within1%",
            "acc_≤6%", "acc_7–8%", "acc_PSA 9%", "acc_PSA 10%"]
    print(comp[[c for c in cols if c in comp.columns]].T.to_string())
    print("\nModels saved to models/ — ready for 18_nonvlm_te.ipynb")
