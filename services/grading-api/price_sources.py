"""
price_sources.py — FREE card price feeds for the Sourcing Scout economics.

pokemontcg.io (v2) gives RAW (ungraded) market prices from TCGplayer (USD) / Cardmarket (EUR), free and
with no approval (a free POKEMONTCG_API_KEY raises the rate limit but isn't required). There is no free
source of GRADED sold comps, so we ESTIMATE PSA 8/9/10 from the raw price via grade multipliers — clearly
labelled as modeled (comps_basis "raw+estimated"), never presented as observed. A paid graded API (e.g.
Pokemon Price Tracker) can later return real psa8/9/10 and replace the estimate with no other change.
"""
import os
import re

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


def pokemontcg_lookup(name, set_name=None, number=None, variant=None, timeout=8.0):
    """Best-effort RAW market price for an identified card. Returns {raw, source, matched} or None."""
    if not name:
        return None
    headers = {}
    key = os.environ.get("POKEMONTCG_API_KEY")
    if key:
        headers["X-Api-Key"] = key
    q = [f'name:"{name}"']
    if number:
        num = re.split(r"[/ ]", str(number))[0].strip()       # "4/102" -> "4"
        if num:
            q.append(f'number:"{num}"')
    try:
        r = requests.get(POKETCG_URL,
                         params={"q": " ".join(q), "pageSize": 20, "orderBy": "-set.releaseDate"},
                         headers=headers, timeout=timeout)
        cards = (r.json() or {}).get("data") or []
    except Exception:
        return None
    if not cards:
        return None

    chosen = None
    if set_name:                                              # prefer a card whose set matches the ID
        sl = set_name.lower()
        chosen = next((c for c in cards
                       if sl in (c.get("set", {}).get("name", "").lower())
                       or (c.get("set", {}).get("name", "").lower()) in sl), None)
    chosen = chosen or cards[0]
    raw, src = _raw_from_card(chosen, variant)
    if raw is None:                                           # fall back to any priced result
        for c in cards:
            raw, src = _raw_from_card(c, variant)
            if raw is not None:
                chosen = c
                break
    if raw is None:
        return None
    return {"raw": round(raw, 2), "source": f"pokemontcg.io/{src}",
            "matched": f"{chosen.get('name')} · {chosen.get('set', {}).get('name')} #{chosen.get('number')}"}


def lookup(identity):
    """identity dict -> {prices:{raw,psa8,psa9,psa10}, basis, source, matched, estimated}.
    basis is 'none' when no price is found, else 'raw+estimated' (raw observed, grades modeled)."""
    res = pokemontcg_lookup(identity.get("name"), identity.get("set"),
                            identity.get("number"), identity.get("variant"))
    if not res:
        return {"prices": {"raw": None, "psa8": None, "psa9": None, "psa10": None},
                "basis": "none", "source": "none", "matched": None, "estimated": False}
    raw = res["raw"]
    prices = {"raw": raw,
              "psa8": round(raw * GRADE_MULT["psa8"], 2),
              "psa9": round(raw * GRADE_MULT["psa9"], 2),
              "psa10": round(raw * GRADE_MULT["psa10"], 2)}
    return {"prices": prices, "basis": "raw+estimated", "source": res["source"],
            "matched": res["matched"], "estimated": True}
