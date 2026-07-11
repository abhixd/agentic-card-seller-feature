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
import os, json, tempfile
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
# Outer-anchor rescue: when the ONLY reason registration fails is scale (the warp crop includes a case/
# sleeve/slab ring around the true die-cut), band-search for the cut just outside the anchored print frame,
# crop to it, and RE-REGISTER — acceptance requires the scale to snap to unit (the verify loop the old
# geometric de-sleeve never had). Fires only when every candidate failed and a scale-only reject exists.
OUTER_RESCUE = os.environ.get("PRINT_REG_OUTER", "").strip().lower() in ("1", "true", "yes", "on")
_RESCUE_MAX_DEV = 0.25          # beyond ±25% scale the "ring" story is implausible — abstain
_RESCUE_BAND = (0.2, 1.8)       # the cut is searched within [0.2, 1.8] × nominal margin outside the print frame
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


_INDEX: list = []


def _load_index():
    """The bundled offline catalog (ptcg_index.json.gz, built from the public pokemon-tcg-data dump).
    Removes the runtime dependency on the rate-limited pokemontcg API for every card the dump knows;
    the live API remains the fallback for sets newer than the bundle."""
    if not _INDEX:
        try:
            import gzip
            fp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ptcg_index.json.gz")
            with gzip.open(fp, "rt") as f:
                _INDEX.extend(json.loads(f.read()))
        except Exception:
            _INDEX.append(None)                                      # sentinel: load failed → API-only
    return [r for r in _INDEX if r]


def _local_cards(name, num):
    """Offline equivalent of the API queries: exact name + number → first-token + number → name-only.
    Returns rows shaped like API card objects (for the shared score())."""
    idx = _load_index()
    if not idx:
        return []
    nl = (name or "").lower()

    def to_card(r):
        return {"id": r["id"], "name": r["n"], "number": r["num"],
                "set": {"name": r["set"], "id": r["sid"], "series": r["ser"],
                        "printedTotal": r["pt"], "total": r["tot"], "releaseDate": r["rd"]},
                "images": {"large": r["img"]}}

    def match(pred):
        rows = [r for r in idx if pred(r)]
        rows.sort(key=lambda r: r["rd"], reverse=True)               # newest sets first, like the API
        return [to_card(r) for r in rows[:30]]

    out = match(lambda r: r["n"] == nl and (not num or _num_parts(r["num"])[0] == num)) if nl else []
    if not out and num and " " in nl:
        base = nl.split()[0]
        out = match(lambda r: r["n"].split()[0] == base and _num_parts(r["num"])[0] == num)
    if not out and nl:
        out = match(lambda r: r["n"] == nl or r["n"].startswith(nl + " "))
    if not out and nl and len(nl) >= 4:                              # spelling-variant tail: substring match is
        out = match(lambda r: nl in r["n"] or r["n"] in nl)          # safe — registration verifies every render
    return out


def _candidate_ids(identity):
    """Ranked pokemontcg candidate ids for an identity — top-K by a registration-oriented score:
    the collector-number DENOMINATOR vs the set's printed size is the strongest cue (promos don't carry
    '/198'), then set-name token overlap, then promo-affinity. Variant is deliberately NOT queried (it
    over-filters; it exists for pricing). Resolution is OFFLINE-FIRST (bundled index); the live API runs
    only when the bundle has no match (newer sets). Returns [] when nothing plausible, None on transient
    API failure."""
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

    cards = _local_cards(name, num)                                  # offline-first: no rate limits, ~1ms
    if not cards:
        cards = q(f'name:"{name}" number:"{num}"') if num else []
        if not cards and num and " " in name:                        # "Charizard GX" → "Charizard"
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


