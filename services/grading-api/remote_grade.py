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
# Modal /gradecontour — same grade on a caller-provided contour (manual 4-corner boundary), skipping SAM3.
# Defaults to the /fullgrade URL with the endpoint swapped; override with GRADE_CONTOUR_URL if needed.
_CONTOUR_URL = os.environ.get("GRADE_CONTOUR_URL", "") or (_URL.replace("fullgrade", "gradecontour") if _URL else "")
_TIMEOUT = float(os.environ.get("GRADE_TIMEOUT", "120"))


def full_grade(img_bgr, zoom: bool = False, raw_bytes: bytes | None = None) -> dict:
    """POST the image to Modal /fullgrade → the complete grade dict. Raises ValueError on a 'no card' style miss
    (so main.py maps it to 422, same as the local path), RuntimeError on config/transport failure.

    raw_bytes: the ORIGINAL uploaded file bytes. When provided they are forwarded UNTOUCHED — never decode +
    re-encode: the webp→JPEG transcode measurably shifts SAM3's mask (card_009: rect_check g 0.792 on original
    bytes vs 0.342 on the transcode; L/R moved a point). Same bug class as the extension's canvas re-encode
    (fixed 2026-06): the grader must score the USER'S image, not our transcode of it. The imencode path remains
    only as a fallback for callers that genuinely have no original bytes (e.g. an already-decoded array)."""
    if _URL == "":
        raise RuntimeError("GRADE_REMOTE_URL not set (required for GRADE_BACKEND=modal)")
    if raw_bytes is not None:
        b64 = base64.b64encode(raw_bytes).decode("ascii")
    else:
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


def grade_contour(img_bgr, contour, zoom: bool = False, raw_bytes: bytes | None = None) -> dict:
    """Grade a MANUAL boundary: POST the image + a caller-provided `contour` ([[x,y],...] in SOURCE pixels — e.g. the
    user's 4 corners) to Modal /gradecontour, which skips SAM3 and runs the exact same downstream grade. Same shape
    and error handling as full_grade. Used when the user overrides an inaccurate auto-segmentation."""
    if _CONTOUR_URL == "":
        raise RuntimeError("GRADE_CONTOUR_URL not set (required for the manual-contour grade path)")
    if raw_bytes is not None:
        b64 = base64.b64encode(raw_bytes).decode("ascii")
    else:
        ok, buf = cv2.imencode(".jpg", img_bgr)
        if not ok:
            raise RuntimeError("JPEG encode failed")
        b64 = base64.b64encode(buf.tobytes()).decode("ascii")
    resp = requests.post(_CONTOUR_URL, json={"image_b64": b64, "contour": contour, "zoom": bool(zoom)},
                         timeout=_TIMEOUT)
    resp.raise_for_status()
    d = resp.json()
    if isinstance(d, dict) and "error" in d and len(d) == 1:
        raise ValueError(d["error"])
    return d
