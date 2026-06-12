"""
A4 — Portfolio Rebalancing Optimizer

Formulation: Constrained Binary Selection (MIP)

Selects which holdings to sell to maximise realized profit while respecting:
  - Max number of cards to sell in a session
  - Minimum liquidity score (can't sell illiquid cards in target window)
  - Max portfolio concentration per set (sell overweight sets first)
  - Sentimental hold constraints (hard lock on user-flagged cards)
  - Optional target profit to realize

Decision variables:
    sell[card_id]  ∈ {0, 1}   — sell this holding

Objective (maximise):
    sum_i: sell[i] * (current_value[i] - cost_basis[i])   [realized profit]
    + alpha * sell[i] * liquidity_score[i]                 [liquidity bonus]
"""

from __future__ import annotations

import logging
from collections import defaultdict
from pulp import LpProblem, LpMaximize, LpVariable, lpSum, LpBinary

from models import (
    PortfolioRebalanceRequest,
    PortfolioRebalanceResponse,
    RebalanceDecision,
)
from solver import solve as run_solver
from formulations.shared_constraints import (
    add_count_limit_constraint,
    add_concentration_constraint,
)

logger = logging.getLogger(__name__)

# Weight given to liquidity in the objective (relative to profit)
_LIQUIDITY_ALPHA = 0.05


def build(req: PortfolioRebalanceRequest) -> tuple[LpProblem, dict]:
    prob = LpProblem("portfolio_rebalance", LpMaximize)
    constraints = req.constraints

    # ── Pre-filter: eligibility ────────────────────────────────────────────────
    eligible = [
        h for h in req.holdings
        if not h.sentimental_hold
        and h.liquidity_score >= constraints.min_liquidity_to_sell
        and h.current_value > 0
    ]

    logger.info("%d / %d holdings eligible to sell", len(eligible), len(req.holdings))

    # ── Decision variables ─────────────────────────────────────────────────────
    sell: dict[str, LpVariable] = {
        h.card_id: LpVariable(f"sell_{h.card_id[:8]}", cat=LpBinary)
        for h in eligible
    }

    # ── Objective: maximise realized profit + liquidity bonus ──────────────────
    profit_terms = [
        sell[h.card_id] * (h.current_value - h.cost_basis)
        for h in eligible
    ]
    liquidity_terms = [
        sell[h.card_id] * _LIQUIDITY_ALPHA * h.liquidity_score * h.current_value
        for h in eligible
    ]
    prob += lpSum(profit_terms) + lpSum(liquidity_terms), "realized_profit_with_liquidity"

    # ── Constraint 1: Max cards to sell in session ─────────────────────────────
    if constraints.max_sell_count:
        count_expr = lpSum(sell[h.card_id] for h in eligible)
        add_count_limit_constraint(
            prob, count_expr, constraints.max_sell_count, name="max_sell_count"
        )

    # ── Constraint 2: Concentration — sell overweight sets ─────────────────────
    # Compute current portfolio value per set
    total_value = sum(h.current_value for h in req.holdings) or 1.0
    set_values: dict[str, float] = defaultdict(float)
    set_holdings: dict[str, list] = defaultdict(list)
    for h in req.holdings:
        set_values[h.set_name]    += h.current_value
        set_holdings[h.set_name].append(h)

    max_conc = constraints.max_concentration_pct
    for set_name, holdings_in_set in set_holdings.items():
        set_weight = set_values[set_name] / total_value
        if set_weight > max_conc:
            # Must sell at least enough to bring set weight to target
            overweight_value = set_values[set_name] - max_conc * total_value
            eligible_in_set  = [h for h in holdings_in_set if h.card_id in sell]
            if eligible_in_set:
                must_sell_expr = lpSum(
                    sell[h.card_id] * h.current_value for h in eligible_in_set
                )
                prob += must_sell_expr >= overweight_value, \
                       f"deconcentrate_{set_name[:20].replace(' ', '_')}"

    # ── Constraint 3: Target profit (optional) ─────────────────────────────────
    if constraints.target_realize_profit:
        profit_expr = lpSum(
            sell[h.card_id] * (h.current_value - h.cost_basis)
            for h in eligible
        )
        prob += profit_expr >= constraints.target_realize_profit, "target_profit"

    meta = {"sell": sell, "eligible": eligible}
    return prob, meta


def decode(result, req: PortfolioRebalanceRequest, meta: dict) -> PortfolioRebalanceResponse:
    sell     = meta["sell"]
    eligible = meta["eligible"]
    eligible_ids = {h.card_id for h in eligible}

    decisions: list[RebalanceDecision] = []
    total_value  = 0.0
    total_profit = 0.0
    cards_to_sell = 0
    cards_to_hold = 0

    for h in req.holdings:
        profit  = h.current_value - h.cost_basis
        roi_pct = profit / h.cost_basis if h.cost_basis > 0 else 0.0

        if h.sentimental_hold:
            action = "hold"
            reason = "Sentimental hold — locked by user preference."
        elif h.card_id not in eligible_ids:
            action = "hold"
            reason = f"Liquidity score {h.liquidity_score:.2f} below minimum — cannot sell in target window."
        else:
            val = result.variables.get(sell[h.card_id].name, 0.0) or 0.0
            if round(val) == 1:
                action = "sell"
                if profit >= 0:
                    reason = f"Realize ${profit:.2f} profit ({roi_pct:.0%} ROI). Liquid card, good time to exit."
                else:
                    reason = f"Cut loss of ${abs(profit):.2f} ({roi_pct:.0%}). Rebalancing overweight set or freeing capital."
                cards_to_sell += 1
                total_value   += h.current_value
                total_profit  += profit
            else:
                action = "hold"
                reason = "Hold — profit insufficient or budget allocated to higher-priority sells."
                cards_to_hold += 1

        decisions.append(RebalanceDecision(
            card_id       = h.card_id,
            card_name     = h.card_name,
            action        = action,
            current_value = h.current_value,
            cost_basis    = h.cost_basis,
            profit        = profit,
            roi_pct       = roi_pct,
            reason        = reason,
        ))

    # Sort: sells first (highest profit), then holds
    decisions.sort(key=lambda d: (d.action != "sell", -d.profit))

    return PortfolioRebalanceResponse(
        status                 = result.status,
        cards_to_sell          = cards_to_sell,
        cards_to_hold          = cards_to_hold,
        total_realized_value   = total_value,
        total_realized_profit  = total_profit,
        decisions              = decisions,
        solver_used            = result.solver_used,
        solve_time_ms          = result.solve_time_ms,
    )


def optimize(req: PortfolioRebalanceRequest) -> PortfolioRebalanceResponse:
    prob, meta = build(req)
    result     = run_solver(prob, backend=req.solver.backend, timeout_s=req.solver.timeout_s)

    if not result.is_optimal:
        return PortfolioRebalanceResponse(
            status                = result.status,
            cards_to_sell         = 0,
            cards_to_hold         = len(req.holdings),
            total_realized_value  = 0.0,
            total_realized_profit = 0.0,
            decisions             = [],
            solver_used           = result.solver_used,
            solve_time_ms         = result.solve_time_ms,
        )

    return decode(result, req, meta)
