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
_RESCUE_MIN_DEV = float(os.environ.get("PRINT_REG_RESCUE_MIN_DEV", "0.03"))
# ^ the rescue needs an UNAMBIGUOUS ring: a case/toploader adds ≥3-5% (card_035: 9.9%). A 1-3% excess is
#   just a slightly loose SAM3 warp — rescuing there INVENTS a cut inside the card (card_006 @1.48%: the
#   mapped cut chopped 2% off the bottom and read a false 50/50 while the selector's 42/58 was correct).
#   Gray zone (1-3%): keep the selector read, demote confidence (the scale excess is real outer evidence).
_RESCUE_BAND = (0.2, 1.8)       # the cut is searched within [0.2, 1.8] × nominal margin outside the print frame
# Anchored outer tightening (per-side sleeve overhang on otherwise-registered cards): a side is moved
# INWARD only when (a) the current warp edge has ~no line prominence (photometrically absent — we never
# override real evidence), (b) a strong coherent line exists inside the anchored miscut band, away from
# the known print-frame position (the anchors tell us exactly where the frame is, so it can't be latched),
# and (c) the resulting print→cut margin stays plausible. Diagnostic over my_cards: fires on 1/44 sides —
# card_025 R, whose sleeve overhangs the die-cut by ~11px (confirmed in the original photo).
TIGHTEN = os.environ.get("PRINT_REG_TIGHTEN", "").strip().lower() in ("1", "true", "yes", "on")
# Re-warp loop: when registration fails but a real-but-weak fit exists, a HOMOGRAPHY fit against the render
# can diagnose a locally-bad SAM3 quad (one corner off → perspective component the similarity fit can't
# see) and produce corrected corners. print_registration only PROPOSES (registration.rewarp); main.py
# executes ONE re-grade via the Modal contour path and keeps it only if registration then verifies.
REWARP = os.environ.get("PRINT_REG_REWARP", "").strip().lower() in ("1", "true", "yes", "on")
_REWARP_DEV = float(os.environ.get("PRINT_REG_REWARP_DEV", "8"))     # working-px corner deviation to propose
_TIGHTEN_EP_MAX = float(os.environ.get("PRINT_REG_TIGHTEN_EP_MAX", "1.5"))   # edge "absent" below this ratio
_TIGHTEN_PP_MIN = float(os.environ.get("PRINT_REG_TIGHTEN_PP_MIN", "5.0"))   # candidate line must be this coherent
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


_INDEX_BY_ID: dict = {}


def _card_by_id(cid):
    """Resolve a REGISTERED ref_id (the RAG+registration-verified catalog card) to its display fields.
    This is the AUTHORITATIVE identity when registration accepts — the profile should use it instead of a
    separate vision text-read (which hallucinates on hard cards). Prefixed ids (ja:/de:/…) are TCGdex;
    the offline pokemontcg index only has EN, so fall back to whatever _catalog_meta captured (image URL)."""
    if not _INDEX_BY_ID:
        for r in _load_index():
            _INDEX_BY_ID[r["id"]] = r
        _INDEX_BY_ID.setdefault("__loaded__", True)
    r = _INDEX_BY_ID.get(cid)
    lang = None
    if r is None and ":" in cid:
        lang, _, base = cid.partition(":")
        r = _INDEX_BY_ID.get(base)                                  # EN twin of a language variant, for text
    url, _rd = _catalog_meta(cid)
    if r is None:
        return {"id": cid, "image": url or _IMG_URLS.get(cid)} if (url or _IMG_URLS.get(cid)) else {"id": cid}
    return {"id": cid, "name": r["n"].title(), "number": r["num"],
            "number_total": r.get("pt") or r.get("tot"), "set": r["set"], "series": r["ser"],
            "year": (r["rd"] or "")[:4] or None, "language": lang,
            "image": url or r.get("img") or _IMG_URLS.get(cid)}


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

    out = match(lambda r: r["n"] == nl and _num_parts(r["num"])[0] == num) if (nl and num) else []
    if not out and num and " " in nl:
        base = nl.split()[0]
        out = match(lambda r: r["n"].split()[0] == base and _num_parts(r["num"])[0] == num)
    if not out and nl:
        # Name tier includes PREFIX matches from the start: a vision read of "Charizard" (number lost to
        # case glare) must rank "Charizard ex"/"Charizard VMAX" prints too — exact-only returned 30 plain
        # Charizards and starved try-and-verify of the true candidate. Registration verifies every render,
        # so a wider pool costs attempts, never correctness.
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
_CATALOG_META: dict = {}                                            # cid → (img_url, release_date)


def _catalog_meta(cid):
    if not _CATALOG_META:
        for r in _load_index():
            _CATALOG_META[r["id"]] = (r.get("img") or "", r.get("rd") or "")
        try:
            import gzip
            fp = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tcgdex_index.json.gz")
            if os.path.exists(fp):
                with gzip.open(fp, "rt") as f:
                    for r in json.loads(f.read()):
                        _CATALOG_META[r["id"]] = (r.get("img") or "", r.get("rd") or "")
        except Exception:
            pass
    return _CATALOG_META.get(cid) or ("", "")


def first_token_pool(name, k=12, exclude=()):
    """LAST-RESORT candidate tier: every catalog card whose name shares the identity's FIRST TOKEN
    (newest set first). Exists because the vision ID can hallucinate an entirely wrong card for a
    glare-heavy photo (ex_1_front: 'Charizard GX 147/147 Burning Shadows' for a MEW Charizard ex) —
    wrong name suffix AND set AND number, so both the exact pool and the number-stripped retry miss.
    Text only needs to get the right card INTO the list; registration rejects the rest (never observed
    a false accept). Cost bounded by k."""
    first = (str(name or "").split() or [""])[0].lower()
    if len(first) < 4:
        return []
    out = []
    for r in _local_cards(first, None):
        cid = r.get("id")
        if not cid or "-" not in cid or cid in exclude or cid in out:
            continue
        url = ((r.get("images") or {}).get("large")) or ((r.get("images") or {}).get("small"))
        if url:
            _IMG_URLS[cid] = url
        out.append(cid)
        if len(out) >= k:
            break
    return out


def _fetch_render(cid):
    """Official render for a pokemontcg id, disk-cached. Prefers the API's own images URL (the constructed
    {set}/{num}_hires.png 404s on some sets); falls back to the hires pattern. Language-variant ids
    ("{lang}:{cid}", from the TCGdex index) fetch the TCGdex high-quality asset instead.
    (None, reason) on failure."""
    if ":" in cid:
        fp = os.path.join(_CACHE, cid.replace(":", "_").replace(".", "_").replace("-", "_") + ".webp")
        try:
            if not os.path.exists(fp):
                import requests as _rq
                url, _rd = _catalog_meta(cid)
                if not url:
                    return None, "no tcgdex url"
                r = _rq.get(url + "/high.webp", timeout=30, headers={"User-Agent": "card-grader/1.0"})
                if r.status_code != 200 or len(r.content) < 10_000:
                    return None, f"render http {r.status_code}"
                with open(fp, "wb") as f:
                    f.write(r.content)
            ref = cv2.imread(fp)
            return (ref, cid) if ref is not None else (None, "render decode")
        except Exception as e:
            return None, f"render {type(e).__name__}"
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


def _render_frame_insets(refw):
    """Detect the render's OWN visible print-frame depth per axis (fractions), searching [1.5%, 8%] inset
    for the most line-prominent edge. The render is the perfectly-centered print by construction, so the
    frame must be symmetric: when both sides of an axis detect coherently they are AVERAGED (an asymmetric
    datum would inject ratio bias); one strong side is mirrored; no detection falls back to NOMINAL_INSET.
    This replaces the fixed 3.4% datum, which sat visibly outside the true frame on cards whose etched
    frame lives at ~3.8-4% (user-confirmed on card_025) — the mapped orange now hugs the visible border."""
    H, W = refw.shape[:2]
    gx, gy = _grad_mags(refw)
    # PHYSICAL search band per axis: a print frame is ~1.4-3.5mm on a 63x88mm card, i.e. x 2.2-5.5% /
    # y 1.6-4.0%. Searching wider (the first cut used up to 8%) grabbed symmetric ART/text-box lines on
    # BW/XY-era renders (2011-2016) at ~7.4% — symmetric, so the symmetry guard can't catch them; the
    # physical band can. No coherent line inside the band → nominal fallback.
    _BANDS = {"x": (0.022, 0.055), "y": (0.016, 0.040)}
    def best(mag, size, horiz, from_end, band):
        lo, hi = (0, W) if horiz else (0, H)
        proms = {}
        for q in range(max(int(size * band[0]), 3), int(size * band[1])):
            pos = size - 1 - q if from_end else q
            proms[q] = _line_prominence(mag, pos, lo, hi, horiz, H, W, R=6)
        if not proms:
            return None, 0.0
        top_q = max(proms, key=proms.get)
        top_r = proms[top_q]
        # The frame is a BAND with two edges (border-side and art-side) a few px apart; the strongest
        # gradient is usually the OUTER edge, but the true inner border — what a human measures to — is
        # the INNERMOST coherent line of the band (user-confirmed on card_025). Walk inward up to 1.2%
        # and take the deepest line still ≥60% of the peak's prominence.
        for q in sorted(proms, reverse=True):
            if top_q < q <= top_q + int(0.012 * size) and proms[q] >= max(0.6 * top_r, 2.5):
                top_q, top_r = q, proms[q]
                break
        return top_q / size, top_r
    out = {}
    for axis, mag, size, horiz in (("x", gx, W, False), ("y", gy, H, True)):
        band = _BANDS[axis]
        (i1, r1), (i2, r2) = best(mag, size, horiz, False, band), best(mag, size, horiz, True, band)
        ok1, ok2 = (i1 is not None and r1 >= 2.5), (i2 is not None and r2 >= 2.5)
        if ok1 and ok2 and abs(i1 - i2) <= 0.008:
            out[axis] = (i1 + i2) / 2
        elif ok1 and ok2:
            out[axis] = i1 if r1 >= r2 else i2
        elif ok1 or ok2:
            out[axis] = i1 if ok1 else i2
        else:
            out[axis] = NOMINAL_INSET
    return out["x"], out["y"]


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
    # Render's DETECTED print frame (per-axis depth, symmetric) → OUR card coords, normalized 0..1.
    RW, RH = ref.shape[1], ref.shape[0]
    ix, iy = _render_frame_insets(ref_bgr)                          # NATIVE res: the frame is a 2-3px band;
                                                                    # working-scale blur biases the peak outward
    meta["frame_insets"] = {"x": round(ix, 4), "y": round(iy, 4)}
    frame = np.float32([[RW * ix, RH * iy], [RW * (1 - ix), RH * iy],
                        [RW * (1 - ix), RH * (1 - iy)], [RW * ix, RH * (1 - iy)]])
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
def _sift_matches(card_bgr, ref_bgr):
    """Shared working-scale SIFT matching → (card_work, ref_work, src_pts, dst_pts) or None."""
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
    return card, ref, src, dst


