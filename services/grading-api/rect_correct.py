"""
rect_correct.py — TAPERED closed-form quad correction + SLAB-SUSPECT gate (SEG_RECT_CORRECT).
Validated in the lab 2026-07-04/05 (research notes: seg-ensemble). Prod modes via SEG_RECT_CORRECT env:
  "off" (default) — module inert.
  "shadow"        — cv_grader runs the FULL decision pipeline per grade and attaches `_rect_correct`
                    (decision, w, residuals, corner shift) to the response + one log line. THE SERVED GRADE
                    IS UNTOUCHED — shadow exists to measure decision mix / verify-failure / slab rates on
                    real traffic before any flip.
  "on"            — grader.detect_and_grade applies the correction to quad_raw/quad_padded BEFORE grading
                    (warp, centering, detectors, corner crops and the response quads all stay consistent).
                    Anything but a verified "corrected" decision leaves the quads untouched. Kill switch:
                    set this env back to "shadow"/"off" and redeploy.

WHY TAPER (B#3 verdict, 2026-07-04): grading is STATELESS — no card identity across requests — so temporal
hysteresis is impossible. A hard trust gate therefore creates a cliff: a card at end_dev 7.9px corrects, at
8.1px it doesn't, and harmless input variants (JPEG re-save, resolution) straddle the line → the GATED
pipeline jitters MORE than the ungated one (Charmander 4→10pt). The stateless fix is Lipschitz output:
  final_quad = quad + w · (corrected_quad − quad)
with w ramping smoothly from 1 (well inside the measurement's validity) to 0 (outside it). Nearby inputs →
nearby w → nearby quads. Cliffs remain only at revert-on-verify-failure (rare, systematic) and slab detection
(bimodal by construction).

WHY THE SLAB GATE (B#1 verdict): corrections HELP raw cards (7/7) and HURT slab/scraped photos (3/3) — behind
plastic the nearest gradient can be the case/sleeve line. Detector: probe the band JUST OUTSIDE the expected
card rect (+8..+30px) for a COHERENT PARALLEL LINE per side (a case/toploader/sleeve edge hugging the card).
Table texture / patterned mats don't line-fit coherently; case edges do. ≥2 sides with coherent outer lines →
slab-suspect → w=0 (flag-only; the shipped confidence veto covers it).

Decisions returned: "corrected" (w>0, verified) · "flag-only:slab" · "flag-only:unmeasurable" ·
"flag-only:out-of-trust" (w tapered to 0) · "micro-skip" (predicted movement <0.5px — true no-op) ·
"reverted" (verify failed: residual got worse) · "n/a" (cropped input).
"""
from __future__ import annotations

import numpy as np, cv2
import rect_check as RC
import card_segmenter as CS
import grader as G

import os
MODE = os.environ.get("SEG_RECT_CORRECT", "off").strip().lower()

Wp, Hp = 630, 880
SIDES = ("top", "right", "bottom", "left")

# taper ramps (px) — full correction inside LO, zero at HI. LO/HI bracket the old hard gates (8 / 16).
END_LO, END_HI = 6.0, 9.0            # worst end-of-side deviation (must stay inside the ±10px band)
SHIFT_LO, SHIFT_HI = 12.0, 16.0      # max corner displacement (extrapolation guard)
# NO taper-in floor — MEASURED TRADEOFF (v2final vs v2final2, 2026-07-05): a 0.30–0.50° fade-in floor gave
# the cleanest GT medians (4.20→3.10) but COLLAPSED coverage (28→5; wild median keystone sits inside the fade
# window) and REGRESSED stability (jitter 5.00→6.76 — the steep fade slope converts ±0.1° measurement wiggle
# into w variance, undoing the convergence property). Without the floor: jitter 5.00 (beats baseline 6.24),
# 28 corrections, GT median shuffles +0.15pt (selector noise). Stability is the user-visible property → ship
# without the floor; MICRO_PX below handles true no-ops.
MICRO_PX = 0.5                        # predicted movement below this = true no-op, skip the re-warp
# slab probe
SLAB_B0, SLAB_B1 = 8.0, 30.0         # outer band (px beyond the expected line)
SLAB_MIN_FRAC = 0.55                  # fraction of profiles that must yield a peak
# Thresholds CHOSEN FROM MEASURED SEPARATION (slab_features.json, 66 labeled cards, 217 fitted sides):
# slab case-lines fit TIGHT and STRONG (resid p75=1.0, strength p25=5.2); raw-background seams fit sloppy and
# weak (resid median 1.7, strength median 2.5). resid<=1.5 & strength>=3 & >=2 sides => 4/4 measured-harm
# cards caught (trio + Greninja toploader), 2 benign FPs on 43 raw. Residual risk: weak-lined slabs (e.g.
# scraped_056) slip through — bounded by taper + verify + the live confidence veto; shadow-mode logs will
# measure the real-world rates.
SLAB_MAX_RESID = 1.5                  # px — Huber-fit residual for a "coherent" outer line
SLAB_MIN_STRENGTH = 3.0               # median peak |gradient| — case edges are strong, mat seams weak
SLAB_MAX_ANG = 2.0                    # deg — outer line must be near-parallel to the side
SLAB_MIN_SIDES = 2                    # suspect when >= this many sides show a coherent outer line


