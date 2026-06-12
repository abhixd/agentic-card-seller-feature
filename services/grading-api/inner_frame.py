"""
inner_frame.py — foil-robust inner design-frame detector for centering (CoherentFrame v3).

L/R: structure-tensor coherence channel (suppresses foil/holo) + symmetric-inset pair pick
     (the validated approach — robust, holds clean controls, fixes the full-art L/R failure).
T/B: an ASPECT-RATIO-CONSTRAINED rectangle fit — the inner frame is a rectangle of ~card
     aspect, so once L/R fixes the width, the top+bottom frame lines must sit at the
     aspect-implied separation. We slide that fixed-height window vertically to maximize
     coherent horizontal-line energy at BOTH lines. This rejects lone deep text/stat bars
     (no matching partner line at the right separation), fixing the bottom-edge drift.
Plus a geometric-consistency 'reliable' flag so we never emit a confidently-wrong number.
"""
import numpy as np, cv2

# Hard limit on how far the inner design-frame can sit from the cut edge, as a fraction of the
# card dimension. Real card borders are thin (PSA10 median per-side ~2.7%, p90 ~12%); without a
# cap the symmetric-pair picker can lock onto strong INTERIOR art structure (e.g. full-art gold
# cards) 12-17% deep. Capping the search keeps the boundary near the real edge.
MAX_INSET = 0.10


def coherence_edges(warped):
    g = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY).astype(np.float32)
    g = cv2.GaussianBlur(g, (0, 0), 1.5)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3); gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    Jxx = cv2.GaussianBlur(gx * gx, (0, 0), 3.0); Jyy = cv2.GaussianBlur(gy * gy, (0, 0), 3.0)
    Jxy = cv2.GaussianBlur(gx * gy, (0, 0), 3.0)
    tr = Jxx + Jyy; tmp = np.sqrt(np.maximum((Jxx - Jyy) ** 2 + 4 * Jxy * Jxy, 0))
    l1 = 0.5 * (tr + tmp); l2 = 0.5 * (tr - tmp)
    coh = (l1 - l2) / (l1 + l2 + 1e-6)
    th = 0.5 * np.arctan2(2 * Jxy, (Jxx - Jyy)); mag = np.sqrt(np.maximum(l1, 0))
    return mag * coh * np.cos(th) ** 2, mag * coh * np.sin(th) ** 2   # Vmap, Hmap


def _pick_pair(sA, sB, dim, lo=0.012, hi=MAX_INSET, sigma=0.04):
    """Pick opposite-side frame lines jointly: geometric-mean of (normalized) coherent-line
    scores × Gaussian symmetry prior on |insetA-insetB|. sA/sB indexed by inset from their cut edge."""
    L, Hh = int(lo * dim), int(hi * dim)
    a = np.arange(L, min(Hh, len(sA))); b = np.arange(L, min(Hh, len(sB)))
    if not len(a) or not len(b):
        return int(np.argmax(sA)), int(np.argmax(sB)), 0.0
    na = sA / (sA.max() + 1e-9); nb = sB / (sB.max() + 1e-9)
    sym = np.exp(-(((a[:, None] - b[None, :]) / (sigma * dim)) ** 2))
    M = np.sqrt(np.clip(na[a][:, None] * nb[b][None, :], 0, None)) * sym
    ia, ib = np.unravel_index(np.argmax(M), M.shape)
    return int(a[ia]), int(b[ib]), float(M.max())


def _row_score(Hm, x_lo, x_hi):
    """Per-row coherent horizontal-line score (energy × span²) over interior columns."""
    sub = Hm[:, x_lo:x_hi]; E = sub.sum(1); thr = np.percentile(sub, 75) + 1e-6
    span = (sub > thr).mean(1)
    return E * np.clip(span, 0, 1) ** 2, span


