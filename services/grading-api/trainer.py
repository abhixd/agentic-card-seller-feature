"""
trainer.py — two-phase retrain of the per-side centering selector, server-side, with NO live lab data.

EVERY retrain uses ALL available data: the 51 BASE cards (bundled in perside_base_dataset.json, now WITH
their warp images at production resolution) + ALL user CORRECTIONS (centering_corrections rows, each
carrying its warped image). Both phases see both sources.

  PHASE 1 — tune the detector SETTINGS (coherence/variance band centres+widths, peak search range) so the
            candidate POOL is better (a within-TAU edge is present per side). Upstream: better candidates
            for Phase 2 to choose from. Coordinate-descent over a small grid; ADOPT only if leave-one-card-out
            pool recall improves by >= PHASE1_MARGIN. Cheap: positions-only, no feature extraction.
  PHASE 2 — refit the per-edge classifier (the one that picks the 4 winning edges) on features recomputed
            under the adopted settings.

retrain() reports LOO tight-rate before vs after (the panel's delta) + the Phase-1 outcome, and returns a
fresh selector + the config snapshot (detector settings included) to checkpoint and hot-swap.
"""
import os, sys, json, base64
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import per_side_selector as PS

BASE_PATH = os.path.join(_HERE, "perside_base_dataset.json")
MODEL_PATH = os.path.join(_HERE, "perside_lr.joblib")
SIDES = "LRTB"
TAU = PS.TAU
DEFAULT_PARAMS = PS.get_detector_params()        # the code defaults, snapshotted once

# Phase-1 search: a small coordinate-descent grid over the high-leverage detector settings. band_center is
# "where we expect the inner edge" — the dominant lever. Kept small so the search stays bounded on Railway.
PHASE1_GRID = [
    ("coh", "band_center", [0.025, 0.030, 0.035, 0.040, 0.045]),
    ("coh", "band_tol",    [0.012, 0.018, 0.024]),
    ("var", "band_center", [0.035, 0.045, 0.050, 0.060]),
    ("var", "band_width",  [0.010, 0.015, 0.020]),
    ("peak", "lo",         [0.004, 0.006, 0.008]),
    ("peak", "dmax",       [0.10, 0.12, 0.15]),
]
PHASE1_MARGIN = 0.5        # adopt new settings only if pool-recall (coverage) improves by >= this many points
PHASE1_SATURATED = 99.5    # coverage at/above this → every side already has a within-TAU candidate; skip the
                           # search (detector tuning can't add a "more present" edge). The cheap confirm path.


# ── loading: base bundle (rows fast-path + card images) + corrections → uniform "units" ──────────────
def load_base():
    return json.load(open(BASE_PATH))


