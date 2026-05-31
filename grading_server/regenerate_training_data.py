"""
regenerate_training_data.py  (Phase 2)
======================================
Rebuild the Stage-B training table by running the CURRENT pipeline
(YOLO -> warp -> palette centering -> claude-sonnet-4-5) over the labeled PSA
dataset, so the aggregator trains on:
  - the GEOMETRIC centering score we actually serve (not Claude's raw centering), and
  - the current model + prompt (the old df_psa_*.pkl predate both).

Walks   datasets/psa_graded/{8,9,10}/*   (grade_actual = folder name)
Writes  df_psa_geometric.pkl   with per-pillar scores + boxes + overall.

Then retrain:  python train_aggregator.py df_psa_geometric.pkl

⚠ COST: one Claude vision call per image (~186 total). Requires ANTHROPIC_API_KEY
and the YOLO weights. Run deliberately, not casually.

Usage:
  python regenerate_training_data.py [dataset_dir] [out.pkl]
"""

import sys
import os
import glob
import traceback

import cv2
import pandas as pd

from grader import detect_and_grade

DATASET_DIR = sys.argv[1] if len(sys.argv) > 1 else \
    os.path.join(os.path.dirname(__file__), "..", "datasets", "psa_graded")
OUT_PKL = sys.argv[2] if len(sys.argv) > 2 else "df_psa_geometric.pkl"

GRADES = ["8", "9", "10"]


def main():
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        print("ERROR: set ANTHROPIC_API_KEY"); sys.exit(1)

    rows = []
    for grade in GRADES:
        files = sorted(glob.glob(os.path.join(DATASET_DIR, grade, "*")))
        print(f"PSA {grade}: {len(files)} images")
        for path in files:
            img = cv2.imread(path)
            if img is None:
                continue
            row = {"image": os.path.basename(path), "grade_actual": int(grade), "error": ""}
            try:
                r = detect_and_grade(img, api_key=api_key)
                cen = r.get("centering", {}) or {}
                row.update({
                    "grade_predicted": r.get("overall_score"),
                    "psa_equivalent":  r.get("psa_equivalent"),
                    "centering_score": cen.get("score"),       # GEOMETRIC (served signal)
                    "corners_score":   (r.get("corners") or {}).get("score"),
                    "edges_score":     (r.get("edges")   or {}).get("score"),
                    "surface_score":   (r.get("surface") or {}).get("score"),
                    "left_right":      cen.get("left_right"),
                    "top_bottom":      cen.get("top_bottom"),
                    "content_region":  cen.get("content_region"),
                    "card_boundary":   r.get("_card_boundary"),
                    "border_type":     r.get("_border_type"),
                    "truncated":       r.get("_truncated", False),
                })
            except Exception as e:
                row["error"] = f"{type(e).__name__}: {e}"
                traceback.print_exc()
            rows.append(row)
            print(f"  {row['image']:30s} -> pred={row.get('grade_predicted')} "
                  f"cen={row.get('centering_score')} err={row['error'][:40]}")

    df = pd.DataFrame(rows)
    df.to_pickle(OUT_PKL)
    ok = df["error"].eq("").sum()
    print(f"\nWrote {OUT_PKL}: {len(df)} rows ({ok} clean). "
          f"Retrain with:  python train_aggregator.py {OUT_PKL}")


if __name__ == "__main__":
    main()
