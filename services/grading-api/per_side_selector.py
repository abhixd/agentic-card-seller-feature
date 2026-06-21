"""
per_side_selector.py — a PER-SIDE inner-frame selection framework.

WHY: no single inner-frame detector wins every card. coherence and variance are COMPLEMENTARY
*per side* (the best L may come from one detector, the best B from another). The per-side oracle
(pick the best edge per side, using GT) is ~78% tight on full-arts vs ~56% for the best single
detector. This module learns to APPROACH that oracle at runtime, with NO ground truth, by scoring
each candidate edge with a classifier over image features.

THE FRAMEWORK — three pluggable registries, so we can keep improving accuracy after rollout:
  1. DETECTORS  : name -> fn(ctx) -> {L,T,R,B} px        (add a new edge proposer here)
  2. FEATURES   : name -> fn(ctx, side, pos_px) -> float  (add a new signal here)
  3. the CLASSIFIER (PerSideSelector.model_factory)        (swap LogisticRegression -> GBM -> ...)

Each card -> a `ctx` (image + gradients + cb), computed ONCE. Each detector proposes 4 edges.
For every (side, candidate edge) we extract the full FEATURES vector; the classifier predicts
P(this edge is within TAU of the true edge); per side we keep argmax; we assemble the 4 winners
into the final inner frame. Training labels come from the corner GT (inner_gt_cb2.jsonl). We
validate leave-one-CARD-out so sides of the same card never leak across the train/test split.

PROD MODULES WIN on sys.path (coherence inner_frame is the shipping detector; the lab has a stale
shadow). GAPI first; research/notebooks appended for lab-only deps.
"""
from __future__ import annotations
import os, sys, json
_HERE = os.path.dirname(os.path.abspath(__file__))
_GAPI = os.path.normpath(os.path.join(_HERE, "..", "..", "services", "grading-api"))
sys.path.insert(0, _GAPI); sys.path.append(_HERE)

import numpy as np, cv2
from scipy.signal import find_peaks
import grader as G
import inner_frame as IF, inner_frame_var as VAR, inner_frame_dp as DP
# warp_cache (WC) + inner_edge_metric (M) are LAB-ONLY — imported lazily inside the training/eval
# functions so this module loads in PRODUCTION (inference = make_ctx + candidates + select) cleanly.

TAU = 0.012          # "tight" threshold: |edge - GT| / card_dim
CENTER = 0.034       # expected inner-border inset (fraction of card dim) — a soft prior, a FEATURE not a rule
SIDES = "LRTB"

# coherence+well and variance+well configs (the two detectors we validated). These are the DEFAULTS;
# the live values sit in _ACTIVE and are OVERRIDABLE at runtime (Phase 1 tunes them; a deploy/startup
# applies the tuned set from the checkpoint config). band_center = "where we expect the inner edge",
# the strongest prior — the main lever Phase 1 moves.
DEFAULT_COH_KW = dict(band_w=6.0, band_center=0.035, band_tol=0.018, band_fall=0.012)
DEFAULT_VAR_KW = dict(band_w=0.4, band_center=0.05, band_width=0.015, max_tilt_px=14)
DEFAULT_PEAK   = dict(k=5, lo=0.006, dmax=0.12)
_ACTIVE = {"coh": dict(DEFAULT_COH_KW), "var": dict(DEFAULT_VAR_KW), "peak": dict(DEFAULT_PEAK)}


def get_detector_params():
    """A deep copy of the live detector settings (for snapshotting / Phase-1 trials)."""
    return {k: dict(v) for k, v in _ACTIVE.items()}


def set_detector_params(params):
    """Atomically swap the LIVE detector settings (the grading-api calls this on deploy/startup so
    production candidate generation uses the checkpointed settings). Rebinds _ACTIVE as a whole so a
    concurrent grade reading it sees either the old or the new dict — never a half-updated one. The
    trainer does NOT call this during its search; it passes trial settings explicitly to candidates()."""
    global _ACTIVE
    if not params:
        return
    nxt = {k: dict(v) for k, v in _ACTIVE.items()}
    for k in ("coh", "var", "peak"):
        sub = params.get(k)
        if isinstance(sub, dict):
            nxt[k].update({kk: vv for kk, vv in sub.items() if vv is not None})
    _ACTIVE = nxt


