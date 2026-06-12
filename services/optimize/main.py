"""
Card Seller OS — Optimization Microservice

Endpoints:
    POST /optimize/grading-submission   A1 — stochastic knapsack MIP
    POST /optimize/triage               A2 — assignment MIP
    POST /optimize/buy-basket           A3 — portfolio knapsack MIP
    POST /optimize/rebalance            A4 — constrained portfolio MIP
    POST /optimize/listing-price        B1 — continuous LP / EV
    POST /optimize/offer                B2 — EV rule-based

Each endpoint: build formulation (Module 1) → solve (Module 2) → decode → return.
"""

import os
import logging

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from models import (
    GradingSubmissionRequest, GradingSubmissionResponse,
    BulkTriageRequest,        BulkTriageResponse,
    BuyBasketRequest,         BuyBasketResponse,
    PortfolioRebalanceRequest, PortfolioRebalanceResponse,
    ListingPriceRequest,      ListingPriceResponse,
    OfferNegotiationRequest,  OfferNegotiationResponse,
)
from formulations import (
    grading_submission,
    bulk_triage,
    buy_basket,
    portfolio_rebalance,
    listing_price,
    offer_negotiation,
)

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(
    title       = "Card Seller OS — Optimization Service",
    description = "MIP/LP optimization engine for grading, buying, triage, and pricing decisions.",
    version     = "1.0.0",
)

ALLOWED_ORIGINS = os.getenv("ALLOWED_ORIGINS", "*").split(",")
app.add_middleware(
    CORSMiddleware,
    allow_origins  = ALLOWED_ORIGINS,
    allow_methods  = ["GET", "POST"],
    allow_headers  = ["*"],
)

# Optional shared secret — set OPTIMIZE_API_SECRET env var to restrict access
API_SECRET = os.getenv("OPTIMIZE_API_SECRET", "")


def _check_secret(secret: str) -> None:
    if API_SECRET and secret != API_SECRET:
        raise HTTPException(status_code=401, detail="Invalid API secret.")


# ── Health ─────────────────────────────────────────────────────────────────────

@app.get("/health")
def health():
    return {"status": "ok", "service": "optimize"}


# ── A1: Grading Submission ─────────────────────────────────────────────────────

@app.post("/optimize/grading-submission", response_model=GradingSubmissionResponse)
def optimize_grading_submission(req: GradingSubmissionRequest):
    """
    Selects which cards to submit for grading, which grader, and which tier
    to maximise expected net profit within budget and deadline constraints.
    """
    logger.info("grading-submission | %d cards | budget=$%.0f",
                len(req.cards), req.constraints.budget)
    return grading_submission.optimize(req)


# ── A2: Bulk Triage ────────────────────────────────────────────────────────────

@app.post("/optimize/triage", response_model=BulkTriageResponse)
def optimize_triage(req: BulkTriageRequest):
    """
    Assigns each card in a bulk lot to one of:
    list-individually, lot, grade, hold, or bulk-sell —
    maximising total net value within labor and grading budget.
    """
    logger.info("triage | %d cards | labor=%.1fh | grade_budget=$%.0f",
                len(req.cards), req.constraints.labor_hours_budget,
                req.constraints.grading_budget)
    return bulk_triage.optimize(req)


# ── A3: Buy Basket ─────────────────────────────────────────────────────────────

@app.post("/optimize/buy-basket", response_model=BuyBasketResponse)
def optimize_buy_basket(req: BuyBasketRequest):
    """
    Selects which cards to buy (and optionally grade) at a show or shop
    to maximise portfolio ROI within a capital budget.
    """
    logger.info("buy-basket | %d cards | budget=$%.0f | min_roi=%.0f%%",
                len(req.cards), req.constraints.capital_budget,
                req.constraints.min_roi_pct * 100)
    return buy_basket.optimize(req)


# ── A4: Portfolio Rebalance ────────────────────────────────────────────────────

@app.post("/optimize/rebalance", response_model=PortfolioRebalanceResponse)
def optimize_rebalance(req: PortfolioRebalanceRequest):
    """
    Recommends which holdings to sell to realise profit, reduce concentration,
    and improve liquidity within session constraints.
    """
    logger.info("rebalance | %d holdings", len(req.holdings))
    return portfolio_rebalance.optimize(req)


# ── B1: Listing Price ──────────────────────────────────────────────────────────

@app.post("/optimize/listing-price", response_model=ListingPriceResponse)
def optimize_listing_price(req: ListingPriceRequest):
    """
    Recommends Quick Sale / Fair Market / Stretch price bands using
    recency-weighted comp analysis and sell-through probability.
    """
    logger.info("listing-price | %s | %d comps | urgency=%s",
                req.card_name, len(req.comps),
                f"{req.urgency_days}d" if req.urgency_days else "none")
    return listing_price.optimize(req)


# ── B2: Offer Negotiation ──────────────────────────────────────────────────────

@app.post("/optimize/offer", response_model=OfferNegotiationResponse)
def optimize_offer(req: OfferNegotiationRequest):
    """
    Recommends accept, counter (with optimal counter price), or decline
    based on expected-value analysis of each outcome.
    """
    logger.info("offer | %s | list=$%.2f | offer=$%.2f | dom=%dd",
                req.card_name, req.list_price, req.offer_price, req.days_on_market)
    return offer_negotiation.optimize(req)
