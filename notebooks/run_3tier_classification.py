"""
3-tier grade probability classification — standalone script.

Loads pre-computed features from feature_dataset.csv (679 cards, no image processing),
trains LightGBM + XGBoost 3-tier classifiers, and saves diagnostic plots to diag/.

Tiers:
  0 = Don't grade  (PSA ≤6)   — card value < grading fee
  1 = Consider     (PSA 7–8)  — depends on card scarcity
  2 = Grade it     (PSA 9–10) — slab premium justifies the fee

Run: cd notebooks && ../backend/venv/bin/python run_3tier_classification.py
"""
import os, sys, json, warnings
import numpy as np
import pandas as pd
import matplotlib; matplotlib.use("Agg")
import matplotlib.pyplot as plt
import seaborn as sns
from scipy.stats import pearsonr
from sklearn.preprocessing import LabelEncoder
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import log_loss, accuracy_score
from sklearn.feature_selection import mutual_info_classif
import lightgbm as lgb
import xgboost as xgb

warnings.filterwarnings("ignore", message="X does not have valid feature names")

sys.path.insert(0, ".")
import nonvlm_cv as N

BASE    = "feature_extraction_dataset"
OUT     = "diag"; os.makedirs(OUT, exist_ok=True)
SEED    = 7
sns.set_theme(style="whitegrid", context="notebook")

# ════════════════════════════════════════════════════════════════════════════
# 1. Load dataset
# ════════════════════════════════════════════════════════════════════════════
df = pd.read_csv(f"{BASE}/feature_dataset.csv")
df = df[df["error"].isna() | (df["error"].astype(str).str.strip() == "")].reset_index(drop=True)

meta = pd.read_csv(f"{BASE}/metadata.csv")[["filename","is_sir"]].rename(columns={"filename":"file"})
meta["is_sir"] = (meta["is_sir"].astype(str).str.strip().str.lower() == "yes")
df = df.merge(meta, on="file", how="left")
df["is_sir"] = df["is_sir"].fillna(False)

print(f"Dataset: {len(df)} cards")
print(f"Per grade: {df.groupby('actual_psa').size().to_dict()}")
print(f"SIR: {df['is_sir'].sum()}")

# ════════════════════════════════════════════════════════════════════════════
# 2. Feature selection (same logic as notebook §9a)
# ════════════════════════════════════════════════════════════════════════════
SEV_COLS  = [c for c in N.FEATURE_COLUMNS if not c.endswith(".confidence")]
CONF_COLS = [c for c in N.FEATURE_COLUMNS if c.endswith(".confidence")]
y_full    = df["actual_psa"].astype(float).values
y_fi_int  = (y_full - 5).astype(int)

Xf = df[SEV_COLS].apply(pd.to_numeric, errors="coerce").fillna(0).values
mi = mutual_info_classif(Xf, y_fi_int, random_state=SEED)
feat_rows = [{"feature": c, "variance": Xf[:,i].var(),
              "|r|": abs(pearsonr(Xf[:,i], y_full)[0]) if Xf[:,i].var()>0 else 0.0,
              "MI": mi[i]} for i, c in enumerate(SEV_COLS)]
fs = pd.DataFrame(feat_rows)

DROP = set(fs[fs.variance == 0]["feature"]) \
     | set(fs[(fs.variance < 0.005) & (fs.variance > 0)]["feature"]) \
     | set(fs[(fs["|r|"] < 0.015) & (fs.MI < 0.005)]["feature"])
CLEAN_SEV  = [c for c in SEV_COLS  if c not in DROP]
CLEAN_CONF = CONF_COLS
CEN        = ["cen.lr_deviation", "cen.tb_deviation"]
print(f"\nFeature selection: kept {len(CLEAN_SEV)} sev + {len(CLEAN_CONF)} conf + 2 cen "
      f"(dropped {len(DROP)} noisy severity features)")

# ════════════════════════════════════════════════════════════════════════════
# 3. 3-tier labels
# ════════════════════════════════════════════════════════════════════════════
TIER_MAP    = {5:0, 6:0, 7:1, 8:1, 9:2, 10:2}
TIER_LABELS = ["Don't grade  (≤6)", "Consider  (7–8)", "Grade it  (9–10)"]
TIER_SHORT  = ["≤6", "7–8", "9–10"]
TIER_COLORS = ["#e45756", "#f28e2b", "#54a24b"]
N_TIERS     = 3

