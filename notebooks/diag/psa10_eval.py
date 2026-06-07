"""PSA10 = ground truth: every folder-10 card MUST pass front centering (PSA 10 tolerance =
60/40, i.e. worst-axis deviation <=10). So a 'fail' is a false negative. Confusion matrix:
OLD pass/fail (compute_centering_hybrid) x NEW pass/fail/abstain (CoherentFrame inner_frame)."""
import os, sys, glob; os.environ["CARD_DETECTOR"] = "seg"
sys.path.insert(0, "."); sys.path.insert(0, "../backend")
from dotenv import load_dotenv; load_dotenv("../.env.local", override=True); load_dotenv("../backend/.env", override=False)
import numpy as np, pandas as pd, warp_cache as WC, nonvlm_cv as N, inner_frame as IF

TOL = 10  # PSA10 front: 60/40 -> worst-axis deviation from 50 <= 10
def dev(cen): return max(abs(int(cen["left_right"].split("/")[0]) - 50),
                         abs(int(cen["top_bottom"].split("/")[0]) - 50))
paths = sorted(glob.glob("feature_extraction_dataset/10/scraped_*_front.jpeg"))
rows = []
for p in paths:
    try:
        det = WC.get_det(p)
        old = N.compute_centering_hybrid(det["warped"], det["cb"])
        new = IF.find_inner_frame(det["warped"], det["cb"])
    except Exception as e:
        rows.append({"path": p, "err": str(e)[:40]}); continue
    od, nd = dev(old), dev(new)
    old_state = "pass" if od <= TOL else "fail"
    new_state = "abstain" if not new["reliable"] else ("pass" if nd <= TOL else "fail")
    rows.append({"path": p, "old_lr": old["left_right"], "old_tb": old["top_bottom"],
                 "new_lr": new["left_right"], "new_tb": new["top_bottom"],
                 "old_dev": od, "new_dev": nd, "old": old_state, "new": new_state,
                 "reliable": new["reliable"]})
D = pd.DataFrame([r for r in rows if "err" not in r])
errs = [r for r in rows if "err" in r]
print(f"folder-10 cards evaluated: {len(D)}   (warp errors skipped: {len(errs)})   PSA10 tol = 60/40 (dev<=10)\n")

ct = pd.crosstab(D["old"], D["new"]).reindex(index=["pass","fail"], columns=["pass","fail","abstain"]).fillna(0).astype(int)
print("CONFUSION MATRIX   rows=OLD detector, cols=NEW CoherentFrame")
print(ct.to_string(), "\n")

old_fail = (D.old == "fail").sum(); new_fail = (D.new == "fail").sum()
fixed = D[(D.old == "fail") & (D.new == "pass")]
broken = D[(D.old == "pass") & (D.new == "fail")]
still_fail = D[(D.old == "fail") & (D.new == "fail")]
still_pass = D[(D.old == "pass") & (D.new == "pass")]
p2a = D[(D.old == "pass") & (D.new == "abstain")]
f2a = D[(D.old == "fail") & (D.new == "abstain")]
print(f"OLD false-negatives (failed a true PSA10): {old_fail}/{len(D)}  ({100*old_fail/len(D):.0f}%)")
print(f"NEW false-negatives (hard fail):           {new_fail}/{len(D)}  ({100*new_fail/len(D):.0f}%)")
print(f"NEW abstains (no claim -> no cap):          {(D.new=='abstain').sum()}/{len(D)}\n")
print(f"  FIXED      (old fail -> new pass):    {len(fixed)}")
print(f"  BROKEN     (old pass -> new FAIL):    {len(broken)}   <-- the harmful regressions")
print(f"  pass->abstain (old pass -> no claim): {len(p2a)}")
print(f"  fail->abstain (old fail -> no claim): {len(f2a)}")
print(f"  still failing (old fail -> new fail): {len(still_fail)}")
print(f"  still passing (old pass -> new pass): {len(still_pass)}")

def ex(df, n=6):
    return [f"notebooks/{r.path}  old={r.old_lr},{r.old_tb}  new={r.new_lr},{r.new_tb}  reli={r.reliable}"
            for _, r in df.sort_values("new_dev", ascending=False).head(n).iterrows()]
print("\n--- examples: BROKEN (passed before, now FAIL) ---")
for e in ex(broken, 12): print("  ", e)
print("\n--- examples: FIXED (failed before, now pass) ---")
for e in ex(fixed, 8): print("  ", e)
print("\n--- examples: STILL FAILING (fail->fail) ---")
for e in ex(still_fail, 8): print("  ", e)
print("\n--- examples: pass->abstain ---")
for e in ex(p2a, 6): print("  ", e)
D.to_csv("diag/psa10_centering_eval.csv", index=False)
print("\nsaved diag/psa10_centering_eval.csv")
