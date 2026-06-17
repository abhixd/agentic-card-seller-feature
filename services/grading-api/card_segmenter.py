"""
card_segmenter.py
=================
Roboflow segmentation-workflow card detector + contour smoothing.

This is an alternative to the YOLO-OBB detector in grader.py. The hosted
segmentation workflow ("general-segmentation-api-6") returns a dense, pixel-
traced polygon that hugs the true card outline far more accurately than the
OBB box — including the card's real ROUNDED corners. The raw contour is
"wiggly" (jpeg-artifact staircase along the edges), so we low-pass smooth it
while preserving the true corner curvature.

Two outputs per detection:
  contour : smoothed full outline (N×2, source-image pixels) — keeps the real
            rounded corners; used for the boundary overlay + corner accuracy.
  quad    : 4 ordered corners derived from the contour — needed by the existing
            perspective-warp / corner-crop machinery, which is quad-based.

Env config:
  ROBOFLOW_API_KEY   — required to call the hosted workflow
  SEG_WORKSPACE      — Roboflow workspace slug      (default: srinivas-doddi)
  SEG_WORKFLOW       — Roboflow workflow id          (default: general-segmentation-api-6)
  SEG_CLASSES        — text prompt for the workflow  (default: card)
  SEG_SIGMA          — smoothing strength in points  (default: 2.5; higher = rounder)
  SEG_RESAMPLE_N     — contour resample resolution    (default: 400)
  SEG_BASE_URL       — serverless inference base url  (default: serverless.roboflow.com)
  SEG_TIMEOUT        — HTTP timeout seconds            (default: 60)
"""
from __future__ import annotations

import os
import base64

import cv2
import numpy as np
import requests

# centering_config.yaml tunables (env var still wins where one is set); cfg() falls back to the
# default if the file/key is missing. See CENTERING_CB_NOTES.md.
try:
    from config import cfg
except Exception:
    def cfg(section, key, default):
        return default

# ── Config ──────────────────────────────────────────────────────────────────
SEG_WORKSPACE  = os.environ.get("SEG_WORKSPACE", "srinivas-doddi")
SEG_WORKFLOW   = os.environ.get("SEG_WORKFLOW",  "general-segmentation-api-6")
SEG_CLASSES    = os.environ.get("SEG_CLASSES",   "card")
SEG_SIGMA      = float(os.environ.get("SEG_SIGMA", str(cfg("segmentation", "sigma", 2.5))))
SEG_RESAMPLE_N = int(os.environ.get("SEG_RESAMPLE_N", str(cfg("segmentation", "resample_n", 400))))
SEG_BASE_URL   = os.environ.get("SEG_BASE_URL", "https://serverless.roboflow.com")
SEG_TIMEOUT    = float(os.environ.get("SEG_TIMEOUT", "60"))
SEG_RETRIES    = int(os.environ.get("SEG_RETRIES", "3"))
# Minimum fraction of the image the chosen card region must cover. Roboflow occasionally returns a
# tiny high-confidence speck alongside (or instead of) the card; selecting by confidence then warped
# that speck to a black image (card_06/08). We select by AREA and reject anything below this floor.
SEG_MIN_AREA_FRAC = float(os.environ.get("SEG_MIN_AREA_FRAC", str(cfg("segmentation", "min_area_frac", 0.05))))


def _poly_area(pts, sx=1.0, sy=1.0) -> float:
    """Shoelace area of a Roboflow points polygon (in original-image px after sx/sy scaling)."""
    if not pts or len(pts) < 3:
        return 0.0
    x = np.array([p["x"] * sx for p in pts], dtype=np.float64)
    y = np.array([p["y"] * sy for p in pts], dtype=np.float64)
    return float(abs(np.dot(x, np.roll(y, -1)) - np.dot(y, np.roll(x, -1))) / 2.0)


# ── Contour smoothing (numpy-only — no scipy dependency) ──────────────────────
def resample_closed(poly: np.ndarray, n: int = SEG_RESAMPLE_N) -> np.ndarray:
    """Resample a closed polygon to n points evenly spaced along its perimeter.

    Uniform spacing makes the Gaussian sigma below behave consistently
    regardless of how many points the segmenter happened to emit.
    """
    poly = np.asarray(poly, dtype=float)
    if len(poly) < 3:
        return poly
    loop = np.vstack([poly, poly[:1]])
    seg  = np.linalg.norm(np.diff(loop, axis=0), axis=1)
    d    = np.r_[0.0, np.cumsum(seg)]
    total = d[-1]
    if total <= 0:
        return poly
    t = np.linspace(0.0, total, n, endpoint=False)
    x = np.interp(t, d, loop[:, 0])
    y = np.interp(t, d, loop[:, 1])
    return np.column_stack([x, y])


def gaussian_smooth_closed(poly: np.ndarray, sigma: float = SEG_SIGMA) -> np.ndarray:
    """Circular Gaussian low-pass on a closed contour (mode='wrap').

    Removes high-frequency edge wiggle while preserving the low-frequency shape
    — i.e. the card's real rounded corners stay, the jpeg staircase goes.
    Larger sigma rounds the corners more.
    """
    poly = np.asarray(poly, dtype=float)
    n = len(poly)
    if n < 3 or sigma <= 0:
        return poly
    r = max(1, int(round(3 * sigma)))
    r = min(r, n - 1)                          # kernel can't exceed contour length
    k = np.exp(-(np.arange(-r, r + 1) ** 2) / (2 * sigma ** 2))
    k /= k.sum()
    xp = np.r_[poly[-r:, 0], poly[:, 0], poly[:r, 0]]   # circular pad
    yp = np.r_[poly[-r:, 1], poly[:, 1], poly[:r, 1]]
    xs = np.convolve(xp, k, mode="valid")
    ys = np.convolve(yp, k, mode="valid")
    return np.column_stack([xs, ys])


