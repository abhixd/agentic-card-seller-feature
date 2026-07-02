"""
remote_detect.py — offload RF-DETR defect detection to the Modal GPU endpoint (DETECT_BACKEND=modal).

Railway's card CPU makes the two RF-DETR passes slow; the Modal L4 container already loads the same scratch +
edge/corner models, so we ship it the 630x880 masked warp we already computed and get {surface, edges, corners}
back — the SAME shape scratch_detect + ec_detect produce locally (so cv_grader / the contract are unchanged).

Non-fatal by construction: any error (endpoint down, cold-start timeout, no URL) returns the all-empty dict so
grading is NEVER blocked — the grade (scores/centering) does not depend on these boxes.

Env (Railway card-grader-api):
  DETECT_BACKEND     "modal" routes here; anything else keeps the local scratch_detect+ec_detect path (default)
  DETECT_REMOTE_URL  the Modal /detect endpoint (e.g. https://srini--card-vision-vision-detect.modal.run)
  DETECT_TIMEOUT     HTTP timeout seconds (default 120 — absorbs a Modal cold start)
"""
import os
import base64
import cv2
import requests

_URL = os.environ.get("DETECT_REMOTE_URL", "")
_TIMEOUT = float(os.environ.get("DETECT_TIMEOUT", "120"))
_EMPTY = {"surface": [], "edges": [], "corners": []}


def defect_boxes(warped_cen):
    """POST the masked warp to the Modal /detect endpoint → {surface, edges, corners}. All-empty on any failure."""
    if warped_cen is None or not _URL:
        return dict(_EMPTY)
    try:
        ok, buf = cv2.imencode(".jpg", warped_cen, [cv2.IMWRITE_JPEG_QUALITY, 92])
        if not ok:
            return dict(_EMPTY)
        b64 = base64.b64encode(buf.tobytes()).decode("ascii")
        resp = requests.post(_URL, json={"warp_b64": b64}, timeout=_TIMEOUT)
        resp.raise_for_status()
        d = resp.json()
        return {"surface": d.get("surface", []), "edges": d.get("edges", []), "corners": d.get("corners", [])}
    except Exception as e:
        print(f"[remote_detect] skipped: {type(e).__name__}: {e}", flush=True)
        return dict(_EMPTY)
