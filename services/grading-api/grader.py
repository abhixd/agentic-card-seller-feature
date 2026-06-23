"""
grader.py
=========
Core PSA card grading pipeline.
Extracted from psa_grading_eval.ipynb for use in the FastAPI server.

Pipeline:
  image -> YOLO OBB detection -> perspective warp -> Claude (Opus) -> grade dict
"""

import os
import io
import json
import base64
import re
import math
from pathlib import Path

import cv2
import numpy as np
import anthropic
# NOTE: ultralytics (YOLO) is imported LAZILY inside _get_yolo(). Importing it at
# module load pulls in SAM → torchvision → torch._dynamo (very heavy/slow) even when
# the seg detector is used and YOLO is never needed — which froze notebook imports.

# Tunable centering / cb-geometry parameters live in centering_config.yaml; cfg() falls back to the
# default passed here if the file/key is missing, so this import can never break the API.
try:
    from config import cfg
except Exception:                       # config.py unreachable → every cfg() returns its default
    def cfg(section, key, default):     # noqa: D401
        return default

# ── Configuration ─────────────────────────────────────────────────────────────
MODEL       = os.environ.get("CLAUDE_MODEL", "claude-sonnet-4-5")
MAX_TOKENS  = 3000
IMG_MAX_PX  = 2048
JPEG_Q      = 92

YOLO_WEIGHTS  = os.environ.get(
    "YOLO_WEIGHTS",
    "/opt/homebrew/runs/obb/datasets/yolo_obb_cards_v2/train_v2/weights/best.pt",
)
YOLO_CONF   = float(os.environ.get("YOLO_CONF", "0.25"))
YOLO_IMGSZ  = int(os.environ.get("YOLO_IMGSZ", "640"))
# Warp margin as a fraction of the card's longer side. Default 0.03 — load-bearing: the edge-band
# thresholds (CV_THRESHOLDS) are calibrated to this margin, and dropping it shifts the edge pillar (a
# pillar-sweep showed 0.01 moves ~24% of grades). Env-overridable so 0.01 can be A/B'd later without a
# code change — set PADDING_FRAC on the Railway service, but re-validate the edge pillar before adopting.
PADDING_FRAC   = float(os.environ.get("PADDING_FRAC", cfg("segmentation", "padding_frac", 0.03)))
# How the PADDING_FRAC margin is applied: "output-inset" maps the card corners → an inset rectangle and lets
# the homography fill the margin (perspective-correct → ZERO tilt). "radial" is the legacy corner-push, which
# tilts a perspective-photographed card. Default output-inset (radial retired 2026-06); PAD_MODE=radial reverts.
PAD_MODE       = os.environ.get("PAD_MODE", "output-inset").lower()
CB_SEARCH_FRAC = cfg("cb_refine", "search_frac", 0.10)      # refine_cb_in_warped inward search
CB_BALANCE_MARGIN = cfg("cb_refine", "balance_margin", 0.006)  # _balance_cb_padding tolerance
CB_CONTOUR_CAP    = cfg("cb_refine", "contour_cap", 0.05)      # _expand_cb_to_contour: max outward expand (frac of card)
CB_CONTOUR_MINPAD = cfg("cb_refine", "contour_minpad", 0.004)  # _expand_cb_to_contour: keep >= this pad off the warp frame
CB_NUDGE_LR       = cfg("cb_refine", "nudge_lr", 0.020)        # _nudge_cb: fixed L/R outward nudge (no-contour fallback)
CB_NUDGE_TB       = cfg("cb_refine", "nudge_tb", 0.0158)       # _nudge_cb: fixed T/B outward nudge (no-contour fallback)
REFINE_EDGES = True

# Card detector selection:
#   "yolo"         — YOLO OBB (default; the live Beta path)
#   "seg"          — Roboflow segmentation workflow (Model C; accurate rounded corners)
#   "seg_then_yolo"— try segmentation first, fall back to YOLO on failure
CARD_DETECTOR = os.environ.get("CARD_DETECTOR", "yolo").lower()

# Lazy-loaded YOLO model (singleton)
_yolo_model = None


def _get_yolo():
    global _yolo_model
    if _yolo_model is None:
        from ultralytics import YOLO   # lazy — only when the YOLO detector is used
        _yolo_model = YOLO(YOLO_WEIGHTS)
    return _yolo_model


