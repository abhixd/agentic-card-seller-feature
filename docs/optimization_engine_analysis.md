# Optimization Engine Analysis
*Card Seller OS — May 2026*

---

## Executive Summary

This document cross-references the optimization use cases from `card_optimization_use_cases.docx` against what is already built in the Card Seller OS, identifies gaps, and proposes a comprehensive optimization engine architecture based on Mixed Integer Programming (MIP).

---

## What's Already Built vs. What the Doc Covers

| Use Case | Doc Priority | Already Built | Gap |
|---|---|---|---|
| Comp Selection & Weighting | Tier 1 | Price Intelligence Hub (TCGPlayer + eBay comps, recency, outlier filtering) | No confidence scoring or exclusion reason codes |
| Buy/Grade/Flip — single card | Tier 2 | Buy Price Calculator (`/tools/buy-price`) | Single card only, no basket selection |
| Grading Advisor — single card | Tier 1 | GradingAdvisor (PSA population, grade estimate, fee table) | No batch optimization, no budget constraint |
| Portfolio Dashboard | Tier 3 | ROI leaderboard, set breakdown on `/dashboard` | No rebalancing recommendations |
| Listing Price | Tier 1 | Not built | Full gap |
| Grading Submission (batch) | Tier 1 | Not built | Full gap |
| Bulk Inventory Triage | Tier 2 | Not built | Full gap |
| Marketplace Routing | Tier 3 | Not built | Full gap |
| Offer Negotiation | Tier 3 | Not built | Full gap |
| Portfolio Rebalancing | Tier 3 | Not built | Full gap |
| Photo Capture Optimization | Tier 3 | Not built | Full gap |

---

## Comprehensive Optimization Use Cases

### Group A — MIP-Native (Binary/Integer Decisions Under Constraints)

These map cleanly to Mixed Integer Programming.

#### A1. Grading Submission Optimizer

**Objective:** Maximize expected net value across all submitted cards after grading fees, shipping, insurance, marketplace fees, and time costs.

**Decision variables:** Submit/skip × grader × tier for each card. Binary variable `x[i,g,t] ∈ {0,1}` where i = card, g = grader, t = service tier.

**Constraints:**
- Total grading budget
- Turnaround deadline
- Minimum batch size per tier
- Shipping and insurance thresholds

**Inputs required:** Canonical card identity, raw and grade-specific comps, grade probability distribution per card, grader pricing and turnaround by tier, estimated seller net after sale, user budget and urgency.

**Formulation:** Stochastic knapsack / mixed-integer optimization.

**Output:** Ranked submission plan, expected-value summary, sensitivity to grade outcomes, reason each card made or missed the cut.

**MVP scope:** PSA-only, modern English Pokémon singles, budget + simple grade band (8/9/10).

---

#### A2. Bulk Inventory Triage

**Objective:** Maximize total net realized value minus labor and carrying costs.

**Decision variables:** Assign each card to one of {list-individually, lot, grade, hold, bulk-sell}. Binary variable `x[i,a] ∈ {0,1}` where i = card, a = action. Each card assigned to exactly one action.

**Constraints:**
- Labor hours available
- Grading budget
- Minimum margin threshold per card
- Lot size rules (by set/era/condition)
- Operational throughput

**Inputs required:** Per-card comps and liquidity, estimated time-to-list and time-to-sell, labor cost per workflow, grading ROI estimate, lotting eligibility rules.

**Formulation:** Mixed-integer assignment problem with labor and budget constraints; heuristic layer appropriate early on.

**Output:** Work queue — grade these, list individually, lot together, bulk out the rest — with total expected-value comparison against alternative strategies.

**MVP scope:** Triage dashboard for 100–500 scanned cards with configurable labor rate and simple buckets.

---

#### A3. Buy Basket Optimizer

*Extends the existing single-card Buy Price Calculator to multi-card basket selection.*

**Objective:** Maximize expected portfolio ROI across a basket of cards at a show or shop.

**Decision variables:**
- `x[i] ∈ {0,1}` — buy card i
- `g[i] ∈ {0,1}` — grade card i after buying (only if `x[i] = 1`)