def reset_detector_params():
    global _ACTIVE
    _ACTIVE = {"coh": dict(DEFAULT_COH_KW), "var": dict(DEFAULT_VAR_KW), "peak": dict(DEFAULT_PEAK)}


def apply_config(config):
    """Apply a checkpoint config_snapshot()'s detector settings to the live detectors (used by the
    grading-api when it loads the newest stored model so production matches the deployed config)."""
    if isinstance(config, dict):
        set_detector_params({"coh": config.get("coh_kw"), "var": config.get("var_kw"), "peak": config.get("peak")})


# ────────────────────────────────────────────────────────────────────────────
# CONTEXT — everything a detector or feature needs for one card, computed once.
# ────────────────────────────────────────────────────────────────────────────
def make_ctx(w, cw, cb_frac):
    """cb_frac: the outer box as FRACTIONS of the warp (the detectors' convention). We store cb in
    PIXELS for geometry/feature math and cb_frac for the detector calls (the one shared builder)."""
    H, W = w.shape[:2]
    fx1, fy1, fx2, fy2 = (float(v) for v in cb_frac)
    x1, y1, x2, y2 = fx1 * W, fy1 * H, fx2 * W, fy2 * H
    if (x2 - x1) < 0.3 * W or (y2 - y1) < 0.3 * H:     # degenerate cb -> unusable card
        return None
    m = w                                              # mask to the card contour, but only if it's sane
    if cw is not None:
        try:
            mm = G.mask_background_to_contour(w, cw)
            if (mm > 0).mean() > 0.2:
                m = mm
        except Exception:
            pass
    g = cv2.cvtColor(m, cv2.COLOR_BGR2GRAY).astype(np.float32) if m.ndim == 3 else m.astype(np.float32)
    gx = np.abs(cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3))
    gy = np.abs(cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3))
    return {"warped": w, "masked": m, "gray": g, "gx": gx, "gy": gy,
            "cb": (x1, y1, x2, y2), "cb_frac": (fx1, fy1, fx2, fy2),
            "W": W, "H": H, "cbw": x2 - x1, "cbh": y2 - y1,
            "grad_thr": float(np.percentile(np.maximum(gx, gy), 85))}


def prep_context(path, cb_override=None):
    """Training-time context from a CACHED warp. cb_override: use a known-good cb (e.g. the GT's
    stored cb_px) — some cached warps have degenerate cb metadata that collapses refine to (0,0,1,1)."""
    import warp_cache as WC                              # lab-only
    d = WC.load_warp(path)
    if d is None:
        return None
    w = d["warped"]; cw = d.get("cw")
    cb = cb_override if cb_override is not None else G.refine_cb_in_warped(w, d["cb"], balance=True, cw=cw)
    return make_ctx(w, cw, cb)


def _span(ctx, side):
    """The along-edge sampling extent for a side (cb interior, trimmed 10% to avoid corners)."""
    x1, y1, x2, y2 = ctx["cb"]; cw, ch = ctx["cbw"], ctx["cbh"]
    if side in "LR":
        return int(y1 + 0.10 * ch), int(y2 - 0.10 * ch)
    return int(x1 + 0.10 * cw), int(x2 - 0.10 * cw)


def inset_frac(ctx, side, pos):
    """Inset of an edge from the cb on that side, as a fraction of the card dim on that axis."""
    x1, y1, x2, y2 = ctx["cb"]
    return {"L": (pos - x1) / ctx["cbw"], "R": (x2 - pos) / ctx["cbw"],
            "T": (pos - y1) / ctx["cbh"], "B": (y2 - pos) / ctx["cbh"]}[side]


# ────────────────────────────────────────────────────────────────────────────
# DETECTORS — registry of edge proposers. fn(ctx) -> {L,T,R,B} px (or None).
# ────────────────────────────────────────────────────────────────────────────
DETECTORS = {}
def detector(name):
    def deco(fn): DETECTORS[name] = fn; return fn
    return deco

# GENERATORS propose MULTIPLE candidate lines per side (raises recall — the true edge being PRESENT
# among the candidates), unlike DETECTORS which commit to one edge per side.
GENERATORS = {}
def generator(name):
    def deco(fn): GENERATORS[name] = fn; return fn
    return deco

