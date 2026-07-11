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

CONTRACT_VERSION = "1.6.0"   # 1.6.0: + optional centering.registration block (PRINT_REG print-registration, additive)
# 1.5.0: + optional ?stability=1 grade input → centering.stability block (additive)
# 1.4.0: + optional `contour` grade input (manual 4-corner boundary → skips SAM3, additive)
# 1.3.0: + defect_boxes (per-pillar defect outline rectangles, optional, additive)
# 1.2.0: + pillar_zooms (high-res defect close-ups, optional, additive)


class ContentRegion(BaseModel):
    """Inner-content bounds as fractions of the warped card (0..1)."""
    x1: float
    y1: float
    x2: float
    y2: float


class Registration(BaseModel):
    """Print-registration read (PRINT_REG=1): the identified card's official render is SIFT-registered
    against the die-cut warp; when accepted, left_right/top_bottom/content_region come from the registered
    print position (sub-pixel; solves full-arts with no detectable inner frame). accepted=False = the
    selector read was kept; this block then only explains why (reason)."""
    accepted: bool
    inliers: Optional[int] = None
    matches: Optional[int] = None
    resid_px: Optional[float] = None
    scale: Optional[float] = None
    ref_id: Optional[str] = None                       # matched pokemontcg.io card id, e.g. "sv3-22"
    reason: Optional[str] = None                       # why not accepted (gate / vintage / no match / ...)


class Stability(BaseModel):
    """Test–retest stability probe (?stability=1): the card is graded a second time on a label-preserving
    perturbation (98% resize + JPEG re-encode) and delta_pts is the largest centering margin-share move in
    points. Stable reads sit at ~1pt; fragile reads (faint sleeve edges) flip by 3–29pt while LOOKING
    confident. `confidence` is the 0..1 ramp of delta_pts, already MIN-combined into centering.confidence."""
    delta_pts: Optional[float] = None                  # None when the probe read was unusable (see error)
    confidence: Optional[float] = None
    probe_left_right: Optional[str] = None             # the perturbed read, for display/debugging
    probe_top_bottom: Optional[str] = None
    error: Optional[str] = None


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
    stability: Optional[Stability] = None              # present only when the grade was called ?stability=1
    registration: Optional[Registration] = None        # present only when PRINT_REG=1 and an identity resolved


class Pillar(BaseModel):
    """Corners / edges / surface."""
    score: float                                       # 1..10 display score
    worst_severity: Optional[int] = None               # 0 none .. 4 heavy


class Issues(BaseModel):
    corners: List[str] = Field(default_factory=list)
    edges: List[str] = Field(default_factory=list)
    surface: List[str] = Field(default_factory=list)
    centering: List[str] = Field(default_factory=list)


class Defect(BaseModel):
    """One detected defect: a bounding box [x, y, w, h] in FRACTIONS of the warped card (0..1, origin
    top-left) plus its classification. Producers: the Sonnet/Opus condition detector (all pillars) and the
    local RF-DETR scratch detector (surface). `extra=allow` so producer-specific keys pass through."""
    model_config = ConfigDict(extra="allow")
    area: Optional[str] = None                          # region, e.g. "top" / "TL" / "surface"
    type: Optional[str] = None                          # short label, e.g. "scratch" / "whitening"
    category: Optional[str] = None                      # artifact | trace | minor | heavy
    box: Optional[List[float]] = None                   # [x, y, w, h], fractions 0..1
    conf: Optional[float] = None                        # detector confidence (RF-DETR), when available


class DefectBoxes(BaseModel):
    """Per-pillar detected defects → outline rectangles drawn over the warped card."""
    edges: List[Defect] = Field(default_factory=list)
    corners: List[Defect] = Field(default_factory=list)
    surface: List[Defect] = Field(default_factory=list)


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
    # per-pillar detected defects (outline rectangles over the warped card); box = [x,y,w,h] fractions 0..1.
    # Sonnet backend fills all pillars (Opus detector); CV backend fills `surface` (local RF-DETR scratches).
    defect_boxes: Optional[DefectBoxes] = None
    economics: Optional[Dict[str, Any]] = None         # present when title/identity supplied (shape evolving)
    decision: Optional[Dict[str, Any]] = None
