"""
remote_grade.py — GRADE_BACKEND=modal: run the WHOLE grade on the Modal GPU /fullgrade endpoint in ONE call
(SAM3 seg → warp → per-side centering → CV/XGBoost scores → RF-DETR detectors → the full grade dict), instead of
the local detect_and_grade which round-trips to Modal twice (/segment then /detect, bouncing the warp).

Returns the SAME shape detect_and_grade returns, so main.py's optional back-side merge, economics, and response
filtering are unchanged — only the source of the grade moves.

Env (Railway card-grader-api):
  GRADE_BACKEND     "modal" routes the grade here; anything else keeps local detect_and_grade (default).
  GRADE_REMOTE_URL  the Modal /fullgrade endpoint (e.g. https://srini--card-vision-vision-fullgrade.modal.run).
  GRADE_TIMEOUT     HTTP timeout seconds (default 120 — absorbs a Modal cold start).
"""
import os
import base64
import cv2
import requests

_URL = os.environ.get("GRADE_REMOTE_URL", "")
_TIMEOUT = float(os.environ.get("GRADE_TIMEOUT", "120"))


def full_grade(img_bgr, zoom: bool = False) -> dict:
    """POST the image to Modal /fullgrade → the complete grade dict. Raises ValueError on a 'no card' style miss
    (so main.py maps it to 422, same as the local path), RuntimeError on config/transport failure."""
    if _URL == "":
        raise RuntimeError("GRADE_REMOTE_URL not set (required for GRADE_BACKEND=modal)")
    ok, buf = cv2.imencode(".jpg", img_bgr)
    if not ok:
        raise RuntimeError("JPEG encode failed")
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    resp = requests.post(_URL, json={"image_b64": b64, "zoom": bool(zoom)}, timeout=_TIMEOUT)
    resp.raise_for_status()
    d = resp.json()
    # Modal returns {"error": "..."} for a decode failure / SAM3-found-no-card — surface it the same way the
    # local detect_and_grade would (ValueError → 422 in main.py) instead of returning a broken grade.
    if isinstance(d, dict) and "error" in d and len(d) == 1:
        raise ValueError(d["error"])
    return d