@detector("coh")
def _det_coh(ctx, params=None):
    try:
        L, T, R, B = IF.find_inner_frame(ctx["masked"], ctx["cb_frac"], **(params or _ACTIVE)["coh"])["frame_px"]
        return {"L": L, "T": T, "R": R, "B": B}
    except Exception:
        return None

@detector("var")
def _det_var(ctx, params=None):
    try:
        c = np.asarray(VAR.find_inner_frame_var(ctx["masked"], ctx["cb_frac"], **(params or _ACTIVE)["var"])["corners"], float)
        return {"L": (c[0,0]+c[3,0])/2, "R": (c[1,0]+c[2,0])/2, "T": (c[0,1]+c[1,1])/2, "B": (c[3,1]+c[2,1])/2}
    except Exception:
        return None

@detector("dp")
def _det_dp(ctx, params=None):
    try:
        L, T, R, B = DP.find_inner_frame_dp(ctx["warped"], ctx["cb_frac"])["frame_px"]
        return {"L": L, "T": T, "R": R, "B": B}
    except Exception:
        return None


# ────────────────────────────────────────────────────────────────────────────
# FEATURES — registry of per-side signals. fn(ctx, side, pos_px) -> float.
# These are the levers the classifier learns to weight. Add new ones freely.
# ────────────────────────────────────────────────────────────────────────────
FEATURES = {}
def feature(name):
    def deco(fn): FEATURES[name] = fn; return fn
    return deco

def _perp_strips(ctx, side, pos):
    """(inside, outside) pixel strips perpendicular to the edge. outside=toward the cut edge."""
    g = ctx["gray"]; a, b = _span(ctx, side)
    wp = max(int(0.022 * (ctx["cbw"] if side in "LR" else ctx["cbh"])), 6)
    p = int(round(pos))
    def strip(x0, x1, y0, y1):
        x0, x1 = max(0, x0), min(g.shape[1], x1); y0, y1 = max(0, y0), min(g.shape[0], y1)
        if x1 - x0 < 3 or y1 - y0 < 3: return None
        v = g[y0:y1, x0:x1]; v = v[v > 0]
        return v if v.size >= 10 else None
    if side == "T":   inn, out = strip(a, b, p, p+wp),   strip(a, b, p-wp, p)
    elif side == "B": inn, out = strip(a, b, p-wp, p),   strip(a, b, p, p+wp)
    elif side == "L": inn, out = strip(p, p+wp, a, b),   strip(p-wp, p, a, b)
    else:             inn, out = strip(p-wp, p, a, b),   strip(p, p+wp, a, b)
    return inn, out

@feature("border_asym")          # inside textured (art) vs outside uniform (border): the strongest single signal
def _f_asym(ctx, side, pos):
    inn, out = _perp_strips(ctx, side, pos)
    if inn is None or out is None: return np.nan
    return float(inn.std() - out.std())

@feature("out_std")              # outside uniformity (low => clean card-stock border outside the edge)
def _f_out_std(ctx, side, pos):
    _, out = _perp_strips(ctx, side, pos)
    return np.nan if out is None else float(out.std())

@feature("in_std")               # inside texture (high => art inside the edge)
def _f_in_std(ctx, side, pos):
    inn, _ = _perp_strips(ctx, side, pos)
    return np.nan if inn is None else float(inn.std())

@feature("out_intensity")        # outside mean brightness (the yellow/silver border tends to be bright)
def _f_out_int(ctx, side, pos):
    _, out = _perp_strips(ctx, side, pos)
    return np.nan if out is None else float(out.mean())

@feature("in_out_int_diff")      # inside-minus-outside mean intensity
def _f_int_diff(ctx, side, pos):
    inn, out = _perp_strips(ctx, side, pos)
    if inn is None or out is None: return np.nan
    return float(inn.mean() - out.mean())

