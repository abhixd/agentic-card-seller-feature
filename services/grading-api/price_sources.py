"""
price_sources.py — FREE card price feeds for the Sourcing Scout economics.

pokemontcg.io (v2) gives RAW (ungraded) market prices from TCGplayer (USD) / Cardmarket (EUR), free and
with no approval (a free POKEMONTCG_API_KEY raises the rate limit but isn't required). There is no free
source of GRADED sold comps, so we ESTIMATE PSA 8/9/10 from the raw price via grade multipliers — clearly
labelled as modeled (comps_basis "raw+estimated"), never presented as observed. A paid graded API (e.g.
Pokemon Price Tracker) can later return real psa8/9/10 and replace the estimate with no other change.
"""
import base64
import json
import os
import re
import time

import requests

POKETCG_URL = "https://api.pokemontcg.io/v2/cards"
EUR_USD = 1.08          # only used if TCGplayer (USD) is missing and we fall back to Cardmarket (EUR)

# Raw -> graded MULTIPLIERS. Rough heuristics for modern holo Pokémon (vintage runs higher). This is the
# single knob; any graded value derived from it is flagged "estimated" so the UI never implies a real comp.
GRADE_MULT = {"psa8": 1.4, "psa9": 2.5, "psa10": 6.0}

# identity.variant -> preferred TCGplayer price buckets (best first)
_VARIANT_PREF = {
    "reverse holo": ["reverseHolofoil", "holofoil", "normal"],
    "holo":         ["holofoil", "1stEditionHolofoil", "unlimitedHolofoil", "reverseHolofoil", "normal"],
    "1st edition":  ["1stEditionHolofoil", "1stEdition", "holofoil", "normal"],
    "full art":     ["holofoil", "normal"],
}
_DEFAULT_BUCKETS = ["holofoil", "1stEditionHolofoil", "unlimitedHolofoil", "reverseHolofoil", "normal"]


def _raw_from_card(card, variant=None):
    tp = ((card.get("tcgplayer") or {}).get("prices")) or {}
    if tp:
        buckets = _VARIANT_PREF.get((variant or "").lower(), _DEFAULT_BUCKETS)
        for b in buckets + list(tp.keys()):
            cell = tp.get(b) or {}
            p = cell.get("market") or cell.get("mid")
            if p:
                return float(p), "tcgplayer"
    cm = ((card.get("cardmarket") or {}).get("prices")) or {}
    p = cm.get("trendPrice") or cm.get("averageSellPrice")
    if p:
        return float(p) * EUR_USD, "cardmarket"
    return None, None


def _num(s):
    """'003/127' -> '3' (pokemontcg.io stores numbers unpadded). Returns None if no digits."""
    m = re.search(r"\d+", str(s or ""))
    return str(int(m.group())) if m else None


def pokemontcg_lookup(name, set_name=None, number=None, variant=None, timeout=10.0):
    """Best-effort RAW market price for an identified card. Returns {raw, source, matched} or None."""
    if not name:
        return None
    headers = {}
    key = os.environ.get("POKEMONTCG_API_KEY")
    if key:
        headers["X-Api-Key"] = key
    num = _num(number)

    def _query(q):
        try:
            r = requests.get(POKETCG_URL, params={"q": q, "pageSize": 30, "orderBy": "-set.releaseDate"},
                             headers=headers, timeout=timeout)
            return (r.json() or {}).get("data") or []
        except Exception:
            return []

    cards = _query(f'name:"{name}" number:"{num}"') if num else []
    if not cards and num:                                     # pokemontcg.io hyphenates suffixes
        base = name.split()[0]                                # "Charizard GX" -> "Charizard" (-> "Charizard-GX")
        if base and base.lower() != name.lower():
            cards = _query(f'name:"{base}" number:"{num}"')
    if not cards:
        cards = _query(f'name:"{name}"')                      # fallback: name only (number format varies)
    if not cards:
        return None

    sl = (set_name or "").lower()

    def rank(c):                                              # prefer set match, then number match, then priced
        cs = (c.get("set", {}).get("name", "") or "").lower()
        score = 0
        if sl and (sl in cs or cs in sl):
            score += 4
        if num and _num(c.get("number")) == num:
            score += 2
        if _raw_from_card(c, variant)[0] is not None:
            score += 1
        return score

    chosen = max(cards, key=rank)
    raw, src = _raw_from_card(chosen, variant)
    if raw is None:                                           # chosen had no price → take any priced result
        for c in sorted(cards, key=rank, reverse=True):
            raw, src = _raw_from_card(c, variant)
            if raw is not None:
                chosen = c
                break
    if raw is None:
        return None
    return {"raw": round(raw, 2), "source": f"pokemontcg.io/{src}",
            "matched": f"{chosen.get('name')} · {chosen.get('set', {}).get('name')} #{chosen.get('number')}"}


