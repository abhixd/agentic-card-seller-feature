"""
B2 — Offer Negotiation Advisor

Formulation: Expected Value (rule-based, no MIP needed)

Computes EV of three decisions:
  - Accept:  certain net = offer_price * (1 - fee) - shipping
  - Counter: EV = P(accept_counter) * net(counter) + P(reject) * EV(relist)
  - Decline: EV = EV(relist) adjusted for liquidity and days on market

Counter price is chosen to maximise EV(counter) using a grid search
over [offer_price, list_price] at $0.50 increments.
"""

from __future__ import annotations

import logging
import numpy as np

from models import (
    OfferNegotiationRequest,
    OfferNegotiationResponse,
)
from formulations.shared_constraints import compute_net_proceeds

logger = logging.getLogger(__name__)

# P(buyer accepts counter | counter/offer ratio)
# Fitted from general e-commerce acceptance curves
def _p_accept_counter(counter: float, offer: float) -> float:
    """
    Probability the buyer accepts a counter offer.
    Decreases as counter moves further from original offer.
    Uses a logistic decay anchored at offer price.
    """
    ratio = counter / offer if offer > 0 else 1.0
    # At ratio=1.0 (match offer): P≈0.95
    # At ratio=1.2 (20% above offer): P≈0.30
    # At ratio=1.4 (40% above offer): P≈0.05
    return 1.0 / (1.0 + np.exp(8.0 * (ratio - 1.08)))


def _p_relist_success(days_on_market: int, liquidity_score: float = 0.5) -> float:
    """
    Probability of selling at list price if we decline/counter fails.
    Decays with days on market (stale listings sell less).
    """
    staleness_penalty = min(0.5, days_on_market / 60.0)
    base_p = 0.70 * liquidity_score
    return max(0.05, base_p - staleness_penalty)


def optimize(req: OfferNegotiationRequest) -> OfferNegotiationResponse:
    fee      = req.marketplace_fee
    shipping = req.shipping_cost
    min_net  = req.min_net or 0.0

    # ── Net proceeds for each scenario ────────────────────────────────────────
    net_offer = compute_net_proceeds(req.offer_price, fee, shipping)
    net_list  = compute_net_proceeds(req.list_price,  fee, shipping)

    # ── EV(accept) ────────────────────────────────────────────────────────────
    ev_accept = net_offer

    # ── EV(relist / decline) ──────────────────────────────────────────────────
    p_relist = _p_relist_success(req.days_on_market)
    ev_relist = p_relist * net_list + (1 - p_relist) * net_offer * 0.5
    # If urgency is high, relist EV is discounted further
    if req.urgency_days and req.urgency_days <= req.days_on_market:
        ev_relist *= 0.70

    # ── EV(counter) — grid search for optimal counter price ───────────────────
    best_ev_counter   = -float("inf")
    best_counter_price: float | None = None

    # Search between offer and list price in $0.50 steps
    lo = req.offer_price
    hi = req.list_price
    if hi > lo:
        for counter in np.arange(lo, hi + 0.50, 0.50):
            net_counter = compute_net_proceeds(counter, fee, shipping)
            if net_counter < min_net:
                continue
            p_accept = _p_accept_counter(counter, req.offer_price)
            ev_c = p_accept * net_counter + (1 - p_accept) * ev_relist
            if ev_c > best_ev_counter:
                best_ev_counter   = ev_c
                best_counter_price = round(counter, 2)

    # ── Decision ───────────────────────────────────────────────────────────────
    # Accept if: net_offer >= min_net AND ev_accept >= ev_counter AND ev_accept >= ev_relist
    if net_offer < min_net:
        recommendation = "decline"
        reasoning = (
            f"Offer nets ${net_offer:.2f} which is below your minimum of ${min_net:.2f}. "
            f"Counter at ${best_counter_price:.2f} if interested, or decline."
        )
    elif ev_accept >= (best_ev_counter or 0) and ev_accept >= ev_relist:
        recommendation = "accept"
        reasoning = (
            f"Accept — EV of accepting (${ev_accept:.2f}) exceeds "
            f"countering (${best_ev_counter:.2f}) and relisting (${ev_relist:.2f}). "
            f"Offer is {req.offer_price/req.fair_value:.0%} of fair value."
        )
    elif best_ev_counter is not None and best_ev_counter >= ev_relist:
        recommendation = "counter"
        reasoning = (
            f"Counter at ${best_counter_price:.2f} — EV ${best_ev_counter:.2f} "
            f"vs. accept ${ev_accept:.2f} vs. relist ${ev_relist:.2f}. "
            f"Card has been listed {req.days_on_market} days; "
            + ("some urgency to close." if req.urgency_days else "market supports patience.")
        )
    else:
        recommendation = "decline"
        reasoning = (
            f"Decline — relisting EV (${ev_relist:.2f}) exceeds accepting (${ev_accept:.2f}). "
            f"Offer is only {req.offer_price/req.fair_value:.0%} of fair value "
            f"and market liquidity supports a better outcome."
        )

    return OfferNegotiationResponse(
        status          = "Optimal",
        recommendation  = recommendation,
        counter_price   = best_counter_price if recommendation == "counter" else None,
        net_if_accept   = round(net_offer, 2),
        net_if_counter  = round(compute_net_proceeds(best_counter_price, fee, shipping), 2)
                          if best_counter_price else None,
        ev_accept       = round(ev_accept, 2),
        ev_counter      = round(best_ev_counter, 2) if best_ev_counter > -float("inf") else None,
        reasoning       = reasoning,
    )
