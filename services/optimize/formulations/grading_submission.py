"""
A1 — Grading Submission Optimizer

Formulation: Stochastic Knapsack (MIP)

Decides which cards to submit, to which grader, at which service tier,
to maximise expected net profit subject to:
  - Total grading budget
  - Turnaround deadline (if set)
  - Minimum expected profit per card (pre-filter)

Decision variables:
    x[card_id, grader, tier]  ∈ {0, 1}
        = 1 if card i is submitted to grader g at tier t

Each card may be assigned to at most one (grader, tier) combination.

Objective (maximise):
    sum over (i, g, t):
        x[i,g,t] * (EV_grade[i] - fee[g,t] - shipping_share[i])
    where EV_grade[i] = P(8)*net(V8) + P(9)*net(V9) + P(10)*net(V10)
"""

from __future__ import annotations

import logging
from pulp import LpProblem, LpMaximize, LpVariable, lpSum, LpBinary

from models import (
    GradingSubmissionRequest,
    GradingSubmissionResponse,
    GradingDecision,
    GraderTierSpec,
)
from solver import solve as run_solver
from formulations.shared_constraints import (
    add_budget_constraint,
    add_single_assignment_constraint,
    compute_expected_grade_value,
    compute_expected_profit,
)

logger = logging.getLogger(__name__)


def build(req: GradingSubmissionRequest) -> tuple[LpProblem, dict]:
    """
    Module 1: Build the MIP formulation.

    Returns:
        prob:     The PuLP LpProblem ready to be passed to the solver.
        meta:     Dict of auxiliary data needed to decode the solution
                  (expected values, fees, variable index).
    """
    prob = LpProblem("grading_submission", LpMaximize)

    # ── Pre-compute expected values for each card ──────────────────────────────
    # EV is card-level (independent of grader/tier), so compute once.
    ev: dict[str, float] = {}
    for card in req.cards:
        ev[card.card_id] = compute_expected_grade_value(
            grade_probs      = card.grade_probs,
            grade_8_value    = card.grade_8_value,
            grade_9_value    = card.grade_9_value,
            grade_10_value   = card.grade_10_value,
            marketplace_fee  = card.marketplace_fee,
            shipping_cost    = card.shipping_cost,
        )

    # ── Filter ineligible cards (below min expected profit) ────────────────────
    min_profit = req.constraints.min_expected_roi
    eligible_cards = [
        c for c in req.cards
        if (ev[c.card_id] - min(t.fee for t in req.grader_tiers)) >= min_profit
    ]

    if not eligible_cards:
        logger.warning("No cards pass min_expected_roi filter — problem will be trivially empty.")

    # ── Filter ineligible grader/tier combos (turnaround deadline) ────────────
    deadline = req.constraints.deadline_days
    eligible_tiers: list[GraderTierSpec] = [
        t for t in req.grader_tiers
        if deadline is None or t.turnaround <= deadline
    ]

    if not eligible_tiers:
        logger.warning("No grader tiers meet deadline constraint.")

    # ── Decision variables x[card_id, grader, tier] ∈ {0,1} ──────────────────
    x: dict[tuple[str, str, str], LpVariable] = {}
    for card in eligible_cards:
        for tier in eligible_tiers:
            key = (card.card_id, tier.grader.value, tier.tier.value)
            var_name = f"x_{card.card_id[:8]}_{tier.grader.value}_{tier.tier.value}"
            x[key] = LpVariable(var_name, cat=LpBinary)

    # ── Objective: maximise total expected net profit ──────────────────────────
    objective_terms = []
    for card in eligible_cards:
        for tier in eligible_tiers:
            key = (card.card_id, tier.grader.value, tier.tier.value)
            expected_profit = compute_expected_profit(
                expected_value   = ev[card.card_id],
                acquisition_cost = 0.0,      # card already owned
                grading_fee      = tier.fee,
            )
            objective_terms.append(x[key] * expected_profit)

    prob += lpSum(objective_terms), "total_expected_profit"

    # ── Constraint 1: Budget ───────────────────────────────────────────────────
    fee_expr = lpSum(
        x[(card.card_id, tier.grader.value, tier.tier.value)] * tier.fee
        for card in eligible_cards
        for tier in eligible_tiers
    )
    add_budget_constraint(prob, fee_expr, req.constraints.budget, name="grading_budget")

    # ── Constraint 2: Each card assigned to at most one (grader, tier) ─────────
    for card in eligible_cards:
        vars_for_card = [
            x[(card.card_id, tier.grader.value, tier.tier.value)]
            for tier in eligible_tiers
        ]
        add_single_assignment_constraint(
            prob,
            vars_for_card,
            name=f"single_tier_{card.card_id[:8]}",
        )

    # ── Constraint 3: Min batch size per (grader, tier) ────────────────────────
    for tier in eligible_tiers:
        if tier.min_batch > 1:
            batch_expr = lpSum(
                x[(card.card_id, tier.grader.value, tier.tier.value)]
                for card in eligible_cards
            )
            # If any card is submitted at this tier, batch must meet minimum
            # (linearised: if sum >= 1 then sum >= min_batch — approximated
            #  as sum == 0 OR sum >= min_batch via big-M)
            M = len(eligible_cards)
            y_tier = LpVariable(
                f"y_batch_{tier.grader.value}_{tier.tier.value}", cat=LpBinary
            )
            prob += batch_expr >= tier.min_batch * y_tier, \
                   f"min_batch_{tier.grader.value}_{tier.tier.value}"
            prob += batch_expr <= M * y_tier, \
                   f"batch_link_{tier.grader.value}_{tier.tier.value}"

    meta = {
        "x":              x,
        "ev":             ev,
        "eligible_cards": eligible_cards,
        "eligible_tiers": eligible_tiers,
    }
    return prob, meta


