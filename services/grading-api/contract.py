"""
contract.py — the STABLE PUBLIC contract for the grading service's /grade response.

This is the SOURCE OF TRUTH for the boundary between the two work streams:
  • grading stream (this service + research/) MUST keep /grade conforming to GradeResponse.
  • product stream (apps/web) consumes the generated types in packages/grading-contract.

Rules (see /CONTRACT.md):
  • Adding an OPTIONAL field is backwards-compatible → bump the PATCH/MINOR version.
  • Renaming/removing/retyping a field is BREAKING → bump MAJOR + update both streams in the same PR.
  • Internal/debug keys are `_`-prefixed and are NOT part of the contract (they pass through via
    `extra="allow"`); consumers must not depend on them.

After any change here: run `python export_openapi.py` to regenerate the committed schema.
"""
from __future__ import annotations
from typing import Optional, List, Dict, Any
from pydantic import BaseModel, ConfigDict, Field

CONTRACT_VERSION = "1.2.0"   # 1.2.0: + pillar_zooms (high-res defect close-ups, optional, additive)


class ContentRegion(BaseModel):
    """Inner-content bounds as fractions of the warped card (0..1)."""
    x1: float
    y1: float
    x2: float
    y2: float


class Centering(BaseModel):
    model_config = ConfigDict(extra="allow")          # _source and other debug keys pass through
    score: float                                       # 1..10 display score
    left_right: str = Field(examples=["49/51"])        # card-edge→inner-border ratio, L/R
    top_bottom: str = Field(examples=["60/40"])        # T/B
    reliable: bool                                     # detector self-report; superseded by `confidence`
    notes: str = ""
    content_region: Optional[ContentRegion] = None
    # NEW (fill-in pending on the grading side): 0..1 read reliability that accounts for faint card↔bg
    # contrast and thin borders — the product surfaces this as a centering confidence badge.
    confidence: Optional[float] = None


class Pillar(BaseModel):
    """Corners / edges / surface."""
    score: float                                       # 1..10 display score
    worst_severity: Optional[int] = None               # 0 none .. 4 heavy


class Issues(BaseModel):
    corners: List[str] = Field(default_factory=list)
    edges: List[str] = Field(default_factory=list)
    surface: List[str] = Field(default_factory=list)
    centering: List[str] = Field(default_factory=list)


class GradeResponse(BaseModel):
    model_config = ConfigDict(extra="allow")           # _-prefixed internal/visual keys flow through
    overall_score: Optional[float] = None              # 1..10
    psa_equivalent: Optional[str] = None               # e.g. "PSA 9 MINT"
    summary: Optional[str] = None
    centering: Centering
    corners: Pillar
    edges: Pillar
    surface: Pillar
    issues: Optional[Issues] = None
    confidence: Optional[str] = None                   # overall grade confidence: low | medium | high
    # per-pillar visual overlays (base64) for the product's click-to-inspect popups:
    #   {centering, edges, surface: <base64 jpeg>, corners: {TL,TR,BR,BL: <base64 jpeg>}}
    pillar_visuals: Optional[Dict[str, Any]] = None
    # high-res zoomed close-ups of detected problem areas (gated behind ?zoom=1) — for buyer verification:
    #   {edges:{side:{crop_b64,flagged[]}}, surface:{scratches:{crop_b64,count}}, corners:{TL,TR,BR,BL:<base64>}}
    pillar_zooms: Optional[Dict[str, Any]] = None
    economics: Optional[Dict[str, Any]] = None         # present when title/identity supplied (shape evolving)
    decision: Optional[Dict[str, Any]] = None
