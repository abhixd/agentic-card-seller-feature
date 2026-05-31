"""
feedback_to_yolo.py
===================
Convert collected boundary corrections (feedback/adjustments.jsonl) into YOLO OBB
training samples, so corrected card detections improve the next YOLO run.

For each correction:
  - The user's corrected OUTER box is in WARPED space (630x880, normalized 0..1).
  - warp.quad_padded (TL,TR,BR,BL in original-image px) + warp.orig_dims define the
    perspective transform used to make the warp.
  - We invert that transform to map the 4 corrected corners back to the ORIGINAL
    image, giving an oriented quad → one YOLO OBB label (class 0).
  - The original image is downloaded from listing_url and saved next to its label.

Output (Ultralytics OBB layout):
  feedback/yolo_dataset/images/<id>.jpg
  feedback/yolo_dataset/labels/<id>.txt   ->  "0 x1 y1 x2 y2 x3 y3 x4 y4" (normalized)

Usage:
  python feedback_to_yolo.py [feedback_dir] [out_dir]
"""

import sys
import json
from pathlib import Path

import cv2
import numpy as np
import requests

OUT_W, OUT_H = 630, 880  # warped canvas used by grader._warp_card

FEEDBACK_DIR = Path(sys.argv[1]) if len(sys.argv) > 1 else Path(__file__).parent / "feedback"
OUT_DIR      = Path(sys.argv[2]) if len(sys.argv) > 2 else FEEDBACK_DIR / "yolo_dataset"


def warped_box_to_original_quad(card_boundary, quad_padded):
    """
    card_boundary: {x1,y1,x2,y2} normalized (0..1) in warped space.
    quad_padded:   4x2 (TL,TR,BR,BL) in original-image px (the warp source quad).
    Returns 4x2 quad in original-image px (TL,TR,BR,BL).
    """
    src = np.asarray(quad_padded, dtype=np.float32).reshape(4, 2)
    dst = np.array([[0, 0], [OUT_W, 0], [OUT_W, OUT_H], [0, OUT_H]], dtype=np.float32)
    M = cv2.getPerspectiveTransform(src, dst)
    M_inv = np.linalg.inv(M)

    x1, y1 = card_boundary["x1"] * OUT_W, card_boundary["y1"] * OUT_H
    x2, y2 = card_boundary["x2"] * OUT_W, card_boundary["y2"] * OUT_H
    warped_corners = np.array([[[x1, y1], [x2, y1], [x2, y2], [x1, y2]]], dtype=np.float32)
    return cv2.perspectiveTransform(warped_corners, M_inv).reshape(4, 2)


def main():
    jsonl = FEEDBACK_DIR / "adjustments.jsonl"
    if not jsonl.exists():
        print(f"No feedback file at {jsonl}")
        return

    (OUT_DIR / "images").mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "labels").mkdir(parents=True, exist_ok=True)

    written = skipped = 0
    for line in jsonl.read_text().splitlines():
        if not line.strip():
            continue
        rec = json.loads(line)
        rid = rec.get("id", "unknown")
        warp = rec.get("warp") or {}
        cb   = (rec.get("corrected") or {}).get("card_boundary_box") \
               or _boundary_as_box(rec)
        quad_padded = warp.get("quad_padded")
        orig_dims   = warp.get("orig_dims")
        # The graded image (front), NOT the listing page URL.
        url         = rec.get("image_url") or rec.get("listing_url")

        if not (cb and quad_padded and orig_dims and url):
            skipped += 1; continue

        try:
            quad = warped_box_to_original_quad(cb, quad_padded)
            W, H = orig_dims
            norm = quad.copy()
            norm[:, 0] /= W
            norm[:, 1] /= H
            norm = np.clip(norm, 0.0, 1.0)

            img_bytes = requests.get(url, timeout=15).content
            arr = np.frombuffer(img_bytes, np.uint8)
            img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
            if img is None:
                skipped += 1; continue
            # If the downloaded image differs in size from what was graded, rescale label coords stay normalized → fine.
            cv2.imwrite(str(OUT_DIR / "images" / f"{rid}.jpg"), img)

            coords = " ".join(f"{v:.6f}" for v in norm.reshape(-1))
            (OUT_DIR / "labels" / f"{rid}.txt").write_text(f"0 {coords}\n")
            written += 1
        except Exception as e:
            print(f"  [{rid}] skipped: {e}")
            skipped += 1

    print(f"Done: {written} labels written, {skipped} skipped → {OUT_DIR}")


def _boundary_as_box(rec):
    """corrected.card_boundary is stored as [x1,y1,x2,y2]; normalize to a dict."""
    arr = (rec.get("corrected") or {}).get("card_boundary")
    if isinstance(arr, list) and len(arr) == 4:
        return {"x1": arr[0], "y1": arr[1], "x2": arr[2], "y2": arr[3]}
    return None


if __name__ == "__main__":
    main()
