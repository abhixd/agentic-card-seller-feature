"""
Module 2 — Generic MIP/LP Solver

Wraps PuLP with pluggable backends (HiGHS preferred, CBC fallback).
Accepts any PuLP LpProblem and returns a standardised SolverResult.

Usage:
    result = solve(prob)
    result = solve(prob, backend=SolverBackend.CBC, timeout_s=10)
"""

from __future__ import annotations

import time
import logging
from dataclasses import dataclass, field
from typing import Optional

from pulp import (
    LpProblem,
    LpStatus,
    LpStatusNotSolved,
    value as lp_value,
)

from models import SolverBackend

logger = logging.getLogger(__name__)


# ── Result dataclass ───────────────────────────────────────────────────────────

@dataclass
class SolverResult:
    """Standardised output from the solver, independent of backend."""

    status:          str                   # "Optimal" | "Infeasible" | "Undefined" | ...
    is_optimal:      bool
    objective_value: Optional[float]       # None if not solved
    variables:       dict[str, float]      # variable name → assigned value
    solve_time_ms:   float
    solver_used:     str
    sensitivity:     dict = field(default_factory=dict)  # shadow prices, slack (HiGHS only)
    message:         str  = ""


# ── Backend loader ─────────────────────────────────────────────────────────────

def _get_solver(backend: SolverBackend, timeout_s: int):
    """
    Return a configured PuLP solver object.

    CBC is bundled with PuLP and is the most reliable choice across all
    deployment environments (Railway, Render, local). HiGHS_CMD requires an
    external binary and env-specific setup — not used here.

    For our problem sizes (< 3000 binary variables) CBC solves in < 1s,
    so the performance difference vs. HiGHS is negligible.
    """
    from pulp import PULP_CBC_CMD
    logger.info("Using CBC solver (backend=%s).", backend)
    return PULP_CBC_CMD(timeLimit=timeout_s, msg=False, threads=2)


# ── Sensitivity extraction ─────────────────────────────────────────────────────

def _extract_sensitivity(prob: LpProblem) -> dict:
    """
    Extract shadow prices and slack values from a solved problem.
    Returns an empty dict if the backend doesn't support it.
    """
    try:
        sensitivity: dict = {"shadow_prices": {}, "slack": {}}
        for name, constraint in prob.constraints.items():
            try:
                sensitivity["shadow_prices"][name] = constraint.pi
                sensitivity["slack"][name]          = constraint.slack
            except Exception:
                pass
        return sensitivity
    except Exception:
        return {}


# ── Public API ─────────────────────────────────────────────────────────────────

def solve(
    prob:       LpProblem,
    backend:    SolverBackend = SolverBackend.HIGHS,
    timeout_s:  int           = 30,
) -> SolverResult:
    """
    Solve a PuLP LpProblem and return a SolverResult.

    Args:
        prob:      Any PuLP LpProblem (LP or MIP).
        backend:   Solver backend to use (HIGHS preferred).
        timeout_s: Wall-clock time limit in seconds.

    Returns:
        SolverResult with status, variable assignments, objective value,
        solve time, and sensitivity data.
    """
    solver = _get_solver(backend, timeout_s)
    solver_name = type(solver).__name__

    t0 = time.perf_counter()
    try:
        prob.solve(solver)
    except Exception as exc:
        elapsed_ms = (time.perf_counter() - t0) * 1000
        logger.error("Solver raised exception: %s", exc)
        return SolverResult(
            status="Error",
            is_optimal=False,
            objective_value=None,
            variables={},
            solve_time_ms=elapsed_ms,
            solver_used=solver_name,
            message=str(exc),
        )

    elapsed_ms = (time.perf_counter() - t0) * 1000
    status_str = LpStatus[prob.status]
    is_optimal = (status_str == "Optimal")

    obj_val = None
    variables: dict[str, float] = {}
    sensitivity: dict = {}

    if is_optimal:
        obj_val = lp_value(prob.objective)
        variables = {v.name: v.varValue for v in prob.variables() if v.varValue is not None}
        sensitivity = _extract_sensitivity(prob)

    logger.info(
        "Solved %s | backend=%s | status=%s | obj=%.4f | time=%.1fms",
        prob.name, solver_name, status_str,
        obj_val if obj_val is not None else float("nan"),
        elapsed_ms,
    )

    return SolverResult(
        status=status_str,
        is_optimal=is_optimal,
        objective_value=obj_val,
        variables=variables,
        solve_time_ms=elapsed_ms,
        solver_used=solver_name,
        sensitivity=sensitivity,
    )
