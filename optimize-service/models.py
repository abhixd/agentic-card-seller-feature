"""
Pydantic request and response schemas for all optimization use cases.

Each use case has:
  - A request model  (inputs from the Next.js API)
  - A response model (decision plan returned to the frontend)
"""

from __future__ import annotations
from enum import Enum
from typing import Optional
from pydantic import BaseModel, Field


# ── Shared enums ───────────────────────────────────────────────────────────────

class Grader(str, Enum):
    PSA   = "psa"
    BGS   = "bgs"
    CGC   = "cgc"

class GradingTier(str, Enum):
    ECONOMY    = "economy"     # ~$18, slowest
    STANDARD   = "standard"   # ~$25
    EXPRESS    = "express"     # ~$50
    WALKTHROUGH = "walkthrough" # ~$150, fastest

class TriageAction(str, Enum):
    LIST_INDIVIDUALLY = "list_individually"
    LOT               = "lot"
    GRADE             = "grade"
    HOLD              = "hold"
    BULK_SELL         = "bulk_sell"

class Platform(str, Enum):
    EBAY      = "ebay"
    TCGPLAYER = "tcgplayer"
    LOCAL     = "local"

class SolverBackend(str, Enum):
    HIGHS = "highs"
    CBC   = "cbc"


# ── Shared sub-models ──────────────────────────────────────────────────────────

class GradeDistribution(BaseModel):
    """Probability distribution over PSA grade outcomes for a single card."""
    grade_8:  float = Field(ge=0, le=1, description="P(PSA 8)")
    grade_9:  float = Field(ge=0, le=1, description="P(PSA 9)")
    grade_10: float = Field(ge=0, le=1, description="P(PSA 10)")

class GraderTierSpec(BaseModel):
    """Fee and turnaround for a specific grader + tier combination."""
    grader:       Grader
    tier:         GradingTier
    fee:          float  = Field(gt=0, description="Grading fee in USD")
    turnaround:   int    = Field(gt=0, description="Expected turnaround in days")
    min_batch:    int    = Field(default=1, ge=1, description="Minimum cards per submission")

class SolverOptions(BaseModel):
    backend:    SolverBackend = SolverBackend.CBC
    timeout_s:  int           = Field(default=30, ge=1, le=300)


# ── A1: Grading Submission Optimizer ──────────────────────────────────────────

class GradingCard(BaseModel):
    """A single card being evaluated for grading submission."""
    card_id:          str
    card_name:        str
    raw_value:        float  = Field(gt=0, description="Current raw (ungraded) market value USD")
    grade_probs:      GradeDistribution
    grade_8_value:    float  = Field(ge=0, description="Expected sale price if PSA 8 USD")
    grade_9_value:    float  = Field(ge=0, description="Expected sale price if PSA 9 USD")
    grade_10_value:   float  = Field(ge=0, description="Expected sale price if PSA 10 USD")
    marketplace_fee:  float  = Field(default=0.1325, ge=0, le=1, description="Fractional marketplace fee")
    shipping_cost:    float  = Field(default=0.0,   ge=0, description="Per-card share of shipping USD")

class GradingConstraints(BaseModel):
    budget:           float          = Field(gt=0, description="Total grading budget USD")
    deadline_days:    Optional[int]  = Field(default=None, ge=1, description="Max acceptable turnaround days")
    min_expected_roi: float          = Field(default=0.0, description="Min expected net gain per card USD to be eligible")

class GradingSubmissionRequest(BaseModel):
    cards:          list[GradingCard]
    grader_tiers:   list[GraderTierSpec]
    constraints:    GradingConstraints
    solver:         SolverOptions = SolverOptions()

class GradingDecision(BaseModel):
    card_id:        str
    card_name:      str
    submit:         bool
    grader:         Optional[Grader]       = None
    tier:           Optional[GradingTier]  = None
    fee:            Optional[float]        = None
    expected_value: float
    expected_profit: float
    reason:         str

class GradingSubmissionResponse(BaseModel):
    status:           str
    objective_value:  float   = Field(description="Total expected net profit across all submitted cards")
    total_fee:        float
    cards_submitted:  int
    decisions:        list[GradingDecision]
    solver_used:      str
    solve_time_ms:    float


# ── A2: Bulk Inventory Triage ─────────────────────────────────────────────────

class TriageCard(BaseModel):
    card_id:              str
    card_name:            str
    set_name:             str
    raw_value:            float  = Field(ge=0)
    liquidity_score:      float  = Field(ge=0, le=1,  description="0=illiquid, 1=very liquid")
    time_to_list_hrs:     float  = Field(ge=0,        description="Labor hours to photograph + list individually")
    time_to_lot_hrs:      float  = Field(ge=0,        description="Labor hours to add to a lot")
    grade_expected_profit: float = Field(description="Expected net profit if graded (can be negative)")
    bulk_value:           float  = Field(ge=0,        description="Bulk buylist or lot sale value")
    lot_eligible:         bool   = Field(default=True)
    grade_eligible:       bool   = Field(default=True)

class TriageConstraints(BaseModel):
    labor_hours_budget:  float  = Field(gt=0, description="Total labor hours available")
    grading_budget:      float  = Field(ge=0, description="Max spend on grading fees USD")
    min_list_margin:     float  = Field(default=0.15, description="Min net margin to list individually")
    hourly_labor_rate:   float  = Field(default=15.0, description="USD per labor hour (opportunity cost)")

class BulkTriageRequest(BaseModel):
    cards:       list[TriageCard]
    constraints: TriageConstraints
    solver:      SolverOptions = SolverOptions()