def _decode_ctx(warp_b64, cb_frac):
    import cv2
    img = cv2.imdecode(np.frombuffer(base64.b64decode(warp_b64), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return None
    return PS.make_ctx(img, None, [float(v) for v in cb_frac])


def _base_units(base):
    """One unit per base card: a ready ctx (image decoded once) + truth + card dims."""
    units = []
    for c in base.get("cards", []):
        ctx = _decode_ctx(c["warp_b64"], c["cb_frac"])
        if ctx is None:
            continue
        units.append({"card": c["card"], "cls": c.get("cls", "normal"), "ctx": ctx,
                      "gt": c["gt"], "cw": c["dims"]["cw"], "ch": c["dims"]["ch"]})
    return units


def _correction_units(corrections):
    units = []
    for rc in corrections or []:
        b64 = rc.get("warped_image_b64"); cc = rc.get("corrected_content_region"); cb = rc.get("card_boundary")
        if not (b64 and cc and cb and len(cb) == 4):
            continue
        ctx = _decode_ctx(b64, [float(v) for v in cb])
        if ctx is None:
            continue
        cwf = max(cb[2] - cb[0], 1e-6); chf = max(cb[3] - cb[1], 1e-6)
        units.append({"card": f"corr_{str(rc.get('correction_id', 'x'))[:12]}", "cls": "correction", "ctx": ctx,
                      "gt": {"L": cc["x1"], "R": cc["x2"], "T": cc["y1"], "B": cc["y2"]}, "cw": cwf, "ch": chf})
    return units


def _den_dim(u, s, ctx):
    return (u["cw"] if s in "LR" else u["ch"]), (ctx["W"] if s in "LR" else ctx["H"])


# ── feature rows (Phase 2) + positions-only pool recall (Phase 1). `params` (a detector-settings dict)
# is passed EXPLICITLY to candidate generation — never mutating the live settings, so this is safe to run
# offloaded while production grading reads the deployed settings concurrently. ──
def _rows_from_units(units, params=None):
    rows = []
    for u in units:
        ctx = u["ctx"]; cand = PS.candidates(ctx, params); gt = u["gt"]
        for s in SIDES:
            den, dim = _den_dim(u, s, ctx)
            for det, pos, feat in cand[s]:
                rows.append({"card": u["card"], "cls": u["cls"], "side": s, "det": det, "feat": feat,
                             "err": abs(pos / dim - gt[s]) / den})
    return rows


def _pool_recall_loo(units, params=None):
    """Pool recall under the given detector `params`: per card, does each side's candidate pool contain a
    within-TAU edge? Positions only (no classifier, no features) — the Phase-1 objective. Pool presence
    doesn't depend on a train split, so this is full-set recall; the per-card framing is kept for symmetry."""
    side_hit = {s: [] for s in SIDES}; whole = []
    for u in units:
        ctx = u["ctx"]; pos = PS.candidate_positions(ctx, params); gt = u["gt"]
        se = {}
        for s in SIDES:
            den, dim = _den_dim(u, s, ctx)
            errs = [abs(p / dim - gt[s]) / den for _, p in pos[s]]
            se[s] = min(errs) if errs else 1e9
        for s in SIDES:
            side_hit[s].append(se[s] <= TAU)
        whole.append(max(se.values()) <= TAU)
    pct = lambda v: round(100 * float(np.mean(v)), 1) if v else None
    return {"overall": pct(whole), "per_side": {s: pct(side_hit[s]) for s in SIDES}}


# ── LOO tight-rate from feature rows (Phase 2 metric) ────────────────────────────────────────────────
def loo_from_rows(rows, model_factory=PS.make_logreg, tau=TAU):
    by = {}
    for r in rows:
        by.setdefault(r["card"], []).append(r)
    tights = []
    for held in sorted(by):
        train = [r for r in rows if r["card"] != held]
        if not train:
            continue
        sel = PS.PerSideSelector(model_factory).fit(train)
        se = {}
        for s in SIDES:
            cs = [r for r in by[held] if r["side"] == s]
            if cs:
                se[s] = cs[int(np.argmax(sel.score([r["feat"] for r in cs])))]["err"]
        if len(se) == 4:
            tights.append(max(se.values()) <= tau)
    return round(100 * float(np.mean(tights)), 1) if tights else None


def loo_detail(rows, model_factory=PS.make_logreg, tau=TAU):
    by = {}
    for r in rows:
        by.setdefault(r["card"], []).append(r)
    whole, side_ok, cls_ok = [], {s: [] for s in SIDES}, {}
    for held in sorted(by):
        train = [r for r in rows if r["card"] != held]
        if not train:
            continue
        sel = PS.PerSideSelector(model_factory).fit(train)
        se = {}
        for s in SIDES:
            cs = [r for r in by[held] if r["side"] == s]
            if cs:
                se[s] = cs[int(np.argmax(sel.score([r["feat"] for r in cs])))]["err"]
        if len(se) == 4:
            ok = max(se.values()) <= tau
            whole.append(ok)
            for s in SIDES:
                side_ok[s].append(se[s] <= tau)
            cls_ok.setdefault(by[held][0].get("cls", "normal"), []).append(ok)
    pct = lambda v: round(100 * float(np.mean(v)), 1) if v else None
    return {"overall": pct(whole), "per_side": {s: pct(side_ok[s]) for s in SIDES},
            "per_class": {c: pct(v) for c, v in cls_ok.items()}, "n_cards": len(whole)}


# ── PHASE 1 — candidate-COVERAGE guard, on ALL units ──────────────────────────────────────────────────
# Phase 1 ensures the candidate POOL covers the true edge on every side (Phase 2 can only pick from the
# pool). It ALWAYS runs as a coverage check, but: (a) early-exits cheaply when coverage is already
# saturated — detector tuning can't add a "more present" edge — and (b) when there's a coverage GAP, it
# searches detector settings to close it, adopting only if recall improves AND selection (LOO) doesn't
# regress. As harder cards accumulate, this is what keeps the pool covering well.
def _copy_params(p):
    return {k: dict(v) for k, v in p.items()}


def _coverage_skip(base):
    return {"ran": True, "adopt": False, "saturated": True,
            "oracle_before": base["overall"], "oracle_after": base["overall"], "oracle_delta": 0.0,
            "per_side_before": base["per_side"], "per_side_after": base["per_side"],
            "params": _copy_params(DEFAULT_PARAMS), "changed": {},
            "note": f"candidate coverage already {base['overall']}% — pool covers every side, detectors unchanged"}


def phase1(units):
    base = _pool_recall_loo(units, DEFAULT_PARAMS)
    if base["overall"] is not None and base["overall"] >= PHASE1_SATURATED:
        return _coverage_skip(base)                  # coverage saturated → confirm-and-skip (cheap)

    # coverage gap → coordinate-descent search to raise pool recall (each trial passes settings EXPLICITLY)
    best = _copy_params(DEFAULT_PARAMS); best_overall = base["overall"]; trail = []
    for det, key, values in PHASE1_GRID:
        for v in values:
            if abs(best[det].get(key, 1e18) - v) < 1e-12:
                continue
            trial = _copy_params(best); trial[det][key] = v
            o = _pool_recall_loo(units, trial)["overall"]
            trail.append({"param": f"{det}.{key}", "value": v, "overall": o})
            if o is not None and best_overall is not None and o > best_overall + 1e-9:
                best, best_overall = trial, o
    chosen_per_side = _pool_recall_loo(units, best)["per_side"]

    changed = {}
    for det in ("coh", "var", "peak"):
        for k, v in best[det].items():
            if abs(v - DEFAULT_PARAMS[det].get(k, v)) > 1e-12:
                changed.setdefault(det, {})[k] = v
    gain = (best_overall - base["overall"]) if (best_overall is not None and base["overall"] is not None) else 0.0
    adopt = bool(changed and gain >= PHASE1_MARGIN)
    note = None
    if adopt:                                        # a coverage gain must not hurt SELECTION (Phase-2 LOO)
        loo_def = loo_detail(_rows_from_units(units, DEFAULT_PARAMS))["overall"]
        loo_new = loo_detail(_rows_from_units(units, best))["overall"]
        if loo_new is not None and loo_def is not None and loo_new < loo_def - 0.1:
            adopt = False
            note = f"coverage +{gain:.1f}pt but selection LOO {loo_def}->{loo_new} — kept defaults"
    return {"ran": True, "adopt": adopt, "saturated": False,
            "oracle_before": base["overall"], "oracle_after": best_overall,
            "oracle_delta": round(gain, 1), "per_side_before": base["per_side"], "per_side_after": chosen_per_side,
            "params": best if adopt else _copy_params(DEFAULT_PARAMS), "changed": changed if adopt else {},
            "note": note, "trail": trail}


# ── orchestration ─────────────────────────────────────────────────────────────────────────────────────
def retrain(corrections=None):
    base = load_base()
    bunits = _base_units(base)
    cunits = _correction_units(corrections)
    units = bunits + cunits

    # BEFORE = the live baseline: base-only feature rows at DEFAULT settings (the bundled fast-path).
    before = loo_detail([_nan_row(r) for r in base.get("rows", [])]) if base.get("rows") else loo_detail(_rows_from_units(bunits, DEFAULT_PARAMS))

    # PHASE 1 — coverage-guard / detector tuning on ALL data (purely functional; live settings untouched)
    p1 = phase1(units)
    params = p1["params"] if p1["adopt"] else DEFAULT_PARAMS

    # PHASE 2 — features + classifier under the chosen settings, on ALL data
    rows = _rows_from_units(units, params)
    after = loo_detail(rows)
    sel = PS.PerSideSelector(PS.make_logreg).fit(rows)
    config = PS.config_snapshot(params)              # snapshot the CHOSEN settings (never mutates live state)

    d = lambda a, b: (round(a - b, 1) if (a is not None and b is not None) else None)
    return {
        "n_base_cards": base.get("n_cards"), "n_base_rows": len(base.get("rows", [])),
        "n_corrections": len(cunits), "n_correction_rows": len(cunits) * 4,
        "loo_before": before["overall"], "loo_after": after["overall"], "delta": d(after["overall"], before["overall"]),
        "per_side": after["per_side"], "per_class": after["per_class"],
        "phase1": {
            "adopted": p1["adopt"], "saturated": p1.get("saturated", False),
            "coverage_before": p1["oracle_before"], "coverage_after": p1["oracle_after"],
            "coverage_delta": p1.get("oracle_delta", d(p1["oracle_after"], p1["oracle_before"])),
            "per_side_before": p1["per_side_before"], "per_side_after": p1["per_side_after"],
            "changed": p1["changed"], "note": p1.get("note"),
        },
        "config": config, "selector": sel,
    }


def _nan_row(r):
    return {"card": r["card"], "cls": r.get("cls", "normal"), "side": r["side"], "det": r["det"],
            "err": r["err"], "feat": [np.nan if x is None else x for x in r["feat"]]}


def save_model(sel, path=MODEL_PATH):
    import joblib
    joblib.dump({"model": sel.model}, path)
    return path


if __name__ == "__main__":
    r = retrain()
    print(json.dumps({k: v for k, v in r.items() if k != "selector"}, indent=2))