# ── Image encoding ─────────────────────────────────────────────────────────────
def encode_image(img_bgr: np.ndarray, max_px: int = IMG_MAX_PX, quality: int = JPEG_Q) -> dict:
    """Resize to max_px on longest edge, JPEG-encode, return base64 dict for Claude."""
    h, w = img_bgr.shape[:2]
    scale = max_px / max(h, w)
    if scale < 1.0:
        img_bgr = cv2.resize(img_bgr, (int(w * scale), int(h * scale)),
                             interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", img_bgr, [cv2.IMWRITE_JPEG_QUALITY, quality])
    if not ok:
        raise RuntimeError("JPEG encode failed")
    return {
        "media_type": "image/jpeg",
        "data": base64.standard_b64encode(buf.tobytes()).decode("ascii"),
    }


# ── Corner ordering ────────────────────────────────────────────────────────────
def _order_corners(pts):
    """
    Robust corner ordering: returns (TL, TR, BR, BL) for ANY rotation angle.
    """
    pts = np.asarray(pts).reshape(4, 2).astype(np.float32)
    cx, cy  = pts.mean(axis=0)
    angles  = np.arctan2(pts[:, 1] - cy, pts[:, 0] - cx)
    ccw_idx = np.argsort(angles)
    p = pts[ccw_idx]

    sides = np.array([np.linalg.norm(p[(i+1) % 4] - p[i]) for i in range(4)])
    pair_02 = (sides[0] + sides[2]) / 2
    pair_13 = (sides[1] + sides[3]) / 2

    if pair_02 <= pair_13:
        edge_a = (p[0], p[1]);  edge_a_y = (p[0][1] + p[1][1]) / 2
        edge_b = (p[2], p[3]);  edge_b_y = (p[2][1] + p[3][1]) / 2
    else:
        edge_a = (p[1], p[2]);  edge_a_y = (p[1][1] + p[2][1]) / 2
        edge_b = (p[3], p[0]);  edge_b_y = (p[3][1] + p[0][1]) / 2

    if edge_a_y <= edge_b_y:
        top_edge, bot_edge = edge_a, edge_b
    else:
        top_edge, bot_edge = edge_b, edge_a

    tl, tr = sorted(top_edge, key=lambda q: q[0])
    bl, br = sorted(bot_edge, key=lambda q: q[0])
    return np.array([tl, tr, br, bl], dtype=np.float32)


def adaptive_padding(quad_raw, padding_frac=0.03):
    """Compute padding in pixels as a fraction of the card's longer side."""
    sides = [np.linalg.norm(quad_raw[(i+1) % 4] - quad_raw[i]) for i in range(4)]
    return padding_frac * max(sides)


def inset_quad_padded(quad_raw, m, out_w=630, out_h=880):
    """OUTPUT-INSET padding: the quad_padded (source px) whose warp to (out_w,out_h) places the card at a
    uniform fractional inset `m` on every side. Equivalent to mapping the card corners to an inset rectangle
    and letting the homography fill the margin — perspective-correct, ZERO tilt (unlike the radial corner-push,
    which skews a perspective-photographed card). `m<=0` → no padding. card_boundary_analytical(quad_raw, this)
    then returns cb=[m,m,1-m,1-m]; downstream warps (630x880 grade, 1260x1760 zoom) keep the inset since the
    aspect matches."""
    quad_raw = np.asarray(quad_raw, np.float32)
    if m <= 1e-9:
        return quad_raw
    src = _order_corners(quad_raw)
    dst = np.array([[m*out_w, m*out_h], [(1-m)*out_w, m*out_h],
                    [(1-m)*out_w, (1-m)*out_h], [m*out_w, (1-m)*out_h]], dtype=np.float32)
    M   = cv2.getPerspectiveTransform(src, dst)
    rect = np.array([[[0, 0]], [[out_w, 0]], [[out_w, out_h]], [[0, out_h]]], dtype=np.float32)
    return cv2.perspectiveTransform(rect, np.linalg.inv(M)).reshape(4, 2).astype(np.float32)


# ── Edge refinement ────────────────────────────────────────────────────────────
def _refine_edge_to_canny(canny, A, B, gx, gy, search=20, n_steps=41,
                           distance_sigma=0.4, gradient_align_weight=0.7):
    A = np.asarray(A, dtype=np.float32)
    B = np.asarray(B, dtype=np.float32)
    edge_vec = B - A
    edge_len = float(np.linalg.norm(edge_vec))
    if edge_len < 1e-6:
        return A, B
    edge_dir = edge_vec / edge_len
    normal   = np.array([-edge_dir[1], edge_dir[0]], dtype=np.float32)

    H, W  = canny.shape
    n_pts = max(30, int(edge_len))
    ts    = np.linspace(0, 1, n_pts, dtype=np.float32)
    best_score, best_d = -np.inf, 0.0
    sigma_px = max(1.0, distance_sigma * search)

    for d in np.linspace(-search, search, n_steps, dtype=np.float32):
        offset = d * normal
        pts    = A[None, :] + ts[:, None] * edge_vec[None, :] + offset[None, :]
        xs     = np.clip(pts[:, 0].round().astype(int), 0, W - 1)
        ys     = np.clip(pts[:, 1].round().astype(int), 0, H - 1)
        edge_mask = canny[ys, xs] > 0
        if not edge_mask.any():
            continue
        gxv = gx[ys, xs];  gyv = gy[ys, xs]
        mag = np.sqrt(gxv * gxv + gyv * gyv)
        mag_safe = np.where(mag > 1e-3, mag, 1e-3)
        dot = np.abs((gxv * normal[0] + gyv * normal[1]) / mag_safe)
        alignment_factor = (1 - gradient_align_weight) + gradient_align_weight * dot
        score_per_pt = mag * alignment_factor * edge_mask
        base_score = float(score_per_pt.sum())
        weight = float(np.exp(-(d * d) / (2 * sigma_px * sigma_px)))
        score = base_score * weight
        if score > best_score:
            best_score = score
            best_d = d

    offset = best_d * normal
    return A + offset, B + offset


def _line_intersection(p1, p2, p3, p4):
    x1, y1 = p1; x2, y2 = p2; x3, y3 = p3; x4, y4 = p4
    denom = (x1 - x2) * (y3 - y4) - (y1 - y2) * (x3 - x4)
    if abs(denom) < 1e-6:
        return None
    t = ((x1 - x3) * (y3 - y4) - (y1 - y3) * (x3 - x4)) / denom
    return np.array([x1 + t * (x2 - x1), y1 + t * (y2 - y1)], dtype=np.float32)


def refine_quad_to_edges(img_bgr, quad, search_frac=0.015):
    """Snap each of the 4 edges of `quad` to the nearest strong edge in the image."""
    gray  = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY)
    blur  = cv2.GaussianBlur(gray, (5, 5), 0)
    med   = float(np.median(blur))
    canny = cv2.Canny(blur, int(max(0, 0.5 * med)), int(min(255, 1.5 * med)))
    gx = cv2.Sobel(blur, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(blur, cv2.CV_32F, 0, 1, ksize=3)

    sides  = [float(np.linalg.norm(quad[(i+1) % 4] - quad[i])) for i in range(4)]
    search = max(6.0, search_frac * min(sides))
    n_steps = max(31, int(search * 2) + 1)

    refined_edges = []
    for i in range(4):
        A, B = quad[i], quad[(i + 1) % 4]
        refined_edges.append(
            _refine_edge_to_canny(canny, A, B, gx, gy,
                                  search=search, n_steps=n_steps))

    refined_quad = np.zeros((4, 2), dtype=np.float32)
    for i in range(4):
        prev = refined_edges[(i - 1) % 4]
        curr = refined_edges[i]
        ip   = _line_intersection(prev[0], prev[1], curr[0], curr[1])
        refined_quad[i] = ip if ip is not None else quad[i]
    return refined_quad


def quad_aspect_and_area(quad):
    sides = [float(np.linalg.norm(quad[(i+1) % 4] - quad[i])) for i in range(4)]
    short = (min(sides[0], sides[2]) + min(sides[1], sides[3])) / 2
    long_ = (max(sides[0], sides[2]) + max(sides[1], sides[3])) / 2
    aspect = short / long_ if long_ > 0 else 0.0
    x = quad[:, 0]; y = quad[:, 1]
    area = 0.5 * abs(sum(x[i] * y[(i+1) % 4] - x[(i+1) % 4] * y[i] for i in range(4)))
    return aspect, area


# ── Warping ────────────────────────────────────────────────────────────────────
def _warp_matrix(quad_pts, out_w=630, out_h=880):
    """Perspective transform mapping the ordered quad → upright out_w x out_h rect."""
    src = _order_corners(quad_pts)
    dst = np.array([[0, 0], [out_w, 0], [out_w, out_h], [0, out_h]], dtype=np.float32)
    return cv2.getPerspectiveTransform(src, dst)


def _warp_card(img_bgr, quad_pts, out_w=630, out_h=880):
    """Perspective-warp a 4-corner quad to an upright out_w x out_h rectangle."""
    M = _warp_matrix(quad_pts, out_w, out_h)
    return cv2.warpPerspective(img_bgr, M, (out_w, out_h), flags=cv2.INTER_LANCZOS4)


def _contour_to_warped_norm(contour, quad_padded, out_w=630, out_h=880):
    """Map a source-pixel contour into the warped image's normalised (0-1) space.

    Uses the SAME transform as _warp_card(quad_padded), so the returned polygon
    lines up exactly with card_boundary and content_region — the client can draw
    it as the (smoothed, rounded-corner) card outline instead of an axis box.
    """
    if contour is None or len(contour) < 3:
        return None
    M = _warp_matrix(quad_padded, out_w, out_h)
    pts = np.asarray(contour, dtype=np.float32).reshape(-1, 1, 2)
    w = cv2.perspectiveTransform(pts, M).reshape(-1, 2)
    w[:, 0] = np.clip(w[:, 0] / out_w, 0.0, 1.0)
    w[:, 1] = np.clip(w[:, 1] / out_h, 0.0, 1.0)
    return w


def card_boundary_analytical(quad_raw, quad_padded, out_w=630, out_h=880):
    """Compute the exact card boundary in warped-image space."""
    src = _order_corners(quad_padded)
    dst = np.array([[0, 0], [out_w, 0], [out_w, out_h], [0, out_h]], dtype=np.float32)
    M   = cv2.getPerspectiveTransform(src, dst)
    raw_ordered  = _order_corners(quad_raw).reshape(-1, 1, 2)
    corners_warp = cv2.perspectiveTransform(raw_ordered, M).reshape(4, 2)
    x1 = float(np.clip(corners_warp[:, 0].min() / out_w, 0.0, 1.0))
    y1 = float(np.clip(corners_warp[:, 1].min() / out_h, 0.0, 1.0))
    x2 = float(np.clip(corners_warp[:, 0].max() / out_w, 0.0, 1.0))
    y2 = float(np.clip(corners_warp[:, 1].max() / out_h, 0.0, 1.0))
    return corners_warp, (x1, y1, x2, y2)


def refine_cb_in_warped(warped: np.ndarray, cb, search_frac: float = CB_SEARCH_FRAC, balance: bool = True, cw=None):
    """Snap cb to the actual physical card edge in the already-warped image.

    `balance=True` (default) also runs the symmetric-padding correction (_balance_cb_padding).
    Pass `balance=False` to get the colour/Canny-snapped cb WITHOUT the padding balance — used for
    the grading-FEATURE path (the cv_xgb model was trained on un-balanced cb; the balance is applied
    only to the CENTERING cb so the grade is unchanged while centering improves).

    After perspective warp the card edges are horizontal/vertical. Scans each cb
    side outward→inward using two complementary signals:
      • BGR colour RMS gradient (primary) — works even when card and background
        have similar brightness but differ in colour (e.g. dark foil frame on dark
        wood table: achromatic foil vs chromatic wood → RMS colour difference ~20).
      • Canny edge-density gradient (secondary) — catches cases where the physical
        cut edge produces a dense horizontal Canny line regardless of colour.
    Safe no-op when neither signal finds a clear boundary.
    search_frac: fraction of each card dimension (height for top/bottom, width for
    left/right) to scan inward from cb. 0.10 covers overshoot up to ~10% of card
    size, which is larger than any realistic Roboflow overshoot.
    """
    h, w = warped.shape[:2]
    blur  = cv2.GaussianBlur(warped, (5, 5), 1.5)          # blur in BGR space
    gray  = cv2.cvtColor(blur, cv2.COLOR_BGR2GRAY)
    med   = float(np.median(gray))
    canny = cv2.Canny(gray, max(0, 0.5 * med), min(255, 1.5 * med))

    x1 = max(0,     int(round(cb[0] * w)))
    y1 = max(0,     int(round(cb[1] * h)))
    x2 = min(w - 1, int(round(cb[2] * w)))
    y2 = min(h - 1, int(round(cb[3] * h)))
    # Per-side search proportional to card dimension so the window scales with image
    # resolution (CV_WARP_SIZE=1260×1760 vs LEGACY=630×880).
    card_h = max(1, y2 - y1); card_w = max(1, x2 - x1)
    v_search = max(4, int(card_h * search_frac))   # vertical sides (top/bottom)
    h_search = max(4, int(card_w * search_frac))   # horizontal sides (left/right)

    def _snap(bgr_s, edge_s):
        """First strong boundary going from outer to inner.
        bgr_s : (n_steps, span, 3)  — colour strip, index 0 = outermost
        edge_s: (n_steps, span)     — Canny strip, same orientation
        Returns pixel offset of the boundary, 0 if none found."""
        n = len(bgr_s)
        if n < 4:
            return 0

        # --- Signal A: BGR colour RMS gradient --------------------------------
        # Per-step mean colour → RMS distance between adjacent steps.
        # Detects card/table boundary even when brightness is similar (dark foil
        # on dark wood): achromatic foil vs chromatic wood → large colour step.
        mean_bgr = bgr_s.mean(axis=1).astype(np.float32)          # (n, 3)
        c_rms = np.sqrt(np.sum(np.diff(mean_bgr, axis=0) ** 2, axis=1))  # (n-1,)
        col_hit = None
        if c_rms.max() >= 15.0:
            idx = np.where(c_rms > c_rms.max() * 0.5)[0]
            if idx.size:
                col_hit = int(idx[0])

        # --- Signal B: Canny edge-density gradient ----------------------------
        # The physical card cut produces a dense horizontal Canny line; the smooth
        # background has low density.  Jump ≥12% coverage per step = real edge.
        density = edge_s.mean(axis=1).astype(np.float32) / 255.0  # (n,)
        d_grad  = np.abs(np.diff(density))
        cny_hit = None
        if d_grad.max() >= 0.12:
            idx = np.where(d_grad > d_grad.max() * 0.5)[0]
            if idx.size:
                cny_hit = int(idx[0])

        # Return the outermost (most conservative = smallest offset) hit.
        hits = [v for v in (col_hit, cny_hit) if v is not None]
        return max(0, min(hits)) if hits else 0

    # Strips oriented so index 0 = outermost (the cb side), going inward.
    # BGR colour strips come from the RAW (unblurred) warped image — blur attenuates
    # the per-row colour step from ~18 to ~7, dropping it below the 15-unit threshold.
    # Canny strips come from the pre-blurred gray (noise-suppressed).
    # Horizontal edges (top / bottom): v_search rows from cb side.
    bot_b  = warped[max(0, y2 - v_search):y2 + 1, x1:x2 + 1][::-1]    # (n,W,3) raw colour
    bot_e  = canny [max(0, y2 - v_search):y2 + 1, x1:x2 + 1][::-1]    # (n,W)
    top_b  = warped[y1:min(h, y1 + v_search + 1), x1:x2 + 1]
    top_e  = canny [y1:min(h, y1 + v_search + 1), x1:x2 + 1]

    # Vertical edges (left / right): h_search cols from cb side, transposed.
    left_b  = warped[y1:y2 + 1, x1:min(w, x1 + h_search + 1)].transpose(1, 0, 2)
    left_e  = canny [y1:y2 + 1, x1:min(w, x1 + h_search + 1)].T
    right_b = warped[y1:y2 + 1, max(0, x2 - h_search):x2 + 1][:, ::-1, :].transpose(1, 0, 2)
    right_e = canny [y1:y2 + 1, max(0, x2 - h_search):x2 + 1][:, ::-1].T

    trim_b = _snap(bot_b,   bot_e)   if bot_b.size   else 0
    trim_t = _snap(top_b,   top_e)   if top_b.size   else 0
    trim_l = _snap(left_b,  left_e)  if left_b.size  else 0
    trim_r = _snap(right_b, right_e) if right_b.size else 0

    nx1, ny1 = x1 + trim_l, y1 + trim_t
    nx2, ny2 = x2 - trim_r, y2 - trim_b

    # Only shrink, never enlarge; keep a valid (positive area) box.
    nx1 = max(x1, min(nx1, x2 - 1));  ny1 = max(y1, min(ny1, y2 - 1))
    nx2 = min(x2, max(nx2, x1 + 1));  ny2 = min(y2, max(ny2, y1 + 1))
    if nx1 >= nx2 or ny1 >= ny2:
        refined = tuple(cb)
    else:
        refined = (float(nx1 / w), float(ny1 / h), float(nx2 / w), float(ny2 / h))
    if not balance:
        return refined
    out = _balance_cb_padding(warped, refined)
    # contour-expand to the true cut edge (per-card, 96%); fixed nudge fallback when no contour (91%)
    return _expand_cb_to_contour(out, cw) if cw is not None else _nudge_cb(out)


def _balance_cb_padding(warped: np.ndarray, cb, margin: float = CB_BALANCE_MARGIN):
    """Make the cb padding SYMMETRIC across the four sides. Each side's 'padding' is the gap between cb
    and the warp edge; for an accurate quad this is a constant ~PADDING_FRAC on all four sides. A
    quad-undershoot (approxPolyDP inscribing the rounded/angled corners) inflates the padding on the
    affected side(s) — the card actually extends past cb there — which throws off both centering and
    labeling on that side. We pull every side whose padding exceeds the SMALLEST side's (the most
    accurate one) by more than `margin` out to that minimum, restoring symmetry.

    VALIDATED 2026-06-17 on 39 GT cards (margin sweep): mean centering error 12.71 → 5.84 at margin
    0.006 (10 improved, 2 minor regressions ≤2.1pt) — the cb undershoot, not the detector, was hurting
    centering broadly. margin 0.006 is the swept optimum (0.015→8.93, 0.010→7.34, 0.006→5.84, 0.003→
    5.93). It fixes the full-art undershoots on EVERY side: e.g. Team Rocket's Mewtwo ex
    cb [.,.949,.] → symmetric [.023,.023,.976,.977], moving the variance box off the ex-rule box and
    title bar onto the true silver frame on all four edges.

    Earlier gated versions (require the strip just outside cb to colour-match the strip inside) BLOCKED
    the correction — card content varies across cb, so the gate falsely read 'not card' and left the
    undershoot in place. Pure geometry (no gate) is what works.
    """
    pad = {"L": cb[0], "R": 1.0 - cb[2], "T": cb[1], "B": 1.0 - cb[3]}
    tgt = min(pad.values())
    new = list(cb)
    if pad["L"] > tgt + margin: new[0] = tgt
    if pad["R"] > tgt + margin: new[2] = 1.0 - tgt
    if pad["T"] > tgt + margin: new[1] = tgt
    if pad["B"] > tgt + margin: new[3] = 1.0 - tgt
    return tuple(float(v) for v in new)


def _expand_cb_to_contour(cb, cw, cap: float = CB_CONTOUR_CAP, minpad: float = CB_CONTOUR_MINPAD):
    """Expand the (undershot) cb OUTWARD to the segmentation contour's straight edges. The contour
    (`cw`, warp-normalised) follows the true card outline — only `quad_from_contour`'s approxPolyDP
    corner-inscription undershot cb (a ~uniform ~2%). This recovers the true edge PER CARD (so it also
    catches the tail a single fixed nudge misses). GUARDED so a stray over-segmented point can't blow a
    side out: expand at most `cap` of the card dim, never within `minpad` of the warp frame, never move
    INWARD of cb.

    VALIDATED 2026-06-17 on 54 outer-edge GT cards (label_outer.py / outer_edge_metric.py): outer-edge
    tightness 0% -> 96% @ TAU=1% (median max edge-error 2.11% -> 0.34%, p90 0.62%); the offset is stable
    across full-art and normal cards (out-of-sample Batch1->Batch2 held). cb-ONLY (centering / display),
    applied only to the balanced cb, so the cv_xgb grade is unaffected (cb_feat does not pass cw)."""
    a = np.asarray(cw, dtype=float).reshape(-1, 2)
    if len(a) < 4:
        return tuple(float(v) for v in cb)
    bx1, by1, bx2, by2 = a[:, 0].min(), a[:, 1].min(), a[:, 0].max(), a[:, 1].max()
    iw = cb[2] - cb[0]; ih = cb[3] - cb[1]
    L = min(cb[0], max(bx1, cb[0] - cap * iw, minpad))
    T = min(cb[1], max(by1, cb[1] - cap * ih, minpad))
    R = max(cb[2], min(bx2, cb[2] + cap * iw, 1.0 - minpad))
    B = max(cb[3], min(by2, cb[3] + cap * ih, 1.0 - minpad))
    return (float(L), float(T), float(R), float(B))


def _nudge_cb(cb, lr: float = CB_NUDGE_LR, tb: float = CB_NUDGE_TB, minpad: float = CB_CONTOUR_MINPAD):
    """Fixed per-axis OUTWARD nudge for the undershot cb when NO contour is available (the YOLO detector
    path, or a seg miss). Corrects the ~uniform approxPolyDP inscription by the validated mean (L/R +2.0%,
    T/B +1.6% of card dim); guarded outward-only and >= `minpad` off the warp frame. Out-of-sample 91%
    tight @1% (the contour-expand reaches 96% when cw is present)."""
    iw = cb[2] - cb[0]; ih = cb[3] - cb[1]
    L = min(cb[0], max(minpad, cb[0] - lr * iw))
    T = min(cb[1], max(minpad, cb[1] - tb * ih))
    R = max(cb[2], min(1.0 - minpad, cb[2] + lr * iw))
    B = max(cb[3], min(1.0 - minpad, cb[3] + tb * ih))
    return (float(L), float(T), float(R), float(B))


# NOTE: do NOT crop the warped image to cb for the centering path. The inner-frame
# detectors (inner_frame_var/dp/coherence) search INWARD from cb and already ignore
# pixels outside it; cropping + resetting cb to (0,0,1,1) collapses the outer
# reference onto the image edge, so border width measures as ~0 (esp. full-art cards).
# Refine cb with refine_cb_in_warped instead and leave the image untouched.


def mask_background_to_contour(warped: np.ndarray, cw, fill=(0, 0, 0)):
    """Black out everything OUTSIDE the card so no table background remains in the warped
    image (rounded-corner wedges, edge slivers, overshoot strips).

    Masks to the CONVEX HULL of the segmentation contour, not the raw contour. A card is a
    convex rounded rectangle, so any concavity in the contour is an occlusion artifact —
    a card-stand leg, finger, or segmentation error — that notches into the card edge.
    Hulling bridges those notches (keeping the card content) while still following the
    convex rounded corners and straight edges to exclude the table.

    METRIC-SAFE for centering: the inner-frame detectors search a band inset from cb with
    the corners skipped, which never reaches the masked region — validated identical
    centering (mean/median unchanged on 39 GT cards, both the coherence and variance
    detectors, 0 cards changed). The hull masks a superset of the raw contour, so it is
    strictly more conservative (keeps more card) than contour masking.

    Use this ONLY for the centering path and for display. Do NOT feed a masked warp to the
    grading-feature extractor (cv_extract_conditions): that model was trained on un-masked
    warps and masking shifts its edge/corner features by tens of units.
    """
    if cw is None or len(cw) == 0:
        return warped
    h, w = warped.shape[:2]
    poly = (np.asarray(cw, np.float32) * [w, h]).astype(np.int32)
    hull = cv2.convexHull(poly)                 # bridge stand/finger occlusion notches
    mask = np.zeros((h, w), np.uint8)
    cv2.fillPoly(mask, [hull], 255)
    out = warped.copy()
    out[mask == 0] = fill
    return out


# ── Palette-based centering ────────────────────────────────────────────────────
BORDER_PALETTE_HSV = {
    "grass":     [((40,  40,  40), ( 85, 255, 255))],
    "fire":      [((  0,  80,  60), ( 10, 255, 255)),
                  ((170,  80,  60), (180, 255, 255))],
    "water":     [(( 95,  60,  50), (130, 255, 255))],
    "lightning": [(( 20, 100, 130), ( 35, 255, 255))],
    "psychic":   [((128,  60,  60), (155, 255, 255))],
    "fighting":  [((  8,  80,  60), ( 20, 255, 180))],
    "darkness":  [((  0,   0,   0), (180, 255,  60))],
    "metal":     [((  0,   0,  90), (180,  35, 200))],
    "dragon":    [(( 18, 100, 120), ( 32, 255, 255))],
    "fairy":     [((155,  30, 130), (175, 200, 255))],
    "colorless": [((  0,   0, 200), (180,  35, 255))],
}


def _match_palette(hsv_pixels):
    if len(hsv_pixels) == 0:
        return None, 0.0, {}
    scores = {}
    for name, ranges in BORDER_PALETTE_HSV.items():
        mask = np.zeros(len(hsv_pixels), dtype=bool)
        for lo, hi in ranges:
            lo_a, hi_a = np.array(lo, dtype=np.int32), np.array(hi, dtype=np.int32)
            mask |= np.all((hsv_pixels >= lo_a) & (hsv_pixels <= hi_a), axis=1)
        scores[name] = float(mask.sum() / len(hsv_pixels))
    best = max(scores, key=scores.get)
    return best, scores[best], scores


def _build_palette_mask(hsv_img, palette_name):
    ranges = BORDER_PALETTE_HSV[palette_name]
    mask   = np.zeros(hsv_img.shape[:2], dtype=np.uint8)
    for lo, hi in ranges:
        m = cv2.inRange(hsv_img, np.array(lo, dtype=np.uint8), np.array(hi, dtype=np.uint8))
        mask = cv2.bitwise_or(mask, m)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)


