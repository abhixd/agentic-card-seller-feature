"""
Request / response Pydantic schemas matching the spec in
docs/ebay_card_grading_extension_spec.docx §12-13.
"""
from __future__ import annotations
from typing import Optional
from pydantic import BaseModel, Field


# ── Request ───────────────────────────────────────────────────────

class AnalyzeListingRequest(BaseModel):
    listing_url: Optional[str] = None
    title: str
    price: float
    shipping: Optional[float] = 0.0
    currency: Optional[str] = "USD"
    image_urls: list[str] = Field(..., min_length=1)
    marketplace: Optional[str] = "ebay"
    card_category: Optional[str] = "pokemon"


# ── Response sub-models ───────────────────────────────────────────

class CardIdentity(BaseModel):
    name: str
    set: str
    number: str
    year: Optional[str] = None


class GradeEstimate(BaseModel):
    band: str               # e.g. "PSA 7-8"
    confidence: str         # "high" | "medium" | "low"
    distribution: dict[str, float]  # {"7": 0.36, "8": 0.42, ...}


class ImageQuality(BaseModel):
    status: str             # "usable" | "poor" | "insufficient"
    warnings: list[str]


class Economics(BaseModel):
    listing_price: float
    grading_fee: float
    raw_estimate: Optional[float] = None
    psa8_estimate: Optional[float] = None
    psa9_estimate: Optional[float] = None
    psa10_estimate: Optional[float] = None
    max_buy_price_for_psa8_target: Optional[float] = None
    max_buy_price_for_psa9_target: Optional[float] = None
    expected_value: Optional[float] = None


class Decision(BaseModel):
    label: str              # "buy" | "maybe" | "skip"
    reason: str


# ── Top-level response ────────────────────────────────────────────

class AnalyzeListingResponse(BaseModel):
    card_identity: CardIdentity
    grade_estimate: GradeEstimate
    issues: list[str]
    image_quality: ImageQuality
    economics: Economics
    decision: Decision


# ── Health / usage ────────────────────────────────────────────────

class HealthResponse(BaseModel):
    status: str
    model_loaded: bool
    model_name: Optional[str] = None
    model_val_acc: Optional[float] = None
    backbone: Optional[str] = None


class UsageResponse(BaseModel):
    analyses_today: int
    limit: int
    tier: str