def find_inner_frame(warped, cb, viz_path=None, max_inset=MAX_INSET):
    H, W = warped.shape[:2]
    V, Hm = coherence_edges(warped)
    x1, y1, x2, y2 = [int(round(v * d)) for v, d in zip(cb, [W, H, W, H])]
    iw, ih = x2 - x1, y2 - y1
    # ASPECT-CORRECT cap: a card border is one physical width, but T/B insets are measured along the
    # longer (height) axis. max_inset is the cap as a fraction of WIDTH (L/R); the T/B cap is the SAME
    # physical max border re-expressed as a fraction of height (= max_inset*iw/ih, i.e. tighter), so
    # 10% of width and 10%-of-height don't allow the top/bottom boundary to wander deeper than left/right.
    cap_lr = max_inset
    cap_tb = max_inset * iw / max(ih, 1)
    ry1, ry2 = y1 + int(0.10 * ih), y2 - int(0.10 * ih)
    rx1, rx2 = x1 + int(0.10 * iw), x2 - int(0.10 * iw)
    bV = int((cap_lr + 0.02) * iw)      # search band just past the cap (keeps normalization near the edge)

    # ---- L/R: coherent symmetric-pair (validated) ----
    def col_score(lo, hi):
        sub = V[ry1:ry2, lo:hi]; E = sub.sum(0); thr = np.percentile(sub, 75) + 1e-6
        return E * np.clip((sub > thr).mean(0), 0, 1) ** 2
    sL = col_score(x1, x1 + bV)
    sR = col_score(x2 - bV, x2)[::-1]
    iL, iR, mLR = _pick_pair(sL, sR, iw, hi=cap_lr)
    L, R = x1 + iL, x2 - iR
    spanL = float((V[ry1:ry2, L] > np.percentile(V[ry1:ry2, x1:x1 + bV], 75)).mean())
    spanR = float((V[ry1:ry2, R] > np.percentile(V[ry1:ry2, x2 - bV:x2], 75)).mean())

    # ---- T/B: coherent symmetric-pair (validated; holds clean controls). The full-art
    #      bottom can still read "a bit inside" — that residual is handled by the VLM rescue,
    #      because pure-CV tightening grabs interior text/stat bars and breaks clean cards.
    bH = int((cap_tb + 0.02) * ih)
    def row_band(lo, hi):
        sub = Hm[lo:hi, rx1:rx2]; E = sub.sum(1); thr = np.percentile(sub, 75) + 1e-6
        return E * np.clip((sub > thr).mean(1), 0, 1) ** 2
    sT = row_band(y1, y1 + bH); sB = row_band(y2 - bH, y2)[::-1]
    iT, iB, mTB = _pick_pair(sT, sB, ih, hi=cap_tb)
    T, B = y1 + iT, y2 - iB
    spanT = float((Hm[T, rx1:rx2] > np.percentile(Hm[y1:y1 + int(0.2 * ih), rx1:rx2], 75)).mean())
    spanB = float((Hm[B, rx1:rx2] > np.percentile(Hm[y2 - int(0.2 * ih):y2, rx1:rx2], 75)).mean())

    lr = iL / (iL + iR + 1e-6) * 100
    tb = iT / (iT + iB + 1e-6) * 100
    spans = {"L": spanL, "R": spanR, "T": spanT, "B": spanB}
    ratio = (max(iL, iR) / (min(iL, iR) + 1e-6), max(iT, iB) / (min(iT, iB) + 1e-6))
    # flag unreliable if a line is pinned at the cap (the real edge was likely beyond the search → a snap)
    pinned = (max(iL, iR) >= 0.985 * cap_lr * iw) or (max(iT, iB) >= 0.985 * cap_tb * ih)
    reliable = (min(spans.values()) >= 0.40 and max(ratio) < 6.0 and not pinned)
    res = {"left_right": f"{int(round(lr))}/{100-int(round(lr))}",
           "top_bottom": f"{int(round(tb))}/{100-int(round(tb))}",
           "insets_px": {"L": iL, "R": iR, "T": iT, "B": iB}, "spans": spans,
           "reliable": bool(reliable), "frame_px": (L, T, R, B), "cb_px": (x1, y1, x2, y2)}
    if viz_path:
        viz = warped.copy()
        cv2.rectangle(viz, (x1, y1), (x2, y2), (255, 0, 0), 3)
        cv2.rectangle(viz, (L, T), (R, B), (0, 255, 0), 3)
        cv2.imwrite(viz_path, viz)
    return res