def _expected_rect(pf):
    return np.array([pf * Wp, pf * Hp, (1 - pf) * Wp, (1 - pf) * Hp], np.float32)


def _side_geoms(pf):
    E = _expected_rect(pf)
    return {
        "top":    (np.array([E[0], E[1]]), np.array([E[2], E[1]]), np.array([0, -1.0])),
        "bottom": (np.array([E[0], E[3]]), np.array([E[2], E[3]]), np.array([0, 1.0])),
        "left":   (np.array([E[0], E[1]]), np.array([E[0], E[3]]), np.array([-1.0, 0])),
        "right":  (np.array([E[2], E[1]]), np.array([E[2], E[3]]), np.array([1.0, 0])),
    }


def _photo_border_segments(qp, src_shape):
    """The SOURCE image's border, projected into warp coords. On tightly-cropped photos this boundary lands
    inside the warp's outer ring as a straight line parallel to the card — the #1 slab-probe false positive
    (validation round 1: 32 FPs, nearly every raw crop). It is exactly computable → mask it, don't tune it."""
    if qp is None or src_shape is None:
        return []
    Hs, Ws = src_shape[:2]
    Hm = cv2.getPerspectiveTransform(CS._order_quad(np.asarray(qp, np.float32)),
                                     np.array([[0, 0], [Wp, 0], [Wp, Hp], [0, Hp]], np.float32))
    corners = np.array([[0, 0], [Ws, 0], [Ws, Hs], [0, Hs]], np.float32)
    w = cv2.perspectiveTransform(corners.reshape(-1, 1, 2), Hm).reshape(4, 2)
    return [(w[i], w[(i + 1) % 4]) for i in range(4)]


def _dist_to_segments(pt, segs):
    best = 1e9
    for a, b in segs:
        ab = b - a
        L2 = float(ab @ ab)
        t = 0.0 if L2 < 1e-9 else max(0.0, min(1.0, float((pt - a) @ ab) / L2))
        best = min(best, float(np.linalg.norm(pt - (a + t * ab))))
    return best