def register(card_bgr, ref_bgr, gates=None):
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
    cv2.setRNGSeed(1234567)                                          # RANSAC is stochastic — borderline fits
    M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC,  # (cased cards ~47 inl) flapped between
                                         ransacReprojThreshold=3.0,    # rescue-eligible and not across runs.
                                         maxIters=10000)               # Seed + more iters = deterministic.
    if M is None or inl is None or int(inl.sum()) < 20:
        return {"accepted": False, "reason": "ransac failed", "matches": len(good)}
    keep = inl.ravel() == 1
    resid = float(np.median(np.linalg.norm((src[keep] @ M[:, :2].T + M[:, 2]) - dst[keep], axis=1)))
    scale = float(np.linalg.norm(M[:, 0]))
    meta = {"inliers": int(inl.sum()), "matches": len(good), "resid_px": round(resid, 2),
            "scale": round(scale, 4)}
    min_inl, max_res, max_dev = gates or (MIN_INLIERS, MAX_RESID, MAX_SCALE_DEV)
    meta["accepted"] = bool(meta["inliers"] >= min_inl and resid <= max_res
                            and abs(scale - 1.0) <= max_dev)
    if gates:
        meta["gate"] = "rescue-verify"
    # Secondary acceptance — sparse-texture cards (alt-arts, glare, sleeves) can produce few anchors whose
    # geometry is nonetheless impeccable. Wrong cards never fit sub-pixel at unit scale (worst observed
    # wrong-ish fit: res 1.16 @ scale dev 0.018 — rejected here by the dev gate), so tighter geometry may
    # compensate for fewer points. Cases: sv10-31 inl=42 res=0.72 sc=0.9985; swsh5-177 55/1.22/1.0019 (still
    # rejected — res above this bar, correctly conservative).
    if not meta["accepted"] and meta["inliers"] >= 40 and resid <= 1.0 and abs(scale - 1.0) <= 0.005:
        meta["accepted"] = True
        meta["gate"] = "secondary (tight-geometry)"
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


# ── outer-anchor rescue (cased/slabbed/sleeved raw cards) ───────────────────────────────────────────
def _fit_loose(card_bgr, ref_bgr):
    """Gate-free registration fit → (card_work, ref_work, M) or None. Used only to locate the print frame
    when the gated register() refused on scale — the rescue's final acceptance re-runs the FULL gates."""
    Hn = 1024
    sc = Hn / card_bgr.shape[0]
    card = cv2.resize(card_bgr, (int(card_bgr.shape[1] * sc), Hn))
    ref = cv2.resize(ref_bgr, (int(ref_bgr.shape[1] * Hn / ref_bgr.shape[0]), Hn))
    gc, gr = _prep(cv2.cvtColor(card, cv2.COLOR_BGR2GRAY)), _prep(cv2.cvtColor(ref, cv2.COLOR_BGR2GRAY))

    def interior(im):
        m = np.zeros(im.shape[:2], np.uint8)
        b = int(0.06 * min(im.shape[:2]))
        m[b:-b, b:-b] = 255
        return m

    sift = cv2.SIFT_create(nfeatures=6000)
    kc, dc = sift.detectAndCompute(gc, interior(gc))
    kr, dr = sift.detectAndCompute(gr, interior(gr))
    if dc is None or dr is None:
        return None
    good = [m for m, n in cv2.BFMatcher(cv2.NORM_L2).knnMatch(dc, dr, k=2) if m.distance < 0.75 * n.distance]
    if len(good) < 25:
        return None
    src = np.float32([kc[m.queryIdx].pt for m in good])
    dst = np.float32([kr[m.trainIdx].pt for m in good])
    cv2.setRNGSeed(1234567)
    M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0, maxIters=10000)
    if M is None or inl is None or int(inl.sum()) < 20:
        return None
    return card, ref, M