def _ridge(ctx, side, pos):
    g_perp = ctx["gx"] if side in "LR" else ctx["gy"]; a, b = _span(ctx, side); p = int(round(pos))
    if side in "LR":
        lo, hi = max(0, p-3), min(g_perp.shape[1], p+4)
        if b-a < 5 or hi-lo < 2: return None
        prof = g_perp[a:b, lo:hi].max(1)
    else:
        lo, hi = max(0, p-3), min(g_perp.shape[0], p+4)
        if b-a < 5 or hi-lo < 2: return None
        prof = g_perp[lo:hi, a:b].max(0)
    return prof

@feature("grad_strength")        # mean perpendicular gradient at the edge (NB: a STRONG edge is often the latch)
def _f_grad(ctx, side, pos):
    prof = _ridge(ctx, side, pos)
    return np.nan if prof is None else float(prof.mean())

@feature("grad_continuity")      # fraction of the span with a strong perpendicular gradient (frame = continuous)
def _f_cont(ctx, side, pos):
    prof = _ridge(ctx, side, pos)
    return np.nan if prof is None else float((prof > ctx["grad_thr"]).mean())

@feature("inset")                # raw inset (fraction of card) — lets the model learn the band shape itself
def _f_inset(ctx, side, pos):
    return float(inset_frac(ctx, side, pos))

@feature("band_dist")            # |inset - expected center| — a soft prior, weighted by the model (not a hard rule)
def _f_band(ctx, side, pos):
    return float(abs(inset_frac(ctx, side, pos) - CENTER))


# ── content (text / rule / art) density tests — the outside-border & inside-content ideas ───────────
def _band_slices(ctx, side, pos):
    """(inside, outside) row/col slices for the band just in/out of the candidate edge."""
    a, b = _span(ctx, side)
    wp = max(int(0.025 * (ctx["cbw"] if side in "LR" else ctx["cbh"])), 6)
    p = int(round(pos))
    if side == "T":   inn, out = (slice(p, p + wp), slice(a, b)), (slice(max(0, p - wp), p), slice(a, b))
    elif side == "B": inn, out = (slice(max(0, p - wp), p), slice(a, b)), (slice(p, p + wp), slice(a, b))
    elif side == "L": inn, out = (slice(a, b), slice(p, p + wp)), (slice(a, b), slice(max(0, p - wp), p))
    else:             inn, out = (slice(a, b), slice(max(0, p - wp), p)), (slice(a, b), slice(p, p + wp))
    return inn, out

def _density(ctx, sl):
    """Fraction of valid pixels in the band that are strong edges — i.e. text/rules/art, not clean margin."""
    rs, cs = sl
    g = ctx["gray"][rs, cs]
    if g.size < 10:
        return np.nan
    gmag = np.maximum(ctx["gx"][rs, cs], ctx["gy"][rs, cs])
    valid = g > 0
    return float((gmag[valid] > ctx["grad_thr"]).mean()) if valid.sum() >= 10 else np.nan

@feature("out_content")          # content density OUTSIDE the line — TRUE boundary => clean margin => LOW
def _f_out_content(ctx, side, pos):
    _, out = _band_slices(ctx, side, pos); return _density(ctx, out)

@feature("in_content")           # content density INSIDE the line — TRUE boundary => card content => HIGH
def _f_in_content(ctx, side, pos):
    inn, _ = _band_slices(ctx, side, pos); return _density(ctx, inn)

@feature("content_asym")         # inside-minus-outside content; an internal separator has content on BOTH sides
def _f_content_asym(ctx, side, pos):
    inn, out = _band_slices(ctx, side, pos); di, do = _density(ctx, inn), _density(ctx, out)
    return np.nan if (np.isnan(di) or np.isnan(do)) else di - do
# NB: colour-jump / entropy / connected-component "objects" features were tried here and REVERTED —
# they dropped LR 85→81% at n=26 (band_dist already carries the signal; extra weights overfit). Re-try
# with many more labels, where orthogonal signal can pay for its parameters.


