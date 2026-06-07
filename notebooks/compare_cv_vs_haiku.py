"""
compare_cv_vs_haiku.py  —  Fast CV vs Haiku 3-tier grading comparison.

Loads pre-computed feature CSVs (no images, no YOLO), runs:
  1. Discriminant analysis  — select most informative features from each source
  2. XGBoost model (CV)     — trained only on CV features
  3. XGBoost model (Haiku)  — trained only on Haiku features
  4. Head-to-head metrics   — log-loss, exact%, within-1%, per-tier accuracy
  5. Example cards          — P(tier) bar charts for both models side by side
  6. Feature importance     — which CV/Haiku features drive the predictions

Prerequisites:
  cv_features.csv must exist  →  run cv_features_extract.py first (one-time, ~5 min)
  feature_dataset.csv exists  →  already cached from the Haiku pipeline

Run: cd notebooks && ../backend/venv/bin/python compare_cv_vs_haiku.py
"""
import os, sys, warnings
import numpy as np
import pandas as pd
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns
from scipy.stats import pearsonr
from sklearn.discriminant_analysis import LinearDiscriminantAnalysis
from sklearn.feature_selection import mutual_info_classif, SelectKBest, f_classif
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import log_loss, accuracy_score, classification_report
from sklearn.preprocessing import LabelEncoder
import xgboost as xgb

warnings.filterwarnings("ignore")
sys.path.insert(0, ".")
import nonvlm_cv as N

BASE = "feature_extraction_dataset"
OUT  = "diag"; os.makedirs(OUT, exist_ok=True)
SEED = 7
sns.set_theme(style="whitegrid", context="notebook")

# ════════════════════════════════════════════════════════════════════════════
# 1. Load and align both feature datasets
# ════════════════════════════════════════════════════════════════════════════
print("=" * 65)
print("Loading feature datasets...")

cv_path  = f"{BASE}/cv_features.csv"
vlm_path = f"{BASE}/feature_dataset.csv"

if not os.path.exists(cv_path):
    print(f"\nERROR: {cv_path} not found.")
    print("Run cv_features_extract.py first to generate CV features.")
    sys.exit(1)

df_cv  = pd.read_csv(cv_path)
df_vlm = pd.read_csv(vlm_path)

# keep only error-free rows in both
df_cv  = df_cv[df_cv.get("error", pd.Series("")).isna() |
               (df_cv.get("error", pd.Series("")).astype(str).str.strip() == "")]
df_vlm = df_vlm[df_vlm["error"].isna() | (df_vlm["error"].astype(str).str.strip() == "")]

# align on (file, actual_psa) — inner join
# cv_features.csv already has is_sir; keep it from the left side
vlm_cols = ["file","actual_psa"] + N.FEATURE_COLUMNS + ["cen.lr_deviation","cen.tb_deviation"]
df = df_cv.merge(df_vlm[[c for c in vlm_cols if c in df_vlm.columns]],
                 on=["file","actual_psa"], how="inner", suffixes=("","_vlm"))

# is_sir already in df_cv (and therefore in df after the merge)
df["is_sir"] = df["is_sir"].fillna(False) if "is_sir" in df.columns else False

print(f"  CV cards:    {len(df_cv)}")
print(f"  Haiku cards: {len(df_vlm)}")
print(f"  Aligned:     {len(df)}  (inner join on file + grade)")
print(f"  SIR cards:   {df['is_sir'].sum()}")

# ════════════════════════════════════════════════════════════════════════════
# 2. 3-tier labels
# ════════════════════════════════════════════════════════════════════════════
TIER_MAP    = {5:0, 6:0, 7:1, 8:1, 9:2, 10:2}
TIER_LABELS = ["Don't grade  (≤6)", "Consider  (7–8)", "Grade it  (9–10)"]
TIER_SHORT  = ["≤6", "7–8", "9–10"]
TIER_COLORS = ["#e45756", "#f28e2b", "#54a24b"]
N_TIERS     = 3

y      = np.array([TIER_MAP[g] for g in df["actual_psa"].astype(int)])
y_raw  = df["actual_psa"].to_numpy(float)
CEN    = ["cen.lr_deviation", "cen.tb_deviation"]

