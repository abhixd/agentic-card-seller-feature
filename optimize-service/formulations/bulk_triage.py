"""
A2 — Bulk Inventory Triage Optimizer

Formulation: Mixed-Integer Assignment Problem

Assigns each card to exactly one action from:
    {list_individually, lot, grade, hold, bulk_sell}

to maximise total net realized value minus labor cost, subject to:
  - Labor hours budget
  - Grading fee budget
  - Action eligibility per card (lot_eligible, grade_eligible flags)

Decision variables:
    x[card_id, action]  ∈ {0, 1}

Objective (maximise):
    sum over (i, a):
        x[i,a] * (net_value[i,a] - labor_cost[i,a])
"""

from __future__ import annotations

import logging
from pulp import LpProblem, LpMaximize, LpVariable, lpSum, LpBinary

from models import (
    BulkTriageRequest,
    BulkTriageResponse,
    TriageDecision,
    TriageAction,
)
from solver import solve as run_solver
from formulations.shared_constraints import (
    add_budget_constraint,
    add_labor_constraint,
    add_single_assignment_constraint,
    compute_net_proceeds,
)

logger = logging.getLogger(__name__)

# Marketplace fee assumed for individually listed cards
_DEFAULT_FEE  = 0.1325
_FIXED_FEE    = 0.30


def _net_value(card, action: TriageAction, labor_rate: float) -> float:
    """
    Compute net economic value of assigning a card to an action,
    after deducting labor cost at the given hourly rate.
    """
    if action == TriageAction.LIST_INDIVIDUALLY:
        gross = compute_net_proceeds(card.raw_value, _DEFAULT_FEE, fixed_fee=_FIXED_FEE)
        labor = card.time_to_list_hrs * labor_rate
        return gross - labor

    if action == TriageAction.LOT:
        # Lot value is a fraction of raw (typically 40-60%); use bulk_value as proxy
        labor = card.time_to_lot_hrs * labor_rate
        return card.bulk_value * 0.55 - labor

    if action == TriageAction.GRADE:
        # grade_expected_profit already accounts for grading fee and resale
        return card.grade_expected_profit

    if action == TriageAction.HOLD:
        # Hold returns 0 net now but retains option value; model as small positive
        return card.raw_value * 0.02   # 2% option premium placeholder

    if action == TriageAction.BULK_SELL:
        return card.bulk_value

    return 0.0


def _labor_cost(card, action: TriageAction) -> float:
    """Labor hours consumed by the action (before rate multiplication)."""
    if action == TriageAction.LIST_INDIVIDUALLY:
        return card.time_to_list_hrs
    if action == TriageAction.LOT:
        return card.time_to_lot_hrs
    if action == TriageAction.GRADE:
        return 0.25   # 15 min to prepare / package for grading
    return 0.0


def _grading_fee(card) -> float:
    """Grading fee is embedded in grade_expected_profit; return standard fee for budget tracking."""
    return 25.0   # default PSA standard tier


def _eligible_actions(card) -> list[TriageAction]:
    actions = [TriageAction.LIST_INDIVIDUALLY, TriageAction.HOLD, TriageAction.BULK_SELL]
    if card.lot_eligible:
        actions.append(TriageAction.LOT)
    if card.grade_eligible:
        actions.append(TriageAction.GRADE)
    return actions