def _band_cut_search(card_work, frame_px, size_meas=None):
    """Locate the die-cut as a FIXED-SIZE box slide. The anchored print frame determines the card's exact
    pixel size (frame / (1-2×inset)) — only the box POSITION is unknown (2 dof). Slide that box over
    ±1.5×nominal and jointly maximize perpendicular edge energy along all FOUR sides at once: independent
    per-side peaks allowed correlated drift (both horizontal cuts grabbing lines shifted the same way,
    which preserves scale and per-side prominence); the true die-cut is the only rectangle of exactly this
    size with aligned edges on all four sides."""
    H, W = card_work.shape[:2]
    gray = cv2.cvtColor(card_work, cv2.COLOR_BGR2GRAY).astype(np.float32)
    gx = np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0, 3))
    gy = np.abs(cv2.Sobel(gray, cv2.CV_32F, 0, 1, 3))
    fx1, fy1, fx2, fy2 = frame_px
    m_nom = NOMINAL_INSET / (1 - 2 * NOMINAL_INSET) * (fx2 - fx1)    # nominal print→cut margin, px
    if size_meas:                                                    # MEASURED card size (ref dims / fit
        bw, bh, tol = size_meas[0], size_meas[1], 0.008              # scale — ~resid-accurate): tight tie
    else:                                                            # kills wrong-pair grabs (title bar +
        bw = (fx2 - fx1) / (1 - 2 * NOMINAL_INSET)                   # shadow spacing ≠ measured height)
        bh = (fy2 - fy1) / (1 - 2 * NOMINAL_INSET)
        tol = 0.035                                                  # nominal fallback: allow inset variance
    colscore = gx[int(H * 0.2):int(H * 0.8)].mean(0)                 # vertical-edge energy per column
    rowscore = gy[:, int(W * 0.2):int(W * 0.8)].mean(1)              # horizontal-edge energy per row
    img = card_work.astype(np.float32)
    k = max(int(0.02 * min(H, W)), 8)                                # the warp corners = pure surround (the
    case_ref = np.median(np.concatenate([                            # ring exists — that's what fired the
        img[:k, :k].reshape(-1, 3), img[:k, -k:].reshape(-1, 3),     # rescue), so they define what "outside
        img[-k:, :k].reshape(-1, 3), img[-k:, -k:].reshape(-1, 3)]), axis=0)   # the card" looks like.

    def outside_ok(axis, p, low_side):
        """A TRUE cut has the surround (case/table) OUTSIDE it and card INSIDE — an interior line (title
        bar) has card on both sides. Size ties can't break pure-translation ambiguity; this can."""
        o1, o2 = (p - 9, p - 3) if low_side else (p + 3, p + 9)
        i1, i2 = (p + 3, p + 9) if low_side else (p - 9, p - 3)
        if axis == "y":
            out = img[max(o1, 0):max(o2, 1), int(W * 0.2):int(W * 0.8)]
            ins = img[max(i1, 0):max(i2, 1), int(W * 0.2):int(W * 0.8)]
        else:
            out = img[int(H * 0.2):int(H * 0.8), max(o1, 0):max(o2, 1)]
            ins = img[int(H * 0.2):int(H * 0.8), max(i1, 0):max(i2, 1)]
        if out.size == 0 or ins.size == 0:
            return False
        d_out = float(np.abs(out.reshape(-1, 3).mean(0) - case_ref).sum())
        d_in = float(np.abs(ins.reshape(-1, 3).mean(0) - case_ref).sum())
        return d_out < 0.8 * d_in + 10.0                             # outside must resemble the surround more

    def axis_pair(score, e1, e2, size, limit, axis):
        """Opposite sides searched JOINTLY: each within its band outside the frame, outside-looks-like-
        surround required per side, the PAIR tied to the measured size, max summed edge energy."""
        a1 = [p for p in range(int(max(e1 - _RESCUE_BAND[1] * m_nom, 0)),
                               int(max(e1 - _RESCUE_BAND[0] * m_nom, 1))) if outside_ok(axis, p, True)]
        a2 = [p for p in range(int(min(e2 + _RESCUE_BAND[0] * m_nom, limit - 1)),
                               int(min(e2 + _RESCUE_BAND[1] * m_nom, limit - 1)) + 1) if outside_ok(axis, p, False)]
        best, bs = None, -1.0
        for p1 in a1:
            for p2 in a2:
                if abs((p2 - p1) - size) > tol * size:
                    continue
                s = float(score[p1] + score[p2])
                if s > bs:
                    bs, best = s, (p1, p2)
        return best

    xp = axis_pair(colscore, fx1, fx2, bw, W, "x")
    yp = axis_pair(rowscore, fy1, fy2, bh, H, "y")
    if xp is None or yp is None:
        return None
    return {"L": xp[0], "T": yp[0], "R": xp[1], "B": yp[1]}


