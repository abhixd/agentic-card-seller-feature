"""
inner_frame_dp.py — bounded, straight-line, multi-cue inner-boundary detector.

Each of the 4 inner-border edges is the best STRAIGHT LINE (offset + small tilt) through a bounded
band just inside the card cut edge — a constrained search, not a free path. Edges are straight by
construction and the offset is hard-bounded to [lo, cap]·width. The line score combines FOUR cues:
  • GRADIENT      ⟂ to the edge        — strong on printed / yellow borders,
  • SATURATION-STEP (local)            — sharp border↔art contrast,
  • COHERENCE (structure tensor)       — foil-robust coherent-line energy,
  • STRIP-EXTENT                       — mean(S inside) − mean(S outside): high where a low-sat
        silver strip ENDS and sustained-saturated art begins. This is the cue that distinguishes
        the true silver→art boundary from the cut-edge BEVEL (which all the "strongest edge" cues
        lock onto), so it's what makes full-arts work.
Plus a distance-to-seed pull. Per-edge & independent ⇒ no 50/50 symmetry bias. The 4 lines are
intersected into a (slightly tiltable) quad.

API mirrors inner_frame.find_inner_frame and adds 'corners' (TL,TR,BR,BL px) and 'paths' (straight).
Cue weights are calibrated against labels by tune_dp.py.
"""
import numpy as np, cv2
import inner_frame as _IF                         # structure-tensor coherence maps

CAP      = 0.085    # max inset (fraction of card WIDTH) — hard boundary condition
LO       = 0.004    # min inset — skip the outermost cut-edge bevel
MARGIN   = 0.14     # fraction trimmed at each edge end (corner zones)
W_GRAD   = 0.6      # cue weights (defaults; tune_dp.py finds the best against labels)
W_SAT    = 0.6
W_COH    = 0.5
W_STRIP  = 2.0      # strip-extent — the dominant cue for full-art silver borders
W_SEED   = 0.5
MAX_TILT = 14       # max top-to-bottom shift of a straight edge (px) — allows a slight quad
STEP_W   = 6        # px window for the saturation step


def _norm(a):
    a = a.astype(np.float64); lo, hi = float(a.min()), float(a.max())
    return (a - lo) / (hi - lo) if hi - lo > 1e-9 else np.zeros_like(a)


def _strip_evidence(Slev):
    """Slev[N, M] saturation level, columns = inset edge→inside. Returns evidence[N, M] where
    evidence[i,k] = mean(Slev[i, k:]) − mean(Slev[i, :k]) — peaks at the silver-strip end."""
    N, M = Slev.shape
    cs = np.zeros((N, M + 1)); cs[:, 1:] = np.cumsum(Slev, axis=1)
    total = cs[:, M:M + 1]
    ev = np.zeros((N, M))
    k = np.arange(1, M)
    ev[:, 1:] = (total - cs[:, 1:M]) / (M - k)[None, :] - cs[:, 1:M] / k[None, :]
    return ev


def _best_line(E, seed_pen, max_tilt):
    """Best straight line through band-evidence E[N, M] (N positions along the edge, M insets).
    Returns (offset_at_start, offset_at_end, score). Maximises mean evidence − seed pull."""
    N, M = E.shape
    rowfrac = (np.arange(N) / max(N - 1, 1) - 0.5)
    best = (-1e18, 0.0, 0.0)
    js = np.arange(M)
    for t in range(-max_tilt, max_tilt + 1):
        cols = js[None, :] + t * rowfrac[:, None]
        colsi = np.clip(np.round(cols).astype(np.int64), 0, M - 1)
        score = np.take_along_axis(E, colsi, axis=1).mean(0) - seed_pen
        j0 = int(np.argmax(score))
        if score[j0] > best[0]:
            best = (float(score[j0]), j0 - 0.5 * t, j0 + 0.5 * t)
    return best[1], best[2], best[0]