y_int = np.array([TIER_MAP[g] for g in df["actual_psa"].astype(int)])
y_raw = df["actual_psa"].to_numpy(float)

print(f"\n3-tier distribution:")
for t, lbl in enumerate(TIER_LABELS):
    n = int((y_int == t).sum())
    print(f"  {lbl:28} {n:4d} cards  ({100*n/len(y_int):.0f}%)")

# ════════════════════════════════════════════════════════════════════════════
# 4. Feature matrices
# ════════════════════════════════════════════════════════════════════════════
def col(c):
    return pd.to_numeric(df[c], errors="coerce").fillna(0.0)

def build(feat_cols, conf_cols=None, extra_cols=None):
    parts = {c: col(c) for c in feat_cols}
    if conf_cols:
        parts.update({c: col(c) for c in conf_cols})
    if extra_cols:
        parts.update({c: col(c) for c in extra_cols})
    return pd.DataFrame(parts)

AGG = [f"{p}.{s}" for p in ("corners","edges","surface")
       for s in ("sum","max","n_minor_plus")]

feature_sets = [
    ("compact (9 agg+cen)",    build(AGG + CEN)),
    ("full-56+cen",            build(N.FEATURE_COLUMNS + CEN)),
    ("clean-sev+cen",          build(CLEAN_SEV + CEN)),
    ("clean-sev+conf+cen",     build(CLEAN_SEV + CLEAN_CONF + CEN)),
    ("clean+conf+cen+sir",     build(CLEAN_SEV + CLEAN_CONF + CEN,
                                     extra_cols=["is_sir"] if "is_sir" in df.columns else None)),
]

# ════════════════════════════════════════════════════════════════════════════
# 5. Models + evaluation
# ════════════════════════════════════════════════════════════════════════════
min_cls = int(pd.Series(y_int).value_counts().min())
n_folds = min(5, min_cls)
skf = StratifiedKFold(n_folds, shuffle=True, random_state=SEED)
print(f"\nCV: {n_folds}-fold (min per tier: {min_cls})")

def make_lgbm():
    return lgb.LGBMClassifier(
        objective="multiclass", num_class=N_TIERS,
        num_leaves=31, n_estimators=500, learning_rate=0.04,
        min_child_samples=5, subsample=0.8, colsample_bytree=0.8,
        class_weight="balanced", random_state=SEED, verbose=-1)

def make_xgb():
    return xgb.XGBClassifier(
        objective="multi:softprob", num_class=N_TIERS,
        n_estimators=500, learning_rate=0.04, max_depth=4,
        subsample=0.8, colsample_bytree=0.8,
        eval_metric="mlogloss", random_state=SEED, verbosity=0)

def eval_proba(X):
    out, proba_out = {}, {}
    for nm, clf in [("LightGBM", make_lgbm()), ("XGBoost", make_xgb())]:
        prob = cross_val_predict(clf, X, y_int, cv=skf, method="predict_proba")
        mode = prob.argmax(axis=1)
        out[nm] = {"log_loss":  round(log_loss(y_int, prob), 3),
                   "exact%":    round(100 * accuracy_score(y_int, mode), 1),
                   "within1%":  round(100 * np.mean(np.abs(mode - y_int) <= 1), 1)}
        proba_out[nm] = prob
    return out, proba_out

print(f"\n{'feature set':28} {'ncols':>5} {'model':10} {'log-loss':>9} {'exact%':>8} {'w/in-1%':>9}")
print("─" * 70)

rows, all_proba = [], {}
for feat_nm, X in feature_sets:
    met, proba = eval_proba(X)
    for nm, m in met.items():
        rows.append({"features": feat_nm, "ncols": X.shape[1], "model": nm, **m})
        all_proba[f"{feat_nm}|{nm}"] = {**m, "proba": proba[nm], "X": X}
        print(f"  {feat_nm:28} {X.shape[1]:5d} {nm:10} {m['log_loss']:9.3f} "
              f"{m['exact%']:7.1f}%  {m['within1%']:7.1f}%")

res_df = pd.DataFrame(rows).sort_values("log_loss").reset_index(drop=True)
print("\nSorted by log-loss:")
print(res_df.to_string(index=False))