def _rescue_outer(card_bgr, ref_bgr):
    """Full rescue: locate print frame (gate-free fit) → band-search the die-cut outside it → crop →
    re-register with the FULL gates. Returns None (abstain) or a dict with the verified read + the cut
    box as fractions of the ORIGINAL warp (for the display boundary)."""
    lf = _fit_loose(card_bgr, ref_bgr)
    if lf is None:
        return None
    card_w, ref_w, M = lf
    RW, RH = ref_w.shape[1], ref_w.shape[0]
    ins = NOMINAL_INSET
    frame = np.float32([[RW * ins, RH * ins], [RW * (1 - ins), RH * ins],
                        [RW * (1 - ins), RH * (1 - ins)], [RW * ins, RH * (1 - ins)]])
    Minv = cv2.invertAffineTransform(M)
    mapped = frame @ Minv[:, :2].T + Minv[:, 2]
    fp = (float(mapped[:, 0].min()), float(mapped[:, 1].min()),
          float(mapped[:, 0].max()), float(mapped[:, 1].max()))
    scale = float(np.linalg.norm(M[:, 0]))                           # card px × scale = render px, so the
    size_meas = (RW / scale, RH / scale)                             # card's TRUE pixel size is measured
    cuts = _band_cut_search(card_w, fp, size_meas)
    if cuts is None:
        return None
    bx1, by1, bx2, by2 = cuts["L"], cuts["T"], cuts["R"], cuts["B"]
    if bx2 - bx1 < 200 or by2 - by1 < 200:
        return None
    # Verify-or-abstain: the artwork match was already established pre-crop (that's what fired the rescue);
    # this re-registration verifies the CROP — the scale must snap to unit. Textured/cased cards give sparse
    # anchors, so the anchor bar relaxes to 40 while the SCALE bar tightens to 1.2% (the actual verify).
    crop = card_w[by1:by2, bx1:bx2]
    # Verify gates: identity was already established by the pre-crop fit, so the anchor bar here is low
    # (30); the SCALE bar (1.2%) is the actual verify — a mis-sized crop cannot re-register at unit scale.
    meta2 = register(crop, ref_bgr, gates=(30, MAX_RESID, 0.012))
    if not meta2.get("accepted"):
        return None
    # Margin sanity from the RE-REGISTERED frame (trustworthy — scale verified): each print→cut margin must
    # be plausible vs nominal. Catches correlated cut shifts that preserve scale (e.g. both horizontal cuts
    # grabbing interior lines). [0.35, 1.8]×nominal tolerates real miscuts to ~82/18 but not interior grabs.
    cr0 = meta2["content_region"]
    nom = NOMINAL_INSET / (1 - 2 * NOMINAL_INSET) * (cr0["x2"] - cr0["x1"])
    for m in (cr0["x1"], 1 - cr0["x2"], cr0["y1"], 1 - cr0["y2"]):
        if not (0.35 * nom <= m <= 1.8 * nom):
            return None
    Hw, Ww = card_w.shape[:2]
    cut_frac = (bx1 / Ww, by1 / Hw, bx2 / Ww, by2 / Hw)
    cr = meta2["content_region"]                                     # fractions of the CROP → map to warp coords
    cw, ch = cut_frac[2] - cut_frac[0], cut_frac[3] - cut_frac[1]
    meta2["content_region"] = {"x1": round(cut_frac[0] + cr["x1"] * cw, 4),
                               "y1": round(cut_frac[1] + cr["y1"] * ch, 4),
                               "x2": round(cut_frac[0] + cr["x2"] * cw, 4),
                               "y2": round(cut_frac[1] + cr["y2"] * ch, 4)}
    meta2["cut_box"] = [round(v, 4) for v in cut_frac]
    meta2["outer_corrected"] = True
    return meta2


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


