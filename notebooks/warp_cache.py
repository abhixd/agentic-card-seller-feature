"""
warp_cache.py — cache the EXPENSIVE Roboflow-seg detection/warp so that iterating on
the CV feature logic (edges/corners/surface) needs no API calls.

The seg output (warped image + cw contour + cb box + seg_conf) is independent of the
downstream feature extraction, so we compute it ONCE per card and reuse it. Stored
losslessly (PNG-encoded warp inside an .npz) under feature_extraction_dataset/warp_cache/.

Usage:
    import warp_cache as WC
    det = WC.get_det(card_path)         # cached if present, else seg + cache
Then feed `det` to N.cv_extract_conditions / N.corner_crops / N.card_mask_warped.
"""
import os, hashlib
from pathlib import Path
import numpy as np, cv2

_HERE = Path(os.path.dirname(os.path.abspath(__file__)))
WARP_DIR = _HERE / "feature_extraction_dataset" / "warp_cache"
WARP_DIR.mkdir(parents=True, exist_ok=True)


def _key(path):
    return hashlib.md5(os.path.abspath(path).encode()).hexdigest()[:16]


def _src_md5(path):
    """md5 of the file's CONTENT — so replacing a file (same path) invalidates its warp."""
    h = hashlib.md5()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def load_warp(path):
    """Return a det dict from cache, or None if not cached / STALE (file content changed)."""
    p = WARP_DIR / (_key(path) + ".npz")
    if not p.exists():
        return None
    d = np.load(p, allow_pickle=False)
    if "src_md5" in d.files:                       # content-validate (legacy entries lack this → trusted)
        if str(d["src_md5"]) != _src_md5(path):
            return None                            # file replaced since cache → stale → force re-warp
    warped = cv2.imdecode(d["warped_png"], cv2.IMREAD_COLOR)
    cw = d["cw"]
    return {"warped": warped, "cw": (cw if cw.size else None),
            "cb": [float(v) for v in d["cb"]], "seg_conf": float(d["seg_conf"]),
            "detector": "seg(cached)", "path": os.path.abspath(path)}


def save_warp(path, det):
    png = cv2.imencode(".png", det["warped"])[1].reshape(-1).astype(np.uint8)
    cw = np.asarray(det["cw"], np.float32) if det.get("cw") is not None else np.array([], np.float32)
    np.savez(WARP_DIR / (_key(path) + ".npz"), warped_png=png, cw=cw,
             cb=np.array(det["cb"], np.float32), seg_conf=np.float32(det.get("seg_conf", 0)),
             src_md5=np.array(_src_md5(path)))     # bind warp to the file content it was computed from


def get_det(path, out_size=None, force=False):
    """Cached seg detection/warp for `path` (computes + caches on a miss)."""
    if not force:
        d = load_warp(path)
        if d is not None:
            return d
    import nonvlm_cv as N
    img = cv2.imread(path)
    det = N.detect_and_warp(img, detector="seg", out_size=out_size or N.CV_WARP_SIZE)
    det["path"] = os.path.abspath(path)
    save_warp(path, det)
    return det


def stats():
    n = len(list(WARP_DIR.glob("*.npz")))
    mb = sum(f.stat().st_size for f in WARP_DIR.glob("*.npz")) / 1e6
    return {"cached_cards": n, "size_mb": round(mb, 1), "dir": str(WARP_DIR)}
