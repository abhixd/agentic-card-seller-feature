"""
apply_thresholds.py — STEP 2 of the CV pipeline: raw measurements → processed severities.

Reads cv_raw.csv (the expensive one-time extraction) and applies CV_THRESHOLDS to the
persisted magnitudes to produce the canonical 56-col processed severity features.
NO image processing — so retuning thresholds is instant and needs no re-extraction.

  extract (cv_features_extract.py) → THIS → train_compare.py

Run:  cd notebooks && ../backend/venv/bin/python apply_thresholds.py
Input:  feature_extraction_dataset/cv_raw.csv
Output: feature_extraction_dataset/cv_features_processed.csv
  Columns: file, actual_psa, path, is_sir, detector, seg_conf,
           cen.lr_deviation, cen.tb_deviation, cv.<feature> × 56
"""
import sys
from pathlib import Path
import numpy as np, pandas as pd

sys.path.insert(0, "."); sys.path.insert(0, "../backend")
import nonvlm_cv as N

BASE = Path("feature_extraction_dataset")
RAW  = BASE / "cv_raw.csv"
OUT  = BASE / "cv_features_processed.csv"


def build_processed(raw_csv=RAW, out_csv=OUT, thresholds=None):
    thr = thresholds or N.CV_THRESHOLDS
    df = pd.read_csv(raw_csv)
    if "error" in df.columns:
        df = df[df["error"].isna() | (df["error"].astype(str).str.strip() == "")]
    df = df.reset_index(drop=True)

    meta_cols = [c for c in ("file", "actual_psa", "path", "is_sir", "detector", "seg_conf",
                             "cen.lr_deviation", "cen.tb_deviation") if c in df.columns]
    rows = []
    for _, r in df.iterrows():
        pv = N.processed_vector_from_raw(r, thr)        # 56-col severity vector
        row = {c: r[c] for c in meta_cols}
        row.update({f"cv.{k}": v for k, v in pv.items()})
        rows.append(row)

    out = pd.DataFrame(rows)
    ordered = meta_cols + [f"cv.{c}" for c in N.FEATURE_COLUMNS]
    out = out[[c for c in ordered if c in out.columns]]
    if out_csv is not None:
        out.to_csv(out_csv, index=False)
    return out


if __name__ == "__main__":
    out = build_processed()
    print(f"Saved: {OUT}")
    print(f"  rows: {len(out)}  cv.* cols: {sum(1 for c in out.columns if c.startswith('cv.'))}")
    # quick grade-ordering sanity (processed maxima should DROP with grade)
    print("\n  processed pillar.max by grade (should generally fall as grade rises):")
    print(f"  {'PSA':>4} {'N':>4} | {'cor.max':>7} {'edg.max':>7} {'srf.max':>7}")
    for g, grp in out.groupby("actual_psa"):
        print(f"  {int(g):>4} {len(grp):>4} | {grp['cv.corners.max'].mean():>7.2f} "
              f"{grp['cv.edges.max'].mean():>7.2f} {grp['cv.surface.max'].mean():>7.2f}")
    print("\nNext: ../backend/venv/bin/python train_compare.py")