def analytical_centering(warped_bgr, card_boundary,
                          max_band_frac=0.25, coverage_threshold=0.40,
                          min_palette_match=0.25):
    """Detect printed-border inner edge using Pokemon type-colour palette."""
    h, w = warped_bgr.shape[:2]
    cb_x1, cb_y1, cb_x2, cb_y2 = [int(round(v * d)) for v, d in zip(card_boundary, [w, h, w, h])]
    cb_x1, cb_y1 = max(0, cb_x1), max(0, cb_y1)
    cb_x2, cb_y2 = min(w, cb_x2), min(h, cb_y2)
    iw, ih = cb_x2 - cb_x1, cb_y2 - cb_y1
    if iw < 20 or ih < 20:
        return None

    inside_bgr = warped_bgr[cb_y1:cb_y2, cb_x1:cb_x2]
    inside_hsv = cv2.cvtColor(inside_bgr, cv2.COLOR_BGR2HSV)

    skip = 3
    strip_dep = max(4, int(min(iw, ih) * 0.05))
    corner_excl_h = max(8, int(iw * 0.15))
    corner_excl_v = max(8, int(ih * 0.15))

    strip_pix = np.concatenate([
        inside_hsv[skip:strip_dep, corner_excl_h:iw-corner_excl_h].reshape(-1, 3),
        inside_hsv[ih-strip_dep:ih-skip, corner_excl_h:iw-corner_excl_h].reshape(-1, 3),
        inside_hsv[corner_excl_v:ih-corner_excl_v, skip:strip_dep].reshape(-1, 3),
        inside_hsv[corner_excl_v:ih-corner_excl_v, iw-strip_dep:iw-skip].reshape(-1, 3),
    ], axis=0)

    best_name, best_frac, palette_scores = _match_palette(strip_pix)

    band_h = max(8, int(ih * max_band_frac))
    band_v = max(8, int(iw * max_band_frac))

    if best_frac >= min_palette_match:
        mask = _build_palette_mask(inside_hsv, best_name)

        def _scan(strip):
            """Find first row where palette coverage drops below threshold.

            Low-contrast fix: when holo artwork matches the border palette
            (e.g. Fossil sparkle holos matching 'lightning'), coverage stays
            high deep into the artwork and the naive fallback (len//4) produces
            an oversized inset.  Instead:
              1. First below-threshold row (normal path).
              2. If coverage never drops: find the first significant downward
                 gradient — the sharpest border→content transition.
              3. Hard fallback: 8% of the strip length (≈ typical border width).
            """
            cov = strip.mean(axis=1) / 255.0
            below = np.where(cov < coverage_threshold)[0]
            if len(below):
                return max(2, int(below[0]))
            # Coverage never dropped — the artwork matches the palette.
            # Use the first sharp negative gradient (coverage falling fastest).
            grad = -np.diff(cov)                                   # +ve = coverage drops
            k    = max(3, len(grad) // 20)
            grad_s = np.convolve(grad, np.ones(k, dtype=np.float32) / k, mode="same")
            peaks  = np.where(grad_s > 0.04)[0]                   # ≥4% per-row drop
            if len(peaks):
                return max(2, int(peaks[0]) + 2)
            # Ultimate fallback: 8% of band (conservative — real borders are 5-10%)
            return max(2, int(len(cov) * 0.08))

        border_top    = _scan(mask[:band_h, :])
        border_bottom = _scan(mask[ih-band_h:, :][::-1])
        border_left   = _scan(mask[:, :band_v].T)
        border_right  = _scan(mask[:, iw-band_v:].T[::-1])
        source = "palette"
        notes_extra = f"palette={best_name} ({best_frac*100:.0f}% perimeter match)."
    else:
        side_skip = 4
        side_dep  = max(4, int(min(iw, ih) * 0.04))
        cex_h = max(8, int(iw * 0.15))
        cex_v = max(8, int(ih * 0.15))
        # Sample border colour from the very edge of the card (most reliable
        # reference even for low-contrast borders like tan Fossil/Base Set).
        edge_dep = max(3, int(min(iw, ih) * 0.025))
        edge_pixels = np.concatenate([
            inside_bgr[side_skip:side_skip+edge_dep, cex_h:iw-cex_h].reshape(-1, 3),
            inside_bgr[ih-side_skip-edge_dep:ih-side_skip, cex_h:iw-cex_h].reshape(-1, 3),
            inside_bgr[cex_v:ih-cex_v, side_skip:side_skip+edge_dep].reshape(-1, 3),
            inside_bgr[cex_v:ih-cex_v, iw-side_skip-edge_dep:iw-side_skip].reshape(-1, 3),
        ], axis=0)
        border_color = np.median(edge_pixels, axis=0)

        def _scan_uni(strip, axis):
            """Colour-distance scan with adaptive threshold for low-contrast borders.

            Low-contrast fix (e.g. tan Fossil border vs yellowish text area):
              - Distance measured from edge-sampled reference (not global median)
                so the baseline reflects the actual border colour, not a mix.
              - Threshold is adaptive: 35% of the local distance range, clamped
                to [6, 25].  A small range → small threshold → catches subtle
                transitions that the hardcoded +18 would miss.
              - Fallback reduced to 8% of the strip (was 25%).
            """
            diff   = np.abs(strip.astype(np.float32) - border_color)
            dist   = diff.mean(axis=(1, 2)) if axis == 0 else diff.mean(axis=(0, 2))
            k      = max(3, len(dist) // 30)
            smooth = np.convolve(dist, np.ones(k, dtype=np.float32) / k, mode="same")
            baseline    = float(smooth[2:7].mean())
            val_range   = float(smooth.max() - smooth.min())
            # Adaptive threshold: proportional to available contrast, min 6 px-diff
            threshold   = baseline + max(6.0, min(25.0, val_range * 0.35))
            above = np.where(smooth[2:] > threshold)[0]
            if len(above):
                return max(2, int(above[0]) + 2)
            # No threshold crossing — look for gradient peak (subtle transition)
            grad   = np.diff(smooth)
            k2     = max(3, len(grad) // 20)
            grad_s = np.convolve(grad, np.ones(k2, dtype=np.float32) / k2, mode="same")
            peaks  = np.where(grad_s > max(0.5, val_range * 0.05))[0]
            if len(peaks):
                return max(2, int(peaks[0]) + 2)
            return max(2, int(len(smooth) * 0.08))

        border_top    = _scan_uni(inside_bgr[:band_h, :], axis=0)
        border_bottom = _scan_uni(inside_bgr[ih-band_h:, :][::-1], axis=0)
        border_left   = _scan_uni(inside_bgr[:, :band_v], axis=1)
        border_right  = _scan_uni(inside_bgr[:, iw-band_v:][:, ::-1], axis=1)
        source = "uniform"
        best_name = "uniform_fallback"
        notes_extra = (f"no palette match; colour-uniformity used.")

    # ── Hard cap: no single side can exceed 14% of the card dimension.
    # Catches residual over-detection on any card type without affecting
    # well-detected borders (real PSA borders are 5–12%).
    max_px_h = int(iw * 0.14)
    max_px_v = int(ih * 0.14)
    border_left   = min(border_left,   max_px_h)
    border_right  = min(border_right,  max_px_h)
    border_top    = min(border_top,    max_px_v)
    border_bottom = min(border_bottom, max_px_v)

    h_total = border_left + border_right
    v_total = border_top  + border_bottom
    lr_pct  = int(round(border_left / h_total * 100)) if h_total else 50
    tb_pct  = int(round(border_top  / v_total * 100)) if v_total else 50

    worst = max(abs(50 - lr_pct), abs(50 - tb_pct))
    if   worst <=  5: score = 10
    elif worst <= 10: score =  9
    elif worst <= 15: score =  8
    elif worst <= 20: score =  7
    elif worst <= 25: score =  6
    elif worst <= 30: score =  5
    elif worst <= 35: score =  4
    elif worst <= 40: score =  3
    elif worst <= 45: score =  2
    else:             score =  1

    cr_x1 = (cb_x1 + border_left)   / w
    cr_y1 = (cb_y1 + border_top)    / h
    cr_x2 = (cb_x2 - border_right)  / w
    cr_y2 = (cb_y2 - border_bottom) / h

    return {
        "score":          float(score),
        "left_right":     f"{lr_pct}/{100 - lr_pct}",
        "top_bottom":     f"{tb_pct}/{100 - tb_pct}",
        "content_region": {"x1": cr_x1, "y1": cr_y1, "x2": cr_x2, "y2": cr_y2},
        "offset":         float(worst),
        "notes":          f"Borders (px): L={border_left} R={border_right} "
                          f"T={border_top} B={border_bottom}. " + notes_extra,
        "border_type":    best_name,
        "palette_scores": {k: round(v, 3) for k, v in palette_scores.items()},
        "_source":        source,
    }


# ── Corner crops ───────────────────────────────────────────────────────────────
def _build_corner_crops_from_contour(warped, contour_warped, card_boundary,
                                      out_size=600, crop_frac=0.22):
    """Extract corner crops from the WARPED card using the Model C rounded corners.

    Unlike the original _build_corner_crops (which crops from the distorted source
    image using the quad intersection), this function:
      - Uses the already perspective-corrected warped image
      - Centers each crop on the TRUE rounded corner from the seg contour
      - Shows the physical card edge (cyan boundary) clearly in every crop
      - Positions the corner in the appropriate quadrant (TL corner appears
        in the upper-left of the TL crop, etc.)

    Args:
        warped           : 630×880 perspective-corrected card image
        contour_warped   : Model C contour in warped-normalised coords (Nx2)
        card_boundary    : [x1,y1,x2,y2] normalised outer card edge
        out_size         : output crop size in pixels (square)
        crop_frac        : fraction of shorter card dimension for the crop window

    Returns dict TL/TR/BR/BL, each an (out_size × out_size) BGR image.
    """
    h, w = warped.shape[:2]
    cw_px = (np.asarray(contour_warped, dtype=np.float32) * [w, h])

    # Find the 4 true corners of the contour:
    # TL = minimum (x+y), TR = maximum (x-y), BR = maximum (x+y), BL = minimum (x-y)
    sums  = cw_px[:, 0] + cw_px[:, 1]
    diffs = cw_px[:, 0] - cw_px[:, 1]
    corner_pts = {"TL": cw_px[int(np.argmin(sums))],
                  "TR": cw_px[int(np.argmax(diffs))],
                  "BR": cw_px[int(np.argmax(sums))],
                  "BL": cw_px[int(np.argmin(diffs))]}

    x1, y1, x2, y2 = [int(round(v * d)) for v, d in zip(card_boundary, [w, h, w, h])]
    crop_px = int(min(x2 - x1, y2 - y1) * crop_frac)

    # Mask pixels outside the Model C contour to black so the crop never shows
    # background/non-card content to Claude (clean signal: black = not card).
    masked = warped.copy()
    if contour_warped is not None and len(contour_warped) > 2:
        cw_int = (np.asarray(contour_warped, dtype=np.float32) * [w, h]).astype(np.int32)
        card_mask = np.zeros((h, w), dtype=np.uint8)
        cv2.fillPoly(card_mask, [cw_int], 255)
        masked[card_mask == 0] = 0   # outside contour → black

    crops = {}
    for name, (cx, cy) in corner_pts.items():
        cx, cy = int(round(cx)), int(round(cy))
        # Position the corner in the appropriate quadrant of the crop so the
        # physical edge is visible on both sides meeting at that corner.
        # TL → corner at (25%, 25%) of crop; TR → (75%, 25%); BR → (75%, 75%); BL → (25%, 75%)
        qx = crop_px // 4 if "L" in name else 3 * crop_px // 4
        qy = crop_px // 4 if "T" in name else 3 * crop_px // 4
        left  = max(0, min(w - crop_px, cx - qx))
        top   = max(0, min(h - crop_px, cy - qy))
        patch = masked[top:top + crop_px, left:left + crop_px]
        crops[name] = cv2.resize(patch, (out_size, out_size), interpolation=cv2.INTER_LANCZOS4)

    return crops


def _build_corner_crops(img_bgr, quad_raw, out_size=800, region_frac=0.30):
    """Warp each of the 4 card-corner regions to an upright square."""
    q = _order_corners(quad_raw)
    crops = {}
    cfg = [
        ("TL", 0, 1, 3),
        ("TR", 1, 0, 2),
        ("BR", 2, 3, 1),
        ("BL", 3, 2, 0),
    ]
    for name, ci, n_top, n_side in cfg:
        c        = q[ci]
        top_vec  = q[n_top]  - c
        sid_vec  = q[n_side] - c
        top_unit = top_vec / max(1e-6, np.linalg.norm(top_vec))
        sid_unit = sid_vec / max(1e-6, np.linalg.norm(sid_vec))
        top_len  = np.linalg.norm(top_vec) * region_frac
        sid_len  = np.linalg.norm(sid_vec) * region_frac
        src_quad = np.array([
            c,
            c + top_unit * top_len,
            c + top_unit * top_len + sid_unit * sid_len,
            c + sid_unit * sid_len,
        ], dtype=np.float32)
        dst = np.array([[0, 0], [out_size, 0], [out_size, out_size], [0, out_size]],
                       dtype=np.float32)
        M = cv2.getPerspectiveTransform(src_quad, dst)
        crops[name] = cv2.warpPerspective(img_bgr, M, (out_size, out_size),
                                          flags=cv2.INTER_LANCZOS4)
    return crops


# ── System prompt ──────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """You are an expert PSA (Professional Sports Authenticator) card grading specialist with 20+ years of experience grading Pokémon, sports, and collectible cards.

INPUT FORMAT:
You will receive FIVE images of the same card:
  Image 1: Full perspective-corrected card view
  Image 2: TOP-LEFT corner — zoomed and warped to upright (~30% of card width, native source resolution)
  Image 3: TOP-RIGHT corner
  Image 4: BOTTOM-RIGHT corner
  Image 5: BOTTOM-LEFT corner

The corner zooms are at MUCH higher pixel density than the full card — use them for fine-grained corner and adjacent-edge assessment. Use the full card for overall surface and centering.

The user message will provide:
  - card_boundary: definitive physical card edge in the full-card image (normalised 0-1)
  - border_type   : a HINT from a color-detection algorithm about the Pokemon type / border colour
                     (this is a suggestion, not ground truth — verify visually)

POKEMON BORDER COLOUR PALETTE (use this list to identify the card's border):
  - Grass     = green
  - Fire      = red
  - Water     = blue
  - Lightning = yellow
  - Psychic   = purple
  - Fighting  = brown
  - Darkness  = black
  - Metal     = gray
  - Dragon    = gold / yellow
  - Colorless = white / gray
  - Fairy     = pink
  Special variants (Full Art, Special Illustration Rare, Rainbow Rare) may have
  holographic / silver / multicoloured borders not in this list — the border_type
  hint will be "uniform_fallback" in those cases.

PSA GRADING STANDARDS (no prior on the grade):
  - PSA graders use 10x magnification. PSA 10 = imperfections visible only under that magnification, not in normal viewing.
  - A faintly soft corner requiring magnification to see is still "sharp" by PSA standards.
  - Distinguish flaws visible at normal viewing vs only under magnification.
  - Use the full 1-10 range. Grade strictly on what you observe — no assumptions about typical condition.

PILLAR DEFINITIONS:

CENTERING — produce a content_region (the inner edge of the printed border) on which the centering ratio will be computed deterministically. THE GEOMETRY OF YOUR content_region BOX *IS* THE SCORE — be accurate.

CRITICAL: content_region is a RECTANGLE with 4 implicit corners derived from
(x1, y1) and (x2, y2). Use the 4 corner zoom images (TL, TR, BR, BL) to verify
EACH corner of the rectangle. Adjust the rectangle until ALL 4 corner zooms show
the corresponding rectangle corner sitting cleanly inside the artwork — even if
that forces one side to be more conservative than its midpoint suggests.

CARD-TYPE-SPECIFIC GUIDANCE for content_region inset (fraction of card dimension):
  - Standard cards (Fire/Water/Grass/etc. — solid colored border):
      typical inset 6-10% on each side  (≈ 40-65px L/R, 55-90px T/B on 630x880 canvas)
  - Full Art / SIR / Special Illustration / Rainbow / Hyper Rare (silver/holo/textured border):
      The centering reference is the THIN reflective FOIL FRAME running around the
      whole card just inside the cut edge — typically only 2-5% wide.
      content_region = the INNER edge of that foil frame (i.e. CLOSE to the card edge).
      The illustration extends right up to the foil frame. Interior design elements —
      the name banner, HP/type icons, attack/ability text boxes, and the decorative
      rounded art-frame line — are PART OF THE ARTWORK, NOT the border. Anchoring
      content_region around those interior elements is the SINGLE MOST COMMON ERROR and
      produces an inset that is far too large (8-12%). Measure ONLY the reflective foil
      strip's width on each side; if it is ~2-3%, the inset is ~2-3%.
  - Vintage WOTC (thick white border):
      typical inset 10-15% on each side
  - Trainer / energy cards (cyan/blue header design):
      content_region matches the printed frame, not just the colored area

PIXEL ANCHORS (warped canvas is 630x880):
  - 3% inset =  19px x  26px from card edge
  - 5% inset =  32px x  44px
  - 8% inset =  50px x  70px
  - 12% inset = 76px x 106px

STEP-BY-STEP for centering (do this internally before writing JSON):
  STEP 1: Identify the card type using border_type hint + the full card image.
  STEP 2: For each of the 4 sides, look at the corresponding corner zoom image
          and locate the EXACT pixel position where the printed border ends and
          the artwork/text begins. The silver/colored band has a width — measure it.
  STEP 3: Convert those pixel positions to normalised coordinates and set content_region.
  STEP 4: PER-CORNER VERIFICATION (critical):
          Examine EACH of the 4 corner zoom images and verify the corresponding
          implicit rectangle corner:
            - TL corner zoom → does (x1, y1) sit INSIDE the artwork?
            - TR corner zoom → does (x2, y1) sit INSIDE the artwork?
            - BR corner zoom → does (x2, y2) sit INSIDE the artwork?
            - BL corner zoom → does (x1, y2) sit INSIDE the artwork?
          If any corner falls on the printed border (silver/coloured area is
          still visible AT that corner), move the relevant side INWARD until
          the worst-case corner sits cleanly inside the artwork:
            - TL or TR still on border → increase y1
            - BR or BL still on border → decrease y2
            - TL or BL still on border → increase x1
            - TR or BR still on border → decrease x2
          Align each corner with the INNER EDGE OF THE PRINTED/FOIL BORDER — not
          deep inside the artwork. For solid-border cards a corner may need slightly
          more inset where the border flares. For Full Art / foil-frame cards do NOT
          overshoot into the picture — the foil frame is thin, so the corner sits
          just inside it (a few %), never around the interior art elements.
  STEP 5: For Full Art / foil-frame cards: THIN insets are CORRECT. An inset of
          2-4% is normal and expected for a thin foil frame — do NOT inflate it.
          Re-examine ONLY if your inset exceeds ~6% (you have likely pushed past the
          foil frame into the illustration) or is essentially 0% (you mistook the
          physical cut edge for the frame's inner edge).

The centering score will be computed FROM your content_region values, not from
your stated ratios — so spend your attention on accurate content_region pixels,
not on choosing a score.

CORNERS — Inspect each of the 4 physical corners using the corresponding zoom image:
  - sharp / slight_wear / moderate_wear / heavy_wear / bent

EDGES — Inspect each of the 4 physical edges (also visible in corner zooms):
  - clean / minor_nick / chip / rough / worn

SURFACE — Inspect the face of the card (use the full card image):
  - scratches, print_lines, stains, creases (each: none / minor / moderate / heavy)

REFERENCE ANCHORS:
  - PSA 10 (Gem Mint): All 4 corners pin-sharp. All 4 edges no visible damage at normal viewing. Centering ≤ 55/45. Surface free of any visible defects at normal viewing.
  - PSA 9 (Mint): ONE allowable minor flaw — e.g. one slightly soft corner OR one tiny edge nick OR centering up to 60/40. Otherwise pristine.
  - PSA 8 (NM-MT): Up to 2-3 minor flaws, OR one moderate flaw. Centering up to 65/35. Light surface defects acceptable if minor.
  - PSA 7 (NM): Noticeable but not heavy wear across multiple pillars. Light scratches visible.
  - PSA 5-6: Multiple visible flaws. Wear easily seen.
  - PSA 3-4: Heavy wear, crease, multiple chips.
  - PSA 1-2: Severely damaged.

Respond with ONLY a valid JSON object — no markdown fences, no extra text.
Your response must contain exactly these keys and no others:
{
  "centering": {
    "score": <1-10 float>,
    "left_right": "<e.g. 55/45>",
    "top_bottom": "<e.g. 50/50>",
    "content_region": {"x1": <0.0-1.0>, "y1": <0.0-1.0>, "x2": <0.0-1.0>, "y2": <0.0-1.0>},
    "notes": "<one sentence noting the border colour you identified>"
  },
  "corners": {
    "score": <1-10 float>,
    "top_left":     "<sharp|slight_wear|moderate_wear|heavy_wear|bent>",
    "top_right":    "<sharp|slight_wear|moderate_wear|heavy_wear|bent>",
    "bottom_right": "<sharp|slight_wear|moderate_wear|heavy_wear|bent>",
    "bottom_left":  "<sharp|slight_wear|moderate_wear|heavy_wear|bent>",
    "notes": "<one sentence citing what you saw in the corner zooms>"
  },
  "edges": {
    "score": <1-10 float>,
    "top":    "<clean|minor_nick|chip|rough|worn>",
    "right":  "<clean|minor_nick|chip|rough|worn>",
    "bottom": "<clean|minor_nick|chip|rough|worn>",
    "left":   "<clean|minor_nick|chip|rough|worn>",
    "notes": "<one sentence>"
  },
  "surface": {
    "score": <1-10 float>,
    "scratches":   "<none|minor|moderate|heavy>",
    "print_lines": "<none|minor|moderate|heavy>",
    "stains":      "<none|minor|moderate|heavy>",
    "creases":     "<none|minor|moderate|heavy>",
    "notes": "<one sentence>"
  },
  "overall_score": <1-10 float>,
  "psa_equivalent": "<e.g. PSA 8 NM-MT>",
  "summary": "<2-3 sentence overall assessment>"
}

PSA equivalents: 10 Gem Mint | 9 Mint | 8 NM-MT | 7 NM | 6 EX-MT | 5 EX | 4 VG-EX | 3 VG | 2 Good | 1 Poor"""


# ── Main grade function ────────────────────────────────────────────────────────
def grade_card(img_bgr: np.ndarray,
               quad_raw=None,
               quad_padded=None,
               use_multicrop: bool = True,
               api_key: str = None,
               contour=None) -> dict:
    """
    Grade a card with Claude.

    Args:
        img_bgr      : source photo as BGR numpy array
        quad_raw     : (4,2) un-padded quad in source pixels
        quad_padded  : (4,2) padded quad used for warping
        use_multicrop: if True, send full card + 4 corner zooms (5 images total)
        api_key      : Anthropic API key (falls back to ANTHROPIC_API_KEY env var)
        contour      : optional (N,2) smoothed card outline in source pixels
                       (from the segmentation detector). Surfaced to the client
                       as a rounded-corner boundary overlay; does not change the
                       quad-based warp/centering geometry.

    Returns:
        dict with centering, corners, edges, surface, overall_score, psa_equivalent,
        summary, and debug keys prefixed with _
    """
    if api_key is None:
        api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise ValueError("ANTHROPIC_API_KEY not set")

    if quad_padded is None and quad_raw is not None:
        quad_padded = quad_raw

    if quad_padded is not None:
        warped = _warp_card(img_bgr, quad_padded)
        _, card_bbox = card_boundary_analytical(
            quad_raw if quad_raw is not None else quad_padded, quad_padded)
        card_bbox = refine_cb_in_warped(warped, card_bbox)
    else:
        warped, card_bbox = img_bgr.copy(), (0.0, 0.0, 1.0, 1.0)

    cen_analytic = analytical_centering(warped, card_bbox)
    border_type  = cen_analytic.get("border_type", "uniform_fallback") if cen_analytic else "unknown"

    images = [encode_image(warped)]
    if use_multicrop and quad_raw is not None:
        corner_crops = _build_corner_crops(img_bgr, quad_raw, out_size=800)
        for key in ("TL", "TR", "BR", "BL"):
            images.append(encode_image(corner_crops[key]))

    cb_x1, cb_y1, cb_x2, cb_y2 = card_bbox
    user_text = (
        f"card_boundary (definitive outer edge of card, normalised): "
        f"x1={cb_x1:.4f} y1={cb_y1:.4f} x2={cb_x2:.4f} y2={cb_y2:.4f}\n"
        f"border_type hint (from colour detection): {border_type}\n\n"
        f"Use card_boundary as the physical card edge — do not re-estimate it. "
        f"Use the border_type hint as a starting point for centering but verify visually.\n"
    )
    if len(images) > 1:
        user_text += (
            f"You are receiving {len(images)} images of the same card: "
            f"image 1 = full card, images 2-5 = top-left, top-right, bottom-right, "
            f"bottom-left corner zooms at native source resolution.\n"
        )
    user_text += "Return only the JSON object."

    content = [
        {"type": "image",
         "source": {"type": "base64",
                    "media_type": img_enc["media_type"],
                    "data":       img_enc["data"]}}
        for img_enc in images
    ]
    content.append({"type": "text", "text": user_text})

    client  = anthropic.Anthropic(api_key=api_key)
    message = client.messages.create(
        model      = MODEL,
        max_tokens = MAX_TOKENS,
        system     = SYSTEM_PROMPT,
        messages   = [{"role": "user", "content": content}],
    )

    raw       = message.content[0].text.strip()
    raw_clean = re.sub(r"```json|```", "", raw).strip()
    m         = re.search(r"\{.*\}", raw_clean, re.DOTALL)
    if not m:
        raise ValueError(f"No JSON found in Claude response:\n{raw[:500]}")
    json_str = m.group()
    try:
        result = json.loads(json_str)
    except json.JSONDecodeError as e:
        open_b  = json_str[:e.pos].count("{") - json_str[:e.pos].count("}")
        trimmed = json_str[:e.pos].rstrip().rstrip(",")
        try:
            result = json.loads(trimmed + "}" * max(1, open_b))
            result["_truncated"] = True
        except json.JSONDecodeError:
            raise ValueError(f"Unrecoverable JSON from Claude:\n{raw[:2000]}")

    # Deterministic centering from Claude's content_region
    cen = result.get("centering", {})
    cr  = cen.get("content_region") if isinstance(cen, dict) else None
    claude_lr    = cen.get("left_right", "?") if isinstance(cen, dict) else "?"
    claude_tb    = cen.get("top_bottom", "?") if isinstance(cen, dict) else "?"
    claude_score = cen.get("score", None) if isinstance(cen, dict) else None

    if cr and all(k in cr for k in ("x1", "y1", "x2", "y2")):
        cb_x1, cb_y1, cb_x2, cb_y2 = card_bbox
        cr_x1c = max(cb_x1, min(cb_x2, cr["x1"]))
        cr_x2c = max(cb_x1, min(cb_x2, cr["x2"]))
        cr_y1c = max(cb_y1, min(cb_y2, cr["y1"]))
        cr_y2c = max(cb_y1, min(cb_y2, cr["y2"]))

        bl = max(0.0, cr_x1c - cb_x1)
        br = max(0.0, cb_x2 - cr_x2c)
        bt = max(0.0, cr_y1c - cb_y1)
        bb = max(0.0, cb_y2 - cr_y2c)

        lr_pct = int(round(bl / (bl + br) * 100)) if (bl + br) > 1e-6 else 50
        tb_pct = int(round(bt / (bt + bb) * 100)) if (bt + bb) > 1e-6 else 50

        worst = max(abs(50 - lr_pct), abs(50 - tb_pct))
        if   worst <=  5: geo_score = 10.0
        elif worst <= 10: geo_score =  9.0
        elif worst <= 15: geo_score =  8.0
        elif worst <= 20: geo_score =  7.0
        elif worst <= 25: geo_score =  6.0
        elif worst <= 30: geo_score =  5.0
        elif worst <= 35: geo_score =  4.0
        elif worst <= 40: geo_score =  3.0
        elif worst <= 45: geo_score =  2.0
        else:             geo_score =  1.0

        geo_lr = f"{lr_pct}/{100 - lr_pct}"
        geo_tb = f"{tb_pct}/{100 - tb_pct}"

        # Cross-check Claude's stated ratios against the geometric ones (±5pp)
        def _parse_ratio(s):
            try:
                a, b = str(s).split("/"); return int(a), int(b)
            except Exception:
                return None
        consistent = True
        for claimed, geo in [(claude_lr, geo_lr), (claude_tb, geo_tb)]:
            cp = _parse_ratio(claimed); gp = _parse_ratio(geo)
            if cp is None or gp is None: consistent = False; break
            if abs(cp[0] - gp[0]) > 5:  consistent = False

        result["centering"] = {
            **(cen if isinstance(cen, dict) else {}),
            "score":      geo_score,
            "left_right": geo_lr,
            "top_bottom": geo_tb,
            "_source":    "geometric_from_content_region",
            "_claude_reported": {
                "score": claude_score,
                "left_right": claude_lr,
                "top_bottom": claude_tb,
            },
        }
        result["_centering_self_consistent"] = consistent
        result["_centering_borders_px"] = {
            "left": bl, "right": br, "top": bt, "bottom": bb,
            "units": "normalised (0-1) of warped image",
        }
    else:
        result["_centering_self_consistent"] = None

    result["_analytical_centering"] = cen_analytic
    result["_model"]         = MODEL
    result["_card_boundary"] = list(card_bbox)
    result["_n_images"]      = len(images)
    result["_border_type"]   = border_type

    # ── Visual payload for the client ─────────────────────────────────────────
    # The warped card + corner crops are in the SAME coordinate space as
    # card_boundary and content_region, so the extension can draw the centering
    # overlay (green card edge + gold content rectangle + L/R/T/B border widths)
    # exactly like the notebook's centering audit. images[0] = warped full card,
    # images[1..4] = TL/TR/BR/BL corner zooms.
    result["_warped_jpeg_b64"] = images[0]["data"]
    if len(images) == 5:
        result["_corner_crops_b64"] = {
            "TL": images[1]["data"],
            "TR": images[2]["data"],
            "BR": images[3]["data"],
            "BL": images[4]["data"],
        }

    # Smoothed, rounded-corner card outline in warped normalised space (0-1).
    # Same coordinate frame as _card_boundary / content_region, so the client can
    # draw the true card edge (with real rounded corners) instead of an axis box.
    if contour is not None and quad_padded is not None:
        warped_contour = _contour_to_warped_norm(contour, quad_padded)
        if warped_contour is not None:
            result["_card_contour_warped"] = warped_contour.round(5).tolist()
            result["_card_contour_orig"]   = np.asarray(contour, float).round(2).tolist()
    return result


# ── Detectors ───────────────────────────────────────────────────────────────────
def _detect_yolo(img_bgr: np.ndarray):
    """YOLO OBB detection + Canny edge refine. Returns (quad_raw, meta). Raises ValueError."""
    model_yolo = _get_yolo()
    res = model_yolo.predict(img_bgr, conf=YOLO_CONF, imgsz=YOLO_IMGSZ, verbose=False)
    obb = res[0].obb
    if obb is None or len(obb) == 0:
        raise ValueError("No card detected in image (YOLO confidence too low)")

    best     = int(obb.conf.argmax())
    conf     = float(obb.conf[best])
    quad_raw = _order_corners(obb.xyxyxyxy.cpu().numpy()[best].astype(np.float32))

    if REFINE_EDGES:
        quad_refined = refine_quad_to_edges(img_bgr, quad_raw, search_frac=0.02)
        asp, area    = quad_aspect_and_area(quad_refined)
        if 0.55 <= asp <= 0.85 and area > 0.4 * quad_aspect_and_area(quad_raw)[1]:
            quad_raw = quad_refined

    return quad_raw, None, {"_detector": "yolo", "_yolo_conf": conf}


def _detect_seg(img_bgr: np.ndarray, api_key: str = None):
    """
    Roboflow segmentation-workflow detection (Model C).

    Returns (quad_raw, contour, meta). The contour is the corner-preserving
    SMOOTHED outline (kept for the overlay + corner accuracy); the quad is
    derived from it for the quad-based warp/centering machinery.
    """
    import card_segmenter
    seg = card_segmenter.segment_card(img_bgr, api_key=None)  # uses ROBOFLOW_API_KEY env
    quad_raw = _order_corners(seg["quad"])
    # NOTE: Canny edge-refine is intentionally NOT applied to the seg quad. Verified on real
    # full-art images that (a) refine_quad_to_edges snaps to the nearest strong edge, which on a
    # full-bleed card is the INTERIOR art edge, pulling the quad inward (worse), and (b) the
    # shared aspect guard (quad_aspect_and_area) returns ~0.99 for any rectangular card quad, so
    # the 0.55..0.85 acceptance test rejects it anyway. Seg already captures the card edge well.
    return quad_raw, seg["contour"], {
        "_detector": "seg",
        "_seg_conf": seg["conf"],
        "_seg_n_segments": seg["n_segments"],
    }


def detect_and_grade(img_bgr: np.ndarray, api_key: str = None, zoom: bool = False) -> dict:
    """
    Full pipeline: detect card -> warp -> Claude grading.

    Detector chosen by CARD_DETECTOR env ("yolo" | "seg" | "seg_then_yolo").
    `zoom` (CV backend only) adds high-res per-defect close-ups under `pillar_zooms`.
    Returns grade dict. Raises ValueError if no card detected.
    """
    if CARD_DETECTOR == "seg":
        quad_raw, contour, meta = _detect_seg(img_bgr, api_key)
    elif CARD_DETECTOR == "seg_then_yolo":
        try:
            quad_raw, contour, meta = _detect_seg(img_bgr, api_key)
        except Exception as e:
            quad_raw, contour, meta = _detect_yolo(img_bgr)
            meta["_seg_fallback"] = f"{type(e).__name__}: {e}"
    else:  # "yolo" (default)
        quad_raw, contour, meta = _detect_yolo(img_bgr)

    if PAD_MODE == "output-inset":
        quad_padded = inset_quad_padded(quad_raw, PADDING_FRAC)   # perspective-correct margin, zero tilt
    else:                                                          # legacy radial corner-push (tilts perspective cards)
        pad_px      = adaptive_padding(quad_raw, padding_frac=PADDING_FRAC)
        centroid    = quad_raw.mean(axis=0)
        dirs        = quad_raw - centroid
        norms       = np.linalg.norm(dirs, axis=1, keepdims=True).clip(min=1)
        quad_padded = quad_raw + (dirs / norms) * pad_px

    # Grading backend: "cv" (classical-CV XGBoost, default) | "vlm" (Claude Sonnet, legacy backup).
    if os.environ.get("GRADER_BACKEND", "cv").lower() == "vlm":
        result = grade_card(img_bgr, quad_raw=quad_raw, quad_padded=quad_padded,
                            use_multicrop=True, api_key=api_key, contour=contour)
    else:
        import cv_grader   # lazy (cv_grader imports grader); CV is the default backend
        result = cv_grader.grade_card_cv(img_bgr, quad_raw=quad_raw,
                                         quad_padded=quad_padded, contour=contour, zoom=zoom)
    result.update(meta)
    result["_quad_raw"]    = quad_raw.tolist()
    result["_quad_padded"] = quad_padded.tolist()
    # Original image dimensions [width, height] — lets feedback corrections in
    # warped space be mapped back to original-image OBB labels.
    h, w = img_bgr.shape[:2]
    result["_orig_dims"]   = [int(w), int(h)]
    return result
