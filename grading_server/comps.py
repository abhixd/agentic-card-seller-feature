"""
comps.py
========
eBay sold-comps lookup + ROI / buy-decision engine.

Ported from the Next.js backend (agentic-card-seller-os):
  - eBay Finding API client      -> src/lib/ebay/findingApi.ts  (fetchEbayComps)
  - grade-price + ROI + decision -> src/app/api/grade/analyze/route.ts

The Python grading pipeline returns a single overall_score (1-10) rather than a
full probability distribution, so distribution_from_overall() synthesises a small
distribution peaked on the rounded grade to feed the same expected-value maths.

Environment variables (same names as the Next.js app):
  EBAY_APP_ID                 — eBay Finding API app id (production, not SBX)
  EBAY_FINDING_API_BASE_URL   — defaults to the production Finding API endpoint
"""

import os
import re
import statistics
from typing import Optional

import requests

# ── Config (mirrors route.ts) ──────────────────────────────────────────────────
GRADING_FEE   = 25       # PSA standard tier (USD)
SELL_FEE      = 0.1295   # eBay ~12.95% final value fee
TARGET_MARGIN = 0.20     # 20% net margin target for "buy"

_GRADE_RE = re.compile(r"\bPSA\s*(\d+(?:\.\d)?)\b", re.IGNORECASE)

EBAY_FINDING_API_BASE_URL = os.environ.get(
    "EBAY_FINDING_API_BASE_URL",
    "https://svcs.ebay.com/services/search/FindingService/v1",
)


def _round2(n: float) -> float:
    return round(n * 100) / 100


# ── eBay Finding API (port of fetchEbayComps) ──────────────────────────────────
def fetch_ebay_comps(keyword: str, timeout: float = 8.0):
    """
    Fetch completed (sold) eBay listings for `keyword`.

    Returns (comps, api_error) where comps is a list of
    {"title": str, "soldPrice": float} and api_error is True on rate-limit /
    HTTP / parse failure (False when eBay succeeds even with zero results).
    """
    app_id = os.environ.get("EBAY_APP_ID")
    if not app_id or "SBX" in app_id or app_id == "YourEbayAppId-Sandbox":
        # Missing or sandbox key — behave like the Next.js code: empty, no error
        return [], False

    params = {
        "OPERATION-NAME":                 "findCompletedItems",
        "SERVICE-VERSION":                "1.0.0",
        "SECURITY-APPNAME":               app_id,
        "RESPONSE-DATA-FORMAT":           "JSON",
        "keywords":                       keyword,
        "itemFilter(0).name":             "SoldItemsOnly",
        "itemFilter(0).value":            "true",
        "sortOrder":                      "EndTimeSoonest",
        "paginationInput.entriesPerPage": "100",
        "paginationInput.pageNumber":     "1",
    }

    try:
        res = requests.get(EBAY_FINDING_API_BASE_URL, params=params, timeout=timeout)
    except Exception as e:
        print(f"[eBay] fetch error: {e}")
        return [], True

    if not res.ok:
        print(f"[eBay] HTTP {res.status_code}")
        return [], True

    try:
        data = res.json()
    except Exception as e:
        print(f"[eBay] JSON parse error: {e}")
        return [], True

    root_list = data.get("findCompletedItemsResponse")
    if not root_list:
        err = (data.get("errorMessage") or [{}])
        print(f"[eBay] No findCompletedItemsResponse: {err}")
        return [], True
    root = root_list[0]

    if (root.get("ack") or [None])[0] != "Success":
        print(f"[eBay] API error: {root.get('errorMessage')}")
        return [], True

    items = (((root.get("searchResult") or [{}])[0]).get("item")) or []
    comps = []
    for item in items:
        try:
            price_str = item["sellingStatus"][0]["currentPrice"][0]["__value__"]
            sold_price = float(price_str)
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if sold_price <= 0:
            continue
        comps.append({
            "title":     (item.get("title") or [""])[0],
            "soldPrice": sold_price,
        })
    return comps, False


