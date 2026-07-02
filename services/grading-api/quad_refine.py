"""
quad_refine.py — band-limited sub-pixel photometric refinement of the segmentation quad (SEG_REFINE=1).

Why: SAM3's mask is intrinsically CONSERVATIVE on low-contrast card edges (measured on a real user photo —
silver border on white paper: the fitted quad sat 5-11px INSIDE the true card edge on three sides and drifted
into the contact shadow on the fourth → borders cut thin in the warp + a background/shadow band, biased
centering). Raising SAM3's imgsz doesn't fix it (model behavior, not resolution).

What: refine each side line of the edge_intersection quad to the TRUE photometric edge — sample perpendicular
intensity profiles in a NARROW band around the SAM3 line, take each profile's sub-pixel gradient peak (with a
proximity prior: the strong peak NEAREST the current line, so nearby parallel structure like a slab's inner
frame can't hijack the fit), robust trimmed Huber line refit, re-intersect the corners. Validated on the user
case: per-side error +8.5/+8.0/-2.8/+11.5px → +3.0/-0.5/-2.0/0.0px at stock settings (~tens of ms CPU).

This is a strict REFINEMENT, never a re-detection — per-side guardrails (weak signal / low inliers / excessive
shift or rotation → keep the SAM3 line) structurally avoid the failure mode of the legacy Canny
refine_quad_to_edges (snapping to interior art edges on full-bleed cards; that path was rejected and stays off
for seg). Non-fatal by construction: any error returns the input quad unchanged.

Env:
  SEG_REFINE            "1"/"true" enables (default OFF — prod behaviour unchanged until flipped)
  SEG_REFINE_BAND_FRAC  band half-width as a fraction of the mean side length (default 0.012, clamped 8..20px)
"""
import os
import numpy as np
import cv2

ENABLED = os.environ.get("SEG_REFINE", "").strip().lower() in ("1", "true", "yes", "on")
BAND_FRAC = float(os.environ.get("SEG_REFINE_BAND_FRAC", "0.012"))

_MIN_GRAD = 3.0        # gray-levels/px — profiles weaker than this carry no edge signal
_REL_PEAK = 0.25       # a candidate peak must be ≥ this fraction of the profile's strongest peak. Kept LOW on
                       # purpose: a weak-but-real card edge (full-art card against slab backing) must stay a
                       # candidate so the PROXIMITY prior can prefer it over a stronger structure farther out
                       # (the slab's inner frame) — at 0.45 the true edge was discarded and full-art slab cards
                       # snapped to the slab frame (caught by the 223-slab regression).
_ON_EDGE_S = 1.5       # px — the "already on an edge" test window around the current line
_ON_EDGE_REL = 0.35    # at-line gradient ≥ this fraction of the profile max ⇒ that profile supports the line
_ON_EDGE_FRAC = 0.45   # ≥ this fraction of supporting profiles ⇒ side is already on the edge → keep it (no refit).
                       # Balance: high enough not to suppress genuine fixes (user-case sides measured ~8px off had
                       # support 0.38-0.43); the proximity+_REL_PEAK rule remains the primary anti-hijack guard.
_MIN_PTS = 25          # min edge points to attempt a side refit
_MIN_INLIERS = 20      # min surviving inliers to accept the refit
_MAX_ANGLE_DEG = 2.5   # max rotation of a side line
_N_PROF = 120          # perpendicular profiles per side
_STEP = 0.5            # px sampling step along each profile


def _side_edge_points(gray, p0, p1, outward, band):
    """Sub-pixel photometric edge points along one side: per profile, the candidate |gradient| peak NEAREST the
    current line (proximity prior). Also measures "on-edge support" — the fraction of profiles whose gradient AT
    the current line is already edge-like. Returns ((N,2) float32 edge points, on_edge_frac)."""
    d = p1 - p0
    L = float(np.linalg.norm(d))
    d = d / L
    ss = np.arange(-band, band + _STEP / 2, _STEP, np.float32)
    at_line = np.abs(ss) <= _ON_EDGE_S
    pts, n_prof, n_on = [], 0, 0
    for t in np.linspace(0.06, 0.94, _N_PROF):
        base = p0 + d * (t * L)
        pp = (base[None, :] + outward[None, :] * ss[:, None]).astype(np.float32)
        vals = cv2.remap(gray, pp[:, 0].reshape(-1, 1).copy(), pp[:, 1].reshape(-1, 1).copy(),
                         cv2.INTER_LINEAR).ravel()
        g = np.gradient(vals)
        ag = np.abs(g)
        mx = float(ag.max()) / _STEP
        if mx >= _MIN_GRAD:
            n_prof += 1
            if float(ag[at_line].max()) / _STEP >= max(_MIN_GRAD, _ON_EDGE_REL * mx):
                n_on += 1                                                      # line already sits on a gradient here
        loc = np.where((ag[1:-1] >= ag[:-2]) & (ag[1:-1] >= ag[2:]))[0] + 1   # local |grad| maxima
        if loc.size == 0:
            continue
        strength = ag[loc] / _STEP
        keep = strength >= max(_MIN_GRAD, _REL_PEAK * float(strength.max()))
        loc = loc[keep]
        if loc.size == 0:
            continue
        k = int(loc[np.argmin(np.abs(ss[loc]))])                              # nearest candidate peak to the line
        den = ag[k - 1] - 2 * ag[k] + ag[k + 1]
        delta = 0.5 * (ag[k - 1] - ag[k + 1]) / den if abs(den) > 1e-6 else 0.0
        s = float(ss[k] + np.clip(delta, -1.0, 1.0) * _STEP)
        pts.append(base + outward * s)
    on_edge_frac = (n_on / n_prof) if n_prof >= 15 else 0.0
    return np.asarray(pts, np.float32), on_edge_frac