def _fit_loose(card_bgr, ref_bgr):
    """Gate-free registration fit → (card_work, ref_work, M) or None. Used only to locate the print frame
    when the gated register() refused on scale — the rescue's final acceptance re-runs the FULL gates."""
    sm = _sift_matches(card_bgr, ref_bgr)
    if sm is None:
        return None
    card, ref, src, dst = sm
    cv2.setRNGSeed(1234567)
    M, inl = cv2.estimateAffinePartial2D(src, dst, method=cv2.RANSAC, ransacReprojThreshold=3.0, maxIters=10000)
    if M is None or inl is None or int(inl.sum()) < 20:
        return None
    return card, ref, M


def _diagnose_rewarp(card_bgr, ref_bgr):
    """BAD-WARP diagnosis: warp↔render should be a SIMILARITY when the warp's quad was right — a similarity
    fit is blind to a single bad quad corner (global scale stays ~1; ex_1_front read sc 0.9999 while its
    bottom-left quad corner was 35px off). A full HOMOGRAPHY exposes it: any perspective component means
    the quad was wrong, and the render's corners mapped through the inverse homography ARE the true die-cut
    corners in warp coords — i.e. the correction. Returns (corners_frac 4x[x,y], dev_px, h_inliers) or None
    (warp fine / can't judge / implausible)."""
    sm = _sift_matches(card_bgr, ref_bgr)
    if sm is None:
        return None
    card_w, ref_w, src, dst = sm
    cv2.setRNGSeed(1234567)
    Hm, inl = cv2.findHomography(src, dst, cv2.RANSAC, 3.0, maxIters=10000)
    if Hm is None or inl is None or int(inl.sum()) < 30:
        return None
    CW, CH = card_w.shape[1], card_w.shape[0]
    RW, RH = ref_w.shape[1], ref_w.shape[0]
    rc = np.float32([[0, 0], [RW, 0], [RW, RH], [0, RH]])
    pts = np.hstack([rc, np.ones((4, 1), np.float32)]) @ np.linalg.inv(Hm).T
    if np.any(np.abs(pts[:, 2]) < 1e-6):
        return None
    tc = pts[:, :2] / pts[:, 2:3]
    wc = np.float32([[0, 0], [CW, 0], [CW, CH], [0, CH]])
    dev = float(np.abs(tc - wc).max())
    if dev < _REWARP_DEV or dev > 0.25 * min(CW, CH):
        return None                                                  # fine, or implausibly broken
    if not cv2.isContourConvex(tc.astype(np.float32)):
        return None
    return ([[round(float(x) / CW, 4), round(float(y) / CH, 4)] for x, y in tc],
            round(dev, 1), int(inl.sum()))


def _tilt_from_ctx(filter_ctx):
    """Mapped-die-line tilt signature from an accepted similarity fit's ctx. Returns
    (tilt_px, max_out_px, corners_frac) at working scale. tilt = max spread between the two ends
    of each side pair — a ROTATED card inside a sleeve/case-aligned warp (card_025: 0.6° → 11px)
    that no axis-aligned crop can contain without cutting corners. Clean straight warps: ≤4px."""
    card_w, ref_w, M = filter_ctx
    CW, CH = card_w.shape[1], card_w.shape[0]
    Minv = cv2.invertAffineTransform(M)
    RW, RH = ref_w.shape[1], ref_w.shape[0]
    c = np.float32([[0, 0], [RW, 0], [RW, RH], [0, RH]]) @ Minv[:, :2].T + Minv[:, 2]
    xs, ys = c[:, 0], c[:, 1]
    tilt = max(abs(xs[0] - xs[3]), abs(xs[1] - xs[2]), abs(ys[0] - ys[1]), abs(ys[2] - ys[3]))
    out = max(max(0 - x, x - CW, 0 - y, y - CH, 0) for x, y in c)
    frac = [[round(float(x) / CW, 4), round(float(y) / CH, 4)] for x, y in c]
    return float(tilt), float(out), frac


def tilt_in_display(result, cid):
    """Re-measure the tilt signature on a grade RESULT's display warp (cropped to _card_boundary when
    set — contour-path re-warps carry a padding ring that would scale-reject the full frame). Used by
    the re-warp executor to verify a tilt-origin re-warp actually STRAIGHTENED the card. None = can't
    judge (registration failed on the crop)."""
    try:
        import base64
        wj = result.get("_warped_jpeg_b64")
        if not wj:
            return None
        ref, _err = _fetch_render(cid)
        if ref is None:
            return None
        card = cv2.imdecode(np.frombuffer(base64.b64decode(wj), np.uint8), cv2.IMREAD_COLOR)
        if card is None:
            return None
        cb = result.get("_card_boundary")
        if cb and (cb[0] > 0.005 or cb[1] > 0.005 or cb[2] < 0.995 or cb[3] < 0.995):
            H, W = card.shape[:2]
            card = card[int(cb[1] * H):int(cb[3] * H), int(cb[0] * W):int(cb[2] * W)]
        m = register(card, ref)
        if not m.get("accepted"):
            return None
        tilt, _out, _frac = _tilt_from_ctx(m.pop("_filter_ctx"))
        return round(tilt, 1)
    except Exception:
        return None


def diagnose_result(result, cid):
    """Residual-bend diagnosis on a grade RESULT (possibly already re-warped): decode its display warp,
    crop to _card_boundary when meaningful (contour-path warps carry a padding ring; rescued results mark
    the true cut — diagnosing the full padded frame would read the ring as bend forever), and run the
    homography diagnosis against the registered render. Returns (corners_frac in FULL-warp coords, dev_px,
    h_inliers) or None (converged / can't judge). This is what lets the re-warp LOOP iterate: the one-shot
    proposal only exists on failed registrations, but a verified re-warp can still carry residual bend."""
    try:
        import base64
        wj = result.get("_warped_jpeg_b64")
        if not wj:
            return None
        ref, _err = _fetch_render(cid)
        if ref is None:
            return None
        card = cv2.imdecode(np.frombuffer(base64.b64decode(wj), np.uint8), cv2.IMREAD_COLOR)
        if card is None:
            return None
        H0, W0 = card.shape[:2]
        cb = result.get("_card_boundary") or [0, 0, 1, 1]
        x1, y1 = int(round(cb[0] * W0)), int(round(cb[1] * H0))
        x2, y2 = int(round(cb[2] * W0)), int(round(cb[3] * H0))
        if x2 - x1 > 100 and y2 - y1 > 100 and (x1 > 2 or y1 > 2 or x2 < W0 - 2 or y2 < H0 - 2):
            d = _diagnose_rewarp(card[y1:y2, x1:x2], ref)
            if d is None:
                return None
            corners, dev, ninl = d
            corners = [[round((x1 + fx * (x2 - x1)) / W0, 4), round((y1 + fy * (y2 - y1)) / H0, 4)]
                       for fx, fy in corners]
            return corners, dev, ninl
        return _diagnose_rewarp(card, ref)
    except Exception:
        return None


# ── ECC layout anchor (haze/glare tier: SIFT descriptors die, dense gradients survive) ─────────────
def _ecc_prep(img, h=360):
    im = cv2.resize(img, (int(img.shape[1] * h / img.shape[0]), h))
    g = cv2.createCLAHE(clipLimit=3.0, tileGridSize=(8, 8)).apply(cv2.cvtColor(im, cv2.COLOR_BGR2GRAY))
    gx = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    gy = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    m = cv2.magnitude(gx, gy)
    return (m / (m.max() + 1e-6)).astype(np.float32), im.shape[1], im.shape[0]


def _ecc_align(card_bgr, ref_bgr, iters=150):
    """Dense affine alignment render→card on gradient-magnitude images. Returns
    (cc, corners_frac[4x2 in card coords], rel_scale) or None. Haze corrupts SIFT DESCRIPTORS
    (card_017: 5,348 keypoints but 60-100 matches yield only 7-13 true inliers) while the card's
    LAYOUT gradients (frame, text boxes, borders) survive — ECC correlates the whole field."""
    try:
        cg, Cw, Ch = _ecc_prep(card_bgr)
        rg, Rw, Rh = _ecc_prep(ref_bgr)
        warp0 = np.array([[Cw / Rw, 0, 0], [0, Ch / Rh, 0]], np.float32)
        cc, W = cv2.findTransformECC(rg, cg, warp0.copy(), cv2.MOTION_AFFINE,
                                     (cv2.TERM_CRITERIA_EPS | cv2.TERM_CRITERIA_COUNT, iters, 1e-5),
                                     None, 5)
        mc = np.float32([[0, 0], [Rw, 0], [Rw, Rh], [0, Rh]]) @ W[:, :2].T + W[:, 2]
        rel = float(np.sqrt(abs(W[0, 0] * W[1, 1] - W[0, 1] * W[1, 0]))) / (Cw / Rw)
        corners = [[round(float(x) / Cw, 4), round(float(y) / Ch, 4)] for x, y in mc]
        return float(cc), corners, rel
    except cv2.error:
        return None


def ecc_verify(result, ref_id, cc_before):
    """Verify an ECC-origin re-warp by IMPROVEMENT: on the corrected warp the correlation must rise and
    the alignment scale must sit at unit (the crop matches the render span). Geometry-only acceptance —
    reads stay with the selector on the cleaned warp; confidence is capped by the caller."""
    try:
        import base64
        ref, _err = _fetch_render(ref_id)
        wj = result.get("_warped_jpeg_b64")
        if ref is None or not wj:
            return None
        card = cv2.imdecode(np.frombuffer(base64.b64decode(wj), np.uint8), cv2.IMREAD_COLOR)
        if card is None:
            return None
        cb = result.get("_card_boundary") or [0, 0, 1, 1]
        H0, W0 = card.shape[:2]
        x1, y1 = int(round(cb[0] * W0)), int(round(cb[1] * H0))
        x2, y2 = int(round(cb[2] * W0)), int(round(cb[3] * H0))
        if x2 - x1 > 200 and y2 - y1 > 200:
            card = card[y1:y2, x1:x2]
        r = _ecc_align(card, ref)
        if r is None:
            return None
        cc2, _corners, rel = r
        ok = cc2 >= max(cc_before + 0.02, 0.32) and 0.97 <= rel <= 1.03
        return {"ok": bool(ok), "cc": round(cc2, 4), "rel_scale": round(rel, 4)}
    except Exception:
        return None