print(f"\n3-tier distribution:")
for t, lbl in enumerate(TIER_LABELS):
    n = (y == t).sum()
    print(f"  {lbl:28} {n:4d} ({100*n/len(y):.0f}%)")

# ════════════════════════════════════════════════════════════════════════════
# 3. Discriminant analysis — feature selection
# ════════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 65)
print("Feature selection via mutual information...")

def top_features(X_df, y, k=15, label=""):
    """Select top-k features by mutual information score."""
    Xv = X_df.apply(pd.to_numeric, errors="coerce").fillna(0).values
    mi = mutual_info_classif(Xv, y, random_state=SEED)
    scores = pd.Series(mi, index=X_df.columns, name="MI").sort_values(ascending=False)
    # also compute pearson r with grade for interpretability
    r_scores = {}
    for c in X_df.columns:
        col = pd.to_numeric(X_df[c], errors="coerce").fillna(0).values
        r = abs(pearsonr(col, y_raw)[0]) if col.var() > 0 else 0.0
        r_scores[c] = r
    r_series = pd.Series(r_scores, name="|r|")
    summary = pd.concat([scores, r_series], axis=1).sort_values("MI", ascending=False)
    top_k   = scores.head(k).index.tolist()
    print(f"\n  Top-{k} {label} features:")
    for i, c in enumerate(top_k[:8], 1):
        print(f"    {i:2d}. {c:42}  MI={scores[c]:.4f}  |r|={r_scores[c]:.3f}")
    if k > 8: print(f"    ... (+{k-8} more)")
    return top_k, summary

# CV feature columns (cv.*) — severity + confidence + aggregates
cv_feat_cols  = [c for c in df.columns if c.startswith("cv.")]
# Haiku feature columns (direct, no prefix) — same 56 columns
vlm_feat_cols = [c for c in N.FEATURE_COLUMNS if c in df.columns]

top_cv_feats,  cv_summary  = top_features(df[cv_feat_cols],  y, k=15, label="CV")
top_vlm_feats, vlm_summary = top_features(df[vlm_feat_cols], y, k=15, label="Haiku")

# Save selection tables
cv_summary.to_csv(f"{OUT}/cv_feature_selection.csv")
vlm_summary.to_csv(f"{OUT}/haiku_feature_selection.csv")

# Final feature sets: top features + centering (always included)
X_cv    = df[top_cv_feats + CEN].apply(pd.to_numeric, errors="coerce").fillna(0)
X_haiku = df[top_vlm_feats + CEN].apply(pd.to_numeric, errors="coerce").fillna(0)

print(f"\n  CV feature matrix:    {X_cv.shape}")
print(f"  Haiku feature matrix: {X_haiku.shape}")

# ════════════════════════════════════════════════════════════════════════════
# 4. XGBoost models — 5-fold stratified CV
# ════════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 65)
min_cls = int(pd.Series(y).value_counts().min())
n_folds = min(5, min_cls)
skf = StratifiedKFold(n_folds, shuffle=True, random_state=SEED)
print(f"Training XGBoost models  ({n_folds}-fold CV, {len(df)} cards)...")

def train_xgb(X, y, name):
    clf = xgb.XGBClassifier(
        objective="multi:softprob", num_class=N_TIERS,
        n_estimators=500, learning_rate=0.05, max_depth=4,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=3,
        eval_metric="mlogloss", random_state=SEED, verbosity=0)

    proba = cross_val_predict(clf, X, y, cv=skf, method="predict_proba")
    mode  = proba.argmax(axis=1)

    # Per-tier accuracy
    per_tier = {}
    for t, lbl in enumerate(TIER_LABELS):
        mask = y == t
        per_tier[lbl] = round(100 * accuracy_score(y[mask], mode[mask]), 1)

    metrics = {
        "name":      name,
        "n_cards":   len(y),
        "n_features":X.shape[1],
        "log_loss":  round(log_loss(y, proba), 3),
        "exact%":    round(100 * accuracy_score(y, mode), 1),
        "within1%":  round(100 * np.mean(np.abs(mode - y) <= 1), 1),
        **{f"acc_{TIER_SHORT[t]}%": per_tier[lbl] for t, lbl in enumerate(TIER_LABELS)},
    }

    # Fit on full data for feature importance
    clf_full = xgb.XGBClassifier(
        objective="multi:softprob", num_class=N_TIERS,
        n_estimators=500, learning_rate=0.05, max_depth=4,
        subsample=0.8, colsample_bytree=0.8, min_child_weight=3,
        eval_metric="mlogloss", random_state=SEED, verbosity=0)
    clf_full.fit(X, y)
    fi = pd.Series(clf_full.feature_importances_, index=X.columns, name="gain")

    print(f"\n  {name}:")
    print(f"    log-loss={metrics['log_loss']:.3f}  exact={metrics['exact%']:.1f}%  "
          f"within-1={metrics['within1%']:.1f}%")
    for t, lbl in enumerate(TIER_LABELS):
        print(f"    P(≤6 correct)={per_tier[lbl]:.1f}%  ({TIER_SHORT[t]})" if t==0 else
              f"    P(7-8 correct)={per_tier[lbl]:.1f}%  ({TIER_SHORT[t]})" if t==1 else
              f"    P(9-10 correct)={per_tier[lbl]:.1f}%  ({TIER_SHORT[t]})")

    return metrics, proba, fi

