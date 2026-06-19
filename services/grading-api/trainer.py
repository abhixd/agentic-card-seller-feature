"""
trainer.py — retrain the per-side centering selector, server-side, with NO lab data.

Two inputs, both reachable from the deployed grading-api:
  • the BASE feature-set — perside_base_dataset.json, precomputed from the lab GT and bundled
    (just feature vectors + labels, no warps needed)
  • LIVE corrections — centering_corrections rows from Supabase; each carries its warped image,
    so we recompute its candidate features here and label them against the user's corrected box

retrain() reports the leave-one-card-out accuracy BEFORE vs AFTER folding in the corrections
(the delta the admin panel shows), and returns a freshly-fit selector ready to hot-swap (P2b).
Everything works from rows alone — loo_from_rows needs no images.
"""
import os, sys, json, base64
import numpy as np

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)
import per_side_selector as PS

BASE_PATH = os.path.join(_HERE, "perside_base_dataset.json")
MODEL_PATH = os.path.join(_HERE, "perside_lr.joblib")


def _nan(v):
    return np.nan if v is None else v


def load_base():
    d = json.load(open(BASE_PATH))
    rows = [{"card": r["card"], "side": r["side"], "det": r["det"], "err": r["err"],
             "feat": [_nan(x) for x in r["feat"]]} for r in d["rows"]]
    return rows, d


def correction_rows(corrections):
    """Supabase centering_corrections → per-candidate feature rows labelled by the corrected box."""
    import cv2
    rows = []
    for rc in corrections:
        b64 = rc.get("warped_image_b64"); cc = rc.get("corrected_content_region"); cb = rc.get("card_boundary")
        if not (b64 and cc and cb and len(cb) == 4):
            continue
        try:
            img = cv2.imdecode(np.frombuffer(base64.b64decode(b64), np.uint8), cv2.IMREAD_COLOR)
            ctx = PS.make_ctx(img, None, [float(v) for v in cb])
        except Exception:
            continue
        if ctx is None:
            continue
        cand = PS.candidates(ctx); W, H = ctx["W"], ctx["H"]
        cwf, chf = max(cb[2] - cb[0], 1e-6), max(cb[3] - cb[1], 1e-6)
        truth = {"L": cc["x1"], "R": cc["x2"], "T": cc["y1"], "B": cc["y2"]}
        cid = f"corr_{str(rc.get('correction_id', 'x'))[:12]}"
        for s in "LRTB":
            den = cwf if s in "LR" else chf
            dim = W if s in "LR" else H
            for det, pos, feat in cand[s]:
                rows.append({"card": cid, "side": s, "det": det, "feat": feat,
                             "err": abs(pos / dim - truth[s]) / den})
    return rows


def loo_from_rows(rows, model_factory=PS.make_logreg, tau=PS.TAU):
    """Leave-one-CARD-out tight-rate, computed purely from rows (no images / warps)."""
    by = {}
    for r in rows:
        by.setdefault(r["card"], []).append(r)
    cards = sorted(by)
    tights = []
    for held in cards:
        train = [r for r in rows if r["card"] != held]
        if not train:
            continue
        sel = PS.PerSideSelector(model_factory).fit(train)
        se = {}
        for s in "LRTB":
            cs = [r for r in by[held] if r["side"] == s]
            if not cs:
                continue
            ps = sel.score([r["feat"] for r in cs])
            se[s] = cs[int(np.argmax(ps))]["err"]
        if len(se) == 4:
            tights.append(max(se.values()) <= tau)
    return round(100 * float(np.mean(tights)), 1) if tights else None


def retrain(corrections=None):
    """Fold corrections into the base, report LOO before/after, return a fresh selector."""
    base, meta = load_base()
    corr = correction_rows(corrections or [])
    before = loo_from_rows(base)
    after = loo_from_rows(base + corr) if corr else before
    sel = PS.PerSideSelector(PS.make_logreg).fit(base + corr)
    return {
        "n_base_cards": meta.get("n_cards"), "n_base_rows": len(base),
        "n_corrections": len({r["card"] for r in corr}), "n_correction_rows": len(corr),
        "loo_before": before, "loo_after": after,
        "delta": (round(after - before, 1) if (after is not None and before is not None) else None),
        "selector": sel,
    }


def save_model(sel, path=MODEL_PATH):
    import joblib
    joblib.dump(sel.model, path)
    return path


if __name__ == "__main__":
    r = retrain()
    print(json.dumps({k: v for k, v in r.items() if k != "selector"}, indent=2))
