"""
train_compare.py — STEPS 3-5: train + compare RAW-measurement vs PROCESSED-severity models.

  (3) ignore_lists.json   — drop noisy features/measurements before training
  (4) train two 4-tier XGBoost models:
        cv_xgb_raw.pkl        ← raw measurements  (m.* + mag.* + conf.* + centering)
        cv_xgb_processed.pkl  ← processed severities (cv.* + centering)   [= the old model]
  (5) compare cross-validated efficacy of both, side by side

Philosophy: KEEP ALL FEATURES — pruning is done ONLY via ignore_lists.json (no MI
pre-selection), so the ignore list is the single explicit knob. The printed
"CANDIDATES" report (grade-inverted / weak features) tells you what to add there.

Run:  cd notebooks && ../backend/venv/bin/python train_compare.py
Inputs:  feature_extraction_dataset/cv_raw.csv  (+ cv_features_processed.csv, auto-built)
         ignore_lists.json
Outputs: models/cv_xgb_raw.pkl, models/cv_xgb_processed.pkl
"""
import os, sys, json, fnmatch, warnings
from pathlib import Path
import numpy as np, pandas as pd
from scipy.stats import spearmanr
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import log_loss, accuracy_score
import xgboost as xgb
import joblib

warnings.filterwarnings("ignore")
sys.path.insert(0, "."); sys.path.insert(0, "../backend")
import nonvlm_cv as N
import apply_thresholds as AT

BASE   = Path("feature_extraction_dataset")
MODELS = Path("models"); MODELS.mkdir(exist_ok=True)
SEED   = 7

TIER_MAP    = {5: 0, 6: 0, 7: 1, 8: 1, 9: 2, 10: 3}
TIER_LABELS = ["Don't grade  (≤6)", "Consider  (7–8)", "PSA 9  (Near Mint)", "PSA 10  (Gem Mint)"]
TIER_SHORT  = ["≤6", "7–8", "PSA 9", "PSA 10"]
N_TIERS     = 4
CEN         = ["cen.lr_deviation", "cen.tb_deviation"]

XGB_PARAMS = dict(objective="multi:softprob", num_class=N_TIERS,
                  n_estimators=500, learning_rate=0.05, max_depth=4,
                  subsample=0.8, colsample_bytree=0.8, min_child_weight=3,
                  eval_metric="mlogloss", random_state=SEED, verbosity=0)


def load_ignore():
    p = Path("ignore_lists.json")
    if not p.exists():
        return {"raw": [], "processed": []}
    d = json.loads(p.read_text())
    return {"raw": d.get("raw", []), "processed": d.get("processed", [])}


def drop_ignored(cols, patterns):
    """Drop columns matching any ignore pattern (exact, or glob with '*')."""
    pats = [p for p in patterns if not p.startswith("_")]
    kept, dropped = [], []
    for c in cols:
        if any(c == p or fnmatch.fnmatch(c, p) or (p.endswith("*") and c.startswith(p[:-1]))
               for p in pats):
            dropped.append(c)
        else:
            kept.append(c)
    return kept, dropped


def train_one(name, df, feat_cols, ignore):
    feat_cols, dropped = drop_ignored(feat_cols, ignore)
    print(f"\n{'='*64}\n{name.upper()} model   ({len(feat_cols)} features"
          f"{f', {len(dropped)} ignored' if dropped else ''})\n{'='*64}")
    if dropped:
        print(f"  ignored: {', '.join(dropped[:8])}{' …' if len(dropped) > 8 else ''}")

    y = np.array([TIER_MAP[int(g)] for g in df["actual_psa"]])
    X = df[feat_cols].apply(pd.to_numeric, errors="coerce").fillna(0).values

    n_folds = min(5, int(pd.Series(y).value_counts().min()))
    skf = StratifiedKFold(n_folds, shuffle=True, random_state=SEED)
    oof = cross_val_predict(xgb.XGBClassifier(**XGB_PARAMS), X, y, cv=skf, method="predict_proba")
    mode = oof.argmax(1)
    per_tier = {TIER_SHORT[t]: round(100 * accuracy_score(y[y == t], mode[y == t]), 1)
                for t in range(N_TIERS)}
    metrics = {"model": name, "n_cards": len(df), "n_features": len(feat_cols), "n_folds": n_folds,
               "log_loss": round(log_loss(y, oof), 3),
               "exact%": round(100 * accuracy_score(y, mode), 1),
               "within1%": round(100 * np.mean(np.abs(mode - y) <= 1), 1),
               **{f"acc_{k}%": v for k, v in per_tier.items()}}
    print(f"  {n_folds}-fold CV: log-loss={metrics['log_loss']}  "
          f"exact={metrics['exact%']}%  within-1={metrics['within1%']}%")
    for t in range(N_TIERS):
        print(f"    {TIER_LABELS[t]:24} acc={per_tier[TIER_SHORT[t]]}%")

    model = xgb.XGBClassifier(**XGB_PARAMS).fit(X, y)
    bundle = {"model": model, "feature_cols": feat_cols, "source": name,
              "tier_map": TIER_MAP, "tier_labels": TIER_LABELS, "tier_short": TIER_SHORT,
              "n_tiers": N_TIERS, "cv_metrics": metrics}
    joblib.dump(bundle, MODELS / f"cv_xgb_{name}.pkl")
    print(f"  saved → models/cv_xgb_{name}.pkl")
    return metrics


