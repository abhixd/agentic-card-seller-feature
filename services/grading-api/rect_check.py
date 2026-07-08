"""
rect_check.py — post-warp RECTIFICATION CHECK (RECT_CHECK=1): a geometric veto on centering confidence.

THE INVARIANT — with PAD_MODE=output-inset (grader.inset_quad_padded), the detected card corners map to the
rectangle [PF, PF, 1-PF, 1-PF] of the warp BY CONSTRUCTION. If Phase-1 (seg → quad) found the true card edge,
the card's PHYSICAL edges in the warp lie exactly on that rectangle with zero tilt. Residual angle/offset of
the photometrically-fitted edge lines = Phase-1 error (keystone / mask offset) — measured HERE, per side, on
the UNMASKED padded warp, independent of the segmenter's own mask.

CONFIDENCE SEMANTICS (doctrine: MIN-only, zero grade risk — see research notes 2026-07):
    surfaced_confidence = min(selector_confidence, g_geom)
g_geom can only LOWER confidence; it never moves an edge, ratio, or grade. It is keyed on the physical die-cut
edge vs the warp's own promise — structurally UNCORRELATED with true print off-centering (a genuinely miscut
card still has a perfectly rectangular die-cut → PASSES → never demoted). This is the property that makes it a
safe confidence signal where axis-asymmetry (degenerate with real miscuts) was not.

Calibration (15 measurable cards, 2026-07-04): clean 0.09–0.23° max-angle / ≤3.8px |pos|; known-keystone
card_009 = 0.51° (→ g≈0.79, visible demotion, stays reliable — its read is ~3pt biased, not garbage);
full-art tail 1.0–1.9° (→ g 0.1–0.4 → reliable=False, the confidently-wrong class). Demotion starts ABOVE the
clean population's worst case, so clean cards are a provable no-op.

Instrument notes (calibrated the hard way):
  · search band must stay < ~20px — the card's INNER frame sits ~20px inside the die-cut at warp scale, and a
    wider strongest-gradient band latches it (measured on card_001/mimikyu).
  · NEAREST-peak-to-expected-line (proximity prior), not strongest peak — the invariant says the edge is AT
    the line. Angle is then the discriminating signal; the prior compresses position residuals.
  · <2 measurable sides (low-contrast edges) = NO INFORMATION → g=1.0. Ignorance never demotes; the selector's
    own P already reflects image quality (double-counting it would demote every dim photo).

Env:
  RECT_CHECK      "1"/"true" enables (default OFF — prod unchanged until flipped)
  RECT_BAND       search half-band px around the expected line   (default 10.0; keep < 20)
  RECT_ANG0/RECT_ANG_SPAN/RECT_ANG_CAP    angle→g ramp           (default 0.25° / 1.25° / 0.9)
  RECT_POS0/RECT_POS_SPAN/RECT_POS_CAP    |pos|→g gross-failure ramp (default 4.5px / 6px / 0.7)
"""
from __future__ import annotations

import os

import cv2
import numpy as np

ENABLED = os.environ.get("RECT_CHECK", "0").strip().lower() in ("1", "true", "yes", "on")
BAND = float(os.environ.get("RECT_BAND", "10.0"))
ANG0 = float(os.environ.get("RECT_ANG0", "0.25"))       # deg — demotion starts above the clean p95
ANG_SPAN = float(os.environ.get("RECT_ANG_SPAN", "1.25"))
ANG_CAP = float(os.environ.get("RECT_ANG_CAP", "0.9"))  # max demotion from angle (g floor 0.1)
POS0 = float(os.environ.get("RECT_POS0", "4.5"))        # px — clean max was 3.8/4.3
POS_SPAN = float(os.environ.get("RECT_POS_SPAN", "6.0"))
POS_CAP = float(os.environ.get("RECT_POS_CAP", "0.7"))

_SIDES = ("top", "right", "bottom", "left")