# ── eBay Browse API — real (asking) graded prices via client-credentials OAuth ─────────────────────────
# Browse gives ACTIVE-listing ask prices (skew high vs sold), but searching "<card> PSA 9" yields real
# graded-slab prices — an upgrade over the modeled estimate. Needs PRODUCTION EBAY_CLIENT_ID/SECRET
# (sandbox can't return real data). Degrades silently to None so the pokemontcg path still runs.
EBAY_OAUTH_URL = "https://api.ebay.com/identity/v1/oauth2/token"
EBAY_BROWSE_URL = "https://api.ebay.com/buy/browse/v1/item_summary/search"
EBAY_SCOPE = "https://api.ebay.com/oauth/api_scope"
_EBAY_TOKEN = {"value": None, "exp": 0.0}


def _clean_cred(v):
    """Strip stray quotes/whitespace/newlines that env values sometimes carry on this host."""
    return v.strip().strip('"').strip("'").strip() if v else v


def _ebay_creds():
    return _clean_cred(os.environ.get("EBAY_CLIENT_ID")), _clean_cred(os.environ.get("EBAY_CLIENT_SECRET"))


def _ebay_token(timeout=10.0):
    """Cached application access token (client_credentials), or None if creds missing/sandbox/failed."""
    cid, sec = _ebay_creds()
    if not cid or not sec or "SBX-" in sec:                  # production creds required
        return None
    now = time.time()
    if _EBAY_TOKEN["value"] and _EBAY_TOKEN["exp"] > now + 60:
        return _EBAY_TOKEN["value"]
    try:
        basic = base64.b64encode(f"{cid}:{sec}".encode()).decode()
        r = requests.post(EBAY_OAUTH_URL,
                          headers={"Authorization": f"Basic {basic}",
                                   "Content-Type": "application/x-www-form-urlencoded"},
                          data={"grant_type": "client_credentials", "scope": EBAY_SCOPE}, timeout=timeout)
        tok = (r.json() or {}).get("access_token") if r.status_code == 200 else None
        if tok:
            _EBAY_TOKEN["value"] = tok
            _EBAY_TOKEN["exp"] = now + float((r.json() or {}).get("expires_in", 7200))
            return tok
    except Exception:
        return None
    return None


def ebay_auth_debug(timeout=10.0):
    """Sanitised diagnostic for the eBay token request — NEVER returns the credential values."""
    cid, sec = _ebay_creds()
    info = {"has_client_id": bool(cid), "has_secret": bool(sec),
            "client_id_prefix": (cid[:5] if cid else None),     # App ID is the public Client ID, ok to hint
            "secret_is_sbx": bool(sec and "SBX-" in sec),
            "marketplace": os.environ.get("EBAY_MARKETPLACE_ID", "EBAY_US")}
    if not cid or not sec:
        info["status"] = "missing-creds"
        return info
    if "SBX-" in sec:
        info["status"] = "sandbox-secret (need production Cert ID)"
        return info
    try:
        basic = base64.b64encode(f"{cid}:{sec}".encode()).decode()
        r = requests.post(EBAY_OAUTH_URL,
                          headers={"Authorization": f"Basic {basic}",
                                   "Content-Type": "application/x-www-form-urlencoded"},
                          data={"grant_type": "client_credentials", "scope": EBAY_SCOPE}, timeout=timeout)
        info["http_status"] = r.status_code
        j = {}
        try:
            j = r.json()
        except Exception:
            pass
        info["ok"] = (r.status_code == 200 and bool(j.get("access_token")))
        if not info["ok"]:
            info["error"] = j.get("error")
            info["error_description"] = (j.get("error_description") or "")[:200]
    except Exception as e:
        info["status"] = f"exception:{type(e).__name__}"
    return info