cv_metrics,    cv_proba,    cv_fi    = train_xgb(X_cv,    y, "CV model")
haiku_metrics, haiku_proba, haiku_fi = train_xgb(X_haiku, y, "Haiku model")

# ════════════════════════════════════════════════════════════════════════════
# 5. Head-to-head comparison table
# ════════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 65)
print("Head-to-head comparison:")
print(f"\n{'Metric':28}  {'CV':>8}  {'Haiku':>8}  {'Winner':>8}")
print("─" * 60)
metrics_to_compare = [
    ("log_loss",     "↓ better"),
    ("exact%",       "↑ better"),
    ("within1%",     "↑ better"),
    (f"acc_{TIER_SHORT[0]}%", "↑ better"),
    (f"acc_{TIER_SHORT[1]}%", "↑ better"),
    (f"acc_{TIER_SHORT[2]}%", "↑ better"),
]
for key, direction in metrics_to_compare:
    cv_val    = cv_metrics.get(key, "—")
    haiku_val = haiku_metrics.get(key, "—")
    if isinstance(cv_val, float) and isinstance(haiku_val, float):
        if "↓" in direction:
            winner = "CV" if cv_val < haiku_val else "Haiku" if haiku_val < cv_val else "Tie"
        else:
            winner = "CV" if cv_val > haiku_val else "Haiku" if haiku_val > cv_val else "Tie"
        print(f"  {key:26}  {cv_val:8.3f}  {haiku_val:8.3f}  {winner:>8}")

# ════════════════════════════════════════════════════════════════════════════
# PLOT 1 — Aggregated probability distributions: CV vs Haiku side by side
# ════════════════════════════════════════════════════════════════════════════
fig, axes = plt.subplots(2, N_TIERS, figsize=(5 * N_TIERS, 9), sharey=False)
fig.suptitle("Mean OOF probability per true tier\n"
             "Top row: CV model  |  Bottom row: Haiku model\n"
             "Coloured bar = true tier. Ideal: coloured bar tallest in every subplot.",
             fontsize=11, y=1.01)

for row_idx, (proba, title) in enumerate([(cv_proba, "CV model"),
                                           (haiku_proba, "Haiku model")]):
    for t, (lbl, col_) in enumerate(zip(TIER_LABELS, TIER_COLORS)):
        ax = axes[row_idx, t]
        mask  = y == t
        P     = proba[mask]
        mean_p = P.mean(0)
        se     = P.std(0) / np.sqrt(max(mask.sum(), 1))
        bar_c  = [TIER_COLORS[j] if j == t else "#aec7e8" for j in range(N_TIERS)]
        ax.bar(range(N_TIERS), mean_p, color=bar_c, edgecolor="white", lw=0.8, alpha=0.9)
        ax.errorbar(range(N_TIERS), mean_p, yerr=se, fmt="none",
                    color="black", capsize=4, lw=1.3)
        ax.set_xticks(range(N_TIERS)); ax.set_xticklabels(TIER_SHORT, fontsize=11)
        acc_t = 100 * (proba[mask].argmax(1) == t).mean()
        ax.set_title(f"{title}\nTrue: {lbl}\n(n={mask.sum()}, acc={acc_t:.0f}%)", fontsize=9)
        ax.set_ylim(0, 1.05)
        for j, (mp, se_j) in enumerate(zip(mean_p, se)):
            ax.text(j, mp + se_j + 0.02, f"{mp:.2f}", ha="center",
                    fontsize=10, fontweight="bold")
        if t == 0:
            ax.set_ylabel("Mean P(tier) ± SE", fontsize=10)

