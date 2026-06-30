"""
ec_detect.py — edge & corner defect boxes via the self-hosted RF-DETR edge/corner model.

Sibling of scratch_detect.py. One RF-DETR pass over the warped card yields boxes labeled `edge` or `corner`
(the model's id2label); we route them into defect_boxes["edges"] / ["corners"]. Output shape matches the
Sonnet grader's `defect_boxes` exactly (box in FRACTIONS of the warp, 0..1, origin top-left) so the contract
+ product render one format. `surface` is left empty here — that's scratch_detect's job.

Scope: the *paintable* edge/corner defects the model was trained on (whitening / nicks / chips). Corner
ROUNDING, creases, dents, bends are geometric and handled elsewhere — NOT in these boxes.

Non-fatal by construction — any error (weights absent, no HF_TOKEN, model still training, etc.) returns the
all-empty dict so grading is NEVER blocked.

Env (set on the Railway card-grader-api service):
  EC_ENABLED     "1"/"true" (default on) — master switch
  EC_MODEL       HF repo id or local dir of the trained RF-DETR (default sdoddi/card-edge-corner-rfdetr-large;
                 private repo → needs HF_TOKEN on the service)
  EC_THRESHOLD   conf cutoff (default 0.6 — provisional; TUNE after sim-to-real on real worn cards, like scratch)
  EC_MAX_BOXES   hard cap per pillar (default 20), conf-desc
"""
import os

_ENABLED = os.environ.get("EC_ENABLED", "1").lower() in ("1", "true", "yes", "on")
_MODEL = os.environ.get("EC_MODEL", "sdoddi/card-edge-corner-rfdetr-large")
_THRESHOLD = float(os.environ.get("EC_THRESHOLD", "0.6"))
_MAX_BOXES = int(os.environ.get("EC_MAX_BOXES", "20"))
print(f"[ec_detect] loaded — enabled={_ENABLED} model={_MODEL} thr={_THRESHOLD}", flush=True)

_LABEL2AREA = {"edge": "edges", "corner": "corners"}


def defect_boxes(warped_cen):
    """RF-DETR edge/corner detections on the masked 630x880 warp, as a {edges,corners,surface} dict matching
    the Sonnet grader's shape (edges + corners populated, surface empty). Returns all-empty on disable/failure."""
    empty = {"edges": [], "corners": [], "surface": []}
    if not _ENABLED or warped_cen is None:
        return empty
    try:
        import local_rfdetr
        H, W = warped_cen.shape[:2]
        raw = local_rfdetr.get_model(_MODEL).detect(warped_cen, threshold=_THRESHOLD)
    except Exception as e:
        print(f"[ec] detection skipped: {type(e).__name__}: {e}")
        return empty
    out = {"edges": [], "corners": [], "surface": []}
    for b in raw:
        area = _LABEL2AREA.get(b.get("label"))
        if area is None or len(out[area]) >= _MAX_BOXES:
            continue
        x1, y1, x2, y2 = b["box"]
        conf = round(float(b["conf"]), 4)
        out[area].append({
            "area": area,
            "type": "wear",                                    # model is 2-class (edge/corner), not per-defect-type
            "category": "minor" if conf >= 0.9 else "trace",   # conf as a coarse visibility proxy (mirrors scratch)
            "box": [round(x1 / W, 5), round(y1 / H, 5), round((x2 - x1) / W, 5), round((y2 - y1) / H, 5)],
            "conf": conf,
        })
    return out