@generator("peak")
def _gen_peaks(ctx, params=None, k=None, lo=None, dmax=None):
    """Top-K perpendicular-gradient peaks per side, over the inset search range — extra candidate lines
    so the true edge is more likely PRESENT (especially the bottom, the weakest-recall side).
    k/lo/dmax default to the passed settings (Phase-1 trials) or the live _ACTIVE['peak']."""
    p = (params or _ACTIVE)["peak"]
    k = p["k"] if k is None else k
    lo = p["lo"] if lo is None else lo
    dmax = p["dmax"] if dmax is None else dmax
    out = {s: [] for s in SIDES}
    x1, y1, x2, y2 = [int(v) for v in ctx["cb"]]; cw, ch = x2 - x1, y2 - y1
    for s in SIDES:
        g = ctx["gy"] if s in "TB" else ctx["gx"]
        a, b = _span(ctx, s)
        if s == "T":   rng = np.arange(int(y1 + lo * ch), int(y1 + dmax * ch)); prof = g[rng][:, a:b].mean(1)
        elif s == "B": rng = np.arange(int(y2 - dmax * ch), int(y2 - lo * ch)); prof = g[rng][:, a:b].mean(1)
        elif s == "L": rng = np.arange(int(x1 + lo * cw), int(x1 + dmax * cw)); prof = g[a:b][:, rng].mean(0)
        else:          rng = np.arange(int(x2 - dmax * cw), int(x2 - lo * cw)); prof = g[a:b][:, rng].mean(0)
        if len(prof) < 5:
            continue
        dim = ch if s in "TB" else cw
        pk, _ = find_peaks(prof, distance=max(int(0.008 * dim), 3))
        if len(pk):
            out[s] = [float(rng[i]) for i in pk[np.argsort(-prof[pk])[:k]]]
    return out


BASE_NAMES = list(FEATURES.keys())
SOURCES = list(DETECTORS.keys()) + list(GENERATORS.keys())            # coh, var, dp, peak
# feature vector = per-candidate base features + source one-hot + cross-candidate (consensus/rank) features.
FEATURE_NAMES = BASE_NAMES + [f"is_{s}" for s in SOURCES] + ["consensus_dist", "n_agree", "out_rank", "grad_rank"]

# GRADIENT-OVERRIDE SAFETY NET — see PerSideSelector.select(). If some candidate's perpendicular gradient
# is >= this multiple of the classifier's pick, take it: a candidate that sharp is almost certainly the real
# edge, even when the classifier vetoed it on atypical priors (border_asym/inset). Tuned CONSERVATIVELY:
# at x5 it fired on exactly 1 of 204 per-side picks (the scraped_004 bottom veto, an 8.3x edge) and lifted
# LOO tight-rate ALL 92.2->94.1%, HARD 88.5->92.3% with no collateral. Lower factors over-fire and regress
# (x3 -> 82%, x1.5 -> 33%). Set GRAD_OVERRIDE_FACTOR = None to disable.
GRAD_OVERRIDE_FACTOR = 5.0
_GRAD_IDX = BASE_NAMES.index("grad_strength")


def config_snapshot(params=None):
    """Revertible snapshot of the settings that define the selector's behaviour — stored alongside each
    deployed model so a checkpoint records exactly how it was produced. Pass `params` to snapshot a
    specific detector-settings dict (Phase-1 result) without touching the live ones; defaults to live.
    `n_features` lets a revert detect an incompatible model (feature set changed in code) before swap."""
    a = params or _ACTIVE
    return {
        "model": "logreg", "tau": TAU, "center": CENTER,
        "sources": list(SOURCES), "n_features": len(FEATURE_NAMES), "features": list(FEATURE_NAMES),
        "coh_kw": dict(a["coh"]), "var_kw": dict(a["var"]), "peak": dict(a["peak"]),
    }


# ────────────────────────────────────────────────────────────────────────────
# CANDIDATES + DATASET
# ────────────────────────────────────────────────────────────────────────────
def candidate_positions(ctx, params=None):
    """{side: [(source, pos_px)]} — detectors + generators only, NO feature extraction. Cheap enough to
    sweep across detector settings in the Phase-1 search (which only needs candidate positions vs GT).
    `params` overrides the live detector settings WITHOUT mutating them (safe under concurrent grading)."""
    raw = {s: [] for s in SIDES}
    for dname, dfn in DETECTORS.items():
        edges = dfn(ctx, params)
        if edges is None:
            continue
        for s in SIDES:
            raw[s].append((dname, edges[s]))
    for gname, gfn in GENERATORS.items():
        try:
            gen = gfn(ctx, params)
        except Exception:
            gen = {}
        for s in SIDES:
            for pos in gen.get(s, []):
                raw[s].append((gname, pos))
    return raw


