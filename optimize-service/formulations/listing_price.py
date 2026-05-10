"""
B1 — Listing Price Optimizer

Formulation: Continuous (LP / rule-based EV)

No binary variables — produces three price bands using:
  - Recency-weighted median of comps as fair value anchor
  - Liquidity-adjusted sell-through probability curve
  - Fee deductions for net proceeds

Returns:
  Quick Sale  — high probability of sale within urgency window
  Fair Market — balanced speed vs. net
  Stretch     — maximises net if patient
"""

from __future__ import annotations

import math
import logging
from statistics import median

from models import (
    ListingPriceRequest,
    ListingPriceResponse,
    PriceBand,
)
from formulations.shared_constraints import compute_net_proceeds

logger = logging.getLogger(__name__)

# Recency decay: half-life of 30 days
_DECAY_HALFLIFE = 30.0

# Price band multipliers relative to fair value
_QUICK_SALE_DISCOUNT  = 0.88   # 12% below fair value
_FAIR_MARKET_FACTOR   = 1.00
_STRETCH_PREMIUM      = 1.10   # 10% above fair value

# Estimated days to sell at each band (rough heuristic)
_DAYS_QUICK   = 2.0
_DAYS_FAIR    = 7.0
_DAYS_STRETCH = 21.0

# Confidence scores for each band
_CONF_QUICK   = 0.90
_CONF_FAIR    = 0.75
_CONF_STRETCH = 0.50


def _recency_weight(days_ago: int) -> float:
    """Exponential decay weight for a comp sold N days ago."""
    return math.exp(-math.log(2) * days_ago / _DECAY_HALFLIFE)


def _weighted_median(values: list[float], weights: list[float]) -> float:
    """
    Compute a weighted median.
    Sorts by value, accumulates weights until 50% threshold is crossed.
    """
    if not values:
        return 0.0
    pairs = sorted(zip(values, weights), key=lambda x: x[0])
    total_w = sum(w for _, w in pairs)
    cumulative = 0.0
    for val, w in pairs:
        cumulative += w
        if cumulative >= total_w * 0.5:
            return val
    return pairs[-1][0]


def optimize(req: ListingPriceRequest) -> ListingPriceResponse:
    if not req.comps:
        return ListingPriceResponse(
            status     = "Error",
            card_name  = req.card_name,
            comp_count = 0,
            fair_value = 0.0,
            bands      = [],
            reasoning  = "No comps provided — cannot generate price recommendation.",
        )

    # ── Recency-weighted median as fair value ──────────────────────────────────
    prices  = [c.sale_price for c in req.comps]
    weights = [_recency_weight(c.days_ago) for c in req.comps]
    fair_value = _weighted_median(prices, weights)

    # ── Adjust for urgency ─────────────────────────────────────────────────────
    urgency_discount = 1.0
    days_quick   = _DAYS_QUICK
    days_fair    = _DAYS_FAIR
    days_stretch = _DAYS_STRETCH

    if req.urgency_days:
        if req.urgency_days <= 3:
            urgency_discount = 0.92
            days_quick       = 1.0
            days_fair        = req.urgency_days * 0.5
        elif req.urgency_days <= 7:
            urgency_discount = 0.96

    # ── Price bands ────────────────────────────────────────────────────────────
    quick_price   = fair_value * _QUICK_SALE_DISCOUNT  * urgency_discount
    fair_price    = fair_value * _FAIR_MARKET_FACTOR   * urgency_discount
    stretch_price = fair_value * _STRETCH_PREMIUM

    # Apply minimum net floor
    min_net = req.min_net or 0.0

    def make_band(label: str, list_price: float, days: float, conf: float) -> PriceBand | None:
        net = compute_net_proceeds(list_price, req.marketplace_fee, req.shipping_cost)
        if net < min_net:
            return None
        return PriceBand(
            label            = label,
            list_price       = round(list_price, 2),
            net_proceeds     = round(net, 2),
            est_days_to_sell = days,
            confidence       = conf,
        )

    bands = []
    for band in [
        make_band("Quick Sale",  quick_price,   days_quick,   _CONF_QUICK),
        make_band("Fair Market", fair_price,    days_fair,    _CONF_FAIR),
        make_band("Stretch",     stretch_price, days_stretch, _CONF_STRETCH),
    ]:
        if band is not None:
            bands.append(band)

    # ── Reasoning ─────────────────────────────────────────────────────────────
    spread = max(prices) - min(prices) if len(prices) > 1 else 0
    reasoning = (
        f"Based on {len(req.comps)} comp(s). "
        f"Recency-weighted median: ${fair_value:.2f}. "
        f"Price spread: ${spread:.2f}. "
        + (f"Urgency adjustment applied ({req.urgency_days}d window). " if req.urgency_days else "")
        + (f"Min net floor: ${min_net:.2f}. " if min_net else "")
    )

    return ListingPriceResponse(
        status     = "Optimal",
        card_name  = req.card_name,
        comp_count = len(req.comps),
        fair_value = round(fair_value, 2),
        bands      = bands,
        reasoning  = reasoning,
    )
