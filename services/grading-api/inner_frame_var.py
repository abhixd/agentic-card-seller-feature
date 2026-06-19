"""
inner_frame_var.py — cumulative-variance inner-boundary detector (polar-variance idea, adapted).

Objective (agreed with the user, traceable to measured failures):
  Find the OUTERMOST card-aspect quad whose perimeter sits at a SUSTAINED cumulative-variance jump,
  at least a small relative gap inside the cut edge, scored on a robust fraction of each edge so a
  broken band doesn't derail it.

Why cumulative variance (Rosado-Toro et al., IEEE TIP — "DP using polar variance"): the homogeneous
border has low cumulative color-variance; the art makes it JUMP and STAY high. A thin spike (bevel,
holo glint) barely moves a *cumulative* statistic, so — unlike gradient/coherence — it can't latch
onto the cut-edge bevel or a deep interior art line. This is the size-robust replacement for the
hand-set `cap` that dominated the DP detector.

Per side: scan inward from the cut edge; CumVar(d) = variance of the strip [edge..d] (summed over
L,a,b). The boundary at each position = the OUTERMOST d ≥ lo where CumVar crosses border-level +
margin. Robust-line-fit the per-position boundaries (median + MAD reject → gap tolerance). The 4
lines intersect into a quad; its aspect is checked against the card (a card design-frame is ~card
aspect). All params are RELATIVE to card size (the DP detector's fatal bug was fixed-pixel params).

Returns the same shape as inner_frame.find_inner_frame plus 'corners', 'paths', 'edge_conf'.
"""
import numpy as np, cv2

LO        = 0.006   # min inset (fraction of card width) — clear the cut-edge bevel, don't eat thin rims
DMAX      = 0.106   # max inset searched (loose safety bound) — tuned vs labels (was 0.13)
MARGIN    = 0.14    # trim each edge's ends (corner zones)
GAMMA     = 0.022   # along-edge smoothing (fraction of edge length) — tuned (was 0.012)
JUMP_FRAC = 0.11    # CumVar crossing = border-level + JUMP_FRAC·(max − border-level) — tuned (was 0.20)
SNAP      = 0.010   # snap window (fraction of card width): lock the variance boundary onto the
                    # strongest contrast edge within ±this (the β·exp(−g) localization). 0 = pure variance.
SNAP_BIAS = 0.35    # anchoring of the snap to the variance estimate: prefer the CLOSEST strong edge,
                    # not the globally strongest. 0 = unconstrained (runs onto interior lines on fuzzy borders).
PEAK_PCT  = 100     # percentile of CumVar used as the "content" reference for the crossing threshold.
                    # 100 = per-position max (sensitive to strong deep art → top/bottom overshoot).
                    # lower (e.g. 70) = typical content level → faint outer transitions register.
ASPECT_EPS = 0.18   # tolerance on |quad-aspect − card-aspect| / card-aspect before flagging
CANONICAL_W = 1000  # RESOLUTION-INVARIANCE: the detector resizes the warp to this width internally,
                    # computes, and scales the result back. The warp arrives at 630px (production) or
                    # 1260px (lab); fixed-px kernels/windows would otherwise detect different features
                    # at each scale (this is the bug that made tuning at 640 not transfer to deployment).
LAM   = 0.583 # BALANCE λ = β/(α+β) ∈ [0,1] between the two complementary cost terms. The per-position
              # argmin is SCALE-invariant, so only this RATIO matters — ONE knob, not two. λ→0 = trust the
              # REGION (cumulative variance — keep the boundary in the homogeneous border); λ→1 = trust the
              # EDGE (gradient — sit on the inner line). 0.583 reproduces the old (α,β)=(1.0,1.4) exactly.