def slab_suspect(warp_bgr, pf, qp=None, src_shape=None, measured_sides=None):
    """Coherent-parallel-line probe just OUTSIDE the CARD'S OWN MEASURED EDGE, with the projected PHOTO
    BORDER masked out. measured_sides = rc0["sides"] (rect_check fits): round-2 taught that probing a fixed
    band past the EXPECTED line flags the card's own undershot edge — the correctable class self-flags as
    slab (24 FPs concentrated on ex_0/card_008 etc.). Fix: each side's probe starts EDGE_CLEAR px beyond the
    card edge we actually measured, so only genuinely third-party structure (case/toploader/sleeve) counts.
    Returns (suspect, detail)."""
    PHOTO_MASK_PX = 4.0
    EDGE_CLEAR = 5.0
    gray = cv2.GaussianBlur(cv2.cvtColor(warp_bgr, cv2.COLOR_BGR2GRAY), (0, 0), 0.8)
    geoms = _side_geoms(pf)
    border = _photo_border_segments(qp, src_shape)
    detail = {}
    n_coherent = 0
    for side, (p0, p1, n) in geoms.items():
        seg = p1 - p0
        ts = np.linspace(0.12, 0.88, 60)
        ms = (measured_sides or {}).get(side)
        b0 = SLAB_B0 if not ms else max(SLAB_B0, float(ms["pos"]) + EDGE_CLEAR)
        ss = np.arange(b0, max(SLAB_B1, b0 + 6.0) + 0.5, 0.5, dtype=np.float32)
        bases = p0[None] + ts[:, None] * seg[None]
        mapx = (bases[:, 0][:, None] + ss[None] * n[0]).astype(np.float32)
        mapy = (bases[:, 1][:, None] + ss[None] * n[1]).astype(np.float32)
        prof = cv2.remap(gray, mapx, mapy, cv2.INTER_LINEAR, borderMode=cv2.BORDER_REPLICATE).astype(np.float32)
        g = np.abs(np.gradient(prof, axis=1))
        pts, strengths = [], []
        for k in range(len(ts)):
            row = g[k]
            med = float(np.median(row)) + 1e-6
            # strongest peaks in order — take the first NOT sitting on the projected photo border
            for j in np.argsort(row)[::-1][:4]:
                if row[j] <= 4 * med:
                    break
                cand = bases[k] + float(ss[j]) * n
                if not border or _dist_to_segments(cand.astype(np.float32), border) > PHOTO_MASK_PX:
                    pts.append(cand); strengths.append(float(row[j]))
                    break
        frac = len(pts) / len(ts)
        strength = float(np.median(strengths)) if strengths else 0.0
        if frac < SLAB_MIN_FRAC:
            detail[side] = {"coherent": False, "frac": round(frac, 2)}
            continue
        P = np.array(pts, np.float32)
        vx, vy, x0, y0 = cv2.fitLine(P, cv2.DIST_HUBER, 0, 0.01, 0.01).ravel()
        d = np.array([vx, vy], np.float32)
        ln = np.array([-vy, vx], np.float32)
        resid = float(np.median(np.abs((P - np.array([x0, y0], np.float32)) @ ln)))
        ang = abs(float(np.degrees(np.arctan2(vy, vx))))
        dev = min(ang, abs(ang - 90), abs(ang - 180))
        coherent = bool(resid <= SLAB_MAX_RESID and dev <= SLAB_MAX_ANG and strength >= SLAB_MIN_STRENGTH)
        detail[side] = {"coherent": coherent, "frac": round(frac, 2), "resid": round(resid, 1),
                        "ang": round(dev, 2), "strength": round(strength, 1)}
        if coherent:
            n_coherent += 1
    return n_coherent >= SLAB_MIN_SIDES, {"n_coherent": n_coherent, "sides": detail}


def _isect(l1, l2):
    p1, d1 = np.array(l1[:2], np.float32), np.array(l1[2:], np.float32)
    p2, d2 = np.array(l2[:2], np.float32), np.array(l2[2:], np.float32)
    M = np.array([[d1[0], -d2[0]], [d1[1], -d2[1]]], np.float32)
    if abs(float(np.linalg.det(M))) < 1e-6:
        return None
    t = np.linalg.solve(M, p2 - p1)
    return p1 + t[0] * d1


def _expected_line(side, pf):
    """The promise itself, as (x0,y0,dx,dy) — the fallback for an unmeasurable side, so one missing side
    zeroes only ITS correction component instead of vetoing the whole card (soften the measurability cliff)."""
    p0, p1, _ = _side_geoms(pf)[side]
    d = (p1 - p0) / max(float(np.linalg.norm(p1 - p0)), 1e-6)
    return [float(p0[0]), float(p0[1]), float(d[0]), float(d[1])]


def _ramp(x, lo, hi):
    """1 below lo, 0 above hi, linear between."""
    if x <= lo: return 1.0
    if x >= hi: return 0.0
    return float((hi - x) / (hi - lo))


