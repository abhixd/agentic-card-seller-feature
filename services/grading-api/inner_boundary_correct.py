"""
inner_boundary_correct.py — rescue the per-side inner-frame selector on EXTREME hijacks.

Failure mode (full-art cards, e.g. card_025 Mega Charizard): the print border on one side is a weak edge over
dark art, so the variance/coherence detectors latch onto the STRONG outer holo/die-cut edge instead → that
inner edge sits ~1-1.5% from the outer while the opposite side has a normal ~4% margin (a very unlikely
73/27-style read). This module ONLY touches those extreme cases and is conservative by construction:

  1. TRIGGER (cheap, geometric): on an axis, the small inner margin < INNER_SMALL AND the opposite > INNER_RATIO×
     it. Only then do we spend an RF-DETR call.
  2. RF-DETR ANCHOR: the fine-tuned inner-boundary model (learns appearance, NOT gradient strength → is NOT
     fooled by the outer edge) predicts a more-inward edge. If it AGREES the margin is small (rf ≤ selector +
     INNER_DELTA) we KEEP the selector — that's a genuine miscut, not a hijack. This is the miscut safety.
  3. BAND SEARCH: between the selector edge and the RF edge, search INWARD of the selector (skip a BUFFER so the
     hijacked outer edge itself is excluded) for the strongest perpendicular gradient. Move the edge there ONLY
     if that gradient exceeds INNER_STRENGTH — a genuine miscut has no strong edge inward of its real border, so
     nothing moves. RF-DETR is used only to BOUND the search; the final edge is the real photometric edge.

Non-fatal: any error returns `inn` unchanged. Gated by INNER_HIJACK_CORRECT (checked by the caller).
"""
import os
import numpy as np
import cv2

_MODEL     = os.environ.get("INNER_MODEL", "sdoddi/card-inner-boundary-rfdetr")
SMALL      = float(os.environ.get("INNER_SMALL", "0.020"))     # "very close to the outer edge"
RATIO      = float(os.environ.get("INNER_RATIO", "2.2"))       # opposite side this many × the small side
DELTA      = float(os.environ.get("INNER_DELTA", "0.015"))     # RF must disagree by at least this (else = miscut)
BUFFER     = float(os.environ.get("INNER_BUFFER", "0.012"))    # skip this band near the (hijacked) selector edge
STRENGTH   = float(os.environ.get("INNER_STRENGTH", "55"))     # min perpendicular gradient for a real frame edge
print(f"[inner_boundary_correct] loaded — model={_MODEL} small={SMALL} ratio={RATIO} strength={STRENGTH}", flush=True)


def _rf_inner_box(warp_bgr):
    """Top RF-DETR inner-boundary box as pixel xyxy on the warp, or None."""
    import local_rfdetr
    boxes = local_rfdetr.get_model(_MODEL).detect(warp_bgr, threshold=0.0)
    return boxes[0]["box"] if boxes else None


def _band_search(warp_bgr, idx, sel_px, rf_px):
    """Strongest perpendicular gradient inward of the selector edge, within (selector, rf). idx: 0=L 1=T 2=R 3=B.
    Returns the new edge px, or None if no edge clears STRENGTH."""
    gray = cv2.cvtColor(warp_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    H, W = gray.shape
    if idx in (0, 2):   # L/R → vertical edges (Sobel-x), profile over interior rows
        prof = np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3))[int(0.15 * H):int(0.85 * H), :].mean(0); N = W
    else:               # T/B → horizontal edges (Sobel-y), profile over interior cols
        prof = np.abs(cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3))[:, int(0.15 * W):int(0.85 * W)].mean(1); N = H
    buf = int(BUFFER * N)
    inward = sel_px + buf if idx in (0, 1) else sel_px - buf    # L/T inward = larger px; R/B inward = smaller px
    lo, hi = sorted([int(round(inward)), int(round(rf_px))])
    lo = max(lo, 1); hi = min(hi, N - 2)
    if hi - lo < 3:
        return None
    k = lo + int(np.argmax(prof[lo:hi + 1]))
    return float(k) if prof[k] >= STRENGTH else None


def correct(warp_bgr, cb, inn):
    """Return `inn` with a hijacked inner edge moved to the real frame edge, or unchanged. cb = outer [x1,y1,x2,y2]
    fractional; inn["frame_px"] = [L,T,R,B] px. Only fires on the extreme-asymmetry trigger + RF disagreement."""
    try:
        fp = list(inn.get("frame_px") or [])
        if len(fp) != 4 or warp_bgr is None:
            return inn
        H, W = warp_bgr.shape[:2]
        L, T, R, Bx = fp
        mL, mR = L / W - cb[0], cb[2] - R / W
        mT, mB = T / H - cb[1], cb[3] - Bx / H
        axes = [(mL, mR, 0, 2), (mT, mB, 1, 3)]                 # (margin1, margin2, idx1, idx2) per axis
        rf = None
        moved = False
        for m1, m2, i1, i2 in axes:
            (sm, small_idx) = (m1, i1) if m1 <= m2 else (m2, i2)
            big = max(m1, m2)
            if not (sm < SMALL and big > RATIO * sm):           # not an extreme hijack candidate
                continue
            if rf is None:
                rf = _rf_inner_box(warp_bgr)
                if rf is None:
                    return inn
            rf_m = {0: rf[0] / W - cb[0], 2: cb[2] - rf[2] / W,
                    1: rf[1] / H - cb[1], 3: cb[3] - rf[3] / H}[small_idx]
            if rf_m < sm + DELTA:                               # RF agrees the margin is small → genuine miscut
                continue
            sel_px = fp[small_idx]
            rf_px  = {0: (cb[0] + rf_m) * W, 2: (cb[2] - rf_m) * W,
                      1: (cb[1] + rf_m) * H, 3: (cb[3] - rf_m) * H}[small_idx]
            new_px = _band_search(warp_bgr, small_idx, sel_px, rf_px)
            if new_px is not None:
                fp[small_idx] = new_px
                moved = True
        if not moved:
            return inn
        L, T, R, Bx = fp
        iL, iR = L / W - cb[0], cb[2] - R / W
        iT, iB = T / H - cb[1], cb[3] - Bx / H
        if min(iL, iR, iT, iB) <= 0 or (iL + iR) <= 0 or (iT + iB) <= 0:
            return inn                                          # geometric sanity → don't apply
        lr = int(round(iL / (iL + iR) * 100)); tb = int(round(iT / (iT + iB) * 100))
        out = dict(inn)
        out["frame_px"] = fp
        out["left_right"] = f"{lr}/{100 - lr}"
        out["top_bottom"] = f"{tb}/{100 - tb}"
        out["_inner_corrected"] = True
        print(f"[inner-correct] MOVED {inn.get('left_right')}/{inn.get('top_bottom')} "
              f"-> {out['left_right']}/{out['top_bottom']}", flush=True)
        return out
    except Exception as e:
        print(f"[inner-correct] skipped: {type(e).__name__}: {e}", flush=True)
        return inn
