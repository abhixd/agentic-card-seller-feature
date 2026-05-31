"""
aggregator.py
=============
Stage-B helpers shared by the server: combine pillar scores into an overall PSA
grade (using the linear weights from grade_model.json), and merge front+back
pillar scores (worst side per pillar — a card is held back by its weaker side).

The same linear model runs client-side (grade_model.js) for interactive edits;
this server copy is used when grading front+back so the response carries a
consistent combined grade + economics.
"""

import os
import json

PSA_NAMES = {
    10: "Gem Mint", 9: "Mint", 8: "NM-MT", 7: "NM", 6: "EX-MT",
    5: "EX", 4: "VG-EX", 3: "VG", 2: "Good", 1: "Poor",
}
PILLARS = ["centering", "corners", "edges", "surface"]

_MODEL = None


def _load_model():
    global _MODEL
    if _MODEL is None:
        path = os.path.join(os.path.dirname(__file__), "grade_model.json")
        try:
            with open(path) as f:
                _MODEL = json.load(f)
        except Exception:
            _MODEL = {}
    return _MODEL


def aggregate_overall(pillars: dict):
    """pillars: {centering, corners, edges, surface} → overall 1–10 (or None)."""
    m = _load_model()
    weights = (m or {}).get("weights")
    if weights:
        g = m["intercept"]
        for k in PILLARS:
            v = pillars.get(k)
            if isinstance(v, (int, float)):
                g += weights[k] * v
        return max(1.0, min(10.0, round(g, 1)))
    vals = [v for v in pillars.values() if isinstance(v, (int, float))]
    return round(sum(vals) / len(vals), 1) if vals else None


def psa_label(score):
    if score is None:
        return None
    g = max(1, min(10, round(score)))
    return f"PSA {g} {PSA_NAMES.get(g, '')}".strip()


def merge_pillars(front: dict, back: dict) -> dict:
    """Worst-side-per-pillar across the two graded sides."""
    def score(r, k):
        return (r.get(k) or {}).get("score") if r else None
    out = {}
    for k in PILLARS:
        vals = [v for v in (score(front, k), score(back, k)) if isinstance(v, (int, float))]
        out[k] = min(vals) if vals else None
    return out
