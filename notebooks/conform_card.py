"""
conform_card.py — CONFORM-CARD: the honest, ship-now product layer.

Stop pretending we can nail an exact grade no human grader hits. Instead turn the
current model into:
  (1) a POINT estimate (argmax tier),
  (2) a CONFORMAL prediction SET with a coverage guarantee (APS) → an ordinal BAND
      ("PSA 8-10, likely 9"),
  (3) SELECTIVE prediction: a confident-flag on the easy cards (high accuracy on the
      subset we choose to answer), the rest get a band / "submit to confirm".

Runs on existing cv_raw.csv (no torch → no xgboost OMP clash). Demonstrates the product
behavior on the 679 cards with honest out-of-fold numbers.

Run: cd notebooks && ../backend/venv/bin/python conform_card.py
"""
import numpy as np, pandas as pd, xgboost as xgb
from numpy.random import RandomState
from sklearn.model_selection import StratifiedKFold, cross_val_predict
from sklearn.metrics import accuracy_score

TIER = {5: 0, 6: 0, 7: 1, 8: 1, 9: 2, 10: 3}
SHORT = ["≤6", "7-8", "PSA9", "PSA10"]
df = pd.read_csv("feature_extraction_dataset/cv_raw.csv")
df = df[df.actual_psa.isin(TIER)].reset_index(drop=True)
cols = [c for c in df.columns if c.startswith(("m.", "mag.", "conf.", "cen."))]
X = df[cols].apply(pd.to_numeric, errors="coerce").fillna(0).values
y = np.array([TIER[int(g)] for g in df.actual_psa])
P = dict(objective="multi:softprob", num_class=4, n_estimators=500, learning_rate=0.05, max_depth=4,
         subsample=0.8, colsample_bytree=0.8, min_child_weight=3, random_state=7, verbosity=0)
# honest out-of-fold probabilities
proba = cross_val_predict(xgb.XGBClassifier(**P), X, y,
                          cv=StratifiedKFold(5, shuffle=True, random_state=7), method="predict_proba")
am = proba.argmax(1)
print(f"POINT estimate:  EXACT={100*accuracy_score(y, am):.1f}%   within-1={100*np.mean(np.abs(am-y)<=1):.1f}%\n")

# ── (2) APS split-conformal prediction sets, averaged over 30 cal/test splits ──
def aps(p_cal, y_cal, p_test, alpha):
    def score(p, yt):
        order = np.argsort(-p); cum = 0.0
        for c in order:
            cum += p[c]
            if c == yt:
                return cum
        return cum
    s = np.array([score(p_cal[i], y_cal[i]) for i in range(len(y_cal))])
    qhat = np.quantile(s, min(1.0, np.ceil((len(s)+1)*(1-alpha))/len(s)))
    sets = []
    for p in p_test:
        order = np.argsort(-p); cum = 0.0; st = []
        for c in order:
            st.append(int(c)); cum += p[c]
            if cum >= qhat:
                break
        sets.append(sorted(st))
    return sets

print("CONFORMAL prediction sets (APS, ordinal band) — honest coverage guarantee:")
print(f"  {'target':8s} {'coverage':9s} {'mean band':10s} {'band≤2 tiers':12s} {'confident(1 tier)':18s} {'…@ correct'}")
for alpha, tgt in [(0.1, "90%"), (0.2, "80%")]:
    cov, sz, le2, sf, sa = [], [], [], [], []
    for r in range(30):
        idx = RandomState(r).permutation(len(y)); h = len(y) // 2; cal, te = idx[:h], idx[h:]
        sets = aps(proba[cal], y[cal], proba[te], alpha)
        cov.append(np.mean([y[te][i] in sets[i] for i in range(len(te))]))
        sz.append(np.mean([len(s) for s in sets]))
        le2.append(np.mean([(max(s)-min(s)+1) <= 2 for s in sets]))   # contiguous ordinal width ≤2
        sing = [i for i in range(len(te)) if len(sets[i]) == 1]
        sf.append(len(sing)/len(te))
        sa.append(np.mean([y[te][i] in sets[i] for i in sing]) if sing else np.nan)
    print(f"  {tgt:8s} {np.mean(cov)*100:7.1f}%  {np.mean(sz):8.2f}  {np.mean(le2)*100:9.0f}%  "
          f"{np.mean(sf)*100:13.0f}%  {np.nanmean(sa)*100:9.0f}%")

# ── (3) Selective prediction: confident-flag the easy cards (risk–coverage) ──
print("\nSELECTIVE prediction (confident-flag by max prob) — answer only the easy ones:")
conf = proba.max(1); order = np.argsort(-conf)
print(f"  {'answer top':12s} {'exact-acc':10s} {'within-1':9s} {'min prob':9s}")
for frac in [0.2, 0.4, 0.6, 0.8, 1.0]:
    k = int(frac*len(y)); sel = order[:k]
    print(f"  {int(frac*100):>9d}%  {100*accuracy_score(y[sel], am[sel]):8.1f}%  "
          f"{100*np.mean(np.abs(am[sel]-y[sel])<=1):7.1f}%  {conf[sel].min():7.2f}")

# ── product-style per-card output (a few examples) ──
def band_str(p, alpha=0.1):
    order = np.argsort(-p); cum = 0.0; st = []
    qh = 1 - alpha
    for c in order:
        st.append(int(c)); cum += p[c]
        if cum >= qh:
            break
    lo, hi = min(st), max(st)
    return f"{SHORT[lo]}–{SHORT[hi]}" if lo != hi else SHORT[lo]
print("\nexample product outputs (point · 90% band · confidence):")
for i in [0, 100, 300, 500, 678]:
    flag = "✅ confident" if conf[i] > 0.6 else ("⚠️ submit to confirm" if conf[i] < 0.45 else "~ likely")
    print(f"  {df.file.iloc[i][:22]:22s} true PSA{int(df.actual_psa.iloc[i])}  → {SHORT[am[i]]:5s} · band {band_str(proba[i]):12s} · {conf[i]:.0%} {flag}")