ALPHA = round(1.0 - LAM, 3)   # region weight (derived from λ); kept module-level for back-compat
BETA  = round(LAM, 3)         # edge weight (derived from λ)
GAIN  = 4.0   # sharpness of the gradient reward in exp(−gain·g); larger = only strong edges count.
CHROMA = 1.5  # weight of the Lab a/b (COLOUR) gradient added to the luminance gradient in the edge term.
              # Lets the detector SEE colour edges the gray gradient is blind to — e.g. a yellow→cream
              # border (strong colour, weak luminance), the classic-yellow-border failure. VALIDATED
              # 2026-06-15 on 8 labelled yellow-border cards: median err 8.0→1.4, leave-one-out robust,
              # non-yellow neutral (2/23 minor regressions). 0 = old grayscale-only behaviour.
BAND  = 5     # thin perpendicular band (px @ the 1000px canonical): each candidate line averages this many
              # adjacent ALONG-edge samples before CumVar/gradient, denoising the per-line reading so the
              # argmin stops jumping to a wrong feature on noisy/low-contrast edges. VALIDATED 2026-06-15:
              # mean err 4.69→4.45, MEDIAN flat (typical cards untouched — it's a hard-tail fix), 0 regressions,
              # leave-one-out robust; band≥7 starts breaking good cards (012 0.3→4.5). 1 = old 1-px behaviour.
SEED_W   = 0.0    # OUTER-INSET PRIOR — the prior's SHARE of the convex cost budget, in [0,1] (NOT an additive
                  # weight any more). cost = α·region + β·edge + SEED_W·seed_prior, with α+β+SEED_W = 1, where
                  # α=(1−SEED_W)(1−λ), β=(1−SEED_W)λ. seed_prior = ‖inset − SEED_FRAC‖ normalised to [0,1]; it pulls
                  # the argmin toward the OUTERMOST ~SEED_FRAC border so a deeper high-contrast internal line
                  # (art-window edge / title bar on holo cards) can't win. Bounded: at SEED_W=1 it's pure prior,
                  # at 0 it's the original evidence-only cost; it can only BREAK TIES, never out-weigh the evidence.
                  #
                  # DEFAULT OFF (0.0). History: an earlier ADDITIVE seed_w=1.5 looked like a 39-GT win (12.7→9.4)
                  # but was OVERFITTING — it forced every edge to ~3% (matching those GT cards' borders) and
                  # REGRESSED the held-out full-art cards (Charizard EX 04/07/09: L/R flipped, T/B 48/52→62/38),
                  # whose true silver border is thinner than 3%. Re-tune this share against the EXPANDED label set
                  # (now incl. full-art) before enabling. A per-card-type SEED_FRAC (thin full-art vs thick regular)
                  # is the likely real fix.
SEED_FRAC = 0.03  # expected border inset (fraction of card width) the prior pulls toward — typical printed border.
CONTENT_W = 0     # CONTENT-GATE forward window (px @ the 1000px canonical; <1 = fraction of card width). Gates the
                  # edge term by the variance of the strip just INSIDE each candidate inset, to suppress a strong
                  # edge with no real content behind it (foil glint, bevel, flat object) — the piece the docstring
                  # describes but never implemented (cost line was ungated). DEFAULT 0 (OFF).
                  # NEGATIVE RESULT (validated 2026-06-16, 39 GT cards): implementing the gate REGRESSES GT
                  # (12.7→13.1 at w=8, worse for larger w) and does NOT fix the holo/art-window latch (card_00
                  # 86/14→90/10) — because the latched art-window edge HAS content behind it, so the gate can't
                  # touch it. The docstring's gate addresses foil-edges-in-the-border, a failure mode our cards
                  # don't actually hit. Kept as an off-by-default param so the negative result is reproducible.