**Constraints:**
- Total capital budget
- Maximum holding period per card
- Concentration limits (max exposure per set or card type)
- Minimum ROI threshold per card

**Inputs required:** Asking/negotiated price, estimated condition and grade probabilities, grade-specific resale comps, fees and grading costs, liquidity and sale velocity.

**Formulation:** Stochastic knapsack / portfolio selection.

**Output:** Ranked buy list with recommended max buy price, expected upside, and grade sensitivity per card. Total expected portfolio return vs. budget spent.

**MVP scope:** Basket selection from pre-scanned cards with fixed budget; expand grade sub-decision once grade probability model is trusted.

---

#### A4. Portfolio Rebalancing Optimizer

**Objective:** Maximize expected portfolio utility subject to risk, liquidity, and preference constraints.

**Decision variables:**
- `sell[i] ∈ {0,1}` — sell card i from current holdings
- `acquire[j] ∈ {0,1}` — acquire card j from opportunity set

**Constraints:**
- Total capital budget for acquisitions
- Max sell quantity per session
- Liquidity minimums (cannot sell illiquid cards in target window)
- Desired concentration limits by set/category
- Sentimental hold flags (user-defined, hard constraints)

**Inputs required:** Per-card valuations and volatility proxies, liquidity estimates, category and set correlations, user preference profile, realized vs. unrealized profit.

**Formulation:** Constrained portfolio optimization problem.

**Output:** Recommended sell-down, hold, and redeploy plan aligned to user's stated goals. Focus on concentration, liquidity, and profit realization rather than full financial portfolio theory for MVP.

**MVP scope:** Concentration and liquidity focus; flag overweight sets and underperforming holds.

---

### Group B — Revenue/Price Optimization (Continuous, Not MIP)

#### B1. Listing Price Optimizer

**Objective:** Maximize expected utility combining sale speed, expected net proceeds, and confidence of execution.

**Decision variables:** List price, auction vs. buy-it-now, offers enabled flag, timing.

**Constraints:** Desired sale window, minimum acceptable proceeds, marketplace fees, user urgency.

**Inputs required:** Trusted recent comps, marketplace fees, historical sell-through rate by price band, current active listings, condition and grade state.

**Formulation:** Revenue optimization using price-response curves and expected-value maximization under time constraints.

**Output:** Price ladder — Quick Sale / Fair Market / Stretch — with estimated days-to-sale range and net proceeds per option.

**MVP scope:** Fixed-price recommendations only using recent solds and price dispersion. Three price bands with liquidity-adjusted confidence.

---

#### B2. Offer Negotiation Advisor

**Objective:** Maximize expected net proceeds adjusted for probability of losing the buyer and user urgency.

**Decision variables:** Accept, counter at specific value, or reject.

**Constraints:** Minimum acceptable proceeds, sale urgency, card liquidity, platform offer mechanics.

**Inputs required:** Current list price, incoming offer value, recent comps, days on market, historical offer acceptance patterns.

**Formulation:** Sequential decision problem approximated with expected-value optimization and policy rules. EV(accept) vs EV(counter at X) vs EV(reject).

**Output:** Recommendation — accept now, counter at $X, or decline — with reasoning based on spread to comp and liquidity.

**MVP scope:** Rule-based EV recommendations driven by liquidity, spread to comp, and user urgency. Markov decision process once data accumulates.

---

#### B3. Marketplace Routing

**Objective:** Maximize expected net proceeds or sale probability by choosing the best channel or channel sequence.

**Decision variables:** Primary marketplace, cross-listing decision, sequencing.

**Constraints:** Platform fees and policy differences, operational overhead of cross-listing, inventory sync constraints, user's preferred selling flow.

**Inputs required:** Marketplace-specific fees, historical sale speed by venue, audience fit by category and card state, card value and liquidity.

**Formulation:** Routing/assignment optimization problem. Sequential decision problem in advanced versions.

**Output:** Simple recommendation — sell raw on platform A, sell graded on platform B, or cross-list with primary fallback order.

**MVP scope:** Advisory only. No automated cross-listing in first version.

---

