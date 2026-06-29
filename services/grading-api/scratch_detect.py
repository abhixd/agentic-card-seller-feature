"""
scratch_detect.py — surface-scratch defect boxes via the self-hosted RF-DETR scratch model.

Fills the GAP in the CV grading backend, which (unlike the Sonnet/Opus backend) has no per-defect boxes.
Output matches the Sonnet grader's `defect_boxes` shape exactly so the contract + product render one format:

    {"edges": [], "corners": [], "surface": [ {area,type,category,box:[x,y,w,h],conf}, ... ]}

with box in FRACTIONS of the warped card (0..1, origin top-left) — same convention as sonnet_defects.

Non-fatal by construction — any error (weights absent, no HF_TOKEN, etc.) returns the all-empty dict so
grading is NEVER blocked.

Env (set on the Railway card-grader-api service):
  SCRATCH_ENABLED    "1"/"true" (default on) — master switch
  SCRATCH_MODEL      HF repo id or local dir of the trained RF-DETR (default sdoddi/card-scratch-rfdetr;
                     private repo → needs HF_TOKEN on the service)
  SCRATCH_THRESHOLD  conf cutoff (default 0.8 — validated ~5% clean-FP / 89% recall on synthetic val;
                     local_rfdetr's 0.3 default is far too permissive, ~45% clean-FP)
  SCRATCH_MAX_BOXES  hard cap on returned boxes (default 20), conf-desc
"""
import os

_ENABLED = os.environ.get("SCRATCH_ENABLED", "1").lower() in ("1", "true", "yes", "on")
_MODEL = os.environ.get("SCRATCH_MODEL", "sdoddi/card-scratch-rfdetr")
_THRESHOLD = float(os.environ.get("SCRATCH_THRESHOLD", "0.6"))   # 0.6 after eyeballing real cards (0.8 too conservative)
_MAX_BOXES = int(os.environ.get("SCRATCH_MAX_BOXES", "20"))
print(f"[scratch_detect] loaded — enabled={_ENABLED} model={_MODEL} thr={_THRESHOLD}", flush=True)


def defect_boxes(warped_cen):
    """RF-DETR scratch detections on the masked 630x880 warp, as a {edges,corners,surface} dict matching
    the Sonnet grader's shape (only `surface` is populated). Returns all-empty on disable/failure."""
    empty = {"edges": [], "corners": [], "surface": []}
    if not _ENABLED or warped_cen is None:
        return empty
    try:
        import local_rfdetr
        H, W = warped_cen.shape[:2]
        raw = local_rfdetr.get_model(_MODEL).detect(warped_cen, threshold=_THRESHOLD)
    except Exception as e:
        print(f"[scratch] detection skipped: {type(e).__name__}: {e}")
        return empty
    surface = []
    for b in raw[:_MAX_BOXES]:
        x1, y1, x2, y2 = b["box"]
        conf = round(float(b["conf"]), 4)
        surface.append({
            "area": "surface",
            "type": "scratch",
            "category": "minor" if conf >= 0.9 else "trace",   # conf as a coarse visibility proxy
            "box": [round(x1 / W, 5), round(y1 / H, 5), round((x2 - x1) / W, 5), round((y2 - y1) / H, 5)],
            "conf": conf,
        })
    return {"edges": [], "corners": [], "surface": surface}