def candidates_report(df, cols, label):
    """Rank defect features by Spearman vs PSA grade. For a defect, higher value
    should mean LOWER grade (negative rho); positive rho = INVERTED (noisy)."""
    g = df["actual_psa"].astype(float).values
    rows = []
    for c in cols:
        x = pd.to_numeric(df[c], errors="coerce").fillna(0).values
        if np.std(x) < 1e-9:
            rows.append((c, 0.0, "flat")); continue
        rho = spearmanr(x, g).correlation
        rho = 0.0 if rho != rho else rho
        flag = "INVERTED" if rho > 0.05 else ("weak" if abs(rho) < 0.05 else "")
        rows.append((c, round(rho, 3), flag))
    rows.sort(key=lambda r: -r[1])   # most positive (most inverted) first
    bad = [r for r in rows if r[2] in ("INVERTED", "flat")]
    print(f"\n  {label}: {len(bad)} candidate-noisy of {len(cols)} "
          f"(rho>0.05 inverted, or flat). Top offenders → add to ignore_lists.json:")
    for c, rho, flag in rows[:12]:
        if flag:
            print(f"     {c:44} rho={rho:+.3f}  {flag}")


if __name__ == "__main__":
    raw_csv = BASE / "cv_raw.csv"
    if not raw_csv.exists():
        sys.exit(f"missing {raw_csv} — run cv_features_extract.py first")

    df_raw = pd.read_csv(raw_csv)
    if "error" in df_raw.columns:
        df_raw = df_raw[df_raw["error"].isna() | (df_raw["error"].astype(str).str.strip() == "")]
    df_raw = df_raw.reset_index(drop=True)

    # processed features (build if missing / stale)
    df_proc = AT.build_processed(raw_csv=raw_csv, out_csv=BASE / "cv_features_processed.csv")

    ignore = load_ignore()
    print(f"cards: {len(df_raw)}   ignore: raw={len(ignore['raw'])} processed={len(ignore['processed'])}")
    for t, lbl in enumerate(TIER_LABELS):
        y = np.array([TIER_MAP[int(g)] for g in df_raw["actual_psa"]])
        print(f"    {lbl:24} {int((y==t).sum()):4d}  ({100*(y==t).mean():.0f}%)")

    raw_feats  = [c for c in df_raw.columns if c.startswith(("m.", "mag.", "conf."))] \
               + [c for c in CEN if c in df_raw.columns]
    proc_feats = [c for c in df_proc.columns if c.startswith("cv.")] \
               + [c for c in CEN if c in df_proc.columns]

    results = []
    results.append(train_one("raw", df_raw, raw_feats, ignore["raw"]))
    results.append(train_one("processed", df_proc, proc_feats, ignore["processed"]))

    # ── comparison ──────────────────────────────────────────────────────────
    print(f"\n{'='*64}\nCOMPARISON — raw measurements vs processed severities\n{'='*64}")
    comp = pd.DataFrame(results).set_index("model")
    cols = ["n_cards", "n_features", "log_loss", "exact%", "within1%",
            "acc_≤6%", "acc_7–8%", "acc_PSA 9%", "acc_PSA 10%"]
    print(comp[[c for c in cols if c in comp.columns]].T.to_string())

    # ── noisy-feature candidates (guide for ignore_lists.json) ───────────────
    print(f"\n{'='*64}\nCANDIDATES (grade-inverted / weak) — informational\n{'='*64}")
    candidates_report(df_raw, [c for c in df_raw.columns if c.startswith("mag.")], "raw magnitudes")
    candidates_report(df_proc, [c for c in df_proc.columns if c.startswith("cv.")
                                and not c.endswith((".max", ".sum", ".n_minor_plus", ".confidence"))],
                      "processed severities")
    print("\nEdit ignore_lists.json with the offenders above, then re-run "
          "train_compare.py (no re-extraction needed).")