plt.tight_layout()
plt.savefig(f"{OUT}/cv_vs_haiku_proba.png", dpi=110, bbox_inches="tight"); plt.close()
print(f"\nsaved cv_vs_haiku_proba.png")

# ════════════════════════════════════════════════════════════════════════════
# PLOT 2 — 3×3 confusion matrices side by side
# ════════════════════════════════════════════════════════════════════════════
fig, axes = plt.subplots(1, 2, figsize=(13, 5))
for ax, proba, title in [(axes[0], cv_proba, "CV model"),
                          (axes[1], haiku_proba, "Haiku model")]:
    conf = np.zeros((N_TIERS, N_TIERS))
    for t in range(N_TIERS):
        mask = y == t
        if mask.sum() > 0:
            conf[t] = proba[mask].mean(0)
    sns.heatmap(conf, annot=True, fmt=".2f", cmap="Blues",
                xticklabels=TIER_SHORT, yticklabels=TIER_SHORT,
                ax=ax, annot_kws={"size": 14}, vmin=0, vmax=1)
    exact = 100 * accuracy_score(y, proba.argmax(1))
    ax.set_title(f"{title}\nexact={exact:.1f}%   log-loss={log_loss(y,proba):.3f}", fontsize=11)
    ax.set_xlabel("Predicted tier"); ax.set_ylabel("True tier")
plt.suptitle("Mean probability confusion matrices  (diagonal = P(correct tier))", fontsize=12)
plt.tight_layout()
plt.savefig(f"{OUT}/cv_vs_haiku_confusion.png", dpi=110); plt.close()
print(f"saved cv_vs_haiku_confusion.png")

# ════════════════════════════════════════════════════════════════════════════
# PLOT 3 — Feature importance: CV vs Haiku
# ════════════════════════════════════════════════════════════════════════════
fig, axes = plt.subplots(1, 2, figsize=(16, 7))
for ax, fi, title, color in [
    (axes[0], cv_fi.sort_values(ascending=False).head(15), "CV features", "#4c78a8"),
    (axes[1], haiku_fi.sort_values(ascending=False).head(15), "Haiku features", "#54a24b"),
]:
    fi.plot.barh(ax=ax, color=color); ax.invert_yaxis()
    ax.set_title(f"XGBoost feature importance — {title}"); ax.set_xlabel("gain")
plt.suptitle("Which features drive 3-tier grade prediction?", fontsize=12)
plt.tight_layout()
plt.savefig(f"{OUT}/cv_vs_haiku_importance.png", dpi=110); plt.close()
print(f"saved cv_vs_haiku_importance.png")

# ════════════════════════════════════════════════════════════════════════════
# PLOT 4 — Example cards: P(tier) bars from both models
# ════════════════════════════════════════════════════════════════════════════
# Pick 1 representative (non-SIR) card per tier
ex_idx = {}
for t in range(N_TIERS):
    mask = (y == t) & (~df["is_sir"].values)
    idxs = np.where(mask)[0]
    if len(idxs):
        ex_idx[t] = int(idxs[0])

fig, axes = plt.subplots(N_TIERS, 2, figsize=(10, 4 * N_TIERS))
for t, (lbl, col_) in enumerate(zip(TIER_LABELS, TIER_COLORS)):
    if t not in ex_idx:
        continue
    idx   = ex_idx[t]
    fname = df.iloc[idx]["file"]
    true_g = int(df.iloc[idx]["actual_psa"])
    for col_idx, (proba, model_name) in enumerate([(cv_proba, "CV model"),
                                                    (haiku_proba, "Haiku model")]):
        ax = axes[t, col_idx]
        p  = proba[idx]
        bar_c = [TIER_COLORS[j] if j == t else "#aec7e8" for j in range(N_TIERS)]
        ax.bar(range(N_TIERS), p, color=bar_c, edgecolor="white", lw=0.8)
        ax.set_xticks(range(N_TIERS)); ax.set_xticklabels(TIER_SHORT, fontsize=11)
        ax.set_ylim(0, 1.05)
        ax.set_title(f"{model_name}\nTrue: {lbl}  (PSA {true_g})  |  {fname[:22]}", fontsize=9)
        for j, prob in enumerate(p):
            ax.text(j, prob + 0.02, f"{prob:.2f}", ha="center", fontsize=10, fontweight="bold")
        ax.set_ylabel("P(tier)")