def _edge(side, gradmap, S, cohmap, cbpx, seed_inset, cap_px, lo_px, w):
    """One inner edge as a straight line. All cues built in inset-order (edge→inside)."""
    x1, y1, x2, y2 = cbpx
    vertical = side in ("L", "R")
    insets = np.arange(lo_px, cap_px)                            # px inset, edge→inside
    sw = w["step_w"]
    if vertical:
        a0 = y1 + int(w["margin"] * (y2 - y1)); a1 = y2 - int(w["margin"] * (y2 - y1))
        along = np.arange(a0, a1)
        cols = (x1 + insets) if side == "L" else (x2 - insets)
        cin = np.clip(cols + (sw if side == "L" else -sw), 0, S.shape[1] - 1)
        cout = np.clip(cols - (sw if side == "L" else -sw), 0, S.shape[1] - 1)
        G = gradmap[np.ix_(along, cols)]; C = cohmap[np.ix_(along, cols)]
        Slev = S[np.ix_(along, cols)]
        satstep = S[np.ix_(along, cin)] - S[np.ix_(along, cout)]
    else:
        a0 = x1 + int(w["margin"] * (x2 - x1)); a1 = x2 - int(w["margin"] * (x2 - x1))
        along = np.arange(a0, a1)
        rows = (y1 + insets) if side == "T" else (y2 - insets)
        rin = np.clip(rows + (sw if side == "T" else -sw), 0, S.shape[0] - 1)
        rout = np.clip(rows - (sw if side == "T" else -sw), 0, S.shape[0] - 1)
        G = gradmap[np.ix_(rows, along)].T; C = cohmap[np.ix_(rows, along)].T
        Slev = S[np.ix_(rows, along)].T
        satstep = (S[np.ix_(rin, along)] - S[np.ix_(rout, along)]).T
    strip = _strip_evidence(Slev)
    E = (w["grad"] * _norm(G) + w["sat"] * _norm(np.clip(satstep, 0, None))
         + w["coh"] * _norm(C) + w["strip"] * _norm(np.clip(strip, 0, None)))
    seed_pen = w["seed"] * _norm(np.abs(insets - seed_inset))
    o0, o1, score = _best_line(E, seed_pen, w["max_tilt"])
    s0 = lo_px + float(np.clip(o0, 0, len(insets) - 1)); s1 = lo_px + float(np.clip(o1, 0, len(insets) - 1))
    if vertical:
        p0 = ((x1 + s0) if side == "L" else (x2 - s0), along[0])
        p1 = ((x1 + s1) if side == "L" else (x2 - s1), along[-1])
    else:
        p0 = (along[0], (y1 + s0) if side == "T" else (y2 - s0))
        p1 = (along[-1], (y1 + s1) if side == "T" else (y2 - s1))
    path = [(p0[0] + (p1[0] - p0[0]) * k / 24.0, p0[1] + (p1[1] - p0[1]) * k / 24.0) for k in range(25)]
    return p0, p1, score, path


def _line_from_pts(p0, p1, vertical):
    if vertical:
        (x0, y0), (x1, y1) = p0, p1
        a = (x1 - x0) / (y1 - y0) if abs(y1 - y0) > 1e-6 else 0.0
        return ("v", a, x0 - a * y0)
    (x0, y0), (x1, y1) = p0, p1
    a = (y1 - y0) / (x1 - x0) if abs(x1 - x0) > 1e-6 else 0.0
    return ("h", a, y0 - a * x0)


def _intersect(vline, hline):
    _, a, b = vline; _, c, d = hline
    denom = 1.0 - c * a
    if abs(denom) < 1e-9:
        return None
    y = (c * b + d) / denom
    return [float(a * y + b), float(y)]