def candidates(ctx, params=None):
    """{side: [(source, pos_px, feature_vector)]} — one line per DETECTOR + K lines per GENERATOR.
    `params` overrides the live detector settings without mutating them (Phase-1 / Phase-2 recompute)."""
    raw = {s: [] for s in SIDES}                              # (source, pos)
    for dname, dfn in DETECTORS.items():
        edges = dfn(ctx, params)
        if edges is None:
            continue
        for s in SIDES:
            raw[s].append((dname, edges[s]))
    for gname, gfn in GENERATORS.items():
        try:
            gen = gfn(ctx, params)
        except Exception:
            gen = {}
        for s in SIDES:
            for pos in gen.get(s, []):
                raw[s].append((gname, pos))
    gs_idx = BASE_NAMES.index("grad_strength")
    out = {s: [] for s in SIDES}
    for s in SIDES:
        positions = [p for _, p in raw[s]]
        med = float(np.median(positions)) if positions else 0.0
        den = ctx["cbw"] if s in "LR" else ctx["cbh"]
        insets = [inset_frac(ctx, s, p) for p in positions]
        bases = [[FEATURES[f](ctx, s, pos) for f in BASE_NAMES] for _, pos in raw[s]]
        gss = [b[gs_idx] if not np.isnan(b[gs_idx]) else -1.0 for b in bases]   # gradient strength per candidate
        n = max(len(raw[s]) - 1, 1)
        for i, (dname, pos) in enumerate(raw[s]):
            base = bases[i]
            onehot = [1.0 if dname == d else 0.0 for d in SOURCES]
            consensus_dist = abs(pos - med) / den
            n_agree = float(sum(1 for q in positions if abs(q - pos) / den < 0.005) - 1)
            my_in = inset_frac(ctx, s, pos)
            out_rank = sum(1 for q in insets if q < my_in - 1e-9) / n          # 0 = most outward
            grad_rank = sum(1 for g in gss if g > gss[i] + 1e-9) / n           # 0 = strongest line (the peak's value)
            out[s].append((dname, pos, base + onehot + [consensus_dist, n_agree, out_rank, grad_rank]))
    return out


def build_dataset(gt):
    """One row per (card, side, detector candidate): features + edge error + meta."""
    import inner_edge_metric as M                        # lab-only
    rows = []
    for rec in gt:
        path = rec.get("src_path") or rec.get("key")
        ctx = prep_context(path)                     # refine -> fractional cb (the detector convention)
        if ctx is None:
            continue
        gl, gtp, gr, gb = M.gt_inner_edges(rec); cwf, chf = M.card_dims_frac(rec)
        x1, y1, x2, y2 = rec["cb_px"]; W, H = rec["warp_wh"]
        gt_frac = {"L": gl, "R": gr, "T": gtp, "B": gb}
        cand = candidates(ctx)
        for s in SIDES:
            den = cwf if s in "LR" else chf
            dim = W if s in "LR" else H
            for dname, pos, fv in cand[s]:
                err = abs(pos / dim - gt_frac[s]) / den
                rows.append({"card": rec.get("name", os.path.basename(path)), "src": path,
                             "side": s, "det": dname, "pos": pos, "feat": fv, "err": err,
                             "label": int(err <= TAU)})
    return rows


EDGE_LABELS = os.path.join(_HERE, "edge_labels.jsonl")

def build_dataset_app(label_file=EDGE_LABELS):
    """Training rows from the edge-picker app's COMPARATIVE labels (chosen detector per side).
    The chosen detector's candidate is positive; the others are negative. No exact GT, so these are
    TRAIN-ONLY (they can't be scored for tightness) — fold them into training via loo_eval(extra_rows=…)."""
    rows = []
    if not os.path.exists(label_file):
        return rows
    for ln in open(label_file):
        ln = ln.strip()
        if not ln:
            continue
        rec = json.loads(ln)
        ctx = prep_context(rec["src_path"])
        if ctx is None:
            continue
        cand = candidates(ctx)
        for s in SIDES:
            chosen = rec.get("sides", {}).get(s, {}).get("chosen")
            # 'chosen' is a LIST of all-correct detectors (new), a single string (old), or None
            correct = set(chosen) if isinstance(chosen, list) else ({chosen} if chosen else set())
            for dname, pos, fv in cand[s]:
                rows.append({"card": rec.get("name"), "src": rec["src_path"], "side": s, "det": dname,
                             "pos": pos, "feat": fv, "label": int(dname in correct)})
    return rows


