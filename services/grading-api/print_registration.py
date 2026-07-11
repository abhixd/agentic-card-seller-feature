"""
print_registration.py — PRINT_REG=1: identity-anchored centering via print registration (kill-switchable).

Centering is physically the offset between the PRINT LAYER and the DIE-CUT. For an IDENTIFIED card the
official pokemontcg.io render IS the print layer with perfect centering by construction, so instead of
detecting the inner frame photometrically (fragile on full-arts/foil — the per-side selector's hard tail),
we SIFT+RANSAC-register our die-cut-cropped warp against the render and read the print offset directly.
Validated in the lab (research/rfdetr_scratch/ref_centering.py): ~1px residual, scale 1.000, self-gating.

Wiring (main.py layer, NOT the grader): after a grade result exists and an identity is known, apply_to_result()
replaces centering left_right/top_bottom/content_region/score when — and only when — the registration passes
the acceptance gate (dense inliers + ~px residual + unit scale). Anything else leaves the read untouched, so
the per-side selector remains the universal fallback (unidentified cards, vintage scans, failed matches).

KILL SWITCH: env PRINT_REG — unset/0 = fully off (no identity fetch, no behavior change); "1"/"on" = active.
Tunables: PRINT_REG_MIN_INLIERS (60) · PRINT_REG_MAX_RESID (2.5 px) · PRINT_REG_MAX_SCALE_DEV (0.03).

⚠ Modern digital-era renders only: vintage pokemontcg images are SCANS of physical copies (their own print
offset baked in), so vintage registration would measure our-copy-vs-their-copy. resolve gates on set release
year when available; the acceptance gate is the backstop.
"""
import os, tempfile
import numpy as np
import cv2

ENABLED       = os.environ.get("PRINT_REG", "").strip().lower() in ("1", "true", "yes", "on")
MIN_INLIERS   = int(os.environ.get("PRINT_REG_MIN_INLIERS", "60"))
MAX_RESID     = float(os.environ.get("PRINT_REG_MAX_RESID", "2.5"))
MAX_SCALE_DEV = float(os.environ.get("PRINT_REG_MAX_SCALE_DEV", "0.03"))
MIN_YEAR      = int(os.environ.get("PRINT_REG_MIN_YEAR", "2011"))   # older renders are SCANS of physical copies
NOMINAL_INSET = 0.034            # per_side_selector.CENTER — the expected print-frame inset on a modern card
_CACHE = os.path.join(tempfile.gettempdir(), "print_reg_refs")
os.makedirs(_CACHE, exist_ok=True)


# ── reference resolution: identity → pokemontcg id → official hires render ──────────────────────────
def resolve_reference(identity):
    """identity {name,set,number,variant} → (ref_bgr, ptcg_id) or (None, reason). Uses the price feed's
    existing pokemontcg matcher so card resolution logic stays in ONE place."""
    if not identity or not identity.get("name"):
        return None, "no identity"
    yr = identity.get("year")
    if isinstance(yr, (int, float)) and yr and yr < MIN_YEAR:       # vintage → render is a scan, not the print layer
        return None, f"vintage ({int(yr)} < {MIN_YEAR})"
    try:
        import price_sources
        pc = price_sources.pokemontcg_lookup(identity["name"], identity.get("set"),
                                             identity.get("number"), identity.get("variant"))
    except Exception as e:
        return None, f"lookup {type(e).__name__}"
    cid = (pc or {}).get("id")
    if not cid or "-" not in cid:
        return None, "no pokemontcg match"
    set_id, num = cid.rsplit("-", 1)
    fp = os.path.join(_CACHE, f"{set_id}_{num}.png")
    try:
        if not os.path.exists(fp):
            import requests
            url = f"https://images.pokemontcg.io/{set_id}/{num}_hires.png"
            r = requests.get(url, timeout=30, headers={"User-Agent": "card-grader/1.0"})
            if r.status_code != 200 or len(r.content) < 10_000:
                return None, f"render http {r.status_code}"
            with open(fp, "wb") as f:
                f.write(r.content)
        ref = cv2.imread(fp)
        return (ref, cid) if ref is not None else (None, "render decode")
    except Exception as e:
        return None, f"render {type(e).__name__}"


# ── registration (lab-validated; ref_centering.py) ─────────────────────────────────────────────────
def _prep(gray):
    """CLAHE-normalized gradient magnitude — match on structure, robust to foil/lighting/JPEG."""
    g = cv2.createCLAHE(2.0, (8, 8)).apply(gray)
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    return cv2.normalize(cv2.magnitude(gx, gy), None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)