def quad_boundary_in_warp(result, src_corners):
    """Where the caller's SOURCE-coords quad sits inside the (padded) contour-path display warp, as a
    normalized bbox — the _card_boundary for a re-warped grade, so registration can use the crop directly."""
    try:
        import base64
        quad = result.get("_quad_padded")
        wj = result.get("_warped_jpeg_b64")
        if not quad or len(quad) != 4 or not wj:
            return None
        img = cv2.imdecode(np.frombuffer(base64.b64decode(wj), np.uint8), cv2.IMREAD_COLOR)
        if img is None:
            return None
        Hh, Ww = img.shape[:2]
        Hq = cv2.getPerspectiveTransform(np.float32(quad), np.float32([[0, 0], [Ww, 0], [Ww, Hh], [0, Hh]]))
        pts = np.float32([[x, y, 1.0] for x, y in src_corners]) @ Hq.T
        if np.any(np.abs(pts[:, 2]) < 1e-6):
            return None
        pp = pts[:, :2] / pts[:, 2:3]
        x1, y1 = float(pp[:, 0].min()), float(pp[:, 1].min())
        x2, y2 = float(pp[:, 0].max()), float(pp[:, 1].max())
        if x2 - x1 < 0.3 * Ww or y2 - y1 < 0.3 * Hh:
            return None
        return [round(max(x1, 0) / Ww, 4), round(max(y1, 0) / Hh, 4),
                round(min(x2, Ww - 1) / Ww, 4), round(min(y2, Hh - 1) / Hh, 4)]
    except Exception:
        return None