# ── Active listings (findItemsAdvanced) — higher-quota fallback ────────────────
def find_active_items(keyword: str, timeout: float = 8.0):
    """
    Fetch ACTIVE (currently-listed) eBay items for `keyword`.

    Used as a fallback when findCompletedItems is rate-limited. findItemsAdvanced
    has a much higher daily quota, but returns *asking* prices, not sold prices —
    callers must label results accordingly (asking prices skew high).

    Returns (comps, api_error) in the same shape as fetch_ebay_comps.
    """
    app_id = os.environ.get("EBAY_APP_ID")
    if not app_id or "SBX" in app_id or app_id == "YourEbayAppId-Sandbox":
        return [], False

    params = {
        "OPERATION-NAME":                 "findItemsAdvanced",
        "SERVICE-VERSION":                "1.0.0",
        "SECURITY-APPNAME":               app_id,
        "RESPONSE-DATA-FORMAT":           "JSON",
        "keywords":                       keyword,
        "paginationInput.entriesPerPage": "100",
        "paginationInput.pageNumber":     "1",
    }

    try:
        res = requests.get(EBAY_FINDING_API_BASE_URL, params=params, timeout=timeout)
    except Exception as e:
        print(f"[eBay] active fetch error: {e}")
        return [], True
    if not res.ok:
        print(f"[eBay] active HTTP {res.status_code}")
        return [], True
    try:
        data = res.json()
    except Exception as e:
        print(f"[eBay] active JSON parse error: {e}")
        return [], True

    root_list = data.get("findItemsAdvancedResponse")
    if not root_list:
        print(f"[eBay] active: no findItemsAdvancedResponse: {data.get('errorMessage')}")
        return [], True
    root = root_list[0]
    if (root.get("ack") or [None])[0] not in ("Success", "Warning"):
        print(f"[eBay] active API error: {root.get('errorMessage')}")
        return [], True

    items = (((root.get("searchResult") or [{}])[0]).get("item")) or []
    comps = []
    for item in items:
        try:
            price_str = item["sellingStatus"][0]["currentPrice"][0]["__value__"]
            price = float(price_str)
        except (KeyError, IndexError, TypeError, ValueError):
            continue
        if price <= 0:
            continue
        comps.append({"title": (item.get("title") or [""])[0], "soldPrice": price})
    return comps, False


# ── Grade-price extraction (port of computeGradePrices) ────────────────────────
def _median(values):
    if not values:
        return None
    return statistics.median_low(sorted(values))  # match JS s[floor(len/2)]


def parse_grade_from_title(title: str) -> Optional[int]:
    m = _GRADE_RE.search(title or "")
    if not m:
        return None
    g = float(m.group(1))
    return round(g) if 1 <= g <= 10 else None


def compute_grade_prices(comps):
    """Median sold price per PSA grade + raw (ungraded) from comp titles."""
    by_grade: dict[int, list[float]] = {}
    raw_prices: list[float] = []
    graded_re = re.compile(r"graded|slab|psa|bgs|sgc|cgc", re.IGNORECASE)

    for c in comps:
        g = parse_grade_from_title(c["title"])
        if g is not None:
            by_grade.setdefault(g, []).append(c["soldPrice"])
        elif not graded_re.search(c["title"]):
            raw_prices.append(c["soldPrice"])

    return {
        "raw":   _median(raw_prices),
        "psa8":  _median(by_grade.get(8, [])),
        "psa9":  _median(by_grade.get(9, [])),
        "psa10": _median(by_grade.get(10, [])),
    }


# ── Distribution from a single overall score ───────────────────────────────────
def distribution_from_overall(overall: float) -> dict:
    """
    Synthesise a grade probability distribution peaked on round(overall).
    The Python grader returns a point estimate; this gives the EV maths a
    realistic spread without claiming false precision.
    """
    if not overall or overall <= 0:
        overall = 5.0
    g0 = max(1, min(10, round(overall)))
    offset_w = {0: 0.50, -1: 0.18, 1: 0.18, -2: 0.07, 2: 0.07}
    dist: dict[str, float] = {}
    for off, w in offset_w.items():
        g = g0 + off
        if 1 <= g <= 10:
            dist[str(g)] = dist.get(str(g), 0.0) + w
    total = sum(dist.values()) or 1.0
    return {k: v / total for k, v in dist.items()}


