"""
Shared constraint and objective routines reused across formulations.

Each routine accepts a PuLP LpProblem and mutates it by adding constraints
or terms. This keeps individual formulation files focused on problem-specific
logic only.

Naming convention:
    add_*_constraint  — adds one or more constraints to the problem
    add_*_objective   — adds terms to the objective expression (returned)
"""

from __future__ import annotations

from typing import Sequence

from pulp import LpProblem, LpAffineExpression, lpSum


# ── Budget constraints ─────────────────────────────────────────────────────────

def add_budget_constraint(
    prob:       LpProblem,
    cost_expr:  LpAffineExpression,
    budget:     float,
    name:       str = "budget",
) -> None:
    """
    Total cost of selected decisions must not exceed budget.

        sum(cost_i * x_i) <= budget
    """
    prob += cost_expr <= budget, name


def add_min_spend_constraint(
    prob:       LpProblem,
    cost_expr:  LpAffineExpression,
    min_spend:  float,
    name:       str = "min_spend",
) -> None:
    """Optional: enforce a minimum spend (e.g., minimum lot size economics)."""
    prob += cost_expr >= min_spend, name


# ── Assignment constraints ─────────────────────────────────────────────────────

def add_single_assignment_constraint(
    prob:     LpProblem,
    var_rows: Sequence,
    name:     str,
) -> None:
    """
    Each item may be assigned to at most one action (used in triage).

        sum_a x[i, a] <= 1  for each item i

    Args:
        var_rows: Iterable of PuLP variables representing all action choices
                  for a single item.
    """
    prob += lpSum(var_rows) <= 1, name


def add_exactly_one_constraint(
    prob:     LpProblem,
    var_rows: Sequence,
    name:     str,
) -> None:
    """Each item must be assigned to exactly one action."""
    prob += lpSum(var_rows) == 1, name


# ── Capacity / throughput constraints ──────────────────────────────────────────

def add_labor_constraint(
    prob:         LpProblem,
    labor_expr:   LpAffineExpression,
    labor_budget: float,
    name:         str = "labor_hours",
) -> None:
    """
    Total labor consumed by selected actions must not exceed available hours.

        sum(labor_i * x_i) <= labor_budget
    """
    prob += labor_expr <= labor_budget, name


def add_count_limit_constraint(
    prob:       LpProblem,
    count_expr: LpAffineExpression,
    max_count:  int,
    name:       str = "count_limit",
) -> None:
    """Limit the total number of selected items."""
    prob += count_expr <= max_count, name


def add_min_count_constraint(
    prob:       LpProblem,
    count_expr: LpAffineExpression,
    min_count:  int,
    name:       str = "min_count",
) -> None:
    """Require at least min_count items to be selected."""
    prob += count_expr >= min_count, name


# ── Margin / ROI constraints ───────────────────────────────────────────────────

def add_min_margin_filter(items: list, min_margin: float) -> list:
    """
    Pre-filter: return only items whose net margin exceeds the threshold.
    Cheaper than adding per-item constraints; applied before building the model.

    Args:
        items:      List of dicts with keys 'net_value' and 'cost'.
        min_margin: Minimum (net_value - cost) / cost ratio.

    Returns:
        Filtered list.
    """
    result = []
    for item in items:
        cost = item.get("cost", 0)
        net  = item.get("net_value", 0)
        if cost <= 0 or (net - cost) / cost >= min_margin:
            result.append(item)
    return result


# ── Concentration / diversification constraints ────────────────────────────────

def add_concentration_constraint(
    prob:       LpProblem,
    group_vars: Sequence,
    max_count:  int,
    name:       str,
) -> None:
    """
    At most max_count items from a group (e.g., same set) may be selected.

        sum_i x[i]  <=  max_count   for each group
    """
    prob += lpSum(group_vars) <= max_count, name


# ── Fee helpers (pure functions, no mutation) ──────────────────────────────────

def compute_net_proceeds(
    sale_price:       float,
    marketplace_fee:  float,
    shipping_cost:    float = 0.0,
    fixed_fee:        float = 0.30,
) -> float:
    """
    Net proceeds after marketplace percentage fee, fixed transaction fee,
    and outbound shipping cost.

        net = sale_price * (1 - marketplace_fee) - fixed_fee - shipping_cost
    """
    return sale_price * (1.0 - marketplace_fee) - fixed_fee - shipping_cost


def compute_expected_grade_value(
    grade_probs:      "GradeDistribution",
    grade_8_value:    float,
    grade_9_value:    float,
    grade_10_value:   float,
    marketplace_fee:  float,
    shipping_cost:    float = 0.0,
) -> float:
    """
    Expected sale value after grading, weighting each grade outcome by its
    probability and deducting marketplace fees.

        EV = P(8)*net(V8) + P(9)*net(V9) + P(10)*net(V10)
    """
    net8  = compute_net_proceeds(grade_8_value,  marketplace_fee, shipping_cost)
    net9  = compute_net_proceeds(grade_9_value,  marketplace_fee, shipping_cost)
    net10 = compute_net_proceeds(grade_10_value, marketplace_fee, shipping_cost)

    return (
        grade_probs.grade_8  * net8  +
        grade_probs.grade_9  * net9  +
        grade_probs.grade_10 * net10
    )


def compute_expected_profit(
    expected_value:  float,
    acquisition_cost: float,
    grading_fee:     float = 0.0,
) -> float:
    """
    Expected profit = expected_value − acquisition_cost − grading_fee.
    Acquisition cost is 0 for grading-only decisions (card already owned).
    """
    return expected_value - acquisition_cost - grading_fee
