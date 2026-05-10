"""
A3 — Buy Basket Optimizer

Formulation: Stochastic Knapsack (MIP)

At a card show or shop, selects which cards to buy (and whether to grade
after purchase) to maximise expected portfolio ROI subject to:
  - Total capital budget
  - Minimum ROI threshold per card
  - Maximum cards from the same set (concentration limit)

Decision variables:
    b[card_id]  ∈ {0, 1}   — buy card i
    g[card_id]  ∈ {0, 1}   — grade card i after buying (only valid if b[i]=1)

Objective (maximise):
    sum_i: b[i] * raw_return[i] + g[i] * grade_uplift[i] - b[i] * ask[i]
"""

from __future__ import annotations

import logging
from pulp import LpProblem, LpMaximize, LpVariable, lpSum, LpBinary

from models import (
    BuyBasketRequest,
    BuyBasketResponse,
    BuyDecision,
)
from solver import solve as run_solver
from formulations.shared_constraints import (
    add_budget_constraint,
    add_concentration_constraint,
    compute_net_proceeds,
    compute_expected_grade_value,
)

logger = logging.getLogger(__name__)


def _raw_net(card) -> float:
    """Net proceeds from selling raw (no grading)."""
    return compute_net_proceeds(
        sale_price      = card.raw_resale_value,
        marketplace_fee = card.marketplace_fee,
    )


def _grade_ev(card) -> float:
    """Expected net proceeds if graded, or 0 if grade data not available."""
    if card.grade_probs is None or card.grade_9_value == 0:
        return 0.0
    return compute_expected_grade_value(
        grade_probs     = card.grade_probs,
        grade_8_value   = card.grade_9_value * 0.75,   # estimate G8 as 75% of G9
        grade_9_value   = card.grade_9_value,
        grade_10_value  = card.grade_10_value,
        marketplace_fee = card.marketplace_fee,
    )


def build(req: BuyBasketRequest) -> tuple[LpProblem, dict]:
    prob = LpProblem("buy_basket", LpMaximize)
    min_roi = req.constraints.min_roi_pct

    # ── Pre-filter: only cards meeting minimum raw ROI ─────────────────────────
    eligible_cards = []
    for card in req.cards:
        raw_profit = _raw_net(card) - card.ask_price
        raw_roi    = raw_profit / card.ask_price if card.ask_price > 0 else -1
        if raw_roi >= min_roi or _grade_ev(card) - card.ask_price - card.grading_cost > 0:
            eligible_cards.append(card)

    logger.info("%d / %d cards eligible after ROI filter", len(eligible_cards), len(req.cards))

    # ── Decision variables ─────────────────────────────────────────────────────
    b: dict[str, LpVariable] = {}   # buy
    g: dict[str, LpVariable] = {}   # grade after buy

    for card in eligible_cards:
        b[card.card_id] = LpVariable(f"buy_{card.card_id[:8]}",   cat=LpBinary)
        g[card.card_id] = LpVariable(f"grade_{card.card_id[:8]}", cat=LpBinary)

    # ── Objective ──────────────────────────────────────────────────────────────
    # Profit from buying and selling raw
    raw_profit_terms = [
        b[card.card_id] * (_raw_net(card) - card.ask_price)
        for card in eligible_cards
    ]

    # Additional uplift from grading (grade_ev - raw_net - grading_cost)
    grade_uplift_terms = [
        g[card.card_id] * (_grade_ev(card) - _raw_net(card) - card.grading_cost)
        for card in eligible_cards
        if card.grade_probs is not None
    ]

    prob += lpSum(raw_profit_terms) + lpSum(grade_uplift_terms), "total_expected_profit"

    # ── Constraint 1: Capital budget ───────────────────────────────────────────
    spend_expr = lpSum(
        b[card.card_id] * card.ask_price + g[card.card_id] * card.grading_cost
        for card in eligible_cards
    )
    add_budget_constraint(prob, spend_expr, req.constraints.capital_budget, name="capital_budget")

    # ── Constraint 2: Can only grade if you buy ────────────────────────────────
    for card in eligible_cards:
        prob += g[card.card_id] <= b[card.card_id], f"grade_requires_buy_{card.card_id[:8]}"

    # ── Constraint 3: Can only grade if grade data available ───────────────────
    for card in eligible_cards:
        if card.grade_probs is None or card.grade_9_value == 0:
            prob += g[card.card_id] == 0, f"no_grade_data_{card.card_id[:8]}"

    # ── Constraint 4: Max cards per set (concentration limit) ──────────────────
    max_per_set = req.constraints.max_per_set
    if max_per_set:
        sets = {card.set_name for card in eligible_cards}
        for set_name in sets:
            set_vars = [b[c.card_id] for c in eligible_cards if c.set_name == set_name]
            if len(set_vars) > max_per_set:
                add_concentration_constraint(
                    prob, set_vars, max_per_set,
                    name=f"concentration_{set_name[:20].replace(' ', '_')}",
                )

    meta = {"b": b, "g": g, "eligible_cards": eligible_cards}
    return prob, meta


