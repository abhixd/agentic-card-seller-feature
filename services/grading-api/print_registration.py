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
MAX_SCALE_DEV = float(os.environ.get("PRINT_REG_MAX_SCALE_DEV", "0.01"))   # read error tracks |scale-1|:
# dev 0.005 → clean reads; dev 0.015 (mimikyu, warp crop ≠ die line) → TB off by 11pts. Both images are
# cropped to the die line, so a real match MUST be ~unit scale; beyond 1% the mapped frame inherits the
# crop bias → reject and let the selector read stand. (Scale-off cards are exactly the future outer-anchor
# corrector's population — rescue-not-reject is the upgrade path if they prove common.)
MIN_YEAR      = int(os.environ.get("PRINT_REG_MIN_YEAR", "2011"))   # older renders are SCANS of physical copies
# Render-verified scratch filter: a scratch is a deviation FROM THE PRINT, and the registered render IS the
# print — so a detected "scratch" whose line exists in the render is printed content (art/text), not damage.
SCRATCH_FILTER = os.environ.get("PRINT_REG_SCRATCH_FILTER", "").strip().lower() in ("1", "true", "yes", "on")
SCRATCH_NOVEL_THR = float(os.environ.get("PRINT_REG_SCRATCH_THR", "0.30"))
NOMINAL_INSET = 0.034            # per_side_selector.CENTER — the expected print-frame inset on a modern card
_CACHE = os.path.join(tempfile.gettempdir(), "print_reg_refs")
os.makedirs(_CACHE, exist_ok=True)


# ── reference resolution: identity → pokemontcg id → official hires render ──────────────────────────
_RESOLVE_MEMO: dict = {}       # identity key → ("neg", reason) | ("cands", [cid,...]) | ("winner", cid, [cid,...])
_CAND_K = int(os.environ.get("PRINT_REG_CANDIDATES", "3"))          # try-and-verify: register up to K candidates

# Vision-ID set phrasings → tokens dropped before matching pokemontcg set names. Registration itself is the
# real verifier (a wrong candidate can't register), so matching here only needs to get the right card INTO
# the top-K — not to be perfect.
_FILLER_TOKENS = {"the", "a", "base", "set", "series", "expansion", "collection", "edition",
                  "black", "star", "promo", "promos", "promotional", "holiday", "exclusive"}


def _tokens(s):
    import re, unicodedata
    s = unicodedata.normalize("NFKD", str(s or "")).encode("ascii", "ignore").decode()
    return {t for t in re.split(r"[^a-z0-9]+", s.lower()) if t and t not in _FILLER_TOKENS}


def _num_parts(number):
    """'085/198' → ('85', 198); '25' → ('25', None). pokemontcg stores numbers unpadded."""
    import re
    s = str(number or "")
    m = re.search(r"(\d+)", s)
    num = str(int(m.group(1))) if m else None
    d = re.search(r"/\s*(\d+)", s)
    return num, (int(d.group(1)) if d else None)


def _candidate_ids(identity):
    """Ranked pokemontcg candidate ids for an identity — top-K by a registration-oriented score:
    the collector-number DENOMINATOR vs the set's printed size is the strongest cue (promos don't carry
    '/198'), then set-name token overlap, then promo-affinity. Variant is deliberately NOT queried (it
    over-filters; it exists for pricing). Returns [] when nothing plausible."""
    import requests as _rq
    name = identity.get("name") or ""
    num, denom = _num_parts(identity.get("number"))
    headers = {}
    key = os.environ.get("POKEMONTCG_API_KEY")
    if key:
        headers["X-Api-Key"] = key

    errored = [0]

    def q(query):
        for attempt in (0, 1):                                       # one retry — the API blips regularly
            try:
                r = _rq.get("https://api.pokemontcg.io/v2/cards",
                            params={"q": query, "pageSize": 30, "orderBy": "-set.releaseDate",
                                    "select": "id,name,number,set,images"},
                            headers=headers, timeout=10.0)
                return (r.json() or {}).get("data") or []
            except Exception:
                if attempt == 0:
                    import time as _t; _t.sleep(1.0)
        errored[0] += 1
        return []

    cards = q(f'name:"{name}" number:"{num}"') if num else []
    if not cards and num and " " in name:                            # "Charizard GX" → "Charizard"
        cards = q(f'name:"{name.split()[0]}" number:"{num}"')
    if not cards:
        cards = q(f'name:"{name}"')
    if not cards:
        return None if errored[0] else []                            # None = transient API failure, [] = true no-match
    idt = _tokens(identity.get("set"))
    id_is_promo = bool({"promo", "promos", "black"} & _tokens((identity.get("set") or "") + " " +
                                                              (identity.get("variant") or "")) |
                       ({"promo"} if "promo" in str(identity.get("set") or "").lower() else set()))

    def score(c):
        st = c.get("set") or {}
        s = 0.0
        if denom and denom in (st.get("printedTotal"), st.get("total")):
            s += 4.0                                                 # '/198' ⇒ a 198-card set, not a promo
        ct = _tokens(f"{st.get('name','')} {st.get('series','')} {st.get('id','')}")
        if idt:
            s += 3.0 * len(idt & ct) / len(idt)
        cand_is_promo = "promo" in (st.get("name") or "").lower() or str(st.get("id", "")).endswith("p")
        if id_is_promo == cand_is_promo:
            s += 1.0
        if num and _num_parts(c.get("number"))[0] == num:
            s += 1.0
        return s

    ranked = sorted(cards, key=score, reverse=True)
    out, seen = [], set()
    for c in ranked:
        cid = c.get("id")
        if cid and "-" in cid and cid not in seen:
            out.append(cid); seen.add(cid)
            url = ((c.get("images") or {}).get("large")) or ((c.get("images") or {}).get("small"))
            if url:                                              # the API's own URL beats the constructed
                _IMG_URLS[cid] = url                             # {set}/{num}_hires.png (404s on some sets)
        if len(out) >= _CAND_K:
            break
    return out