def build(req: BulkTriageRequest) -> tuple[LpProblem, dict]:
    prob = LpProblem("bulk_triage", LpMaximize)
    labor_rate = req.constraints.hourly_labor_rate

    # ── Decision variables ─────────────────────────────────────────────────────
    x: dict[tuple[str, str], LpVariable] = {}
    net_vals: dict[tuple[str, str], float] = {}

    for card in req.cards:
        for action in _eligible_actions(card):
            key      = (card.card_id, action.value)
            var_name = f"x_{card.card_id[:8]}_{action.value}"
            x[key]   = LpVariable(var_name, cat=LpBinary)
            net_vals[key] = _net_value(card, action, labor_rate)

    # ── Objective ──────────────────────────────────────────────────────────────
    prob += lpSum(
        x[key] * net_vals[key]
        for key in x
    ), "total_net_value"

    # ── Constraint 1: Each card assigned to at most one action ─────────────────
    for card in req.cards:
        vars_for_card = [
            x[(card.card_id, a.value)]
            for a in _eligible_actions(card)
        ]
        add_single_assignment_constraint(
            prob, vars_for_card, name=f"assign_{card.card_id[:8]}"
        )

    # ── Constraint 2: Labor hours budget ───────────────────────────────────────
    labor_expr = lpSum(
        x[(card.card_id, action.value)] * _labor_cost(card, action)
        for card in req.cards
        for action in _eligible_actions(card)
    )
    add_labor_constraint(
        prob, labor_expr, req.constraints.labor_hours_budget, name="labor_hours"
    )

    # ── Constraint 3: Grading budget ───────────────────────────────────────────
    if req.constraints.grading_budget > 0:
        grade_fee_expr = lpSum(
            x[(card.card_id, TriageAction.GRADE.value)] * _grading_fee(card)
            for card in req.cards
            if card.grade_eligible
        )
        add_budget_constraint(
            prob, grade_fee_expr, req.constraints.grading_budget, name="grading_budget"
        )

    meta = {"x": x, "net_vals": net_vals}
    return prob, meta


def decode(result, req: BulkTriageRequest, meta: dict) -> BulkTriageResponse:
    x        = meta["x"]
    net_vals = meta["net_vals"]
    labor_rate = req.constraints.hourly_labor_rate

    decisions:  list[TriageDecision] = []
    summary:    dict[str, int]       = {a.value: 0 for a in TriageAction}
    total_net   = 0.0

    for card in req.cards:
        chosen_action: TriageAction | None = None
        chosen_net = 0.0

        for action in _eligible_actions(card):
            key = (card.card_id, action.value)
            val = result.variables.get(x[key].name, 0.0)
            if val is not None and round(val) == 1:
                chosen_action = action
                chosen_net    = net_vals[key]
                break

        if chosen_action is None:
            # Not assigned — default to hold (no labor cost, no decision)
            chosen_action = TriageAction.HOLD
            chosen_net    = card.raw_value * 0.02
            reason = "Unassigned by solver — defaulting to hold."
        else:
            reasons = {
                TriageAction.LIST_INDIVIDUALLY: (
                    f"List individually at ~${card.raw_value:.2f}. "
                    f"Net after fees: ${chosen_net:.2f}."
                ),
                TriageAction.LOT: (
                    f"Include in a lot (est. ${card.bulk_value * 0.55:.2f}). "
                    f"Labor-efficient for low-value card."
                ),
                TriageAction.GRADE: (
                    f"Submit for grading. "
                    f"Expected profit after grading: ${card.grade_expected_profit:.2f}."
                ),
                TriageAction.HOLD: (
                    f"Hold — margin too thin to list now or grade ROI insufficient."
                ),
                TriageAction.BULK_SELL: (
                    f"Bulk sell at ${card.bulk_value:.2f}. "
                    f"Best use of labor given low raw value."
                ),
            }
            reason = reasons[chosen_action]

        summary[chosen_action.value] += 1
        total_net += chosen_net

        decisions.append(TriageDecision(
            card_id   = card.card_id,
            card_name = card.card_name,
            action    = chosen_action,
            net_value = chosen_net,
            reason    = reason,
        ))

    decisions.sort(key=lambda d: -d.net_value)

    return BulkTriageResponse(
        status          = result.status,
        objective_value = result.objective_value or 0.0,
        decisions       = decisions,
        summary         = summary,
        total_net_value = total_net,
        solver_used     = result.solver_used,
        solve_time_ms   = result.solve_time_ms,
    )


def optimize(req: BulkTriageRequest) -> BulkTriageResponse:
    prob, meta = build(req)
    result     = run_solver(prob, backend=req.solver.backend, timeout_s=req.solver.timeout_s)

    if not result.is_optimal:
        return BulkTriageResponse(
            status          = result.status,
            objective_value = 0.0,
            decisions       = [],
            summary         = {},
            total_net_value = 0.0,
            solver_used     = result.solver_used,
            solve_time_ms   = result.solve_time_ms,
        )

    return decode(result, req, meta)
