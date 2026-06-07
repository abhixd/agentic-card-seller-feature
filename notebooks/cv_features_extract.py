"""
cv_features_extract.py  —  ONE-TIME CV RAW-measurement extraction (checkpoint/resume).

Reads every card path from feature_dataset.csv, runs the classical-CV pipeline
(seg Model C card detect → full-res warp → corner/edge/surface), and persists the
RAW MEASUREMENTS (+ pre-threshold magnitudes + confidences) — NOT thresholded
severities. This is the expensive step; run it once.

  Pipeline:  extract (this) → apply_thresholds.py → train_compare.py
  Retuning thresholds needs only apply_thresholds.py — NO re-extraction.

Run once:   cd notebooks && ../backend/venv/bin/python cv_features_extract.py
Resume:     just re-run — already-processed cards are skipped automatically.

Output: feature_extraction_dataset/cv_raw.csv
  Columns: file, actual_psa, path, is_sir, detector, seg_conf,
           cen.lr_deviation, cen.tb_deviation,
           m.<...>   (125 raw measurements)
           mag.<...> (38 pre-threshold magnitudes → to_sev = processed severities)
           conf.<...>(9 detector confidences)
"""
import os, sys, json, csv as _csv
import numpy as np
import pandas as pd

os.environ["CARD_DETECTOR"] = "seg"   # Roboflow Model C — production card detection
os.environ.setdefault("YOLO_WEIGHTS", "../backend/models/yolo_obb_best.pt")
sys.path.insert(0, "../backend"); sys.path.insert(0, ".")
from dotenv import load_dotenv
load_dotenv("../.env.local", override=True); load_dotenv("../backend/.env", override=False)

import cv2
import nonvlm_cv as N          # CV detectors
import warp_cache as WC        # cached Roboflow-seg warps (no repeat API calls)
import grader; import importlib; importlib.reload(grader)  # YOLO warp

BASE  = "feature_extraction_dataset"
OUT   = f"{BASE}/cv_raw.csv"
CKPT  = f"{BASE}/cv_raw_progress.jsonl"   # one JSON line per card

# ── Load Haiku CSV for the card list + metadata ───────────────────────────
df_haiku = pd.read_csv(f"{BASE}/feature_dataset.csv")
df_haiku = df_haiku[
    df_haiku["error"].isna() | (df_haiku["error"].astype(str).str.strip() == "")
].reset_index(drop=True)

meta = pd.read_csv(f"{BASE}/metadata.csv")[["filename","actual_psa","is_sir"]]
meta = meta.rename(columns={"filename": "file"})
meta["is_sir"] = (meta["is_sir"].astype(str).str.strip().str.lower() == "yes")
# merge on BOTH file AND actual_psa — same filename exists in every grade folder
df_haiku = df_haiku.merge(meta.drop_duplicates(["file","actual_psa"]),
                           on=["file","actual_psa"], how="left")
df_haiku["is_sir"] = df_haiku["is_sir"].fillna(False)

total = len(df_haiku)
print(f"Cards to process: {total}  (from feature_dataset.csv)")

# ── Load checkpoint ───────────────────────────────────────────────────────
done = {}
if os.path.exists(CKPT):
    with open(CKPT) as f:
        for line in f:
            line = line.strip()
            if line:
                try:
                    row = json.loads(line)
                    done[row["path"]] = row
                except json.JSONDecodeError:
                    pass
    print(f"Checkpoint: {len(done)} cards already done — skipping them.")

todo = [r for _, r in df_haiku.iterrows() if r["path"] not in done]
print(f"Remaining: {len(todo)} cards\n")

if not todo:
    print("All cards already processed. Building CSV from checkpoint...")