def decode(
    result,
    req:  GradingSubmissionRequest,
    meta: dict,
) -> GradingSubmissionResponse:
    """
    Decode a SolverResult into a GradingSubmissionResponse.
    Builds per-card decisions with human-readable reason strings.
    """
    x             = meta["x"]
    ev            = meta["ev"]
    eligible_cards = meta["eligible_cards"]
    eligible_tiers = meta["eligible_tiers"]

    eligible_ids = {c.card_id for c in eligible_cards}
    decisions: list[GradingDecision] = []
    total_fee   = 0.0
    cards_submitted = 0

    for card in req.cards:
        # Cards filtered out before building the model
        if card.card_id not in eligible_ids:
            decisions.append(GradingDecision(
                card_id        = card.card_id,
                card_name      = card.card_name,
                submit         = False,
                expected_value = ev.get(card.card_id, 0.0),
                expected_profit = ev.get(card.card_id, 0.0) -
                                  min((t.fee for t in req.grader_tiers), default=0),
                reason         = "Expected profit below minimum threshold.",
            ))
            continue

        # Find the chosen (grader, tier) for this card
        chosen_tier: GraderTierSpec | None = None
        for tier in eligible_tiers:
            key = (card.card_id, tier.grader.value, tier.tier.value)
            val = result.variables.get(x[key].name, 0.0)
            if val is not None and round(val) == 1:
                chosen_tier = tier
                break

        card_ev = ev[card.card_id]

        if chosen_tier is None:
            decisions.append(GradingDecision(
                card_id         = card.card_id,
                card_name       = card.card_name,
                submit          = False,
                expected_value  = card_ev,
                expected_profit = card_ev - min(t.fee for t in eligible_tiers),
                reason          = "Not selected — budget allocated to higher-value cards.",
            ))
        else:
            profit = compute_expected_profit(
                expected_value   = card_ev,
                acquisition_cost = 0.0,
                grading_fee      = chosen_tier.fee,
            )
            total_fee      += chosen_tier.fee
            cards_submitted += 1
            decisions.append(GradingDecision(
                card_id         = card.card_id,
                card_name       = card.card_name,
                submit          = True,
                grader          = chosen_tier.grader,
                tier            = chosen_tier.tier,
                fee             = chosen_tier.fee,
                expected_value  = card_ev,
                expected_profit = profit,
                reason          = (
                    f"Submit to {chosen_tier.grader.value.upper()} "
                    f"{chosen_tier.tier.value} (${chosen_tier.fee:.0f} fee, "
                    f"~{chosen_tier.turnaround}d). "
                    f"Expected profit: ${profit:.2f}."
                ),
            ))

    # Sort: submitted first, then by expected profit descending
    decisions.sort(key=lambda d: (not d.submit, -d.expected_profit))

    return GradingSubmissionResponse(
        status          = result.status,
        objective_value = result.objective_value or 0.0,
        total_fee       = total_fee,
        cards_submitted = cards_submitted,
        decisions       = decisions,
        solver_used     = result.solver_used,
        solve_time_ms   = result.solve_time_ms,
    )


def optimize(req: GradingSubmissionRequest) -> GradingSubmissionResponse:
    """
    Entry point: build → solve → decode.
    Called by the FastAPI route handler.
    """
    prob, meta = build(req)
    result     = run_solver(prob, backend=req.solver.backend, timeout_s=req.solver.timeout_s)

    if not result.is_optimal:
        # Return a meaningful error response without crashing
        return GradingSubmissionResponse(
            status          = result.status,
            objective_value = 0.0,
            total_fee       = 0.0,
            cards_submitted = 0,
            decisions       = [],
            solver_used     = result.solver_used,
            solve_time_ms   = result.solve_time_ms,
        )

    return decode(result, req, meta)