# ── ROI (port of computeROI) ───────────────────────────────────────────────────
def compute_roi(listing_total: float, grade_dist: dict, prices: dict) -> dict:
    raw   = prices.get("raw")
    psa8  = prices.get("psa8")
    psa9  = prices.get("psa9")
    psa10 = prices.get("psa10")

    def net(p: float) -> float:
        return p * (1 - SELL_FEE) - GRADING_FEE

    def first(*vals):
        for v in vals:
            if v is not None:
                return v
        return 0

    ev = 0.0
    for grade_str, prob in grade_dist.items():
        g = int(grade_str)
        if g >= 10:
            sale_price = first(psa10, psa9, raw, 0)
        elif g == 9:
            sale_price = first(psa9, psa10, raw, 0)
        elif g >= 7:
            sale_price = first(psa8, psa9, raw, 0)
        else:
            sale_price = (raw if raw is not None else 20) * (g / 8)
        ev += prob * sale_price * (1 - SELL_FEE)
    ev -= GRADING_FEE

    max_psa9 = _round2(max(0.0, net(psa9) * (1 - TARGET_MARGIN)))       if psa9 else None
    max_psa8 = _round2(max(0.0, net(psa8) * (1 - TARGET_MARGIN * 0.6))) if psa8 else None

    return {
        "listing_price":                 _round2(listing_total),
        "grading_fee":                   GRADING_FEE,
        "raw_estimate":                  _round2(raw)   if raw   else None,
        "psa8_estimate":                 _round2(psa8)  if psa8  else None,
        "psa9_estimate":                 _round2(psa9)  if psa9  else None,
        "psa10_estimate":                _round2(psa10) if psa10 else None,
        "max_buy_price_for_psa8_target": max_psa8,
        "max_buy_price_for_psa9_target": max_psa9,
        "expected_value":                _round2(ev),
    }


# ── Decision (port of computeDecision, + no-data / active-basis handling) ──────
def compute_decision(economics: dict, confidence: str,
                     has_prices: bool = True, basis: str = "sold") -> dict:
    if confidence == "low":
        return {"label": "skip", "reason": "Image quality too low for reliable analysis"}

    # No usable comp prices → don't fake a confident skip; say so honestly.
    if not has_prices:
        return {"label": "unknown",
                "reason": "No eBay comp data available — economics can't be computed "
                          "(sold-comp quota likely exhausted)."}

    # When working from active asking prices, prefix the reason so the user knows.
    caveat = "Asking-price estimate — " if basis == "active" else ""

    p  = economics["listing_price"]
    m9 = economics["max_buy_price_for_psa9_target"]
    m8 = economics["max_buy_price_for_psa8_target"]
    ev = economics["expected_value"]

    if m9 and p <= m9 and (ev or 0) > p:
        return {"label": "buy",
                "reason": f"{caveat}Profitable at PSA 9 — max buy ${m9:.0f}, EV ${(ev or 0):.0f}"}
    if m8 and p <= m8:
        return {"label": "maybe",
                "reason": f"{caveat}Profitable if PSA 9, marginal at PSA 8 — max buy ${m8:.0f}"}
    if ev and p <= ev * 1.1:
        return {"label": "maybe",
                "reason": f"{caveat}Borderline — EV ${ev:.0f} near listing ${p:.0f}"}
    tail = f" (PSA 9 target ${m9:.0f})" if m9 else ""
    return {"label": "skip", "reason": f"{caveat}Price ${p:.0f} exceeds break-even{tail}"}


# ── Orchestrator ───────────────────────────────────────────────────────────────
def compute_economics(title: str,
                      price: float,
                      shipping: float,
                      overall_score: float,
                      confidence: str = "high") -> dict:
    """
    Full comps + ROI + decision for one listing.

    Returns {"economics": {...}, "decision": {...}, "comps_source": str}.
    Never raises — eBay failures degrade to null prices so grading still returns.
    """
    listing_total = (price or 0) + (shipping or 0)

    # Mirror the Next.js main flow: search by the listing title, minus the PSA tag.
    keyword = re.sub(r"\bPSA\s*\d+\b", "", title or "", flags=re.IGNORECASE)
    keyword = re.sub(r"\s+", " ", keyword).strip()[:100]

    prices = {"raw": None, "psa8": None, "psa9": None, "psa10": None}
    comps_source = "none"
    basis = "sold"
    if keyword:
        # 1) Prefer true SOLD comps (findCompletedItems).
        comps, sold_err = fetch_ebay_comps(keyword)
        if comps:
            prices = compute_grade_prices(comps)
            comps_source = f"ebay sold ({len(comps)})"
        else:
            # 2) Fall back to ACTIVE asking prices (findItemsAdvanced, higher quota)
            #    when sold comps are rate-limited or empty.
            active, active_err = find_active_items(keyword)
            if active:
                prices = compute_grade_prices(active)
                basis = "active"
                comps_source = f"ebay active ({len(active)})"
            elif sold_err or active_err:
                comps_source = "ebay (error)"

    has_prices = any(v is not None for v in prices.values())
    dist       = distribution_from_overall(overall_score)
    economics  = compute_roi(listing_total, dist, prices)
    decision   = compute_decision(economics, confidence,
                                  has_prices=has_prices, basis=basis)

    return {
        "economics":    economics,
        "decision":     decision,
        "comps_source": comps_source,
        "comps_basis":  basis if has_prices else "none",
    }