def _redraw_centering_viz(result, cen):
    """The 'what we measured' popup shows a SERVER-BAKED overlay (pillar_visuals.centering) rendered by
    the grader BEFORE registration runs — after an anchored/rescued read replaces the selector's, that
    image still shows the OLD boundaries. Redraw it from the current _card_boundary + content_region
    (same colors/format as cv_grader._viz_centering) so the picture matches the numbers."""
    import base64
    pv = result.get("pillar_visuals")
    wj = result.get("_warped_jpeg_b64")
    if not isinstance(pv, dict) or not wj:
        return
    im = cv2.imdecode(np.frombuffer(base64.b64decode(wj), np.uint8), cv2.IMREAD_COLOR)
    if im is None:
        return
    H, W = im.shape[:2]
    cb = result.get("_card_boundary") or [0.0, 0.0, 1.0, 1.0]
    cv2.rectangle(im, (int(cb[0] * W), int(cb[1] * H)), (int(cb[2] * W), int(cb[3] * H)), (0, 255, 0), 2)
    cr = cen.get("content_region")
    if cr:
        cv2.rectangle(im, (int(cr["x1"] * W), int(cr["y1"] * H)),
                      (int(cr["x2"] * W), int(cr["y2"] * H)), (0, 200, 255), 2)
    ok, buf = cv2.imencode(".jpg", im, [int(cv2.IMWRITE_JPEG_QUALITY), 85])
    if ok:
        pv["centering"] = base64.b64encode(buf.tobytes()).decode()


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
        meta, tried, scale_rejects = None, [], []
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
                if (m["inliers"] >= 40 and (m.get("resid_px") or 9) <= MAX_RESID
                        and MAX_SCALE_DEV < abs((m.get("scale") or 1) - 1.0) <= _RESCUE_MAX_DEV):
                    scale_rejects.append((m["inliers"], cid, ref))   # scale-ONLY reject → rescue candidate
            else:
                tried.append(f"{cid}:{m.get('reason', 'rej')}")
            if m.get("accepted"):
                meta = m
                meta["ref_id"] = cid
                mark_winner(identity, cid)
                break
        if meta is None and OUTER_RESCUE and scale_rejects:
            # The fit is real but the warp crop includes a case/sleeve ring — try the outer-anchor rescue
            # with the best-fitting candidate. Acceptance is the full-gate re-registration on the crop.
            _, cid, ref = max(scale_rejects)
            r = _rescue_outer(card, ref)
            if r is not None:
                meta = r
                meta["ref_id"] = cid
                mark_winner(identity, cid)
                tried.append(f"{cid}:outer-rescued(sc→{meta.get('scale')})")
        if meta is None:
            cen["registration"] = {"accepted": False, "reason": "no candidate registered", "tried": tried}
            return
        meta["tried"] = tried
        filter_ctx = meta.pop("_filter_ctx", None)                  # numpy arrays — never serialize
        cen["registration"] = {k: v for k, v in meta.items() if k != "content_region"}
        if meta.get("outer_corrected") and meta.get("cut_box"):
            # The true die-cut sits INSIDE the displayed warp (case/sleeve ring around it) — move the
            # outer boundary so the UI's green rect hugs the actual card. content_region is already
            # mapped into the same (original-warp) coordinates.
            result["_card_boundary"] = list(meta["cut_box"])
            filter_ctx = None                                        # crop-frame ctx ≠ warp-frame boxes → skip
            cen["registration"]["scratch_filter"] = {"skipped": "outer-corrected (frame mismatch)"}
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
        try:
            _redraw_centering_viz(result, cen)                      # keep the baked popup in sync with the read
        except Exception:
            pass
    except Exception as e:                                          # never break a grade over registration
        cen["registration"] = {"accepted": False, "reason": f"{type(e).__name__}: {e}"}