BEST_KEY = f"{res_df.iloc[0]['features']}|{res_df.iloc[0]['model']}"
best     = all_proba[BEST_KEY]
proba    = best["proba"]
print(f"\nBest: {BEST_KEY}  (log-loss={best['log_loss']:.3f})")

# ════════════════════════════════════════════════════════════════════════════
# 6. Per-tier diagonal
# ════════════════════════════════════════════════════════════════════════════
print(f"\n{'True tier':28} {'n':>4}  {'P(correct)':>11}  {'mode'}")
print("─" * 58)
for t, lbl in enumerate(TIER_LABELS):
    mask  = y_int == t
    mp    = proba[mask].mean(axis=0)[t]
    mode_lbl = TIER_LABELS[proba[mask].mean(axis=0).argmax()]
    chk   = "✓" if proba[mask].mean(axis=0).argmax() == t else "✗"
    print(f"  {lbl:28} {mask.sum():4d}  {mp:11.3f}  {chk} {mode_lbl}")

# ════════════════════════════════════════════════════════════════════════════
# 7. PLOT 1 — Log-loss / exact% comparison
# ════════════════════════════════════════════════════════════════════════════
pivot_ll = res_df.pivot_table(index="features", columns="model", values="log_loss")
pivot_ex = res_df.pivot_table(index="features", columns="model", values="exact%")
order    = res_df.groupby("features")["log_loss"].min().sort_values().index.tolist()
x = np.arange(len(order)); w = 0.35

fig, axes = plt.subplots(1, 2, figsize=(14, 5))
for ax, pv, title, ylabel in [
    (axes[0], pivot_ll.reindex(order), "Log-loss  (↓ = better)", "log-loss"),
    (axes[1], pivot_ex.reindex(order), "Exact-tier accuracy  (↑ = better)", "exact %"),
]:
    ax.bar(x - w/2, pv.get("LightGBM", pd.Series(np.zeros(len(order)))).values,
           w, label="LightGBM", color="#4c78a8")
    ax.bar(x + w/2, pv.get("XGBoost",  pd.Series(np.zeros(len(order)))).values,
           w, label="XGBoost",  color="#f28e2b")
    ax.set_xticks(x); ax.set_xticklabels(order, rotation=28, ha="right", fontsize=9)
    ax.set_title(title); ax.set_ylabel(ylabel); ax.legend()
plt.suptitle("3-tier grade classification — feature-set comparison  (679 cards, 5-fold CV)",
             fontsize=12, y=1.02)
plt.tight_layout()
plt.savefig(f"{OUT}/grade_clf_comparison.png", dpi=110); plt.close()
print(f"saved grade_clf_comparison.png")

# ════════════════════════════════════════════════════════════════════════════
# 8. PLOT 2 — Aggregated mean probability per TRUE TIER
# ════════════════════════════════════════════════════════════════════════════
agg = {}
for t, lbl in enumerate(TIER_LABELS):
    mask = y_int == t
    P    = proba[mask]
    agg[t] = {"mean": P.mean(0), "std": P.std(0), "n": int(mask.sum()), "label": lbl}

fig, axes = plt.subplots(1, N_TIERS, figsize=(5 * N_TIERS, 5.5), sharey=True)
for ax, (t, stats) in zip(axes, sorted(agg.items())):
    mean_p = stats["mean"]; se = stats["std"] / np.sqrt(max(stats["n"], 1))
    bar_cols = [TIER_COLORS[j] if j == t else "#aec7e8" for j in range(N_TIERS)]
    ax.bar(range(N_TIERS), mean_p, color=bar_cols, edgecolor="white", lw=0.8, alpha=0.9)
    ax.errorbar(range(N_TIERS), mean_p, yerr=se, fmt="none", color="black", capsize=4, lw=1.3)
    ax.set_xticks(range(N_TIERS)); ax.set_xticklabels(TIER_SHORT, fontsize=12)
    ax.set_title(f"True: {stats['label']}\n(n={stats['n']})", fontsize=10)
    ax.set_ylim(0, 1.05)
    for j, (mp, se_j) in enumerate(zip(mean_p, se)):
        ax.text(j, mp + se_j + 0.02, f"{mp:.2f}", ha="center", fontsize=12, fontweight="bold")
    ax.axvline(float((np.arange(N_TIERS) * mean_p).sum()), color="black",
               lw=1.5, ls="--", alpha=0.4)