_IMG_URLS: dict = {}                                                # cid → the API's own images.large URL


def _fetch_render(cid):
    """Official render for a pokemontcg id, disk-cached. Prefers the API's own images URL (the constructed
    {set}/{num}_hires.png 404s on some sets); falls back to the hires pattern. (None, reason) on failure."""
    set_id, num = cid.rsplit("-", 1)
    fp = os.path.join(_CACHE, f"{set_id}_{num}.png")
    try:
        if not os.path.exists(fp):
            import requests as _rq
            urls = []
            if _IMG_URLS.get(cid):
                urls.append(_IMG_URLS[cid])
            urls.append(f"https://images.pokemontcg.io/{set_id}/{num}_hires.png")
            last = None
            for url in urls:
                r = _rq.get(url, timeout=30, headers={"User-Agent": "card-grader/1.0"})
                last = r.status_code
                if r.status_code == 200 and len(r.content) >= 10_000:
                    with open(fp, "wb") as f:
                        f.write(r.content)
                    break
            else:
                return None, f"render http {last}"
        ref = cv2.imread(fp)
        return (ref, cid) if ref is not None else (None, "render decode")
    except Exception as e:
        return None, f"render {type(e).__name__}"


def _identity_key(identity):
    return (identity.get("name"), identity.get("set"), identity.get("number"), identity.get("variant"))


def resolve_candidates(identity):
    """identity → (candidate_ids, reason_if_empty). Memoized (winner-first after an acceptance)."""
    if not identity or not identity.get("name"):
        return [], "no identity"
    key = _identity_key(identity)
    memo = _RESOLVE_MEMO.get(key)
    if memo:
        if memo[0] == "neg":
            return [], memo[1]
        if memo[0] == "winner":                                      # winner first, then the other candidates
            return [memo[1]] + [c for c in memo[2] if c != memo[1]], None
        return memo[1], None
    yr = identity.get("year")
    if isinstance(yr, (int, float)) and yr and yr < MIN_YEAR:        # vintage → render is a scan, not the print
        _RESOLVE_MEMO[key] = ("neg", f"vintage ({int(yr)} < {MIN_YEAR})")
        return [], f"vintage ({int(yr)} < {MIN_YEAR})"
    cands = _candidate_ids(identity)
    if cands is None:                                                # transient API failure — NOT memoized
        return [], "lookup unavailable"
    if not cands:
        _RESOLVE_MEMO[key] = ("neg", "no pokemontcg match")          # true no-match → memoized
        return [], "no pokemontcg match"
    _RESOLVE_MEMO[key] = ("cands", cands)
    return cands, None


def mark_winner(identity, cid):
    key = _identity_key(identity)
    memo = _RESOLVE_MEMO.get(key)
    cands = memo[1] if memo and memo[0] == "cands" else (memo[2] if memo and memo[0] == "winner" else [cid])
    _RESOLVE_MEMO[key] = ("winner", cid, cands)


def resolve_reference(identity):
    """Back-compat single-reference resolve (lab tools): first candidate's render."""
    cands, why = resolve_candidates(identity)
    if not cands:
        return None, why
    return _fetch_render(cands[0])


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
    meta["_filter_ctx"] = (card, ref, M)                            # working-scale images + fit, for the
    return meta                                                     # scratch filter; popped before serializing