def _photometric_sides(warp_bgr, pf, band):
    """Per side: Huber line fit to the gradient peak NEAREST the expected line within ±band px.
    Returns {side: {"ang": deg, "pos": signed px (+ = outside expected), "n": pts} | None}."""
    Hh, Ww = warp_bgr.shape[:2]
    E = np.array([pf * Ww, pf * Hh, (1 - pf) * Ww, (1 - pf) * Hh], np.float32)
    gray = cv2.GaussianBlur(cv2.cvtColor(warp_bgr, cv2.COLOR_BGR2GRAY), (0, 0), 0.8)
    out = {}
    for side in _SIDES:
        if side == "top":      p0, p1, n = np.array([E[0], E[1]]), np.array([E[2], E[1]]), np.array([0, -1.0])
        elif side == "bottom": p0, p1, n = np.array([E[0], E[3]]), np.array([E[2], E[3]]), np.array([0, 1.0])
        elif side == "left":   p0, p1, n = np.array([E[0], E[1]]), np.array([E[0], E[3]]), np.array([-1.0, 0])
        else:                  p0, p1, n = np.array([E[2], E[1]]), np.array([E[2], E[3]]), np.array([1.0, 0])
        seg = p1 - p0
        ts = np.linspace(0.12, 0.88, 60)
        ss = np.arange(-band, band + 0.5, 0.5, dtype=np.float32)
        bases = p0[None] + ts[:, None] * seg[None]
        mapx = (bases[:, 0][:, None] + ss[None] * n[0]).astype(np.float32)
        mapy = (bases[:, 1][:, None] + ss[None] * n[1]).astype(np.float32)
        prof = cv2.remap(gray, mapx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
        g = np.abs(np.gradient(prof, axis=1))
        pts = []
        for k in range(len(ts)):
            row = g[k]
            med = float(np.median(row)) + 1e-6
            cand = [j for j in range(1, len(ss) - 1)
                    if row[j] > row[j - 1] and row[j] >= row[j + 1] and row[j] > 4 * med]
            if cand:
                j = min(cand, key=lambda j: abs(float(ss[j])))          # NEAREST peak, not strongest
                pts.append(bases[k] + ss[j] * n)
        if len(pts) < 20:
            out[side] = None
            continue
        P = np.array(pts, np.float32)
        vx, vy, x0, y0 = cv2.fitLine(P, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        ang = abs(float(np.degrees(np.arctan2(vy, vx))))
        dev = min(ang, abs(ang - 90), abs(ang - 180))
        mid = bases[len(ts) // 2].astype(np.float32)
        pos = float((np.array([x0, y0], np.float32) - mid) @ n.astype(np.float32))
        out[side] = {"ang": round(float(dev), 3), "pos": round(pos, 1), "n": len(pts),
                     # fitted line (point + unit dir, warp px) — consumed by the rectification
                     # CORRECTION prototype (intersect sides → true corners → unwarp).
                     "line": [round(float(x0), 2), round(float(y0), 2),
                              round(float(vx), 5), round(float(vy), 5)]}
    return out


def check(warp_bgr, pf):
    """Rectification check on the UNMASKED padded warp. Returns a dict with per-side residuals and the
    MIN-only geometric trust factor g_geom in [0,1] (1.0 = clean / no information)."""
    sides = _photometric_sides(warp_bgr, float(pf), BAND)
    found = {s: v for s, v in sides.items() if v is not None}
    if len(found) < 2:                                     # no information → never demote on ignorance
        return {"sides": sides, "n_sides": len(found), "max_ang": None, "max_pos": None,
                "g_ang": 1.0, "g_pos": 1.0, "g_geom": 1.0}
    max_ang = max(v["ang"] for v in found.values())
    max_pos = max(abs(v["pos"]) for v in found.values())
    g_ang = 1.0 - min(max(0.0, (max_ang - ANG0) / ANG_SPAN), ANG_CAP)
    g_pos = 1.0 - min(max(0.0, (max_pos - POS0) / POS_SPAN), POS_CAP)
    g = min(g_ang, g_pos)
    return {"sides": sides, "n_sides": len(found), "max_ang": round(max_ang, 3), "max_pos": round(max_pos, 1),
            "g_ang": round(g_ang, 3), "g_pos": round(g_pos, 3), "g_geom": round(g, 3)}