def _segment(warped, cb):
    """Coarse border-type / era segment from the printed-border colour: 'yellow' (classic/old), 'metallic'
    (silver full-art — the HARDEST segment, mean err ~6 vs ~4), or 'colored'. For confidence ROUTING only
    (route metallic flagged cards to review more readily) — NOT for parameters: α/β have no generalizable
    segment relationship (held-out 4.50 vs 4.54), border WIDTH doesn't correlate with segment, and the only
    type-related weight (chroma) is already global. Cheap HSV-ring read; a card-metadata (set/year) lookup
    is a more reliable source when available."""
    H, W = warped.shape[:2]
    x1, y1, x2, y2 = [int(round(v * d)) for v, d in zip(cb, [W, H, W, H])]
    iw = max(x2 - x1, 1)
    m = max(3, int(0.012 * iw)); Mo = max(m + 3, int(0.05 * iw))
    hsv = cv2.cvtColor(warped, cv2.COLOR_BGR2HSV)
    ring = np.zeros((H, W), bool)
    ring[y1 + m:y2 - m, x1 + m:x2 - m] = True; ring[y1 + Mo:y2 - Mo, x1 + Mo:x2 - Mo] = False
    px = hsv[ring]
    if px.size == 0:
        return "colored"
    hue = float(px[:, 0].mean()); sat = float(px[:, 1].mean())
    if 15 <= hue <= 45 and sat >= 70:
        return "yellow"
    return "metallic" if sat < 55 else "colored"


def _norm_rows(a):
    """Per-row (per-position-along-the-edge) min-max normalise to [0,1] so α and β are comparable
    regardless of a card's absolute contrast/variance scale."""
    lo = a.min(1, keepdims=True); rng = a.max(1, keepdims=True) - lo
    return (a - lo) / (rng + 1e-9)


def _cumvar(strip):
    """strip: (N_along, M_inset, C) feature (L,a,b in [0,1]). Returns CumVar[N, M] = sum over
    channels of the variance of strip[:, 0:d+1, :] (cumulative from the edge inward)."""
    N, M, C = strip.shape
    k = np.arange(1, M + 1, dtype=np.float64)[None, :]          # count of pixels in [0:d]
    cv = np.zeros((N, M))
    for c in range(C):
        s = strip[:, :, c].astype(np.float64)
        cs = np.cumsum(s, axis=1); cs2 = np.cumsum(s * s, axis=1)
        mean = cs / k
        cv += np.maximum(cs2 / k - mean * mean, 0.0)
    return cv


def _forward_var(strip, w):
    """CONTENT signal for the gradient gate: variance of the strip in a FORWARD window [d, d+w] for
    each inset d (summed over Lab channels). High where real card content (art / text) lies just
    inside the candidate boundary; low where only more border or a uniform region follows (a foil
    glint, the cut-edge bevel, or a flat internal object). strip: (N, M, C) → returns (N, M)."""
    N, M, C = strip.shape
    w = max(1, int(w))
    d = np.arange(M); e = np.minimum(d + w, M); k = np.maximum(e - d, 1).astype(np.float64)
    out = np.zeros((N, M))
    for c in range(C):
        s = strip[:, :, c].astype(np.float64)
        cs  = np.concatenate([np.zeros((N, 1)), np.cumsum(s, axis=1)],     axis=1)   # (N, M+1)
        cs2 = np.concatenate([np.zeros((N, 1)), np.cumsum(s * s, axis=1)], axis=1)
        ssum  = cs[:, e]  - cs[:, d]
        ssum2 = cs2[:, e] - cs2[:, d]
        mean = ssum / k[None, :]
        out += np.maximum(ssum2 / k[None, :] - mean * mean, 0.0)
    return out


def _robust_line(along, insets, tol_frac=0.10, span=None):
    """Fit inset = a·along + b robustly (median + MAD outlier reject). Returns (a, b, inlier_frac)."""
    along = np.asarray(along, float); insets = np.asarray(insets, float)
    med = np.median(insets); mad = np.median(np.abs(insets - med)) * 1.4826
    tol = max(3 * mad, tol_frac * (span or max(1.0, med)))
    keep = np.abs(insets - med) <= tol
    if keep.sum() >= max(6, 0.3 * len(insets)):
        a, b = np.polyfit(along[keep], insets[keep], 1)
    else:
        a, b = 0.0, med
    return float(a), float(b), float(keep.mean())