def find_inner_frame_dp(warped, cb, seed=None, cap=CAP, w_grad=W_GRAD, w_sat=W_SAT, w_coh=W_COH,
                        w_strip=W_STRIP, w_seed=W_SEED, max_tilt=MAX_TILT, step_w=STEP_W,
                        margin=MARGIN, lo=LO):
    H, W = warped.shape[:2]
    x1, y1, x2, y2 = [int(round(v * d)) for v, d in zip(cb, [W, H, W, H])]
    iw, ih = max(x2 - x1, 1), max(y2 - y1, 1)
    cap_px = max(8, int(cap * iw)); lo_px = max(1, int(lo * iw))
    gray = cv2.GaussianBlur(cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 1.2)
    gx = np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3))
    gy = np.abs(cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3))
    S = cv2.cvtColor(warped, cv2.COLOR_BGR2HSV)[:, :, 1].astype(np.float32)
    Vmap, Hmap = _IF.coherence_edges(warped)

    if seed is None:
        seed = {"L": 0.03 * iw, "R": 0.03 * iw, "T": 0.03 * iw, "B": 0.03 * iw}
    w = {"grad": w_grad, "sat": w_sat, "coh": w_coh, "strip": w_strip, "seed": w_seed,
         "max_tilt": int(max_tilt), "step_w": int(step_w), "margin": margin}
    cbpx = (x1, y1, x2, y2)

    eL = _edge("L", gx, S, Vmap, cbpx, seed["L"], cap_px, lo_px, w)
    eR = _edge("R", gx, S, Vmap, cbpx, seed["R"], cap_px, lo_px, w)
    eT = _edge("T", gy, S, Hmap, cbpx, seed["T"], cap_px, lo_px, w)
    eB = _edge("B", gy, S, Hmap, cbpx, seed["B"], cap_px, lo_px, w)

    lL = _line_from_pts(eL[0], eL[1], True);  lR = _line_from_pts(eR[0], eR[1], True)
    lT = _line_from_pts(eT[0], eT[1], False); lB = _line_from_pts(eB[0], eB[1], False)
    TL = _intersect(lL, lT); TR = _intersect(lR, lT); BR = _intersect(lR, lB); BL = _intersect(lL, lB)
    corners = [TL, TR, BR, BL]
    if any(c is None for c in corners):
        corners = [[x1 + seed["L"], y1 + seed["T"]], [x2 - seed["R"], y1 + seed["T"]],
                   [x2 - seed["R"], y2 - seed["B"]], [x1 + seed["L"], y2 - seed["B"]]]

    (tlx, tly), (trx, tryy), (brx, bry), (blx, bly) = corners
    iL = (tlx + blx) / 2 - x1; iR = x2 - (trx + brx) / 2
    iT = (tly + tryy) / 2 - y1; iB = y2 - (bly + bry) / 2
    iL, iR, iT, iB = [max(0.0, v) for v in (iL, iR, iT, iB)]
    lr = iL / (iL + iR + 1e-6) * 100; tb = iT / (iT + iB + 1e-6) * 100

    pinned = (max(iL, iR) >= 0.97 * cap_px) or (max(iT, iB) >= 0.97 * cap_px)
    minscore = min(eL[2], eR[2], eT[2], eB[2])
    reliable = bool(minscore > 0.15 and not pinned)

    return {
        "left_right": f"{int(round(lr))}/{100-int(round(lr))}",
        "top_bottom": f"{int(round(tb))}/{100-int(round(tb))}",
        "insets_px": {"L": int(round(iL)), "R": int(round(iR)), "T": int(round(iT)), "B": int(round(iB))},
        "corners": corners, "paths": {"L": eL[3], "R": eR[3], "T": eT[3], "B": eB[3]},
        "edge_scores": {"L": round(eL[2], 3), "R": round(eR[2], 3), "T": round(eT[2], 3), "B": round(eB[2], 3)},
        "frame_px": (int(x1 + iL), int(y1 + iT), int(x2 - iR), int(y2 - iB)),
        "cb_px": (x1, y1, x2, y2), "reliable": reliable, "_source": "dp",
    }