else:
    ckpt_handle = open(CKPT, "a")
    consecutive_errors = 0
    MAX_ERRORS = 5

    for i, r in enumerate(todo, 1):
        path = r["path"]
        fname = r["file"]
        grade = int(r["actual_psa"])

        row = {"file": fname, "actual_psa": grade, "path": path,
               "is_sir": bool(r["is_sir"])}

        pct = int(100 * i / len(todo))
        print(f"  [{grade}] ({i}/{len(todo)}, {pct}%) {fname} ...", end=" ", flush=True)

        try:
            # seg = production Model C (detects CARD inside slab); full-res warp.
            # CACHED: the expensive Roboflow-seg warp is reused across re-extractions
            # so iterating on the CV feature logic costs no API calls (see warp_cache.py).
            det = WC.get_det(path, out_size=N.CV_WARP_SIZE)
            row["detector"]  = det.get("detector", "yolo")
            row["seg_conf"]  = round(float(det.get("seg_conf", 0)), 3)

            # Hybrid centering (deterministic)
            cen = N.compute_centering_hybrid(det["warped"], det["cb"])
            cr  = cen["content_region"]
            lr  = int(cen["left_right"].split("/")[0])
            tb  = int(cen["top_bottom"].split("/")[0])
            row["cen.lr_deviation"] = float(abs(lr - 50))
            row["cen.tb_deviation"] = float(abs(tb - 50))

            # CV extraction → persist RAW measurements (m.*) + magnitudes (mag.*)
            # + confidences (conf.*). Processed severities are derived later by
            # apply_thresholds.py, so thresholds can be retuned without re-extracting.
            cv_cond, cv_raw = N.cv_extract_conditions(det, cr=cr)
            rawvec = N.raw_to_vector(cv_cond, cv_raw)
            row.update(rawvec)

            # Quick summary: derive processed maxima on the fly (cheap)
            pv = N.processed_vector_from_raw(rawvec)
            print(f"ok  det={row['detector']}  conf={row['seg_conf']:.2f}  "
                  f"cor={pv['corners.max']:.0f} edg={pv['edges.max']:.0f} "
                  f"srf={pv['surface.max']:.0f}  "
                  f"cen={row['cen.lr_deviation']:.0f}/{row['cen.tb_deviation']:.0f}")

            consecutive_errors = 0

        except Exception as exc:
            row["error"] = f"{type(exc).__name__}: {str(exc)[:120]}"
            print(f"ERROR: {row['error']}")
            consecutive_errors += 1
            if consecutive_errors >= MAX_ERRORS:
                print(f"\n⚠  {consecutive_errors} consecutive errors — stopping.")
                print("  Fix the issue and re-run; checkpoint will resume from here.")
                done[path] = row
                ckpt_handle.write(json.dumps(row, default=str) + "\n")
                ckpt_handle.flush()
                ckpt_handle.close()
                break

        done[path] = row
        if "error" not in row:
            ckpt_handle.write(json.dumps(row, default=str) + "\n")
            ckpt_handle.flush()

    ckpt_handle.close()

# ── Build final CSV from checkpoint ──────────────────────────────────────
rows = list(done.values())
errors = sum(1 for r in rows if "error" in r)
print(f"\nDone: {len(rows)} cards  ({errors} errors)")

df_cv = pd.DataFrame(rows)

# Column order: metadata, centering, then raw families m.* / mag.* / conf.*, error
meta_cols = ["file", "actual_psa", "path", "is_sir", "detector", "seg_conf"]
cen_cols  = ["cen.lr_deviation", "cen.tb_deviation"]
m_cols    = sorted(c for c in df_cv.columns if c.startswith("m."))
mag_cols  = sorted(c for c in df_cv.columns if c.startswith("mag."))
conf_cols = sorted(c for c in df_cv.columns if c.startswith("conf."))
ordered   = meta_cols + [c for c in cen_cols if c in df_cv.columns] \
          + m_cols + mag_cols + conf_cols \
          + (["error"] if "error" in df_cv.columns else [])
df_cv = df_cv[[c for c in ordered if c in df_cv.columns]]

df_cv.to_csv(OUT, index=False)
print(f"Saved: {OUT}")
print(f"  rows: {len(df_cv)}  cols: {len(df_cv.columns)}")
print(f"  m.*={len(m_cols)}  mag.*={len(mag_cols)}  conf.*={len(conf_cols)}")
print(f"  error-free: {sum(1 for r in rows if 'error' not in r)}")
print(f"\nNext: ../backend/venv/bin/python apply_thresholds.py   # raw → processed severities")