### Group C — Data Quality (Foundational, Underpins Everything)

#### C1. Comp Confidence Scoring

**Objective:** Minimize pricing error while resisting outliers, mismatches, stale comps, and noisy listings.

**Decision variables:** Include/exclude each candidate comp, weight assigned to each accepted comp, recency decay and similarity thresholds.

**Constraints:** Minimum number of comps, recency windows, card and grade similarity requirements, thin-market fallback rules.

**Formulation:** Robust estimation and weighted subset-selection problem. Deterministic rules and confidence scoring first; learned weighting once labeled feedback accumulates.

**Output:** Comp set with confidence score, reason codes for exclusions, fair-market estimate and price bands.

**Status:** Partially built (Price Intelligence Hub). Missing: confidence score and exclusion reason codes.

---

#### C2. Grade Probability Estimation

**Objective:** Produce a reliable probability distribution over PSA grade outcomes (8/9/10) for each card prior to submission.

**Inputs:** PSA population data, image defect signals from scanner, card era and print run, historical submission outcomes for similar cards.

**Formulation:** Bayesian update from PSA population data plus image defect model. Required input to A1 (Grading Submission) and A3 (Buy Basket).

**Status:** Partially built (GradingAdvisor shows PSA pop data). Missing: calibrated probability model.

---

## Recommended Architecture

### Solver Microservice

Following the same pattern as the Prophet forecast microservice, the optimization engine runs as a dedicated Python microservice:

```
Next.js API → POST /api/optimize/[use-case]
           → Python microservice (PuLP + CBC or OR-Tools)
           → returns decision plan + sensitivity analysis
```

**Technology:**
- **PuLP** — clean MIP formulation, free CBC solver bundled, good for A1/A3/A4
- **OR-Tools** (Google) — faster, handles larger problems (500+ cards), better for A2
- **Deployment:** Railway or Render (same pattern as forecast service)

**API contract per use case:**
```
POST /optimize/grading-submission   → A1
POST /optimize/triage               → A2
POST /optimize/buy-basket           → A3
POST /optimize/rebalance            → A4
POST /optimize/listing-price        → B1
POST /optimize/offer                → B2
POST /optimize/routing              → B3
```

Each endpoint accepts a JSON payload with cards, constraints, and user preferences. Returns a decision plan, objective value, sensitivity ranges, and explanation strings.

---

## Build Order and Phasing

### Phase 1 — MIP Foundation
- **A1 Grading Submission Optimizer** (highest user value, clear economics)
- **A3 Buy Basket Optimizer** (extends existing Buy Calculator; natural next step)
- **C2 Grade Probability Model** (required input for A1 and A3)

### Phase 2 — Dealer Workflows
- **A2 Bulk Inventory Triage** (high value for shops and power sellers)
- **B1 Listing Price Optimizer** (completes the sell-side workflow)
- **C1 Comp Confidence Scoring** (improves quality of all price inputs)

### Phase 3 — Advanced Intelligence
- **A4 Portfolio Rebalancing**
- **B2 Offer Negotiation Advisor**
- **B3 Marketplace Routing**
- Photo Capture Optimization (sequential sensing, longer-term research item)

---

## Shared Data Requirements

All use cases depend on the same foundational data layer:

- Canonical card identity with exact variant and parallel resolution
- Trusted recent sales comps with visible inclusion/exclusion logic
- Raw-to-graded value linkage
- Liquidity and sale-velocity features by card and price band
- Seller fee models per marketplace
- Grading fee and turnaround models per grader and tier
- Grade probability distributions per card
- Image-quality and defect signals from scanner
- User constraints: budget, urgency, preferred marketplaces, risk tolerance

---

## Competitive Differentiation

| Tool | Layer |
|---|---|
| TCGPlayer | Scanning, inventory, pricing, listing workflows |
| Collectr | Portfolio tracking across raw, graded, sealed |
| PriceCharting | Sold-data-driven valuation |
| **Card Seller OS** | **Optimization — converts data into explicit action recommendations** |

The distinction: data products tell the user what happened. The optimization engine tells the user what to do next, under their specific constraints and goals.