def map_warp_frac_to_source(result, corners_frac):
    """Corrected corners (warp-fraction coords) → SOURCE-photo pixels, through the inverse of the
    quad→rect perspective used to build the warp. Sanity: area within [0.7, 1.4]× the original quad,
    convex, corners clipped to ±5% of the source bounds. Returns [[x,y],...] or None."""
    import base64
    quad = result.get("_quad_padded")
    wj = result.get("_warped_jpeg_b64")
    if not quad or len(quad) != 4 or not wj:
        return None
    img = cv2.imdecode(np.frombuffer(base64.b64decode(wj), np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        return None
    Hh, Ww = img.shape[:2]
    Hq = cv2.getPerspectiveTransform(np.float32(quad), np.float32([[0, 0], [Ww, 0], [Ww, Hh], [0, Hh]]))
    pts = np.float32([[fx * Ww, fy * Hh, 1.0] for fx, fy in corners_frac]) @ np.linalg.inv(Hq).T
    if np.any(np.abs(pts[:, 2]) < 1e-6):
        return None
    src = pts[:, :2] / pts[:, 2:3]
    a1 = cv2.contourArea(np.float32(quad))
    a2 = cv2.contourArea(src.astype(np.float32))
    if not (0.7 * a1 <= a2 <= 1.4 * a1) or not cv2.isContourConvex(src.astype(np.float32)):
        return None
    od = result.get("_orig_dims") or []
    out = []
    for x, y in src:
        if len(od) >= 2 and od[0] and od[1]:
            x = min(max(float(x), -0.05 * od[0]), 1.05 * od[0])
            y = min(max(float(y), -0.05 * od[1]), 1.05 * od[1])
        out.append([round(float(x), 1), round(float(y), 1)])
    return out


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


def _line_prominence(mag, fixed, lo, hi, horiz, H, W, R=10):
    """LINE PROMINENCE ratio: perpendicular gradient integrated along the full line at `fixed`, divided by
    the same statistic at parallel offset lines (|d| ≥ 4px). A real cut is a coherent line — sharp peak
    within ±2px. Texture (sparkle case, sleeve plastic) has strong gradients EVERYWHERE, so the profile is
    flat and the ratio ≈ 1. (A per-point 'any peak near the line' test saturates on texture — same failure
    mode as the band-search surround tests; line-integration is what distinguishes cut from case.)"""
    pts = np.linspace(lo + 0.08 * (hi - lo), hi - 0.08 * (hi - lo), 60).astype(int)
    prof = {}
    for d in range(-R, R + 1):
        p = fixed + d
        if horiz:
            if not (0 <= p < H):
                continue
            prof[d] = float(mag[p, pts].mean())
        else:
            if not (0 <= p < W):
                continue
            prof[d] = float(mag[pts, p].mean())
    near = [v for d, v in prof.items() if abs(d) <= 2]
    bg = [v for d, v in prof.items() if abs(d) >= 4]
    if not near or len(bg) < 4:
        return 0.0
    return max(near) / (float(np.median(bg)) + 1e-6)


def _grad_mags(card_bgr):
    gray = cv2.cvtColor(card_bgr, cv2.COLOR_BGR2GRAY).astype(np.float32)
    return (np.abs(cv2.Sobel(gray, cv2.CV_32F, 1, 0, ksize=3)),
            np.abs(cv2.Sobel(gray, cv2.CV_32F, 0, 1, ksize=3)))


def _cut_edge_support(card_bgr, box_px):
    """Per-side photometric confirmability of a claimed die-cut box, mapped to [0,1]:
    prominence ratio 1.0 → 0, ≥1.8 → 1.0. Low = the line is extrapolated, not visible."""
    x1, y1, x2, y2 = [int(round(v)) for v in box_px]
    gx, gy = _grad_mags(card_bgr)
    H, W = card_bgr.shape[:2]
    def score(mag, fixed, lo, hi, horiz):
        ratio = _line_prominence(mag, fixed, lo, hi, horiz, H, W)
        return round(max(0.0, min(1.0, (ratio - 1.0) / 0.8)), 3)
    return {"T": score(gy, y1, x1, x2, True), "B": score(gy, y2, x1, x2, True),
            "L": score(gx, x1, y1, y2, False), "R": score(gx, x2, y1, y2, False)}


def _tighten_outer(card, refw, M, insets=None):
    """Anchored per-side outer tightening (sleeve overhang over a dark border). Operates on the accepted
    registration's working-scale ctx. A side moves INWARD only when ALL hold: the current warp edge has no
    coherent line (prominence < _TIGHTEN_EP_MAX — we never override real photometric evidence), a strong
    line (≥ _TIGHTEN_PP_MIN) exists inside the anchored miscut band but OUTSIDE the known print-frame
    position (frame can't be latched — the anchors locate it exactly), and the resulting print→cut margin
    stays in [0.35, 1.8]×the frame margin. Frame + margins use the DETECTED per-axis render insets —
    the same datum the read is computed against; validating against NOMINAL while reading against
    DETECTED let a full-art card (detected y-inset 1.7% vs nominal ~3.6%) accept a line 3px from the
    real frame → 86/14 (sc204 Seismitoad). `insets` = (ix, iy) from register()'s frame_insets, detected
    at NATIVE render res (working-scale detection fails — the frame is a 2-3px band); when absent, fall
    back to NOMINAL. Returns (cut{L,T,R,B} px, moved{side: px}, frame{L,T,R,B} px) or None."""
    H, W = card.shape[:2]
    RW, RH = refw.shape[1], refw.shape[0]
    Minv = cv2.invertAffineTransform(M)
    corners = np.float32([[0, 0], [RW, 0], [RW, RH], [0, RH]]) @ Minv[:, :2].T + Minv[:, 2]
    anch = {"L": float(corners[:, 0].min()), "T": float(corners[:, 1].min()),
            "R": float(corners[:, 0].max()), "B": float(corners[:, 1].max())}
    ix = iy = NOMINAL_INSET
    if insets and insets[0] and insets[1]:
        ix, iy = float(insets[0]), float(insets[1])
    fpx = np.float32([[RW * ix, RH * iy], [RW * (1 - ix), RH * iy],
                      [RW * (1 - ix), RH * (1 - iy)], [RW * ix, RH * (1 - iy)]]) @ Minv[:, :2].T + Minv[:, 2]
    fr = {"L": float(fpx[:, 0].min()), "T": float(fpx[:, 1].min()),
          "R": float(fpx[:, 0].max()), "B": float(fpx[:, 1].max())}
    m_nom_x = ix / (1 - 2 * ix) * (anch["R"] - anch["L"])            # per-axis frame→cut margin (px)
    m_nom_y = iy / (1 - 2 * iy) * (anch["B"] - anch["T"])
    gx, gy = _grad_mags(card)
    cut = {"L": 0.0, "T": 0.0, "R": float(W - 1), "B": float(H - 1)}
    moved = {}
    for side in ("L", "T", "R", "B"):
        horiz = side in ("T", "B")
        mag = gy if horiz else gx
        lo, hi = (0, W) if horiz else (0, H)
        lim = H if horiz else W
        m_nom = m_nom_y if horiz else m_nom_x
        edge = int(round(cut[side]))
        if _line_prominence(mag, edge, lo, hi, horiz, H, W) >= _TIGHTEN_EP_MAX:
            continue                                                 # the warp edge IS a line — trust it
        b0 = int(round(anch[side] - 1.5 * m_nom))
        b1 = int(round(anch[side] + 1.5 * m_nom))
        if side in ("L", "T"):
            b0 = max(b0, edge + 1)                                   # inward moves only
            b1 = min(b1, int(fr[side]) - 7, lim - 4)                 # never reach the print frame
        else:
            b1 = min(b1, edge - 1)
            b0 = max(b0, int(fr[side]) + 7, 3)
        best_p, best_s = None, -1.0
        for p in range(b0, b1 + 1):
            if not (3 <= p < lim - 3):
                continue
            s = _line_prominence(mag, p, lo, hi, horiz, H, W)
            if s > best_s:
                best_s, best_p = s, p
        if best_p is None or best_s < _TIGHTEN_PP_MIN:
            continue
        marg = abs(best_p - fr[side])
        if not (0.35 * m_nom <= marg <= 1.8 * m_nom):
            continue
        cut[side] = float(best_p)
        moved[side] = round(abs(best_p - edge), 1)
    if not moved:
        return None
    return cut, moved, fr


def _gray_zone_recover(card_bgr, ref_bgr):
    """Gray-zone recovery (scale excess 1-3%): the fit is real but the warp is slightly larger than the
    card — some sides carry background slop. Instead of giving up (selector read + conf 0.4), run the SAME
    anchored tightener evidence rules on the gate-free fit: move a side inward only where the warp edge is
    photometrically absent AND a strong coherent line sits in the anchored band. Then crop to the tightened
    box and RE-REGISTER WITH FULL GATES — if the slop was truly removed, scale snaps to unit and the read
    is a verified registered read; anything else honestly fails and the demotion path stands. Strictly
    additive: only cards that today end at 'scale-reject unrescued' can reach this."""
    lf = _fit_loose(card_bgr, ref_bgr)
    if lf is None:
        return None, None
    card_w, ref_w, M = lf
    # Anchor diagnosis (also the abstain explanation): where does the fit say the cut sits relative to the
    # warp edges? +px inside = slop the tightener may remove; -px outside = the warp CUT OFF part of the
    # card — unfixable from the warp alone (the pixels don't exist; the honest outcome is the demotion).
    Hw0, Ww0 = card_w.shape[:2]
    RW0, RH0 = ref_w.shape[1], ref_w.shape[0]
    Minv0 = cv2.invertAffineTransform(M)
    mc0 = np.float32([[0, 0], [RW0, 0], [RW0, RH0], [0, RH0]]) @ Minv0[:, :2].T + Minv0[:, 2]
    over = {"L": float(mc0[:, 0].min()), "T": float(mc0[:, 1].min()),
            "R": Ww0 - 1 - float(mc0[:, 0].max()), "B": Hw0 - 1 - float(mc0[:, 1].max())}
    parts = [f"{s} {'cut-off' if v < -3 else 'slop'} ~{abs(round(v))}px" for s, v in over.items() if abs(v) > 3]
    diag = ("anchors: " + ", ".join(parts)) if parts else None
    try:
        nat_ins = _render_frame_insets(ref_bgr)                      # native-res detection (working-scale fails)
    except Exception:
        nat_ins = None
    t = _tighten_outer(card_w, ref_w, M, insets=nat_ins)
    if t is None:
        return None, diag                                            # no side had absent-edge + strong-line
    cut, moved, _fr = t
    x1, y1 = int(round(cut["L"])), int(round(cut["T"]))
    x2, y2 = int(round(cut["R"])), int(round(cut["B"]))
    Hw, Ww = card_w.shape[:2]
    if x2 - x1 < 200 or y2 - y1 < 200:
        return None, diag
    crop = card_w[y1:y2 + 1, x1:x2 + 1]
    meta2 = register(crop, ref_bgr)                                  # FULL gates — the scale IS the verify
    if not meta2.get("accepted"):
        return None, diag
    # Reads (lr/tb) are crop-relative = die-cut-relative. Map content_region back to ORIGINAL warp coords
    # for display; the crop-frame filter ctx can't be used on warp-frame boxes downstream.
    cw, ch = x2 - x1 + 1, y2 - y1 + 1
    cr = meta2["content_region"]
    meta2["content_region"] = {"x1": round((x1 + cr["x1"] * cw) / Ww, 4),
                               "y1": round((y1 + cr["y1"] * ch) / Hw, 4),
                               "x2": round((x1 + cr["x2"] * cw) / Ww, 4),
                               "y2": round((y1 + cr["y2"] * ch) / Hw, 4)}
    meta2.pop("_filter_ctx", None)
    meta2["cut_box"] = [round(x1 / Ww, 4), round(y1 / Hw, 4), round((x2 + 1) / Ww, 4), round((y2 + 1) / Hw, 4)]
    meta2["gray_zone_tightened"] = moved                             # px moved inward per side (working scale)
    return meta2, None


def _frame_snap_on_card(card_w, cr, cut, band_frac=0.04, guard_frac=0.012, absent_only=False,
                        allowed_sides=("L", "T", "R", "B")):
    """Confirm/correct the mapped print-frame box against the CARD's own pixels: per side, snap to the
    NEAREST coherent full-span line within ±band_frac (proximity prior). The render-side frame walk can
    lock onto the wrong line on busy full-art renders (sc204: walked y-inset 0.017 at the physical-band
    edge vs true silver frame ~0.03) — the card's photometric frame is the authority when they disagree.
    guard_frac: a candidate must sit at least this far INSIDE the cut box on its side — the print frame
    is physically never at the die edge (nominal insets ≥1.6%), which stops the snap from latching onto
    the card's own outer edge.
    absent_only (direct-accept mode): a side may move ONLY when the mapped position itself has NO card-
    side line (±2px all below threshold) — a photometrically CONFIRMED mapping always wins over nearby
    stronger lines (card_030: the copyright baseline outshines the true frame 11px away; without this
    gate the snap hijacked a verified-good read). Returns (new_cr, fsnap) or None if no side moved."""
    Hw, Ww = card_w.shape[:2]
    cx1, cy1, cx2, cy2 = cut
    gxf, gyf = _grad_mags(card_w)
    fpx = {"L": cr["x1"] * Ww, "T": cr["y1"] * Hw, "R": cr["x2"] * Ww, "B": cr["y2"] * Hw}
    fthr = float(os.environ.get("PRINT_REG_FRAME_SNAP_PROM", "2.5"))
    gx = guard_frac * (cx2 - cx1)
    gy = guard_frac * (cy2 - cy1)
    inner = {"L": (cx1 + gx, (cx1 + cx2) / 2), "R": ((cx1 + cx2) / 2, cx2 - gx),
             "T": (cy1 + gy, (cy1 + cy2) / 2), "B": ((cy1 + cy2) / 2, cy2 - gy)}
    fsnap = {}
    for side in ("L", "T", "R", "B"):
        if side not in allowed_sides:
            continue
        horiz = side in ("T", "B")
        mag = gyf if horiz else gxf
        lo2, hi2 = (0, Ww) if horiz else (0, Hw)
        lim = Hw if horiz else Ww
        band = int(band_frac * (Hw if horiz else Ww))
        base = fpx[side]
        if absent_only:
            present = False
            for d0 in (-2, -1, 0, 1, 2):
                pp0 = int(round(base + d0))
                if 2 <= pp0 < lim - 2 and _line_prominence(mag, pp0, lo2, hi2, horiz, Hw, Ww) >= fthr:
                    present = True
                    break
            if present:
                continue                                             # mapping confirmed on the card → keep
        best, bestd = None, None
        for d in range(-band, band + 1):
            pp = int(round(base + d))
            if not (2 <= pp < lim - 2):
                continue
            if not (inner[side][0] <= pp <= inner[side][1]):
                continue
            r_ = _line_prominence(mag, pp, lo2, hi2, horiz, Hw, Ww)
            if r_ >= fthr and (bestd is None or abs(d) < bestd):
                best, bestd = pp, abs(d)
        if best is not None and bestd > 2:
            fsnap[side] = int(round(best - base))
            fpx[side] = float(best)
    if not fsnap:
        return None
    # SYMMETRIC COMPLETION: the mapped frame's per-axis error is COUPLED — both sides inherit the same
    # wrong walk inset, while the frame CENTER comes from the fit and survives (symmetric error cancels).
    # When one side of an axis snapped and its partner didn't, the partner's true line is predicted by
    # reflecting about the original mapped center; a coherent line there may be too soft for the full
    # threshold (sc204's bottom frame: art fades into silver, prom 1.8 vs bar 2.5) yet the ±4px prior
    # makes the weak likelihood decisive. Verify-or-keep: no line ≥1.5 near the prediction → no move.
    orig = {"L": cr["x1"] * Ww, "T": cr["y1"] * Hw, "R": cr["x2"] * Ww, "B": cr["y2"] * Hw}
    for a, b in (("T", "B"), ("B", "T"), ("L", "R"), ("R", "L")):
        if a not in fsnap or b in fsnap or b not in allowed_sides:
            continue
        horiz = b in ("T", "B")
        mag = gyf if horiz else gxf
        lo2, hi2 = (0, Ww) if horiz else (0, Hw)
        lim = Hw if horiz else Ww
        pred = (orig[a] + orig[b]) - fpx[a]
        best, bestr = None, 0.0
        for d in range(-4, 5):
            pp = int(round(pred + d))
            if not (2 <= pp < lim - 2) or not (inner[b][0] <= pp <= inner[b][1]):
                continue
            r_ = _line_prominence(mag, pp, lo2, hi2, horiz, Hw, Ww)
            if r_ >= 1.5 and r_ > bestr:
                best, bestr = pp, r_
        if best is not None and abs(best - orig[b]) > 2:
            fsnap[b] = int(round(best - orig[b]))
            fpx[b] = float(best)
    new_cr = {"x1": round(fpx["L"] / Ww, 4), "y1": round(fpx["T"] / Hw, 4),
              "x2": round(fpx["R"] / Ww, 4), "y2": round(fpx["B"] / Hw, 4)}
    return new_cr, fsnap


def _rescue_outer(card_bgr, ref_bgr, gates=(30, None, 0.012)):
    """Full rescue: the RENDER spans exactly die-cut to die-cut, so its own image corners mapped through
    the fitted transform ARE the die-cut estimate — directly, at the registration's ~px precision. (Earlier
    photometric band-searches failed one by one on a dark-sparkle-border card in a dark-sparkle case: the
    border and the case are photometrically identical, so edge peaks, size ties, and surround tests all
    saturate. The mapping needs none of that.) Then crop → re-register to verify. Returns None (abstain)
    or the verified read + the cut box as fractions of the ORIGINAL warp."""
    lf = _fit_loose(card_bgr, ref_bgr)
    if lf is None:
        return None
    card_w, ref_w, M = lf
    RW, RH = ref_w.shape[1], ref_w.shape[0]
    Minv = cv2.invertAffineTransform(M)
    corners = np.float32([[0, 0], [RW, 0], [RW, RH], [0, RH]])       # the render's die line
    mc = corners @ Minv[:, :2].T + Minv[:, 2]
    H, W = card_w.shape[:2]
    bx1 = int(round(max(float(mc[:, 0].min()), 0)))                  # display box (axis-aligned bbox of the
    by1 = int(round(max(float(mc[:, 1].min()), 0)))                  # mapped die line; the fit may carry a
    bx2 = int(round(min(float(mc[:, 0].max()), W - 1)))              # small rotation)
    by2 = int(round(min(float(mc[:, 1].max()), H - 1)))
    if bx2 - bx1 < 200 or by2 - by1 < 200:
        return None
    # Verify-or-abstain: the artwork match was already established pre-crop (that's what fired the rescue);
    # this re-registration verifies the CROP — the scale must snap to unit. Textured/cased cards give sparse
    # The crop is a RESAMPLE through the fitted transform onto the render's own grid — die-cut-aligned and
    # rotation-corrected by construction (a plain bbox crop of a slightly-rotated fit overshoots each side
    # and honestly fails the scale verify). The re-registration then verifies the fit itself: if M really
    # mapped the die line, this registers at scale ≈ 1.000 with near-zero offset; if M was off, it can't.
    crop = cv2.warpAffine(card_w, M, (RW, RH))
    meta2 = register(crop, ref_bgr, gates=(gates[0], gates[1] if gates[1] is not None else MAX_RESID, gates[2]))
    if not meta2.get("accepted"):
        return None
    # Margin sanity from the RE-REGISTERED frame: each print→cut margin must be plausible vs nominal.
    # [0.35, 1.8]×nominal tolerates real miscuts to ~82/18 but rejects interior-structure lock-ons.
    cr0 = meta2["content_region"]
    nom = NOMINAL_INSET / (1 - 2 * NOMINAL_INSET) * (cr0["x2"] - cr0["x1"])
    for m in (cr0["x1"], 1 - cr0["x2"], cr0["y1"], 1 - cr0["y2"]):
        if not (0.35 * nom <= m <= 1.8 * nom):
            return None
    # Reads (lr/tb, content_region) from meta2 are in DIE-CUT coordinates — exactly what centering wants.
    # For the DISPLAY, map the frame back into original-warp coordinates through Minv.
    Hw, Ww = card_w.shape[:2]
    cr_px = np.float32([[cr0["x1"] * RW, cr0["y1"] * RH], [cr0["x2"] * RW, cr0["y1"] * RH],
                        [cr0["x2"] * RW, cr0["y2"] * RH], [cr0["x1"] * RW, cr0["y2"] * RH]])
    mapped_cr = cr_px @ Minv[:, :2].T + Minv[:, 2]
    meta2["content_region"] = {"x1": round(float(mapped_cr[:, 0].min()) / Ww, 4),
                               "y1": round(float(mapped_cr[:, 1].min()) / Hw, 4),
                               "x2": round(float(mapped_cr[:, 0].max()) / Ww, 4),
                               "y2": round(float(mapped_cr[:, 1].max()) / Hw, 4)}
    # FRAME snap: the placeholder render misplaces the FRAME line too — its gray-band inner edge sits at a
    # different content-relative depth than the physical etch boundary (card_035: mapped frame ~13px deep).
    # The physical frame is a strong full-span line on the card, so snap each mapped frame edge to the
    # NEAREST coherent line within the band (proximity prior — title/art edges can be stronger but are
    # farther); no qualifying line → keep the mapped position.
    try:
        fs = _frame_snap_on_card(card_w, meta2["content_region"], cut=(0, 0, Ww, Hw))
        if fs is not None:
            meta2["content_region"], meta2["frame_snap"] = fs
    except Exception:
        pass
    # Photometric snap: pokemontcg renders depict SIR/etched borders as a flat gray PLACEHOLDER whose
    # width differs from the physical etch, so the extrapolated corners inherit a per-side error in EITHER
    # direction (card_035: top 30px inside, bottom ~right). Per side, search a band around the
    # extrapolation in BOTH directions (frame line masked out) and snap to the STRONGEST coherent line;
    # sides with no qualifying line keep the extrapolation, and their low cut_edge_support keeps
    # confidence honest. NO cross-side mirroring — the errors are independent (user-falsified).
    try:
        gx2, gy2 = _grad_mags(card_w)
        cr2 = meta2["content_region"]
        m_nx = NOMINAL_INSET / (1 - 2 * NOMINAL_INSET) * (cr2["x2"] - cr2["x1"]) * Ww
        m_ny = NOMINAL_INSET / (1 - 2 * NOMINAL_INSET) * (cr2["y2"] - cr2["y1"]) * Hw
        box = {"L": bx1, "T": by1, "R": bx2, "B": by2}
        fr_px = {"L": cr2["x1"] * Ww, "T": cr2["y1"] * Hw, "R": cr2["x2"] * Ww, "B": cr2["y2"] * Hw}
        snapped = {}
        thr = float(os.environ.get("PRINT_REG_SNAP_PROM", "2.5"))
        for side in ("L", "T", "R", "B"):
            horiz = side in ("T", "B")
            mag = gy2 if horiz else gx2
            lo2, hi2 = (0, Ww) if horiz else (0, Hw)
            lim = Hw if horiz else Ww
            band = int(0.035 * (Hw if horiz else Ww))
            m_nom_s = m_ny if horiz else m_nx
            quals = []
            for d in range(-band, band + 1):
                pp = int(round(box[side] + d))
                if not (2 <= pp < lim - 2):
                    continue
                if abs(pp - fr_px[side]) <= 7:                       # never latch the print frame
                    continue
                marg = abs(pp - fr_px[side])                         # frame→cut must stay plausible
                if not (0.35 * m_nom_s <= marg <= 1.9 * m_nom_s):
                    continue
                r_ = _line_prominence(mag, pp, lo2, hi2, horiz, Hw, Ww)
                if r_ >= thr:
                    quals.append((pp, r_))
            if not quals:
                continue
            # strongest coherent line = the contiguous run containing the global peak, at its peak
            quals.sort()
            peak_p, peak_r = max(quals, key=lambda t: t[1])
            if abs(peak_p - box[side]) <= 2:
                continue                                             # already there
            snapped[side] = int(peak_p - box[side])
            box[side] = float(peak_p)
        if snapped:
            meta2["cut_snap"] = snapped
            bx1, by1, bx2, by2 = box["L"], box["T"], box["R"], box["B"]
        if snapped or meta2.get("frame_snap"):
            L, R = fr_px["L"] - bx1, bx2 - fr_px["R"]                # per-side best evidence for the read
            T, B = fr_px["T"] - by1, by2 - fr_px["B"]
            if min(L, R, T, B) > 0:
                meta2["lr"] = f"{round(L / (L + R) * 100)}/{round(R / (L + R) * 100)}"
                meta2["tb"] = f"{round(T / (T + B) * 100)}/{round(B / (T + B) * 100)}"
    except Exception:
        pass
    bx1, by1 = max(bx1, 0), max(by1, 0)                              # display box clipped to the warp
    bx2, by2 = min(bx2, Ww - 1), min(by2, Hw - 1)
    meta2["cut_box"] = [round(bx1 / Ww, 4), round(by1 / Hw, 4), round(bx2 / Ww, 4), round(by2 / Hw, 4)]
    meta2["outer_corrected"] = True
    # The register(crop) ctx is CROP-frame — useless for warp-frame defect boxes. The loose fit maps the
    # render onto the FULL warp, which is exactly the ctx the scratch filter needs → no more 'frame
    # mismatch' skip on rescued cards (render-verified FP suppression now runs on EVERY anchored path).
    meta2["_filter_ctx"] = (card_w, ref_w, M)
    try:                                                             # coords are working-scale → probe card_w
        meta2["cut_edge_support"] = _cut_edge_support(card_w, (bx1, by1, bx2, by2))
    except Exception:
        meta2["cut_edge_support"] = None
    return meta2


# ── render-verified scratch filter ──────────────────────────────────────────────────────────────────
def _novel_line_score(card_w, ref_dil, box_px):
    """Does the box contain a coherent LINE absent from the render? Largest connected novel-edge
    component's extent / box diagonal, chance-corrected by the render's local edge coverage (in busy art
    the dilated render edges blanket most of a patch, which would otherwise eat a real scratch).
    Validated: content-line FPs ≤0.24, real/synthetic scratches ≥0.32 (scratch_filter_proto)."""
    x1, y1, x2, y2 = [int(v) for v in box_px]
    # Tiny detector boxes (RF-DETR can emit ~10-15px boxes) give the scorer almost no pixels to judge —
    # expand to a minimum analysis window so a REAL small scratch can still show its line.
    MIN_WIN = 24
    if x2 - x1 < MIN_WIN:
        cx = (x1 + x2) // 2; x1, x2 = cx - MIN_WIN // 2, cx + MIN_WIN // 2
    if y2 - y1 < MIN_WIN:
        cy = (y1 + y2) // 2; y1, y2 = cy - MIN_WIN // 2, cy + MIN_WIN // 2
    x1, y1 = max(x1, 0), max(y1, 0)
    x2, y2 = min(x2, card_w.shape[1]), min(y2, card_w.shape[0])
    if x2 - x1 < 4 or y2 - y1 < 4:
        return None                                                 # out of frame — genuinely can't judge
    ours = cv2.Canny(cv2.cvtColor(card_w[y1:y2, x1:x2], cv2.COLOR_BGR2GRAY), 60, 140)
    if int((ours > 0).sum()) < 20:
        # A scratch claim asserts a bright LINE exists here; if even our own edge detector finds no line
        # structure, the claim is unsupported → score 0 (suppressed). Previously None (kept) — that leaked
        # tiny low-conf art/noise boxes past the filter (card_035: 15x10px box, conf 0.34, on the tail art).
        return 0.0
    ref_e = ref_dil[y1:y2, x1:x2]
    coverage = float((ref_e > 0).mean())
    novel = cv2.dilate(((ours > 0) & (ref_e == 0)).astype(np.uint8), np.ones((3, 3), np.uint8))
    ncomp, labels, stats, _ = cv2.connectedComponentsWithStats(novel, 8)
    if ncomp <= 1:
        return 0.0
    # The chance-correction /(1-coverage) exists to rescue a real scratch LINE partially masked by busy
    # art. A compact BLOB residue (blur/JPEG noise around printed shapes on soft warps) doesn't assert a
    # line, yet at coverage ~0.6+ the correction inflated it 2-3x past the threshold (nc004 Gastly: raw
    # 0.2 blobs scored 0.5-1.1). Gate the amplification on line-ness: per component, amplify only when
    # its pixel cloud is elongated (PCA aspect >= 2); blobs score their raw extent uncorrected.
    bd = max(np.hypot(x2 - x1, y2 - y1), 1.0)
    best = 0.0
    for i in range(1, ncomp):
        raw = float(np.hypot(stats[i, cv2.CC_STAT_WIDTH], stats[i, cv2.CC_STAT_HEIGHT])) / bd
        if raw <= best:                                              # can't beat current best even amplified? cheap skip
            if raw / max(1.0 - coverage, 0.15) <= best:
                continue
        pts = np.stack(np.where(labels == i)[::-1], 1).astype(np.float32)
        elong = 1.0
        if len(pts) >= 5:
            pts -= pts.mean(0)
            ev = np.linalg.eigvalsh(np.cov(pts.T))
            elong = float(np.sqrt(max(ev[1], 1e-6) / max(ev[0], 1e-6)))
        score = min(raw / max(1.0 - coverage, 0.15), 1.5) if elong >= 2.0 else raw
        best = max(best, score)
    return best


def _filter_surface_boxes(result, cen, card_full, filter_ctx, crop_off=None, dilate=3):
    """Suppress RF-DETR surface boxes whose 'scratch' line exists in the registered render (printed content,
    not damage). Suppress-only; kept boxes gain render_novel for observability. Non-fatal.
    crop_off = (bx1,by1,bx2,by2) px in FULL-warp coords when the registration ran on a boundary CROP
    (re-warped / manual-contour grades): boxes are full-warp fractions and must be shifted into the crop
    before scoring; boxes outside the crop (sleeve-region detections) score None and are kept."""
    boxes = (result.get("defect_boxes") or {}).get("surface")
    if not boxes:
        return
    card_w, ref_w, M = filter_ctx
    Minv = cv2.invertAffineTransform(M)
    ref_on = cv2.warpAffine(ref_w, Minv, (card_w.shape[1], card_w.shape[0]))
    ref_dil = cv2.dilate(cv2.Canny(cv2.cvtColor(ref_on, cv2.COLOR_BGR2GRAY), 40, 120),
                         np.ones((dilate, dilate), np.uint8))
    H, W = card_full.shape[:2]
    if crop_off is not None:
        bx1, by1, _bx2, by2 = crop_off
        sc = card_w.shape[0] / max(by2 - by1, 1)
    else:
        bx1 = by1 = 0
        sc = card_w.shape[0] / H
    boxes_px = []
    for b in boxes:
        x, y, w, h = b["box"]
        boxes_px.append(((x * W - bx1) * sc, (y * H - by1) * sc,
                         ((x + w) * W - bx1) * sc, ((y + h) * H - by1) * sc))
    # Card-level NULL calibration: on soft/low-res warps the blur+JPEG noise around printed content
    # scores well above the fixed threshold EVERYWHERE on the card, not just in detector boxes (nc004
    # Gastly: null p90 0.73 vs threshold 0.30 → 10 content FPs survived). Score a deterministic grid of
    # non-box windows to measure this card's intrinsic noise floor and raise the keep bar to it. Sharp
    # cards have null ≈ 0-0.2 → bar stays at SCRATCH_NOVEL_THR (behavior unchanged = no recall loss
    # there); the 0.55 cap keeps strong real scratches (validated ≥0.8 on soft warps) always above it.
    thr = SCRATCH_NOVEL_THR
    null_p90 = None
    try:
        Hc, Wc = card_w.shape[:2]
        win = 36
        gx0, gx1 = int(0.08 * Wc), int(0.92 * Wc) - win
        gy0, gy1 = int(0.08 * Hc), int(0.70 * Hc) - win
        nulls = []
        for gy in range(gy0, gy1, max((gy1 - gy0) // 7, 1)):
            for gx in range(gx0, gx1, max((gx1 - gx0) // 7, 1)):
                nb = (gx, gy, gx + win, gy + win)
                if any(not (nb[2] < p[0] - 6 or nb[0] > p[2] + 6 or nb[3] < p[1] - 6 or nb[1] > p[3] + 6)
                       for p in boxes_px):
                    continue                                         # never let a real scratch raise its own bar
                s = _novel_line_score(card_w, ref_dil, nb)
                if s is not None:
                    nulls.append(s)
        if len(nulls) >= 8:
            null_p90 = float(np.percentile(nulls, 90))
            thr = max(SCRATCH_NOVEL_THR, min(null_p90 + 0.02, 0.55))
    except Exception:
        pass
    kept, suppressed = [], 0
    for b, px in zip(boxes, boxes_px):
        try:
            score = _novel_line_score(card_w, ref_dil, px)
        except Exception:
            score = None
        if score is not None and score < thr:
            suppressed += 1                                          # the line exists in the print → content
            continue
        if score is not None:
            b = dict(b); b["render_novel"] = round(score, 2)
        kept.append(b)
    result["defect_boxes"]["surface"] = kept
    cen["registration"]["scratch_filter"] = {"checked": len(boxes), "suppressed": suppressed,
                                             "threshold": round(thr, 2),
                                             "null_p90": None if null_p90 is None else round(null_p90, 2)}


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
        card = cv2.imdecode(np.frombuffer(base64.b64decode(wj), np.uint8), cv2.IMREAD_COLOR)
        if card is None:
            cen["registration"] = {"accepted": False, "reason": "warp decode"}
            return
        # DIRECT-CROP registration (the 2a refinement): when the result carries a meaningful
        # _card_boundary (a re-warped grade — main.py marks the anchor-corrected quad inside the padded
        # contour warp), register THAT crop instead of the padded frame. The old path bounced through the
        # ring rescue (scale-reject at the pad → extrapolated cut → snaps), whose machinery misfired on
        # some cards (audit: a false 7/93). The crop IS the claimed die-cut: registration accepts at unit
        # scale directly, reads are crop margins, and confidence is support-gated below.
        card_full, cb_off = card, None
        cbb = result.get("_card_boundary") or [0, 0, 1, 1]
        Hf, Wf = card.shape[:2]
        if (result.get("_rewarped_boundary") and len(cbb) == 4
                and (cbb[0] > 0.015 or cbb[1] > 0.015 or cbb[2] < 0.985 or cbb[3] < 0.985)):
            bx1, by1 = int(round(cbb[0] * Wf)), int(round(cbb[1] * Hf))
            bx2, by2 = int(round(cbb[2] * Wf)), int(round(cbb[3] * Hf))
            if bx2 - bx1 > 200 and by2 - by1 > 200:
                card = card[by1:by2, bx1:bx2]
                cb_off = (bx1, by1, bx2, by2)
        cands, why = resolve_candidates(identity)
        vis_used = []
        vis_top_sim = None
        try:
            import visual_id as _vid
            if _vid.ENABLED:
                # Visual retrieval (RAG over renders) leads: image-native candidates, text as backup.
                # Vintage renders are SCANS (their own print offset) — same gate as the text path.
                seen_family = set()
                en_kept, lang_kept, rank_of = [], [], {}
                for rank, (vcid, _sim) in enumerate(_vid.candidates(card, k=15)):
                    if vcid.startswith("_cardback"):
                        # Reference CARD-BACK embeddings live in the index (backs match each other at
                        # ~0.93 cross-holder but fronts at only ~0.66, so magnitude alone can't separate).
                        # Top-ranked back = this photo is a back: registration is meaningless and the
                        # wrong-artwork cap must not fire (a back's selector read is legitimately good).
                        if rank == 0:
                            cen["registration"] = {"accepted": False,
                                                   "reason": f"card back (matched back reference, sim {_sim:.2f})"}
                            return
                        continue                                     # never a registration candidate
                    fam = vcid.split(":", 1)[-1]                 # same card across languages = one family
                    if fam in seen_family:
                        continue
                    seen_family.add(fam)
                    if vis_top_sim is None or _sim > vis_top_sim:
                        vis_top_sim = _sim
                    url, rd = _catalog_meta(vcid)
                    if rd and rd[:4] and int(rd[:4]) < MIN_YEAR:
                        continue
                    if url:
                        _IMG_URLS[vcid] = url
                    rank_of[vcid] = rank
                    (lang_kept if ":" in vcid else en_kept).append(vcid)
                # Language twins rank high on shared ART but fit sparsely on text (a JP twin at 33
                # inliers crowded out the EN render that fits densely) — cap twins and ALWAYS include
                # the best same-language (unprefixed) candidates, in overall rank order.
                vis_used = sorted(set(lang_kept[:3] + en_kept[:3]), key=lambda c: rank_of[c])
        except Exception:
            vis_used = []
        if vis_top_sim is not None and vis_top_sim < float(os.environ.get("PRINT_REG_VISUAL_MIN_SIM", "0.42")):
            # The index is all catalog FRONTS: a card BACK (or non-card) sits far from everything (fronts
            # embed ≥0.6 to their own render even under glare/case/sleeve). Registration is meaningless
            # here — and crucially the wrong-artwork honesty cap must NOT fire (a back's selector read is
            # legitimately reliable; the audit showed every back capped to 0.7 by a hallucinated identity).
            cen["registration"] = {"accepted": False,
                                   "reason": f"not in catalog (top artwork sim {vis_top_sim:.2f} — card back / non-card?)"}
            return
        if vis_used:
            cands = list(dict.fromkeys(vis_used + (cands or [])))
        if not cands:
            cen["registration"] = {"accepted": False, "reason": why}
            return
        # TRY-AND-VERIFY: text matching only needs to get the right card into the top-K — registration
        # itself is the verifier (a wrong card's artwork cannot produce a dense unit-scale RANSAC fit;
        # observed rejecting wrong Pokémon, wrong prints, even a card-back placeholder render).
        meta, tried, scale_rejects, weak_fits = None, [], [], []

        def _try_loop(cand_list):
            for cid in cand_list:
                ref, ferr = _fetch_render(cid)
                if ref is None:
                    tried.append(f"{cid}:{ferr}")
                    continue
                m = register(card, ref)
                if m.get("accepted"):
                    tried.append(f"{cid}:ok")
                    m["ref_id"] = cid
                    mark_winner(identity, cid)                       # keyed on the ORIGINAL identity — the
                    return m                                         # next same-misread run goes straight here
                if m.get("inliers") is not None:                     # a fit existed — say which gate failed
                    tried.append(f"{cid}:{m.get('reason', 'rej')}(inl={m.get('inliers')} "
                                 f"res={m.get('resid_px')} sc={m.get('scale')})")
                    if (m["inliers"] >= 40 and (m.get("resid_px") or 9) <= MAX_RESID
                            and MAX_SCALE_DEV < abs((m.get("scale") or 1) - 1.0) <= _RESCUE_MAX_DEV):
                        scale_rejects.append((m["inliers"], cid, ref,      # scale-ONLY reject: rescue candidate
                                              abs((m.get("scale") or 1) - 1.0),   # if big enough, else demote-only
                                              m.get("resid_px"), m.get("scale")))
                    if (m["inliers"] >= 25 and (m.get("resid_px") or 9) <= MAX_RESID
                            and abs((m.get("scale") or 0) - 1.0) <= _RESCUE_MAX_DEV):
                        weak_fits.append((m["inliers"], cid, ref))         # real artwork match → rewarp-diagnosable
                else:
                    tried.append(f"{cid}:{m.get('reason', 'rej')}")
            return None

        meta = _try_loop(cands)
        # "No real fit yet" = neither a scale-reject nor a weak fit — every attempt was wrong ARTWORK
        # (ransac fail / too few / fetch error / degenerate fit). String-free signal for the retry tiers.
        if (meta is None and not scale_rejects and not weak_fits and (identity or {}).get("number") and tried):
            # Wrong-artwork signature WITH a number present = the number was misread (case glare picks a
            # digit run off the label/art). Retry the resolution NUMBER-STRIPPED — deterministic, no second
            # vision roll needed; the prefix name pool + the registration verifier take it from there.
            nn = {k: v for k, v in identity.items() if k != "number"}
            extra = [c for c in (resolve_candidates(nn)[0] or []) if c not in set(cands)]
            if extra:
                tried.append("(number-stripped retry)")
                meta = _try_loop(extra)
        if meta is None and not scale_rejects and not weak_fits and (identity or {}).get("name") and tried:
            # LAST RESORT — every candidate from every tier was the wrong ARTWORK. The vision ID can
            # hallucinate a whole different card on glare-heavy foil (wrong name suffix AND set AND
            # number), so derive nothing from it except the first name token and let registration
            # verify a wide newest-first pool.
            done = {t.split(":", 1)[0] for t in tried if ":" in t}
            extra2 = first_token_pool(identity.get("name"), k=12, exclude=done)
            if extra2:
                tried.append("(first-token retry)")
                meta = _try_loop(extra2)
        rescueable = [] if cb_off is not None else [t for t in scale_rejects if t[3] >= _RESCUE_MIN_DEV]
        gray_diag = None
        if meta is None and cb_off is not None and (scale_rejects or weak_fits):
            # Crop-registered re-warp with residual ring slop: the anchors measured the per-side overhang
            # exactly — adjust the boundary by it (≤3% moves, clipped) and re-register ONCE at FULL gates.
            # Pure-anchor adjustment is safe at this magnitude: acceptance still requires unit scale, and
            # the read's confidence is support-gated regardless.
            try:
                if scale_rejects:
                    _tb = max(scale_rejects)
                    cidb, refb = _tb[1], _tb[2]
                else:
                    _, cidb, refb = max(weak_fits)
                lfb = _fit_loose(card, refb)
                if lfb is not None:
                    cwb, rwb, Mb = lfb
                    Hwb = cwb.shape[0]
                    RWb, RHb = rwb.shape[1], rwb.shape[0]
                    Mi = cv2.invertAffineTransform(Mb)
                    mcb = np.float32([[0, 0], [RWb, 0], [RWb, RHb], [0, RHb]]) @ Mi[:, :2].T + Mi[:, 2]
                    sc_b = card.shape[0] / Hwb
                    bx1o, by1o, bx2o, by2o = cb_off
                    nb = (max(bx1o + float(mcb[:, 0].min()) * sc_b, 0),
                          max(by1o + float(mcb[:, 1].min()) * sc_b, 0),
                          min(bx1o + float(mcb[:, 0].max()) * sc_b, Wf - 1),
                          min(by1o + float(mcb[:, 1].max()) * sc_b, Hf - 1))
                    _badj = float(os.environ.get("PRINT_REG_BADJ_MAX", "0.12"))
                    # Generous cap: hand-dragged corners are routinely 5-10% off (ring slop from the
                    # loop is <3%). Magnitude is NOT the safety gate — the full-gates re-registration
                    # at unit scale is, plus support-gated confidence downstream.
                    if (abs(nb[0] - bx1o) < _badj * Wf and abs(nb[1] - by1o) < _badj * Hf
                            and abs(nb[2] - bx2o) < _badj * Wf and abs(nb[3] - by2o) < _badj * Hf
                            and nb[2] - nb[0] > 200 and nb[3] - nb[1] > 200):
                        crop2 = card_full[int(nb[1]):int(nb[3]), int(nb[0]):int(nb[2])]
                        # Rescue-verify gates: identity is pre-established by the anchor loop and the
                        # scale snapping to unit IS the verify (glare keeps SIFT sparse on some cards —
                        # ex_1: 35 inliers at res 1.45 with a perfect sc 0.997). Support-gating caps conf.
                        m2 = register(crop2, refb, gates=(30, MAX_RESID, 0.012))
                        if m2.get("accepted"):
                            meta = m2
                            meta["ref_id"] = cidb
                            meta["boundary_adjust"] = {"L": round(nb[0] - bx1o, 1), "T": round(nb[1] - by1o, 1),
                                                       "R": round(nb[2] - bx2o, 1), "B": round(nb[3] - by2o, 1)}
                            mark_winner(identity, cidb)
                            tried.append(f"{cidb}:boundary-adjusted(sc→{m2.get('scale')})")
                            cb_off = (int(nb[0]), int(nb[1]), int(nb[2]), int(nb[3]))
                            result["_card_boundary"] = [round(cb_off[0] / Wf, 4), round(cb_off[1] / Hf, 4),
                                                        round(cb_off[2] / Wf, 4), round(cb_off[3] / Hf, 4)]
            except Exception:
                pass
        if meta is None and OUTER_RESCUE and rescueable:
            # The fit is real and the warp crop is UNAMBIGUOUSLY larger than the card (a case/sleeve/
            # toploader ring) — try the outer-anchor rescue with the best-fitting candidate. Acceptance is
            # the full-gate re-registration on the crop. Sub-threshold scale excess (a slightly loose warp)
            # deliberately does NOT rescue: the selector read stands and confidence is demoted below.
            _t = max(rescueable)
            cid, ref = _t[1], _t[2]
            r = _rescue_outer(card, ref)
            if r is not None:
                meta = r
                meta["ref_id"] = cid
                mark_winner(identity, cid)
                tried.append(f"{cid}:outer-rescued(sc→{meta.get('scale')})")
        if meta is None and TIGHTEN and scale_rejects and not rescueable and cb_off is None:
            # GRAY ZONE (scale excess 1-3%): anchored tightening + crop + full-gate re-registration.
            _t = max(scale_rejects)
            cid, ref = _t[1], _t[2]
            r, gray_diag = _gray_zone_recover(card, ref)
            if r is not None:
                meta = r
                meta["ref_id"] = cid
                mark_winner(identity, cid)
                tried.append(f"{cid}:gray-zone-tightened(sc→{meta.get('scale')})")
        if meta is None and OUTER_RESCUE and cb_off is None and scale_rejects and not rescueable \
                and os.environ.get("PRINT_REG_SMALLDEV", "1").strip().lower() not in ("0", "false", "no", "off"):
            # STRONG-FIT SMALL-DEV RESCUE (slab/sleeve recess lip: crop 1-3% larger than the card).
            # A dense low-residual fit measures scale to ~0.2%, so a 1-3% excess on such a fit is real
            # geometry, not estimation noise — the sparse-fit noise class that motivated the 3% floor
            # (card_006's 1.48% misfire) stays excluded by the inlier/resid bar. Direction must be
            # crop-larger (scale > 1); the cut-off direction has no pixels to recover. Verify is TIGHTER
            # than the big-ring rescue (dense re-fit, near-unit scale) and the read stays support-gated.
            strong = [t for t in scale_rejects
                      if t[0] >= 150 and (t[4] or 9) <= 1.6
                      and t[5] is not None and 0.0 < t[5] - 1.0 <= _RESCUE_MIN_DEV]
            if strong:
                _t = max(strong)
                cid, ref = _t[1], _t[2]
                r = _rescue_outer(card, ref, gates=(60, None, 0.008))
                if r is not None:
                    meta = r
                    meta["ref_id"] = cid
                    mark_winner(identity, cid)
                    tried.append(f"{cid}:smalldev-rescued(sc→{meta.get('scale')})")
        if meta is None:
            cen["registration"] = {"accepted": False, "reason": "no candidate registered", "tried": tried}
            if scale_rejects:
                # The right card WAS found — its render fit densely but at non-unit scale, which is anchor
                # evidence that the warp crop is card + case/sleeve ring — and the rescue couldn't verify a
                # cut. The selector is therefore confidently measuring the RING: demote, don't trust.
                cen["registration"]["reason"] = ("scale-reject unrescued (crop larger than the card)"
                                                 + (f"; {gray_diag}" if gray_diag else ""))
                cur = cen.get("confidence")
                cen["confidence"] = round(min(cur if cur is not None else 1.0, 0.4), 3)
            if REWARP and weak_fits and cb_off is None:
                # PROPOSE a re-warp: a real artwork match exists but registration can't accept — check
                # whether the WARP itself is the problem (homography exposes a locally-bad quad corner).
                # main.py executes the proposal (one Modal contour re-grade, verify-or-discard).
                try:
                    _, cid_w, ref_w2 = max(weak_fits)
                    d = _diagnose_rewarp(card, ref_w2)
                    if d is not None:
                        corners, dev, ninl = d
                        cen["registration"]["rewarp"] = {"corners_frac": corners, "dev_px": dev,
                                                         "h_inliers": ninl, "ref_id": cid_w}
                        # The diagnosis itself is evidence the warp is bad — cap until the re-warp
                        # verifies (on success main.py replaces this whole result).
                        cur = cen.get("confidence")
                        cen["confidence"] = round(min(cur if cur is not None else 1.0, 0.5), 3)
                except Exception:
                    pass
            if (cb_off is None and REWARP and not cen["registration"].get("rewarp")
                    and os.environ.get("PRINT_REG_ECC", "").strip().lower() in ("1", "true", "yes", "on")):
                # ECC layout-anchor tier (last resort): every SIFT fit failed — haze/glare kills
                # descriptors, but dense LAYOUT gradients survive. Scan the already-ranked candidates by
                # ECC correlation; the best same-layout render anchors the GEOMETRY (cut position) even
                # when exact identity stays uncertain. Emits a re-warp proposal only — never a read; the
                # loop verifies by ECC improvement and the adopted result keeps the selector read capped.
                try:
                    ecc_pool = [t.split(":", 1)[0] if not t.startswith(("ja:", "de:", "fr:", "it:", "es:"))
                                else ":".join(t.split(":", 2)[:2]) for t in tried if "retry" not in t]
                    ecc_pool = list(dict.fromkeys(ecc_pool))[:12]
                    best = None
                    for ecid in ecc_pool:
                        eref, _e = _fetch_render(ecid)
                        if eref is None:
                            continue
                        r = _ecc_align(card, eref)
                        if r is None:
                            continue
                        cc_, corners_, rel_ = r
                        if best is None or cc_ > best[0]:
                            best = (cc_, ecid, corners_, rel_)
                    if best is not None:
                        cc_, ecid, corners_, rel_ = best
                        c_arr = np.float32(corners_)
                        convex = cv2.isContourConvex(c_arr.reshape(-1, 1, 2))
                        inb = bool((c_arr > -0.03).all() and (c_arr < 1.03).all())
                        # cc >= 0.30: user red-lines falsified a 0.249 anchor on card_017 — at that
                        # correlation ECC can lock onto the SLEEVE's frame-like gradients and the weak
                        # verify (+0.005) waves it through. Below the bar the tier ABSTAINS (honest
                        # fallback beats confident-wrong geometry — the system's core doctrine).
                        if cc_ >= float(os.environ.get("PRINT_REG_ECC_MIN_CC", "0.30")) \
                                and 0.85 <= rel_ <= 1.02 and convex and inb:
                            dev = float(np.abs(c_arr - np.float32([[0, 0], [1, 0], [1, 1], [0, 1]])).max())
                            cen["registration"]["rewarp"] = {"corners_frac": corners_,
                                                             "dev_px": round(dev * card.shape[0], 1),
                                                             "ref_id": ecid, "ecc": round(cc_, 4)}
                            cen["registration"]["ecc_anchor"] = {"ref_id": ecid, "cc": round(cc_, 4),
                                                                 "rel_scale": round(rel_, 4)}
                            cur = cen.get("confidence")
                            cen["confidence"] = round(min(cur if cur is not None else 1.0, 0.5), 3)
                except Exception:
                    pass
            if (not scale_rejects and any(":" in t for t in tried)
                    and not cen["registration"].get("rewarp")):
                # UNVERIFIED read: either no render fit at all, or only a sparse fit that the rewarp
                # diagnosis couldn't act on. Both mean the selector read has no anchor evidence — cap at
                # medium (a weak-fit-undiagnosable case previously escaped uncapped at 0.9).
                cur = cen.get("confidence")
                cen["confidence"] = round(min(cur if cur is not None else 1.0, 0.7), 3)
                cen["registration"]["reason"] = "no candidate registered (no render fit — read unverified)"
            return
        meta["tried"] = tried
        filter_ctx = meta.pop("_filter_ctx", None)                  # numpy arrays — never serialize
        if cb_off is not None:
            # Crop-registered (re-warped) result: reads are already die-cut-relative (the crop IS the
            # claimed cut). Map the frame back to FULL-warp coords for display, measure per-side support
            # of the boundary lines (drives the confidence gate below), and skip the tightener + scratch
            # filter (their ctx is crop-frame; defect boxes are warp-frame).
            meta["boundary_registered"] = True
            bx1, by1, bx2, by2 = cb_off
            cr = meta.get("content_region")
            if cr:
                meta["content_region"] = {
                    "x1": round((bx1 + cr["x1"] * (bx2 - bx1)) / Wf, 4),
                    "y1": round((by1 + cr["y1"] * (by2 - by1)) / Hf, 4),
                    "x2": round((bx1 + cr["x2"] * (bx2 - bx1)) / Wf, 4),
                    "y2": round((by1 + cr["y2"] * (by2 - by1)) / Hf, 4)}
            try:
                meta["cut_edge_support"] = _cut_edge_support(card_full, cb_off)
            except Exception:
                meta["cut_edge_support"] = None
        if TIGHTEN and not meta.get("outer_corrected") and filter_ctx is not None:
            try:
                fi = meta.get("frame_insets") or {}
                t = _tighten_outer(*filter_ctx, insets=(fi.get("x"), fi.get("y")))
            except Exception:
                t = None
            if t is not None:
                tcut, moved, _ = t
                cw, ch = filter_ctx[0].shape[1], filter_ctx[0].shape[0]
                cr0 = meta["content_region"]                         # detected-datum frame, same coords as cut
                L, R = cr0["x1"] * cw - tcut["L"], tcut["R"] - cr0["x2"] * cw
                T, B = cr0["y1"] * ch - tcut["T"], tcut["B"] - cr0["y2"] * ch
                if min(L, R, T, B) > 0:
                    meta["lr"] = f"{round(L / (L + R) * 100)}/{round(R / (L + R) * 100)}"
                    meta["tb"] = f"{round(T / (T + B) * 100)}/{round(B / (T + B) * 100)}"
                    meta["outer_tightened"] = moved                  # px moved per side (working scale)
                    result["_card_boundary"] = [round(tcut["L"] / cw, 4), round(tcut["T"] / ch, 4),
                                                round((tcut["R"] + 1) / cw, 4), round((tcut["B"] + 1) / ch, 4)]
        if filter_ctx is not None and cb_off is None and not meta.get("outer_corrected") \
                and not meta.get("frame_snap"):
            # Card-side FRAME confirmation on DIRECT accepts (the rescue path already snaps): the
            # render-side frame walk can lock onto the wrong line on busy full-art renders (sc204:
            # y-inset walked to 0.017 vs true silver frame ~0.03 → displayed inner border floated above
            # the print frame). Same confirm-else-keep rule as the outer datum: snap each mapped frame
            # side to the card's own nearest coherent line; an already-correct mapping moves ≤2px and
            # stays byte-identical. Read recomputed against the (possibly tightened) cut when it moves.
            try:
                # DEGENERATE-WALK gate: only an axis whose render-side walk jammed against its physical
                # band boundary (±0.002) is eligible — that is the walk-latched-wrong signature (sc204:
                # y=0.017 at floor 0.016). A healthy mid-band walk with an absent card line is a FULL-ART
                # frame that is legitimately invisible — snapping there hijacks interior structure
                # (card_030's ex-rule box, eyeball-falsified).
                fi = meta.get("frame_insets") or {}
                eligible = []
                if fi.get("x") is not None and (fi["x"] <= 0.024 or fi["x"] >= 0.053):
                    eligible += ["L", "R"]
                if fi.get("y") is not None and (fi["y"] <= 0.018 or fi["y"] >= 0.038):
                    eligible += ["T", "B"]
                cw_, ch_ = filter_ctx[0].shape[1], filter_ctx[0].shape[0]
                cb_now = result.get("_card_boundary") or [0.0, 0.0, 1.0, 1.0]
                cut_px = (cb_now[0] * cw_, cb_now[1] * ch_, cb_now[2] * cw_, cb_now[3] * ch_)
                fs = None
                if eligible:
                    fs = _frame_snap_on_card(filter_ctx[0], meta["content_region"], cut=cut_px,
                                             absent_only=True, allowed_sides=tuple(eligible))
                if fs is not None:
                    new_cr, fsnap = fs
                    L, R = new_cr["x1"] * cw_ - cut_px[0], cut_px[2] - new_cr["x2"] * cw_
                    T, B = new_cr["y1"] * ch_ - cut_px[1], cut_px[3] - new_cr["y2"] * ch_
                    if min(L, R, T, B) > 0:
                        meta["content_region"], meta["frame_snap"] = new_cr, fsnap
                        meta["lr"] = f"{round(L / (L + R) * 100)}/{round(R / (L + R) * 100)}"
                        meta["tb"] = f"{round(T / (T + B) * 100)}/{round(B / (T + B) * 100)}"
            except Exception:
                pass
        if filter_ctx is not None and cb_off is None and not result.get("_rewarped"):
            # TILT-IN-WARP diagnosis on direct accepts: the fit's mapped die line should hug the display
            # frame; a card ROTATED inside a sleeve/case-aligned warp maps outside it at the corners
            # (card_025: 0.6° tilt → TL 15px out; any axis-aligned crop must cut card corners). Propose
            # a re-warp to the card's own corners; the executor adopts only on verified tilt IMPROVEMENT,
            # so clean cards (tilt ≤4px measured across the sentinel set) never churn. Overhang WITHOUT
            # tilt is deliberately not a trigger — that is a boundary offset, fixable without a re-grade.
            try:
                tilt, out, frac = _tilt_from_ctx(filter_ctx)
                meta["tilt_in_warp"] = {"tilt_px": round(tilt, 1), "max_out": round(out, 1)}
                if (REWARP and tilt >= 6.0 and not meta.get("rewarp")
                        and cv2.isContourConvex(np.float32(frac))):
                    meta["rewarp"] = {"corners_frac": frac, "dev_px": round(tilt, 1),
                                      "ref_id": meta.get("ref_id"), "tilt": True}
            except Exception:
                pass
        cen["registration"] = {k: v for k, v in meta.items() if k != "content_region"}
        if meta.get("ref_id"):
            try:                                                    # the VERIFIED catalog card (RAG+register)
                cen["registration"]["ref_card"] = _card_by_id(meta["ref_id"])
            except Exception:
                pass
        if (meta.get("outer_corrected") or meta.get("gray_zone_tightened")) and meta.get("cut_box"):
            # The true die-cut sits INSIDE the displayed warp (case/sleeve/slop ring around it) — move the
            # outer boundary so the UI's green rect hugs the actual card. content_region is already
            # mapped into the same (original-warp) coordinates.
            result["_card_boundary"] = list(meta["cut_box"])
        if SCRATCH_FILTER and filter_ctx is not None:
            try:
                _filter_surface_boxes(result, cen, card_full if cb_off is not None else card,
                                      filter_ctx, crop_off=cb_off,
                                      # rescue fits carry extra alignment slop (loose-fit extrapolation,
                                      # ~1.6px resid) — widen the render-edge band so real art lines don't
                                      # leak past as 'novel' (card_035 tail: 0.31 vs thr 0.30)
                                      dilate=7 if meta.get("outer_corrected") else 3)
            except Exception as e:                                   # filter is optional polish — never fatal
                cen["registration"]["scratch_filter"] = {"error": type(e).__name__}
        # Accepted → the registered read replaces the selector's. Score ladder stays byte-compatible.
        from cv_grader import _centering_score
        lr, tb = meta["lr"], meta["tb"]
        cen["left_right"], cen["top_bottom"] = lr, tb
        cen["content_region"] = meta["content_region"]
        cen["score"] = _centering_score(lr, tb)
        cen["_source"] = "print_reg"
        # Confidence FROM the anchors: instead of two fixed tiers, score the fit itself — inlier count
        # (how much of the print layer agreed) and residual (how precisely). A dense sub-pixel fit earns
        # ~0.95; a barely-passing sparse fit earns ~0.7 (medium). g_geom still MINs in below (a loose/
        # tilted warp shifts the die-cut crop itself), and the stability probe MINs in afterwards.
        q_inl = min(1.0, meta["inliers"] / 120.0)
        q_res = max(0.0, min(1.0, (MAX_RESID - meta["resid_px"]) / 2.0))
        reg_conf = round(0.6 + 0.35 * (0.5 * q_inl + 0.5 * q_res), 3)
        if meta.get("outer_corrected"):
            # Rescued reads: the die-cut is EXTRAPOLATED from the fit. Whether that deserves medium or LOW
            # depends on whether the claimed cut line is photometrically confirmable: if the gradient probe
            # finds an actual edge coinciding with the line on every side, cap at medium (0.7); if any side
            # is invisible against the case (the very situation that fired the rescue), cap at LOW (0.4).
            sup = meta.get("cut_edge_support") or {}
            sup_min = min(sup.values()) if sup else 0.0
            confirmable = sup_min >= float(os.environ.get("PRINT_REG_SUPPORT_THR", "0.4"))
            cap = float(os.environ.get("PRINT_REG_RESCUE_CONF", "0.7")) if confirmable \
                else float(os.environ.get("PRINT_REG_RESCUE_CONF_LOW", "0.4"))
            reg_conf = min(reg_conf, cap)
        elif meta.get("boundary_registered"):
            # Boundary came from a CONVERGED anchor loop + unit-scale re-registration — stronger than the
            # rescue's raw extrapolation, so the tiers sit higher: all four boundary lines photometrically
            # confirmed → near-full anchor confidence; any side unconfirmed → medium.
            sup = meta.get("cut_edge_support") or {}
            sup_min = min(sup.values()) if sup else 0.0
            confirmable = sup_min >= float(os.environ.get("PRINT_REG_SUPPORT_THR", "0.4"))
            cap = float(os.environ.get("PRINT_REG_BREG_CONF", "0.85")) if confirmable \
                else float(os.environ.get("PRINT_REG_BREG_CONF_LOW", "0.6"))
            reg_conf = min(reg_conf, cap)
        g_geom = ((result.get("_rect_check") or {}).get("g_geom"))
        if meta.get("boundary_registered"):
            # rect_check's inset invariant is tuned for SAM3 warps ([0.03,0.97] card edges) and mis-scores
            # padded contour warps (audit: g_geom 0.1 on a support-confirmed re-warp). For crop-registered
            # reads the geometry trust comes from the unit-scale re-verify + per-side support instead.
            g_geom = None
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