def _ebay_median(query, limit=25, timeout=10.0):
    """Median fixed-price USD ask for a keyword query, or (None, reason)."""
    tok = _ebay_token()
    if not tok:
        return None, "no-token"
    mkt = os.environ.get("EBAY_MARKETPLACE_ID", "EBAY_US")
    try:
        r = requests.get(EBAY_BROWSE_URL,
                         params={"q": query, "limit": str(limit), "filter": "buyingOptions:{FIXED_PRICE}"},
                         headers={"Authorization": f"Bearer {tok}", "X-EBAY-C-MARKETPLACE-ID": mkt},
                         timeout=timeout)
        if r.status_code != 200:
            return None, f"http-{r.status_code}"
        items = (r.json() or {}).get("itemSummaries") or []
    except Exception as e:
        return None, type(e).__name__
    vals = sorted(float(p["value"]) for it in items
                  for p in [it.get("price") or {}]
                  if p.get("value") and p.get("currency") in (None, "USD"))
    if not vals:
        return None, "no-items"
    return vals[len(vals) // 2], None


def ebay_graded_asks(name, set_name=None, number=None):
    """{psa9, psa10} real asking prices from active eBay listings, or None if eBay unavailable/empty."""
    if not name or not _ebay_token():
        return None
    num = _num(number) or ""
    out = {}
    for g in (9, 10):
        med, _ = _ebay_median(" ".join(x for x in [name, set_name, num, f"PSA {g}"] if x))
        if med is None and set_name:                         # retry without set if over-narrowed to zero
            med, _ = _ebay_median(" ".join(x for x in [name, num, f"PSA {g}"] if x))
        if med:
            out[f"psa{g}"] = round(med, 2)
    return out or None


# ── Pokémon Price Tracker (paid, real PSA SOLD comps) — schema probe; client finalized vs live response ──
PPT_BASE = "https://www.pokemonpricetracker.com/api/v1"


_PPT_NAMES = ("POKEMON_PRICE_TRACKER_TOKEN", "POKEMON_PRICE_TRACKER_API_KEY",
              "POKEMONPRICETRACKER_TOKEN", "POKEMONPRICETRACKER_API_KEY",
              "PPT_TOKEN", "PPT_API_KEY", "POKEMON_PRICE_TRACKER_KEY")


def _ppt_token():
    for n in _PPT_NAMES:
        v = _clean_cred(os.environ.get(n))
        if v:
            return v
    return None


def ppt_probe(identity, timeout=12.0):
    """Diagnostic only (inert without a token): hit likely PPT search shapes and return the raw responses,
    so the real endpoint + field names can be mapped before wiring the live client."""
    tok = _ppt_token()
    if not tok:                                              # help locate a misnamed / wrong-service var
        present = {n: bool(os.environ.get(n)) for n in _PPT_NAMES}
        hint = sorted(k for k in os.environ
                      if any(s in k.upper() for s in ("POKEMON", "PRICE", "TRACKER", "PPT")))
        return {"token": False, "checked_names": present, "env_names_seen": hint}
    name = identity.get("name"); num = _num(identity.get("number")); st = identity.get("set")
    q = " ".join(x for x in [name, num, st] if x)
    headers = {"Authorization": f"Bearer {tok}", "Accept": "application/json"}
    out = {"token": True, "query": q, "attempts": []}
    for path, params in [("/cards", {"search": q}), ("/cards", {"q": q}), ("/search", {"q": q}),
                         ("/cards", {"name": name, "number": num})]:
        rec = {"path": path, "params": params}
        try:
            r = requests.get(f"{PPT_BASE}{path}", params=params, headers=headers, timeout=timeout)
            rec["status"] = r.status_code
            try:
                rec["body"] = json.loads(json.dumps(r.json()))  # ensure serialisable
            except Exception:
                rec["body"] = (r.text or "")[:300]
            out["attempts"].append(rec)
            if r.status_code == 200 and rec.get("body"):
                break
        except Exception as e:
            rec["error"] = type(e).__name__
            out["attempts"].append(rec)
    return out


def _ebay_asks_sane(eb, raw):
    """eBay keyword-ask medians are noisy (lots, accessories, wrong cards). Trust them only if internally
    ordered AND plausible vs raw: PSA 10 >= PSA 9, and each graded ask within a sane band of the raw
    price. Otherwise fall back to the modeled estimate (which at least preserves grade ordering)."""
    psa9, psa10 = eb.get("psa9"), eb.get("psa10")
    if not (psa9 or psa10):
        return False
    if psa9 and psa10 and psa10 < psa9 * 0.95:               # PSA 10 should not be cheaper than PSA 9
        return False
    if raw:
        for v in (psa9, psa10):
            if v and not (raw * 0.8 <= v <= raw * 120):       # graded within a sane multiple of raw
                return False
    return True


def lookup(identity):
    """identity dict -> {prices:{raw,psa8,psa9,psa10}, basis, source, matched, estimated, asking}.
    Prefers real eBay graded ASKS (basis 'active') for PSA 9/10; else pokemontcg raw + modeled grades
    (basis 'raw+estimated'); else 'none'."""
    res = pokemontcg_lookup(identity.get("name"), identity.get("set"),
                            identity.get("number"), identity.get("variant"))
    raw = res["raw"] if res else None
    matched = res["matched"] if res else None
    eb = ebay_graded_asks(identity.get("name"), identity.get("set"), identity.get("number"))

    if eb and _ebay_asks_sane(eb, raw):                      # real (asking) graded prices from eBay
        def _g(key):
            return eb.get(key) or (round(raw * GRADE_MULT[key], 2) if raw else None)
        prices = {"raw": raw,
                  "psa8": round(raw * GRADE_MULT["psa8"], 2) if raw else None,
                  "psa9": _g("psa9"), "psa10": _g("psa10")}
        src = "ebay-browse(asks)" + ("+pokemontcg" if raw else "")
        return {"prices": prices, "basis": "active", "source": src,
                "matched": matched, "estimated": False, "asking": True}

    if raw:                                                  # pokemontcg raw + modeled grades
        prices = {"raw": raw,
                  "psa8": round(raw * GRADE_MULT["psa8"], 2),
                  "psa9": round(raw * GRADE_MULT["psa9"], 2),
                  "psa10": round(raw * GRADE_MULT["psa10"], 2)}
        return {"prices": prices, "basis": "raw+estimated", "source": res["source"],
                "matched": matched, "estimated": True, "asking": False}

    return {"prices": {"raw": None, "psa8": None, "psa9": None, "psa10": None},
            "basis": "none", "source": "none", "matched": None, "estimated": False, "asking": False}
