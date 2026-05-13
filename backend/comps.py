"""
Pricing & ROI engine.

v1 uses a hardcoded comp table for common Pokémon cards.
Replace COMP_TABLE entries with live sold-price data in v2
(PriceCharting API, Terapeak, or your own sold-listing tracker).
"""
from __future__ import annotations
import re

from schemas import Economics, Decision

# ── PSA sold-price ladder (USD, rough 2025 market) ───────────────
# Format: { keyword: {psa8, psa9, psa10, raw} }
# Matched against the listing title (lowercase, longest match wins).
COMP_TABLE: dict[str, dict[str, float]] = {
    # Base Set holo rares
    "charizard base set":       {"raw": 300, "psa8": 2500,  "psa9": 5500,  "psa10": 30000},
    "charizard":                {"raw": 250, "psa8": 2000,  "psa9": 5000,  "psa10": 25000},
    "blastoise base set":       {"raw": 60,  "psa8": 450,   "psa9": 900,   "psa10": 4500},
    "blastoise":                {"raw": 55,  "psa8": 400,   "psa9": 800,   "psa10": 4000},
    "venusaur base set":        {"raw": 55,  "psa8": 380,   "psa9": 750,   "psa10": 3800},
    "venusaur":                 {"raw": 50,  "psa8": 350,   "psa9": 700,   "psa10": 3500},
    "mewtwo base set":          {"raw": 25,  "psa8": 180,   "psa9": 380,   "psa10": 2000},
    "mewtwo":                   {"raw": 20,  "psa8": 150,   "psa9": 320,   "psa10": 1800},
    # Pikachu promos / specials
    "pikachu illustrator":      {"raw": 5000,"psa8": 50000, "psa9": 175000,"psa10": 600000},
    "pikachu red cheeks":       {"raw": 80,  "psa8": 550,   "psa9": 1300,  "psa10": 9000},
    "pikachu":                  {"raw": 15,  "psa8": 80,    "psa9": 180,   "psa10": 800},
    # Other base holos
    "alakazam":                 {"raw": 20,  "psa8": 160,   "psa9": 350,   "psa10": 2200},
    "machamp":                  {"raw": 5,   "psa8": 40,    "psa9": 100,   "psa10": 800},
    "raichu":                   {"raw": 30,  "psa8": 220,   "psa9": 500,   "psa10": 3500},
    "gyarados":                 {"raw": 30,  "psa8": 200,   "psa9": 450,   "psa10": 3000},
    "ninetales":                {"raw": 25,  "psa8": 180,   "psa9": 400,   "psa10": 2800},
    "chansey":                  {"raw": 25,  "psa8": 170,   "psa9": 380,   "psa10": 2500},
    "clefairy":                 {"raw": 20,  "psa8": 140,   "psa9": 320,   "psa10": 2200},
    "zapdos":                   {"raw": 20,  "psa8": 150,   "psa9": 340,   "psa10": 2500},
    "moltres":                  {"raw": 18,  "psa8": 130,   "psa9": 300,   "psa10": 2200},
    "articuno":                 {"raw": 18,  "psa8": 130,   "psa9": 300,   "psa10": 2200},
    # Modern hits
    "charizard vmax":           {"raw": 30,  "psa8": 100,   "psa9": 180,   "psa10": 500},
    "charizard ex":             {"raw": 25,  "psa8": 80,    "psa9": 150,   "psa10": 400},
    "umbreon vmax alt art":     {"raw": 150, "psa8": 400,   "psa9": 700,   "psa10": 2500},
    "umbreon vmax":             {"raw": 50,  "psa8": 150,   "psa9": 280,   "psa10": 900},
    "lugia v alt art":          {"raw": 80,  "psa8": 250,   "psa9": 450,   "psa10": 1800},
    # Fallback
    "__default__":              {"raw": 20,  "psa8": 50,    "psa9": 100,   "psa10": 300},
}

GRADING_FEE = 25.0      # PSA standard tier (USD)
SELL_FEE    = 0.1295    # eBay ~12.95% final value fee
TARGET_MARGIN = 0.20    # 20% net margin target for "buy" decision


def _lookup_comps(title: str) -> dict[str, float]:
    tl = title.lower()
    # Try longest keyword match first
    best_key = "__default__"
    best_len = 0
    for key in COMP_TABLE:
        if key == "__default__":
            continue
        if key in tl and len(key) > best_len:
            best_key = key
            best_len = len(key)
    return COMP_TABLE[best_key]


def compute_roi(title: str, listing_price: float,
                grade_distribution: dict[str, float]) -> Economics:
    """
    Return the Economics object given listing price and grade probability distribution.
    """
    comps = _lookup_comps(title)
    total_cost = listing_price + GRADING_FEE

    psa8  = comps.get("psa8",  0.0)
    psa9  = comps.get("psa9",  0.0)
    psa10 = comps.get("psa10", 0.0)
    raw   = comps.get("raw",   listing_price)

    # Weighted expected value across the grade distribution
    ev = 0.0
    for grade_str, prob in grade_distribution.items():
        g = int(grade_str)
        if g <= 2:
            ev += prob * raw * (1 - SELL_FEE)
        elif g <= 4:
            ev += prob * (raw * 1.3) * (1 - SELL_FEE)
        elif g <= 6:
            ev += prob * (psa8 * 0.7) * (1 - SELL_FEE)
        elif g <= 8:
            ev += prob * psa8 * (1 - SELL_FEE)
        elif g == 9:
            ev += prob * psa9 * (1 - SELL_FEE)
        else:
            ev += prob * psa10 * (1 - SELL_FEE)

    ev -= GRADING_FEE

    # Max buy price = net_sale - grading_fee - target_margin
    max_psa9 = round(psa9 * (1 - SELL_FEE) - GRADING_FEE - psa9 * TARGET_MARGIN, 2)
    max_psa8 = round(psa8 * (1 - SELL_FEE) - GRADING_FEE - psa8 * (TARGET_MARGIN * 0.6), 2)

    return Economics(
        listing_price=round(listing_price, 2),
        grading_fee=GRADING_FEE,
        raw_estimate=round(raw, 2),
        psa8_estimate=round(psa8, 2),
        psa9_estimate=round(psa9, 2),
        psa10_estimate=round(psa10, 2),
        max_buy_price_for_psa8_target=max(0.0, max_psa8),
        max_buy_price_for_psa9_target=max(0.0, max_psa9),
        expected_value=round(ev, 2),
    )


def compute_decision(economics: Economics, confidence: str) -> Decision:
    if confidence == "low":
        return Decision(label="skip",
                        reason="Image quality too low for reliable analysis")

    price = economics.listing_price
    max9  = economics.max_buy_price_for_psa9_target or 0
    max8  = economics.max_buy_price_for_psa8_target or 0
    ev    = economics.expected_value or 0

    if price <= max9 and ev > price:
        return Decision(
            label="buy",
            reason=f"Profitable at PSA 9 target — max buy ${max9:.0f}, EV ${ev:.0f}",
        )
    if price <= max8:
        return Decision(
            label="maybe",
            reason=f"Profitable if PSA 9, marginal at PSA 8 — max buy ${max8:.0f}",
        )
    if ev > 0 and price <= ev * 1.1:
        return Decision(
            label="maybe",
            reason=f"Borderline — EV ${ev:.0f} close to listing price ${price:.0f}",
        )
    return Decision(
        label="skip",
        reason=f"Price ${price:.0f} exceeds break-even — PSA 9 target ${max9:.0f}",
    )