# ────────────────────────────────────────────────────────────────────────────
# THE SELECTOR — wraps any sklearn-style classifier; picks argmax P(good) per side.
# ────────────────────────────────────────────────────────────────────────────
from sklearn.linear_model import LogisticRegression
from sklearn.ensemble import GradientBoostingClassifier
from sklearn.pipeline import Pipeline
from sklearn.impute import SimpleImputer
from sklearn.preprocessing import StandardScaler

def make_logreg():
    return Pipeline([("imp", SimpleImputer(strategy="median")), ("sc", StandardScaler()),
                     ("clf", LogisticRegression(max_iter=1000, class_weight="balanced"))])

def make_gbm():
    return Pipeline([("imp", SimpleImputer(strategy="median")),
                     ("clf", GradientBoostingClassifier(n_estimators=120, max_depth=2, learning_rate=0.06))])


class PerSideSelector:
    def __init__(self, model_factory=make_logreg):
        self.model_factory = model_factory; self.model = None

    def fit(self, rows, tau=TAU):
        X = np.array([r["feat"] for r in rows], float)
        y = np.array([int(r["label"]) if "label" in r else int(r["err"] <= tau) for r in rows], int)
        self.model = self.model_factory(); self.model.fit(X, y)
        return self

    def score(self, feat_vectors):
        X = np.array(feat_vectors, float)
        return self.model.predict_proba(X)[:, 1]

    def select(self, cand, default_det=None, margin=0.0, grad_override=GRAD_OVERRIDE_FACTOR):
        """cand = candidates(ctx); returns {side: (det, pos, p_good)}.
        Picks argmax P(good) per side. SAFETY GATE: if default_det is set, only override the default
        when the best candidate's P exceeds the default's P by >= margin — otherwise keep the default.
        With default_det='var' this guarantees the result is never worse than the variance baseline.
        GRADIENT OVERRIDE (grad_override, default GRAD_OVERRIDE_FACTOR): after the pick, if some candidate's
        perpendicular gradient is >= grad_override x the picked candidate's, take it instead — insurance for
        the rare case where the classifier vetoes an overwhelmingly sharp true edge (see GRAD_OVERRIDE_FACTOR).
        The returned p_good stays the classifier's score for the chosen line, so a fired override reads as
        lower confidence (an honest classifier-vs-gradient disagreement). Pass None to disable."""
        chosen = {}
        for s in SIDES:
            if not cand[s]:
                continue
            ps = self.score([fv for _, _, fv in cand[s]])
            i = int(np.argmax(ps))
            if default_det is not None:
                di = next((k for k, (dn, _, _) in enumerate(cand[s]) if dn == default_det), None)
                if di is not None and cand[s][i][0] != default_det and ps[i] - ps[di] < margin:
                    i = di
            if grad_override:
                grads = [fv[_GRAD_IDX] for _, _, fv in cand[s]]
                ig = int(np.argmax(grads))
                if ig != i and grads[ig] > grad_override * grads[i]:
                    i = ig
            dname, pos, _ = cand[s][i]
            chosen[s] = (dname, pos, float(ps[i]))
        return chosen

    def predict_frame(self, ctx, default_det=None, margin=0.0):
        chosen = self.select(candidates(ctx), default_det, margin)
        return {s: chosen[s][1] for s in chosen}  # {side: pos_px}