def smooth_contour(poly: np.ndarray, n: int = SEG_RESAMPLE_N,
                   sigma: float = SEG_SIGMA, eps_frac: float = 0.0) -> np.ndarray:
    """Corner-preserving smooth: optional approxPolyDP de-noise → resample → Gaussian.

    eps_frac > 0 pre-simplifies with approxPolyDP (fraction of perimeter) before
    smoothing; usually unnecessary — leave at 0 to keep the full outline.
    """
    poly = np.asarray(poly, dtype=np.float32)
    if len(poly) < 3:
        return poly
    if eps_frac > 0:
        peri = cv2.arcLength(poly.reshape(-1, 1, 2), True)
        poly = cv2.approxPolyDP(poly.reshape(-1, 1, 2), eps_frac * peri, True)\
                  .reshape(-1, 2).astype(np.float32)
    return gaussian_smooth_closed(resample_closed(poly, n), sigma)


def quad_from_contour(poly: np.ndarray) -> np.ndarray:
    """Reduce a contour to a clean 4-corner quad via adaptive approxPolyDP.

    Used only for the geometry that REQUIRES 4 points (perspective warp,
    corner crops, card_boundary). Falls back to minAreaRect if 4 corners
    aren't found. Returns (4,2) float32 — NOT corner-ordered (caller orders it).
    """
    poly = np.asarray(poly, dtype=np.float32).reshape(-1, 1, 2)
    peri = cv2.arcLength(poly, True)
    for eps in np.linspace(0.005, 0.08, 40):
        ap = cv2.approxPolyDP(poly, eps * peri, True)
        if len(ap) == 4:
            return ap.reshape(4, 2).astype(np.float32)
    return cv2.boxPoints(cv2.minAreaRect(poly)).astype(np.float32)


# ── Hosted segmentation inference ─────────────────────────────────────────────
def _post_workflow(b64: str, api_key: str, classes: str) -> dict:
    url = f"{SEG_BASE_URL}/infer/workflows/{SEG_WORKSPACE}/{SEG_WORKFLOW}"
    body = {
        "api_key": api_key,
        "inputs": {
            "image":   {"type": "base64", "value": b64},
            "classes": classes,
        },
        "use_cache": True,
    }
    last_err = None
    for attempt in range(SEG_RETRIES):
        try:
            resp = requests.post(url, json=body, timeout=SEG_TIMEOUT)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:           # transient SSL/network — retry
            last_err = e
    raise RuntimeError(f"segmentation workflow call failed after {SEG_RETRIES} tries: {last_err}")


def segment_card(img_bgr: np.ndarray,
                 api_key: str | None = None,
                 classes: str | None = None,
                 sigma: float | None = None) -> dict:
    """
    Detect the card via the Roboflow segmentation workflow.

    Returns dict:
        contour_raw      : (M,2) float32 — raw segmentation polygon (source px)
        contour          : (N,2) float32 — corner-preserving SMOOTHED outline
        quad             : (4,2) float32 — corners derived from the smoothed contour
        conf             : float
        n_segments       : int

    Raises ValueError if no card is segmented, RuntimeError on API failure.
    """
    api_key = api_key or os.environ.get("ROBOFLOW_API_KEY", "")
    if not api_key:
        raise RuntimeError("ROBOFLOW_API_KEY not set (required for segmentation detector)")
    classes = classes if classes is not None else SEG_CLASSES
    sigma   = SEG_SIGMA if sigma is None else sigma

    oh, ow = img_bgr.shape[:2]
    ok, buf = cv2.imencode(".jpg", img_bgr)
    if not ok:
        raise RuntimeError("JPEG encode failed")
    b64 = base64.b64encode(buf.tobytes()).decode("ascii")

    data = _post_workflow(b64, api_key, classes)
    try:
        out = data["outputs"][0]
    except (KeyError, IndexError):
        raise ValueError("segmentation workflow returned no outputs")

    pred_block = out.get("predictions", {}) or {}
    img_block = pred_block.get("image") or {}
    iw = img_block.get("width")  or ow          # Roboflow occasionally returns width/height = None;
    ih = img_block.get("height") or oh          # fall back to the original dims instead of dividing by None
    sx, sy = ow / iw, oh / ih
    preds = pred_block.get("predictions", []) or []
    if not preds:
        raise ValueError("no card segmented in image")

    # Select the LARGEST region (the card), NOT the highest-confidence one — Roboflow can emit a tiny
    # high-confidence speck that, picked by confidence, warps to black (card_06/08). The card is by far
    # the biggest object, so area is the reliable selector.
    best = max(preds, key=lambda p: _poly_area(p.get("points", []), sx, sy))
    pts  = best.get("points", [])
    if len(pts) < 3:
        raise ValueError("segmentation polygon has too few points")
    area_frac = _poly_area(pts, sx, sy) / max(ow * oh, 1)
    if area_frac < SEG_MIN_AREA_FRAC:                       # even the largest region is a speck → genuine miss
        raise ValueError(f"segmentation found no card: largest region is {area_frac*100:.2f}% of the image "
                         f"(< {SEG_MIN_AREA_FRAC*100:.0f}% floor)")

    contour_raw = np.array([[p["x"] * sx, p["y"] * sy] for p in pts], dtype=np.float32)
    contour     = smooth_contour(contour_raw, n=SEG_RESAMPLE_N, sigma=sigma).astype(np.float32)
    quad        = quad_from_contour(contour)

    return {
        "contour_raw": contour_raw,
        "contour":     contour,
        "quad":        quad,
        "conf":        float(best.get("confidence", 0.0)),
        "n_segments":  len(preds),
    }