def _fit_line(pts):
    """2-round trimmed Huber line fit → (point, unit_dir, n_inliers)."""
    for _ in range(2):
        vx, vy, x0, y0 = cv2.fitLine(pts, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        n = np.array([-vy, vx], np.float32)
        dist = np.abs((pts - np.array([x0, y0], np.float32)) @ n)
        keep = dist < max(2.0, float(np.percentile(dist, 80)))
        if keep.sum() < _MIN_INLIERS:
            break
        pts = pts[keep]
    vx, vy, x0, y0 = cv2.fitLine(pts, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
    return np.array([x0, y0], np.float32), np.array([vx, vy], np.float32), len(pts)


def _intersect(l1, l2):
    (p, d1), (q, d2) = l1, l2
    A = np.array([d1, -d2], np.float32).T
    if abs(np.linalg.det(A)) < 1e-8:
        raise ValueError("near-parallel lines")
    t = np.linalg.solve(A, q - p)
    return p + d1 * t[0]


def refine_quad(img_bgr, quad):
    """Refine the 4 side lines of `quad` (any consistent convex order, source px) to the photometric card edge.
    Returns (quad_refined float32 (4,2) in the SAME corner order, info dict). On any failure or if no side
    passes the guards, returns the input quad unchanged (info["accepted"] lists refined sides)."""
    info = {"accepted": [], "rejected": {}}
    try:
        quad = np.asarray(quad, np.float32)
        gray = cv2.GaussianBlur(cv2.cvtColor(img_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 1.2)
        centroid = quad.mean(axis=0)
        mean_side = float(np.mean([np.linalg.norm(quad[i] - quad[(i + 1) % 4]) for i in range(4)]))
        band = float(np.clip(BAND_FRAC * mean_side, 8.0, 20.0))
        info["band"] = band
        lines = []
        for i in range(4):
            p0, p1 = quad[i], quad[(i + 1) % 4]
            d = p1 - p0
            d = d / np.linalg.norm(d)
            nv = np.array([-d[1], d[0]], np.float32)
            if np.dot(nv, (p0 + p1) / 2 - centroid) < 0:
                nv = -nv
            orig = ((p0 + p1) / 2, d)                        # fallback: the SAM3 line itself
            pts, on_edge = _side_edge_points(gray, p0, p1, nv, band)
            if on_edge >= _ON_EDGE_FRAC:                     # line already photometrically ON an edge → keep it
                lines.append(orig); info["rejected"][i] = f"on-edge({on_edge:.2f})"; continue
            if len(pts) < _MIN_PTS:
                lines.append(orig); info["rejected"][i] = "weak-signal"; continue
            lp, ld, n_in = _fit_line(pts)
            if n_in < _MIN_INLIERS:
                lines.append(orig); info["rejected"][i] = "few-inliers"; continue
            ang = np.degrees(np.arccos(np.clip(abs(float(np.dot(ld, d))), 0, 1)))
            nn = np.array([-ld[1], ld[0]], np.float32)
            shift = max(abs(float((p0 - lp) @ nn)), abs(float((p1 - lp) @ nn)))
            if ang > _MAX_ANGLE_DEG or shift > 0.8 * band:   # a refinement, not a re-detection
                lines.append(orig); info["rejected"][i] = f"clamp(ang={ang:.1f},shift={shift:.1f})"; continue
            lines.append((lp, ld)); info["accepted"].append(i)
        if not info["accepted"]:
            return quad, info
        out = np.array([_intersect(lines[(i - 1) % 4], lines[i]) for i in range(4)], np.float32)
        # sanity: the refined quad must stay a similar convex quad (area within ±15%)
        a0 = abs(cv2.contourArea(quad.reshape(-1, 1, 2)))
        a1 = abs(cv2.contourArea(out.reshape(-1, 1, 2)))
        if not (0.85 * a0 <= a1 <= 1.15 * a0) or not cv2.isContourConvex(out.reshape(-1, 1, 2).astype(np.int32)):
            info["rejected"]["quad"] = "sanity"
            return quad, info
        return out, info
    except Exception as e:                                   # non-fatal by construction
        info["rejected"]["error"] = f"{type(e).__name__}: {e}"
        return np.asarray(quad, np.float32), info