def correct_quad_tapered(img_bgr, quad, pf, warp0=None, qp=None, rc0=None):
    """The full decision pipeline on one card. Returns dict with decision, w, final quad, rc0/rc1, detail.
    warp0/qp/rc0 may be passed to reuse work the grade path already did (shadow mode)."""
    quad = CS._order_quad(np.asarray(quad, np.float32))
    if qp is None:
        qp = G.inset_quad_padded(quad, pf)
    else:
        qp = CS._order_quad(np.asarray(qp, np.float32))
    if warp0 is None:
        warp0 = G._warp_card(img_bgr, qp)
    if rc0 is None:
        rc0 = RC.check(warp0, pf)
    out = {"rc0": rc0, "w": 0.0, "final_quad": quad, "qp": qp, "warp0": warp0}

    sides = rc0.get("sides") or {}
    measured = [s for s in SIDES if sides.get(s)]
    if len(measured) < 2:
        out["decision"] = "flag-only:unmeasurable"; return out

    suspect, sd = slab_suspect(warp0, pf, qp=qp, src_shape=img_bgr.shape, measured_sides=sides)
    out["slab"] = sd
    if suspect:
        out["decision"] = "flag-only:slab"; return out

    # per-side end deviation over MEASURED sides only; missing sides contribute no correction
    SIDE_LEN = {"top": (1 - 2 * pf) * Wp, "bottom": (1 - 2 * pf) * Wp,
                "left": (1 - 2 * pf) * Hp, "right": (1 - 2 * pf) * Hp}
    end_dev = max(abs(sides[s]["pos"]) + (SIDE_LEN[s] / 2) * np.tan(np.radians(sides[s]["ang"])) for s in measured)
    w_end = _ramp(end_dev, END_LO, END_HI)
    out["end_dev"] = round(float(end_dev), 1)
    if w_end <= 0.0:
        out["decision"] = "flag-only:out-of-trust"; return out

    ln = {s: (sides[s]["line"] if sides.get(s) else _expected_line(s, pf)) for s in SIDES}
    cw = [_isect(ln["top"], ln["left"]), _isect(ln["top"], ln["right"]),
          _isect(ln["bottom"], ln["right"]), _isect(ln["bottom"], ln["left"])]
    if any(c is None for c in cw):
        out["decision"] = "flag-only:degenerate"; return out
    Hm = cv2.getPerspectiveTransform(qp, np.array([[0, 0], [Wp, 0], [Wp, Hp], [0, Hp]], np.float32))
    full = CS._order_quad(cv2.perspectiveTransform(
        np.array(cw, np.float32).reshape(-1, 1, 2), np.linalg.inv(Hm)).reshape(4, 2))

    shift = float(np.linalg.norm(full - quad, axis=1).max())
    w = w_end * _ramp(shift, SHIFT_LO, SHIFT_HI)
    out["w"] = round(w, 3); out["shift_full"] = round(shift, 1)
    if w <= 0.0:
        out["decision"] = "flag-only:out-of-trust"; return out
    if w * shift < MICRO_PX:
        out["decision"] = "micro-skip"; return out

    final = (quad + w * (full - quad)).astype(np.float32)          # the taper — Lipschitz in the input
    qp1 = G.inset_quad_padded(CS._order_quad(final), pf)
    warp1 = G._warp_card(img_bgr, qp1)
    rc1 = RC.check(warp1, pf)
    out["rc1"] = rc1

    # verify = NEVER-WORSE (partial corrections improve proportionally by construction; full corrections
    # should land clean). Worse residual = the line fits were geometrically inconsistent → revert.
    ok = (rc1.get("max_ang") is not None
          and rc1["max_ang"] <= (rc0["max_ang"] or 99) + 0.05
          and rc1["max_pos"] <= (rc0["max_pos"] or 99) + 0.5)
    if w >= 0.8:                                                    # near-full corrections must land clean
        ok = ok and rc1["max_ang"] <= 0.35 and rc1["max_pos"] <= 5.0
    if not ok:
        out["decision"] = "reverted"; return out

    out.update({"decision": "corrected", "final_quad": CS._order_quad(final), "warp1": warp1, "qp1": qp1})
    return out