def register(card_bgr, ref_bgr):
    """card_bgr = OUR card cropped to the die-cut (the display warp); ref_bgr = official render.
    Returns meta dict (always, for observability) — meta["accepted"] gates any use of the read.
    On acceptance, meta["content_region"] is the render's nominal print frame mapped into OUR card's
    normalized coords, and lr/tb are computed FROM that box so the drawn overlay and the numbers agree."""
    Hn = 1024
    sc = Hn / card_bgr.shape[0]
    card = cv2.resize(card_bgr, (int(card_bgr.shape[1] * sc), Hn))
    ref = cv2.resize(ref_bgr, (int(ref_bgr.shape[1] * Hn / ref_bgr.shape[0]), Hn))
    gc, gr = _prep(cv2.cvtColor(card, cv2.COLOR_BGR2GRAY)), _prep(cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY))

    def interior(im):                                   # exclude the outer 6% so the die-cut edge can't match
        m = np.zeros(im.shape[:2], np.uint8)
        b = int(0.06 * min(im.shape[:2]))
        m[b:-b, b:-b] = 255
        return m

    sift = cv2.SIFT_create(nfeatures=6000)
    kc, dc = sift.detectAndCompute(gc, interior(gc))
    kr, dr = sift.detectAndCompute(gr, interior(gr))
    if dc is None or dr is None or len(kc) < 50 or len(kr) < 50:
        return {"accepted": False, "reason": "too few features"}
    pairs = cv2.BFMatcher(cv2.NORM_L2).knnMatch(dc, dr, k=2)
    good = [m for m, n in pairs if m.distance < 0.75 * n.distance]
    if len(good) < 25:
        return {"accepted": False, "reason": "too few matches", "matches": len(good)}
    src = np.float32([kc[m.queryIdx].pt for m in good])
    dst = np.float32([kr[m.trainIdx].pt for m in good])
    M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC,
                                         ransacReprojThreshold=3.0, maxIters=5000)
    if M is None or inl is None or int(inl.sum()) < 20:
        return {"accepted": False, "reason": "ransac failed", "matches": len(good)}
    keep = inl.ravel() == 1
    resid = float(np.median(np.linalg.norm((src[keep] @ M[:, :2].T + M[:, 2]) - dst[keep], axis=1)))
    scale = float(np.linalg.norm(M[:, 0]))
    meta = {"inliers": int(inl.sum()), "matches": len(good), "resid_px": round(resid, 2),
            "scale": round(scale, 4)}
    meta["accepted"] = bool(meta["inliers"] >= MIN_INLIERS and resid <= MAX_RESID
                            and abs(scale - 1.0) <= MAX_SCALE_DEV)
    if not meta["accepted"]:
        meta["reason"] = "gate"
        return meta
    # Render's nominal print frame → OUR card coords (via the inverse transform), normalized 0..1.
    RW, RH = ref.shape[1], ref.shape[0]
    ins = NOMINAL_INSET
    frame = np.float32([[RW * ins, RH * ins], [RW * (1 - ins), RH * ins],
                        [RW * (1 - ins), RH * (1 - ins)], [RW * ins, RH * (1 - ins)]])
    Minv = cv2.invertAffineTransform(M)
    mapped = frame @ Minv[:, :2].T + Minv[:, 2]                    # working-scale card px
    x1, y1 = float(mapped[:, 0].min()), float(mapped[:, 1].min())
    x2, y2 = float(mapped[:, 0].max()), float(mapped[:, 1].max())
    W, Hh = card.shape[1], card.shape[0]
    cr = {"x1": x1 / W, "y1": y1 / Hh, "x2": x2 / W, "y2": y2 / Hh}
    L, R = cr["x1"], 1 - cr["x2"]
    T, B = cr["y1"], 1 - cr["y2"]
    if min(L, R, T, B) <= 0:                                       # print frame outside the die-cut → nonsense
        meta["accepted"] = False
        meta["reason"] = "frame outside die-cut"
        return meta
    meta["content_region"] = {k: round(v, 4) for k, v in cr.items()}
    meta["lr"] = f"{round(L / (L + R) * 100)}/{round(R / (L + R) * 100)}"
    meta["tb"] = f"{round(T / (T + B) * 100)}/{round(B / (T + B) * 100)}"
    return meta


# ── result integration ──────────────────────────────────────────────────────────────────────────────
def apply_to_result(result, identity):
    """Mutates result.centering in place when registration is accepted; always attaches
    centering.registration for observability. Non-fatal by construction."""
    if not ENABLED:
        return
    cen = result.get("centering")
    if not isinstance(cen, dict):
        return
    try:
        import base64
        wj = result.get("_warped_jpeg_b64")
        if not wj:
            cen["registration"] = {"accepted": False, "reason": "no warp"}
            return
        ref, why = resolve_reference(identity)
        if ref is None:
            cen["registration"] = {"accepted": False, "reason": why}
            return
        card = cv2.imdecode(np.frombuffer(base64.b64decode(wj), np.uint8), cv2.IMREAD_COLOR)
        if card is None:
            cen["registration"] = {"accepted": False, "reason": "warp decode"}
            return
        meta = register(card, ref)
        meta["ref_id"] = why                                        # the matched pokemontcg id
        cen["registration"] = {k: v for k, v in meta.items() if k != "content_region"}
        if not meta.get("accepted"):
            return
        # Accepted → the registered read replaces the selector's. Score ladder stays byte-compatible.
        from cv_grader import _centering_score
        lr, tb = meta["lr"], meta["tb"]
        cen["left_right"], cen["top_bottom"] = lr, tb
        cen["content_region"] = meta["content_region"]
        cen["score"] = _centering_score(lr, tb)
        cen["_source"] = "print_reg"
        # Confidence: registration is sub-pixel when accepted; the warp (die-cut) quality still gates via
        # g_geom (a loose/tilted warp shifts the die-cut crop itself). Stability MINs in afterwards.
        reg_conf = 0.95 if meta["resid_px"] <= 1.5 else 0.85
        g_geom = ((result.get("_rect_check") or {}).get("g_geom"))
        cen["confidence"] = round(min(reg_conf, g_geom) if g_geom is not None else reg_conf, 3)
        if isinstance(result.get("summary"), str) and "Centering" in result["summary"]:
            import re
            result["summary"] = re.sub(r"Centering \d+/\d+ L/R · \d+/\d+ T/B",
                                       f"Centering {lr} L/R · {tb} T/B", result["summary"])
    except Exception as e:                                          # never break a grade over registration
        cen["registration"] = {"accepted": False, "reason": f"{type(e).__name__}: {e}"}