plt.suptitle("Example card predictions — CV (left) vs Haiku (right)\n"
             "Coloured bar = true tier", fontsize=11, y=1.01)
plt.tight_layout()
plt.savefig(f"{OUT}/cv_vs_haiku_examples.png", dpi=110, bbox_inches="tight"); plt.close()
print(f"saved cv_vs_haiku_examples.png")

# ════════════════════════════════════════════════════════════════════════════
# PLOT 5 — LDA discriminability: visualize class separation in 2D
# ════════════════════════════════════════════════════════════════════════════
fig, axes = plt.subplots(1, 2, figsize=(14, 5))
for ax, X, proba, title, color in [
    (axes[0], X_cv,    cv_proba,    "CV features",    "#4c78a8"),
    (axes[1], X_haiku, haiku_proba, "Haiku features", "#54a24b"),
]:
    lda = LinearDiscriminantAnalysis(n_components=2)
    try:
        Z = lda.fit_transform(X.values, y)
        for t, (lbl, col_) in enumerate(zip(TIER_LABELS, TIER_COLORS)):
            mask = y == t
            ax.scatter(Z[mask, 0], Z[mask, 1], c=col_, s=15, alpha=0.5,
                       label=f"{TIER_SHORT[t]} (n={mask.sum()})")
        ax.set_title(f"LDA projection — {title}\n"
                     f"exact={100*accuracy_score(y,proba.argmax(1)):.1f}%  "
                     f"log-loss={log_loss(y,proba):.3f}")
        ax.set_xlabel("LDA 1"); ax.set_ylabel("LDA 2")
        ax.legend(fontsize=9)
    except Exception as e:
        ax.text(0.5, 0.5, f"LDA failed: {e}", ha="center", transform=ax.transAxes)
plt.suptitle("Linear discriminant projection — how well do features separate tiers?",
             fontsize=12)
plt.tight_layout()
plt.savefig(f"{OUT}/cv_vs_haiku_lda.png", dpi=110); plt.close()
print(f"saved cv_vs_haiku_lda.png")

# ════════════════════════════════════════════════════════════════════════════
# Final summary
# ════════════════════════════════════════════════════════════════════════════
print("\n" + "=" * 65)
print("FINAL SUMMARY")
print("=" * 65)
print(f"\n{'':30}  {'CV model':>12}  {'Haiku model':>12}")
print("─" * 58)
for key, label in [("log_loss","Log-loss (↓)"), ("exact%","Exact tier % (↑)"),
                   ("within1%","Within-1 tier % (↑)")]:
    cv_v = cv_metrics[key]; h_v = haiku_metrics[key]
    print(f"  {label:30}  {cv_v:>12}  {h_v:>12}")
print(f"\n  {'Per-tier accuracy:':30}")
for t, short in enumerate(TIER_SHORT):
    key = f"acc_{short}%"
    cv_v = cv_metrics.get(key,"—"); h_v = haiku_metrics.get(key,"—")
    print(f"    {TIER_LABELS[t]:30}  {cv_v:>10}%  {h_v:>10}%")

print(f"\nOutputs saved to {OUT}/:")
for f in ["cv_vs_haiku_proba.png","cv_vs_haiku_confusion.png","cv_vs_haiku_importance.png",
          "cv_vs_haiku_examples.png","cv_vs_haiku_lda.png",
          "cv_feature_selection.csv","haiku_feature_selection.csv"]:
    sz = os.path.getsize(f"{OUT}/{f}") if os.path.exists(f"{OUT}/{f}") else 0
    print(f"  {'OK' if sz else 'MISS'} {f}  ({sz//1024}KB)")