axes[0].set_ylabel("Mean P(tier)  ±  SE", fontsize=11)
plt.suptitle(
    f"Mean OOF probability per true tier  —  {BEST_KEY}  (n=679 cards)\n"
    "Coloured bar = true tier.  Ideal: coloured bar tallest in every subplot.",
    fontsize=11, y=1.03)
plt.tight_layout()
plt.savefig(f"{OUT}/grade_proba_distributions.png", dpi=110); plt.close()
print(f"saved grade_proba_distributions.png")

# ════════════════════════════════════════════════════════════════════════════
# 9. PLOT 3 — 3×3 probability confusion matrix
# ════════════════════════════════════════════════════════════════════════════
conf_mat = np.zeros((N_TIERS, N_TIERS))
for t in range(N_TIERS):
    mask = y_int == t
    if mask.sum() > 0:
        conf_mat[t] = proba[mask].mean(axis=0)

fig, ax = plt.subplots(figsize=(6, 5))
sns.heatmap(conf_mat, annot=True, fmt=".2f", cmap="Blues",
            xticklabels=TIER_SHORT, yticklabels=TIER_SHORT,
            ax=ax, annot_kws={"size": 14})
ax.set_xlabel("Predicted tier", fontsize=11)
ax.set_ylabel("True tier", fontsize=11)
ax.set_title(f"Mean probability confusion matrix  ({BEST_KEY})\n"
             f"Diagonal = P(correct tier).  Ideal = identity matrix.  n=679", fontsize=10)
plt.tight_layout()
plt.savefig(f"{OUT}/grade_proba_confusion.png", dpi=110); plt.close()
print(f"saved grade_proba_confusion.png")

# ════════════════════════════════════════════════════════════════════════════
# 10. PLOT 4 — P(true tier) per card scatter
# ════════════════════════════════════════════════════════════════════════════
mode_tier = proba.argmax(axis=1)
correct   = mode_tier == y_int
rng = np.random.default_rng(42)

fig, ax = plt.subplots(figsize=(8, 5))
for t, (lbl, col_) in enumerate(zip(TIER_LABELS, TIER_COLORS)):
    mask = y_int == t
    jit  = rng.uniform(-0.18, 0.18, mask.sum())
    ax.scatter(np.full(mask.sum(), t) + jit, proba[mask, t],
               c=np.where(correct[mask], col_, "#bbb"), s=18, alpha=0.55, linewidths=0,
               label=f"{lbl} (n={mask.sum()}, acc={100*(mode_tier[mask]==t).mean():.0f}%)")
ax.axhline(1/N_TIERS, color="gray", lw=1, ls=":", alpha=0.7, label="random baseline")
ax.set_xticks(range(N_TIERS)); ax.set_xticklabels(TIER_SHORT, fontsize=11)
ax.set_xlabel("True tier"); ax.set_ylabel("P(true tier)  from OOF model")
ax.set_title(f"P(correct tier) per card  —  {BEST_KEY}\n"
             "Coloured = correct prediction  |  grey = wrong  |  dotted = random (0.33)")
ax.legend(fontsize=9); ax.set_ylim(-0.03, 1.03)
plt.tight_layout()
plt.savefig(f"{OUT}/grade_expected_scatter.png", dpi=110); plt.close()
print(f"saved grade_expected_scatter.png")

# ════════════════════════════════════════════════════════════════════════════
# 11. PLOT 5 — Feature importance
# ════════════════════════════════════════════════════════════════════════════
clf_fi = make_lgbm()
clf_fi.fit(best["X"], y_int)
fi = (pd.Series(clf_fi.feature_importances_, index=best["X"].columns, name="gain")
      .sort_values(ascending=False).head(20))
fig, ax = plt.subplots(figsize=(8, 6))
fi.plot.barh(ax=ax, color="#4c78a8"); ax.invert_yaxis()
ax.set_title(f"LightGBM top-20 feature importance  ({BEST_KEY})")
ax.set_xlabel("gain importance")
plt.tight_layout()
plt.savefig(f"{OUT}/feature_importance.png", dpi=110); plt.close()
print(f"saved feature_importance.png")

print("\n=== Summary ===")
print(f"Best model: {BEST_KEY}")
print(f"  log-loss:  {best['log_loss']:.3f}")
print(f"  exact%:    {best['exact%']:.1f}%")
print(f"  within-1%: {best['within1%']:.1f}%")
print(f"All 5 plots saved to diag/")