class TriageDecision(BaseModel):
    card_id:    str
    card_name:  str
    action:     TriageAction
    net_value:  float
    reason:     str

class BulkTriageResponse(BaseModel):
    status:          str
    objective_value: float
    decisions:       list[TriageDecision]
    summary:         dict[str, int]   = Field(description="Count per action")
    total_net_value: float
    solver_used:     str
    solve_time_ms:   float


# ── A3: Buy Basket Optimizer ──────────────────────────────────────────────────

class BuyCard(BaseModel):
    card_id:           str
    card_name:         str
    ask_price:         float  = Field(gt=0, description="Seller's asking price USD")
    raw_resale_value:  float  = Field(ge=0, description="Expected raw resale value USD")
    grade_probs:       Optional[GradeDistribution] = None
    grade_9_value:     float  = Field(default=0.0, ge=0)
    grade_10_value:    float  = Field(default=0.0, ge=0)
    grading_cost:      float  = Field(default=25.0, ge=0)
    marketplace_fee:   float  = Field(default=0.1325, ge=0, le=1)
    set_name:          str    = Field(default="")

class BuyConstraints(BaseModel):
    capital_budget:      float          = Field(gt=0, description="Total buying budget USD")
    min_roi_pct:         float          = Field(default=0.20, description="Minimum ROI to consider buying")
    max_per_set:         Optional[int]  = Field(default=None, description="Max cards from same set")
    max_holding_days:    Optional[int]  = Field(default=None)

class BuyBasketRequest(BaseModel):
    cards:       list[BuyCard]
    constraints: BuyConstraints
    solver:      SolverOptions = SolverOptions()

class BuyDecision(BaseModel):
    card_id:         str
    card_name:       str
    buy:             bool
    grade_after:     bool   = False
    ask_price:       float
    expected_return: float
    expected_roi:    float
    reason:          str

class BuyBasketResponse(BaseModel):
    status:           str
    objective_value:  float
    total_spend:      float
    total_expected_return: float
    portfolio_roi:    float
    decisions:        list[BuyDecision]
    solver_used:      str
    solve_time_ms:    float


# ── A4: Portfolio Rebalancing ──────────────────────────────────────────────────

class HoldingCard(BaseModel):
    card_id:          str
    card_name:        str
    set_name:         str
    cost_basis:       float  = Field(ge=0)
    current_value:    float  = Field(ge=0)
    liquidity_score:  float  = Field(ge=0, le=1)
    days_held:        int    = Field(ge=0)
    sentimental_hold: bool   = Field(default=False)

class RebalanceConstraints(BaseModel):
    max_sell_count:          Optional[int]   = Field(default=None)
    min_liquidity_to_sell:   float           = Field(default=0.3, description="Min liquidity score to be sell-eligible")
    max_concentration_pct:   float           = Field(default=0.30, description="Max portfolio weight per set")
    target_realize_profit:   Optional[float] = Field(default=None, description="Target profit to realize USD")

class PortfolioRebalanceRequest(BaseModel):
    holdings:    list[HoldingCard]
    constraints: RebalanceConstraints
    solver:      SolverOptions = SolverOptions()

class RebalanceDecision(BaseModel):
    card_id:       str
    card_name:     str
    action:        str   # "sell" | "hold"
    current_value: float
    cost_basis:    float
    profit:        float
    roi_pct:       float
    reason:        str

class PortfolioRebalanceResponse(BaseModel):
    status:               str
    cards_to_sell:        int
    cards_to_hold:        int
    total_realized_value: float
    total_realized_profit: float
    decisions:            list[RebalanceDecision]
    solver_used:          str
    solve_time_ms:        float


# ── B1: Listing Price Optimizer ────────────────────────────────────────────────

class PriceComp(BaseModel):
    sale_price:  float
    days_ago:    int
    condition:   str = "NM"

class ListingPriceRequest(BaseModel):
    card_id:         str
    card_name:       str
    condition:       str   = "NM"
    platform:        Platform = Platform.EBAY
    comps:           list[PriceComp]
    urgency_days:    Optional[int]  = Field(default=None, description="Must sell within N days")
    min_net:         Optional[float] = Field(default=None, description="Minimum acceptable net proceeds USD")
    marketplace_fee: float = Field(default=0.1325)
    shipping_cost:   float = Field(default=4.0)

class PriceBand(BaseModel):
    label:           str    # "Quick Sale" | "Fair Market" | "Stretch"
    list_price:      float
    net_proceeds:    float
    est_days_to_sell: Optional[float]
    confidence:      float  = Field(ge=0, le=1)

class ListingPriceResponse(BaseModel):
    status:       str
    card_name:    str
    comp_count:   int
    fair_value:   float
    bands:        list[PriceBand]
    reasoning:    str


# ── B2: Offer Negotiation ─────────────────────────────────────────────────────

class OfferNegotiationRequest(BaseModel):
    card_id:       str
    card_name:     str
    list_price:    float
    offer_price:   float
    fair_value:    float
    days_on_market: int
    urgency_days:  Optional[int]  = None
    min_net:       Optional[float] = None
    marketplace_fee: float = Field(default=0.1325)
    shipping_cost:   float = Field(default=4.0)

class OfferNegotiationResponse(BaseModel):
    status:         str
    recommendation: str    # "accept" | "counter" | "decline"
    counter_price:  Optional[float] = None
    net_if_accept:  float
    net_if_counter: Optional[float] = None
    ev_accept:      float
    ev_counter:     Optional[float] = None
    reasoning:      str