def decode(result, req: BuyBasketRequest, meta: dict) -> BuyBasketResponse:
    b              = meta["b"]
    g              = meta["g"]
    eligible_cards = meta["eligible_cards"]
    eligible_ids   = {c.card_id for c in eligible_cards}

    decisions: list[BuyDecision] = []
    total_spend   = 0.0
    total_return  = 0.0

    for card in req.cards:
        if card.card_id not in eligible_ids:
            raw_roi = (_raw_net(card) - card.ask_price) / card.ask_price if card.ask_price > 0 else 0
            decisions.append(BuyDecision(
                card_id         = card.card_id,
                card_name       = card.card_name,
                buy             = False,
                grade_after     = False,
                ask_price       = card.ask_price,
                expected_return = _raw_net(card),
                expected_roi    = raw_roi,
                reason          = f"ROI {raw_roi:.0%} below minimum {req.constraints.min_roi_pct:.0%}.",
            ))
            continue

        buy_val   = result.variables.get(b[card.card_id].name, 0.0) or 0.0
        grade_val = result.variables.get(g[card.card_id].name, 0.0) or 0.0

        do_buy   = round(buy_val)   == 1
        do_grade = round(grade_val) == 1

        if do_grade:
            exp_return = _grade_ev(card)
            exp_profit = exp_return - card.ask_price - card.grading_cost
            exp_roi    = exp_profit / (card.ask_price + card.grading_cost)
            reason     = (
                f"Buy and grade. EV after grading: ${exp_return:.2f}. "
                f"Expected profit: ${exp_profit:.2f} ({exp_roi:.0%} ROI)."
            )
        elif do_buy:
            exp_return = _raw_net(card)
            exp_profit = exp_return - card.ask_price
            exp_roi    = exp_profit / card.ask_price if card.ask_price > 0 else 0
            reason     = (
                f"Buy and sell raw. Net after fees: ${exp_return:.2f}. "
                f"Expected profit: ${exp_profit:.2f} ({exp_roi:.0%} ROI)."
            )
        else:
            exp_return = _raw_net(card)
            exp_roi    = (exp_return - card.ask_price) / card.ask_price if card.ask_price > 0 else 0
            reason     = "Skipped — budget allocated to higher-ROI opportunities."

        if do_buy:
            spend = card.ask_price + (card.grading_cost if do_grade else 0)
            total_spend  += spend
            total_return += (exp_return - spend)

        decisions.append(BuyDecision(
            card_id         = card.card_id,
            card_name       = card.card_name,
            buy             = do_buy,
            grade_after     = do_grade,
            ask_price       = card.ask_price,
            expected_return = exp_return,
            expected_roi    = exp_roi,
            reason          = reason,
        ))

    decisions.sort(key=lambda d: (not d.buy, -d.expected_roi))
    portfolio_roi = total_return / total_spend if total_spend > 0 else 0.0

    return BuyBasketResponse(
        status                 = result.status,
        objective_value        = result.objective_value or 0.0,
        total_spend            = total_spend,
        total_expected_return  = total_return,
        portfolio_roi          = portfolio_roi,
        decisions              = decisions,
        solver_used            = result.solver_used,
        solve_time_ms          = result.solve_time_ms,
    )


def optimize(req: BuyBasketRequest) -> BuyBasketResponse:
    prob, meta = build(req)
    result     = run_solver(prob, backend=req.solver.backend, timeout_s=req.solver.timeout_s)

    if not result.is_optimal:
        return BuyBasketResponse(
            status                = result.status,
            objective_value       = 0.0,
            total_spend           = 0.0,
            total_expected_return = 0.0,
            portfolio_roi         = 0.0,
            decisions             = [],
            solver_used           = result.solver_used,
            solve_time_ms         = result.solve_time_ms,
        )

    return decode(result, req, meta)