# ────────────────────────────────────────────────────────────────────────────
# LEAVE-ONE-CARD-OUT EVALUATION
# ────────────────────────────────────────────────────────────────────────────
def loo_eval(gt, model_factory=make_logreg, tau=TAU, default_det=None, margin=0.0, verbose=True,
             _rows=None, extra_rows=None):
    rows = _rows if _rows is not None else build_dataset(gt)
    cards = sorted({r["card"] for r in rows})
    is_hard = {rec.get("name"): ("feature_extraction_dataset" in (rec.get("src_path") or "")) for rec in gt}
    extra = [r for r in (extra_rows or []) if r["card"] not in set(cards)]   # app labels = pure train signal
    per_card = {}
    for held in cards:
        train = [r for r in rows if r["card"] != held] + extra
        test = [r for r in rows if r["card"] == held]
        sel = PerSideSelector(model_factory).fit(train, tau)
        side_err = {}
        for s in SIDES:
            cs = [r for r in test if r["side"] == s]
            if not cs:
                continue
            ps = sel.score([r["feat"] for r in cs])
            i = int(np.argmax(ps))
            if default_det is not None:
                di = next((k for k, r in enumerate(cs) if r["det"] == default_det), None)
                if di is not None and cs[i]["det"] != default_det and ps[i] - ps[di] < margin:
                    i = di
            side_err[s] = cs[i]["err"]
        if len(side_err) == 4:
            per_card[held] = max(side_err.values())
    def rate(subset):
        v = [mx for c, mx in per_card.items() if subset(c)]
        return 100 * np.mean([x <= tau for x in v]) if v else float("nan"), len(v)
    hard = rate(lambda c: is_hard.get(c)); easy = rate(lambda c: not is_hard.get(c))
    allr = rate(lambda c: True)
    if verbose:
        print(f"  LOO tight @ {tau}:  ALL {allr[0]:.0f}% (n={allr[1]})   "
              f"HARD {hard[0]:.0f}% (n={hard[1]})   EASY {easy[0]:.0f}% (n={easy[1]})")
    return {"all": allr, "hard": hard, "easy": easy, "per_card": per_card, "rows": rows}


if __name__ == "__main__":
    import inner_edge_metric as M                        # lab-only
    gt = M.load_inner_gt()
    gt = [r for r in gt if r.get("warp_version", "cb_v2") == "cb_v2"]
    print(f"Loaded {len(gt)} cards | detectors={list(DETECTORS)} | features={FEATURE_NAMES}")
    rows = build_dataset(gt)
    # reference ceilings on the same rows
    by = {}
    for r in rows:
        by.setdefault((r["card"], r["side"]), []).append(r)
    cards = sorted({r["card"] for r in rows})
    is_hard = {rec.get("name"): ("feature_extraction_dataset" in (rec.get("src_path") or "")) for rec in gt}
    def ceil(pick):  # pick(list_of_rows)->row
        pc = {}
        for c in cards:
            errs = [pick(by[(c, s)])["err"] for s in SIDES if (c, s) in by]
            if len(errs) == 4: pc[c] = max(errs)
        h = [mx for c, mx in pc.items() if is_hard.get(c)]
        return 100*np.mean([x <= TAU for x in h]) if h else float("nan")
    print(f"\n  reference (HARD subset):")
    print(f"    always-var      : {ceil(lambda L: next(r for r in L if r['det']=='var')):.0f}%")
    print(f"    per-side ORACLE : {ceil(lambda L: min(L, key=lambda r: r['err'])):.0f}%")
    print(f"\n  learned per-side selector (LOO, argmax — no gate):")
    print("    LogisticRegression:", end=" "); loo_eval(gt, make_logreg, _rows=rows)
    print("    GradientBoosting  :", end=" "); loo_eval(gt, make_gbm, _rows=rows)
    print(f"\n  SAFETY-GATED (default=var, only override when confident) — GBM:")
    for mg in (0.0, 0.10, 0.20, 0.35):
        print(f"    margin={mg:>4}:", end=" "); loo_eval(gt, make_gbm, default_det="var", margin=mg, _rows=rows)
    app_rows = build_dataset_app()
    if app_rows:
        print(f"\n  + {len(app_rows)} edge-picker rows folded into training — GBM:")
        print("    ", end=""); loo_eval(gt, make_gbm, _rows=rows, extra_rows=app_rows)
    sel = PerSideSelector(make_gbm).fit(rows + (app_rows or []))
    imp = sel.model.named_steps["clf"].feature_importances_
    print("\n  GBM feature importance (what the classifier uses):")
    for name, w in sorted(zip(FEATURE_NAMES, imp), key=lambda kv: -kv[1]):
        if w >= 0.01:
            print(f"    {name:14} {w:.3f}")