# ── render-verified scratch filter ──────────────────────────────────────────────────────────────────
def _novel_line_score(card_w, ref_dil, box_px):
    """Does the box contain a coherent LINE absent from the render? Largest connected novel-edge
    component's extent / box diagonal, chance-corrected by the render's local edge coverage (in busy art
    the dilated render edges blanket most of a patch, which would otherwise eat a real scratch).
    Validated: content-line FPs ≤0.24, real/synthetic scratches ≥0.32 (scratch_filter_proto)."""
    x1, y1, x2, y2 = [int(v) for v in box_px]
    x1, y1 = max(x1, 0), max(y1, 0)
    x2, y2 = min(x2, card_w.shape[1]), min(y2, card_w.shape[0])
    if x2 - x1 < 4 or y2 - y1 < 4:
        return None
    ours = cv2.Canny(cv2.cvtColor(card_w[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY), 60, 140)
    if int((ours > 0).sum()) < 20:
        return None                                                 # too little structure to judge
    ref_e = ref_dil[y1:y2, x1:x2]
    coverage = float((ref_e > 0).mean())
    novel = cv2.dilate(((ours > 0) & (ref_e == 0)).astype(np.uint8), np.ones((3, 3), np.uint8))
    ncomp, _, stats, _ = cv2.connectedComponentsWithStats(novel, 8)
    if ncomp <= 1:
        return 0.0
    diags = [np.hypot(stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT]) for i in range(1, ncomp)]
    raw = float(max(diags) / max(np.hypot(x2 - x1, y2 - y1), 1.0))
    return min(raw / max(1.0 - coverage, 0.15), 1.5)


def _filter_surface_boxes(result, cen, card_full, filter_ctx):
    """Suppress RF-DETR surface boxes whose 'scratch' line exists in the registered render (printed content,
    not damage). Suppress-only; kept boxes gain render_novel for observability. Non-fatal."""
    boxes = (result.get("defect_boxes") or {}).get("surface")
    if not boxes:
        return
    card_w, ref_w, M = filter_ctx
    Minv = cv2.invertAffineTransform(M)
    ref_on = cv2.warpAffine(ref_w, Minv, (card_w.shape[1], card_w.shape[0]))
    ref_dil = cv2.dilate(cv2.Canny(cv2.cvtColor(ref_on, cv2.COLOR_BGR2GRAY), 40, 120),
                         np.ones((3, 3), np.uint8))
    H, W = card_full.shape[:2]
    sc = card_w.shape[0] / H
    kept, suppressed = [], 0
    for b in boxes:
        try:
            x, y, w, h = b["box"]
            score = _novel_line_score(card_w, ref_dil,
                                      (x * W * sc, y * H * sc, (x + w) * W * sc, (y + h) * H * sc))
        except Exception:
            score = None
        if score is not None and score < SCRATCH_NOVEL_THR:
            suppressed += 1                                          # the line exists in the print → content
            continue
        if score is not None:
            b = dict(b); b["render_novel"] = round(score, 2)
        kept.append(b)
    result["defect_boxes"]["surface"] = kept
    cen["registration"]["scratch_filter"] = {"checked": len(boxes), "suppressed": suppressed,
                                             "threshold": SCRATCH_NOVEL_THR}


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
        cands, why = resolve_candidates(identity)
        if not cands:
            cen["registration"] = {"accepted": False, "reason": why}
            return
        card = cv2.imdecode(np.frombuffer(base64.b64decode(wj), np.uint8), cv2.IMREAD_COLOR)
        if card is None:
            cen["registration"] = {"accepted": False, "reason": "warp decode"}
            return
        # TRY-AND-VERIFY: text matching only needs to get the right card into the top-K — registration
        # itself is the verifier (a wrong card's artwork cannot produce a dense unit-scale RANSAC fit;
        # observed rejecting wrong Pokémon, wrong prints, even a card-back placeholder render).
        meta, tried = None, []
        for cid in cands:
            ref, ferr = _fetch_render(cid)
            if ref is None:
                tried.append(f"{cid}:{ferr}")
                continue
            m = register(card, ref)
            if m.get("accepted"):
                tried.append(f"{cid}:ok")
            elif m.get("inliers") is not None:                       # a fit existed — say which gate failed
                tried.append(f"{cid}:{m.get('reason', 'rej')}(inl={m.get('inliers')} "
                             f"res={m.get('resid_px')} sc={m.get('scale')})")
            else:
                tried.append(f"{cid}:{m.get('reason', 'rej')}")
            if m.get("accepted"):
                meta = m
                meta["ref_id"] = cid
                mark_winner(identity, cid)
                break
        if meta is None:
            cen["registration"] = {"accepted": False, "reason": "no candidate registered", "tried": tried}
            return
        meta["tried"] = tried
        filter_ctx = meta.pop("_filter_ctx", None)                  # numpy arrays — never serialize
        cen["registration"] = {k: v for k, v in meta.items() if k != "content_region"}
        if SCRATCH_FILTER and filter_ctx is not None:
            try:
                _filter_surface_boxes(result, cen, card, filter_ctx)
            except Exception as e:                                   # filter is optional polish — never fatal
                cen["registration"]["scratch_filter"] = {"error": type(e).__name__}
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