def _side_boundary(side, lab, grad, cbpx, lo_px, dmax_px, gamma_px, margin, alpha, beta, gain, band,
                   seed_w=SEED_W, seed_px=None, content_w=0, max_tilt_px=None, edge_decay=0.0,
                   band_w=0.0, band_center_px=0.0, band_width_px=1.0):
    """JOINT cost per position (Rosado-Toro α·V + β·exp(−g), made robust): for each inset d ≥ lo,
        cost(d) = α·CumVar(edge→d)  +  β·exp(−gain · g(d)·content(d))  +  w_seed·‖d − seed‖
    with the three CUE WEIGHTS forming a convex combination: α + β + w_seed = 1 (each in [0,1]); they
    arrive pre-scaled so the seed prior can only break ties, never out-weigh the evidence. (gain,
    gamma, band, chroma are shape/scale params, not combination weights — they're not in the sum.)
    The variance term keeps the boundary inside the HOMOGENEOUS border (it can't run deep into the
    picture); the gradient term locks it onto the inner LINE — but GATED by content(d) = forward
    variance, so an edge only counts where real content lies just inside it (a foil/holo edge within
    the border has a strong gradient but no content behind → suppressed). The seed term is an OUTER
    prior that pulls toward the expected border inset, so a deeper internal holo line (just as long /
    high-gradient as the border) can't win over the OUTERMOST border line. One objective: the line is
    accounted for *inside* the variance. Then robust-line-fit. Returns (p_start,p_end,frac,path) px."""
    x1, y1, x2, y2 = cbpx
    vertical = side in ("L", "R")
    insets = np.arange(lo_px, dmax_px)                          # px, edge→inside (≥ lo: the min-gap)
    if vertical:
        a0 = y1 + int(margin * (y2 - y1)); a1 = y2 - int(margin * (y2 - y1))
        along = np.arange(a0, a1)
        cols = (x1 + insets) if side == "L" else (x2 - insets)
        strip = lab[np.ix_(along, cols)]                        # (N, M, 3)
        gstrip = grad[np.ix_(along, cols)]                      # (N, M) gradient ⟂ to the edge
    else:
        a0 = x1 + int(margin * (x2 - x1)); a1 = x2 - int(margin * (x2 - x1))
        along = np.arange(a0, a1)
        rows = (y1 + insets) if side == "T" else (y2 - insets)
        strip = lab[np.ix_(rows, along)].transpose(1, 0, 2)     # (N_along, M_inset, 3)
        gstrip = grad[np.ix_(rows, along)].T                    # (N_along, M_inset)
    if band > 1:                                               # THIN PERPENDICULAR BAND: average `band` adjacent
        kb = np.ones(band) / band                              # along-edge samples per line → denoise the per-line
        strip = strip.copy()                                   # reading so the argmin doesn't jump to a wrong
        for _c in range(strip.shape[2]):                       # feature on noisy/low-contrast edges
            strip[:, :, _c] = np.apply_along_axis(lambda v: np.convolve(v, kb, "same"), 0, strip[:, :, _c])
        gstrip = np.apply_along_axis(lambda v: np.convolve(v, kb, "same"), 0, gstrip)
    cv = _cumvar(strip)                                          # (N, M) cumulative variance edge→d
    content = _forward_var(strip, content_w) if content_w > 0 else None   # CONTENT just inside d
    if gamma_px >= 2:                                           # smooth all cues along the edge (denoise)
        ker = np.ones(gamma_px) / gamma_px
        sm = lambda A: np.apply_along_axis(lambda r: np.convolve(r, ker, "same"), 0, A)
        cv = sm(cv); gstrip = sm(gstrip)
        if content is not None:
            content = sm(content)
    # CONTENT-GATED edge: a gradient only counts where real content lies just inside it. Without the
    # gate a strong edge with NO content behind (foil glint, bevel, flat internal object) scores the
    # same as the true frame line; the gate (×content) suppresses it. content_w=0 → ungated (legacy).
    edge_sig = _norm_rows(gstrip)
    if content is not None:
        edge_sig = edge_sig * _norm_rows(content)
    if edge_decay > 0:                                          # #2 distance-attenuate the edge term: down-weight
        M = edge_sig.shape[1]                                   # FAR gradients so a near-WEAK frame beats a far-STRONG
        decay = np.exp(-edge_decay * (np.arange(M) / max(M - 1, 1)))   # interior line (1 at lo → exp(−edge_decay) at dmax)
        edge_sig = edge_sig * decay[None, :]
    cost = alpha * _norm_rows(cv) + beta * np.exp(-gain * edge_sig)   # JOINT cost per (pos, d)
    if band_w > 0:                                             # #2b BAND prior: a Gaussian WELL penalty — ~0 inside the
        well = band_w * (1.0 - np.exp(-((insets - band_center_px) ** 2) / (2.0 * band_width_px ** 2 + 1e-9)))
        cost = cost + well[None, :]                            # expected-border band, rising when too CLOSE or too FAR
    if seed_w > 0 and seed_px is not None:                     # OUTER prior: ‖inset − seed‖ normalised to [0,1]
        d_seed = np.abs(insets - seed_px).astype(np.float64)
        rng = d_seed.max() - d_seed.min()
        seed_pen = (d_seed - d_seed.min()) / (rng + 1e-9)
        cost = cost + seed_w * seed_pen[None, :]               # pull the argmin toward the expected border line
    first = np.argmin(cost, axis=1)                            # min-cost inset per position
    bnd_px = insets[0] + first                                  # boundary inset (px) per position
    floor_frac = float(np.mean(first <= 1))                     # picks pinned at the lo_px min-gap floor:
    # when the cost finds NO real boundary (homogeneous colorless border → variance stays low onto the
    # bevel, gradient latches the inner foil line) the argmin piles up at the floor → an UNRELIABLE edge.
    a, b, frac = _robust_line(along, bnd_px, span=len(insets))
    if max_tilt_px is not None:                                # #3 angle constraint: cap the slope so content-feature
        edge_len = max(float(along[-1] - along[0]), 1.0)       # argmins can't tilt the fitted line off axis-aligned
        max_slope = max_tilt_px / edge_len
        if abs(a) > max_slope:
            a = float(np.clip(a, -max_slope, max_slope))
            b = float(np.median(bnd_px - a * along))           # re-center the intercept for the clamped slope
    s0 = a * along[0] + b; s1 = a * along[-1] + b
    if vertical:
        p0 = ((x1 + s0) if side == "L" else (x2 - s0), along[0])
        p1 = ((x1 + s1) if side == "L" else (x2 - s1), along[-1])
    else:
        p0 = (along[0], (y1 + s0) if side == "T" else (y2 - s0))
        p1 = (along[-1], (y1 + s1) if side == "T" else (y2 - s1))
    path = [(p0[0] + (p1[0] - p0[0]) * k / 24.0, p0[1] + (p1[1] - p0[1]) * k / 24.0) for k in range(25)]
    return p0, p1, frac, path, floor_frac


def _line(p0, p1, vertical):
    (x0, y0), (x1, y1) = p0, p1
    if vertical:
        a = (x1 - x0) / (y1 - y0) if abs(y1 - y0) > 1e-6 else 0.0
        return ("v", a, x0 - a * y0)
    a = (y1 - y0) / (x1 - x0) if abs(x1 - x0) > 1e-6 else 0.0
    return ("h", a, y0 - a * x0)


def _intersect(v, h):
    _, a, b = v; _, c, d = h
    den = 1.0 - c * a
    if abs(den) < 1e-9:
        return None
    y = (c * b + d) / den
    return [float(a * y + b), float(y)]


def find_inner_frame_var(warped, cb, lo=LO, dmax=DMAX, margin=MARGIN, gamma=GAMMA,
                         lam=LAM, gain=GAIN, chroma=CHROMA, band=BAND, alpha=None, beta=None,
                         seed_w=SEED_W, seed_frac=SEED_FRAC, content_w=CONTENT_W,
                         canonical_w=CANONICAL_W, aspect_eps=ASPECT_EPS,
                         max_tilt_px=None, edge_decay=0.0,
                         band_w=0.0, band_center=0.03, band_width=0.02, **_ignore):
    # CONVEX cue weights that SUM TO 1: cost = α·region + β·edge + w_seed·seed_prior.
    #   w_seed ∈ [0,1] is the seed prior's share of the budget; the remaining (1−w_seed) is the
    #   image-evidence budget, split between region and edge by the balance λ. So:
    #       α = (1−w_seed)·(1−λ),  β = (1−w_seed)·λ,  and  α + β + w_seed = 1.
    #   Every weight is now bounded [0,1] and the seed prior can never out-weigh the evidence — it
    #   can only break ties (fixing the old additive seed_w, which could exceed the [0,1] cost).
    seed_w = float(min(max(seed_w, 0.0), 1.0))                 # clamp the prior's budget share to [0,1]
    if alpha is None or beta is None:                          # default: derive α,β from λ within the evidence budget
        ev = 1.0 - seed_w
        alpha = ev * (1.0 - lam); beta = ev * lam
    H0, W0 = warped.shape[:2]
    if canonical_w and abs(W0 - canonical_w) > 2:              # work at one fixed scale → resolution-invariant
        sc = canonical_w / W0
        warped = cv2.resize(warped, (canonical_w, max(1, int(round(H0 * sc)))),
                            interpolation=cv2.INTER_AREA if sc < 1 else cv2.INTER_LINEAR)
    else:
        sc = 1.0
    H, W = warped.shape[:2]
    x1, y1, x2, y2 = [int(round(v * d)) for v, d in zip(cb, [W, H, W, H])]
    iw, ih = max(x2 - x1, 1), max(y2 - y1, 1)
    lo_px = max(2, int(lo * iw)); dmax_px = max(lo_px + 8, int(dmax * iw))
    gamma_px = max(2, int(gamma * ih))
    lab = cv2.cvtColor(warped, cv2.COLOR_BGR2LAB).astype(np.float32) / 255.0
    g = cv2.GaussianBlur(cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY).astype(np.float32), (0, 0), 1.0)
    gx = np.abs(cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3))        # ⟂ gradient for L/R edges
    gy = np.abs(cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3))        # ⟂ gradient for T/B edges
    if chroma > 0:                                             # add Lab a/b COLOUR edges (default off):
        for ch in (1, 2):                                      # a, b carry colour the gray gradient misses
            cc = cv2.GaussianBlur(lab[:, :, ch] * 255.0, (0, 0), 1.0)   # ×255 → comparable scale to gray
            gx += chroma * np.abs(cv2.Sobel(cc, cv2.CV_32F, 1, 0, ksize=3))
            gy += chroma * np.abs(cv2.Sobel(cc, cv2.CV_32F, 0, 1, ksize=3))
    cbpx = (x1, y1, x2, y2)
    seed_px = seed_frac * iw                                   # expected border inset (px @ canonical scale)
    cw_px = int(round(content_w * iw)) if 0 < content_w < 1 else int(content_w)   # forward-content window (px)
    band_center_px = band_center * iw; band_width_px = max(band_width * iw, 1.0)   # well prior center/σ (px @ canonical)

    eL = _side_boundary("L", lab, gx, cbpx, lo_px, dmax_px, gamma_px, margin, alpha, beta, gain, band, seed_w, seed_px, cw_px, max_tilt_px, edge_decay, band_w, band_center_px, band_width_px)
    eR = _side_boundary("R", lab, gx, cbpx, lo_px, dmax_px, gamma_px, margin, alpha, beta, gain, band, seed_w, seed_px, cw_px, max_tilt_px, edge_decay, band_w, band_center_px, band_width_px)
    eT = _side_boundary("T", lab, gy, cbpx, lo_px, dmax_px, gamma_px, margin, alpha, beta, gain, band, seed_w, seed_px, cw_px, max_tilt_px, edge_decay, band_w, band_center_px, band_width_px)
    eB = _side_boundary("B", lab, gy, cbpx, lo_px, dmax_px, gamma_px, margin, alpha, beta, gain, band, seed_w, seed_px, cw_px, max_tilt_px, edge_decay, band_w, band_center_px, band_width_px)

    lL = _line(eL[0], eL[1], True);  lR = _line(eR[0], eR[1], True)
    lT = _line(eT[0], eT[1], False); lB = _line(eB[0], eB[1], False)
    TL = _intersect(lL, lT); TR = _intersect(lR, lT); BR = _intersect(lR, lB); BL = _intersect(lL, lB)
    corners = [TL, TR, BR, BL]
    if any(c is None for c in corners):
        corners = [[x1 + lo_px, y1 + lo_px], [x2 - lo_px, y1 + lo_px],
                   [x2 - lo_px, y2 - lo_px], [x1 + lo_px, y2 - lo_px]]

    (tlx, tly), (trx, tryy), (brx, bry), (blx, bly) = corners
    iL = (tlx + blx) / 2 - x1; iR = x2 - (trx + brx) / 2
    iT = (tly + tryy) / 2 - y1; iB = y2 - (bly + bry) / 2
    iL, iR, iT, iB = [max(0.0, v) for v in (iL, iR, iT, iB)]
    lr = iL / (iL + iR + 1e-6) * 100; tb = iT / (iT + iB + 1e-6) * 100

    inner_w = (iw - iL - iR); inner_h = (ih - iT - iB)
    q_asp = inner_w / max(inner_h, 1); card_asp = iw / ih
    aspect_dev = abs(q_asp - card_asp) / card_asp
    conf = {"L": round(eL[2], 2), "R": round(eR[2], 2), "T": round(eT[2], 2), "B": round(eB[2], 2)}
    floor = {"L": round(eL[4], 2), "R": round(eR[4], 2), "T": round(eT[4], 2), "B": round(eB[4], 2)}
    # an edge is UNRELIABLE if its fit is loose (low inlier frac) OR its picks piled up at the min-gap
    # floor (no real boundary found — the colorless-border failure). Bias toward flagging: a false flag
    # just routes the card to manual/VLM, a false pass returns a confident wrong centering.
    reliable = bool(min(conf.values()) >= 0.45 and max(floor.values()) <= 0.30 and aspect_dev <= aspect_eps)

    inv = 1.0 / sc; _s = lambda v: float(v) * inv           # scale px outputs back to the INPUT resolution
    return {
        "left_right": f"{int(round(lr))}/{100-int(round(lr))}",   # ratios are scale-invariant
        "top_bottom": f"{int(round(tb))}/{100-int(round(tb))}",
        "insets_px": {"L": int(round(iL*inv)), "R": int(round(iR*inv)), "T": int(round(iT*inv)), "B": int(round(iB*inv))},
        "corners": [[_s(x), _s(y)] for x, y in corners],
        "paths": {k: [[_s(x), _s(y)] for x, y in p] for k, p in
                  {"L": eL[3], "R": eR[3], "T": eT[3], "B": eB[3]}.items()},
        "edge_conf": conf, "floor_frac": floor, "aspect_dev": round(aspect_dev, 3),
        "segment": _segment(warped, cb),
        "frame_px": (int(round((x1+iL)*inv)), int(round((y1+iT)*inv)), int(round((x2-iR)*inv)), int(round((y2-iB)*inv))),
        "cb_px": (int(round(x1*inv)), int(round(y1*inv)), int(round(x2*inv)), int(round(y2*inv))),
        "reliable": reliable, "_source": "var",
    }
