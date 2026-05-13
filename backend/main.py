"""
Card Grading API — FastAPI entry point.

Run with:
    uvicorn main:app --reload --port 8000

Endpoints:
    GET  /api/health
    GET  /api/user/usage
    POST /api/analyze-listing
    POST /api/analyze-images
"""
from __future__ import annotations

import os
import sys
from contextlib import asynccontextmanager
from pathlib import Path

# Ensure local modules are importable when run from any cwd
sys.path.insert(0, str(Path(__file__).parent))

from dotenv import load_dotenv
load_dotenv()

import asyncio
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from schemas import (
    AnalyzeListingRequest,
    AnalyzeListingResponse,
    HealthResponse,
    UsageResponse,
)
from inference import InferenceEngine
from comps import compute_roi, compute_decision

# ── Config from environment (with sensible defaults) ─────────────
_HERE        = Path(__file__).parent
_PROJECT     = _HERE.parent

MODEL_PATH = Path(os.getenv(
    "MODEL_PATH",
    str(_PROJECT / "notebooks" / "grade_mlp_best.pt"),
))
CACHE_PATH = Path(os.getenv(
    "CACHE_PATH",
    str(_PROJECT / "notebooks" / "datasets" / "feature_cache" /
        "features_unified_ext_convnext_tiny_fb_in22k_ft_in1k.pkl"),
))

# ── App state ─────────────────────────────────────────────────────
engine: InferenceEngine | None = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global engine
    print(f"[startup] Loading model from {MODEL_PATH} ...")
    if not MODEL_PATH.exists():
        print(f"[startup] WARNING: model not found at {MODEL_PATH}")
        print("          Run 05_feature_model.ipynb through Step 10 first.")
    else:
        engine = InferenceEngine(model_path=MODEL_PATH, cache_path=CACHE_PATH)
    yield
    engine = None


# ── App ───────────────────────────────────────────────────────────
app = FastAPI(
    title="Card Grading API",
    description="Grade viability + ROI analysis for eBay Pokémon card listings.",
    version="0.1.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # tighten to extension origin in production
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Routes ────────────────────────────────────────────────────────

@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        model_loaded=engine is not None,
        model_name=engine.model_name if engine else None,
        model_val_acc=engine.val_acc if engine else None,
        backbone=engine.backbone_name if engine else None,
    )


@app.get("/user/usage", response_model=UsageResponse)
def usage() -> UsageResponse:
    # Stub — wire to Supabase/Postgres in v2
    return UsageResponse(analyses_today=0, limit=5, tier="free")


@app.post("/analyze-listing", response_model=AnalyzeListingResponse)
async def analyze_listing(req: AnalyzeListingRequest) -> AnalyzeListingResponse:
    if engine is None:
        raise HTTPException(
            status_code=503,
            detail="Model not loaded. Run 05_feature_model.ipynb first.",
        )

    loop = asyncio.get_event_loop()
    try:
        # Run CPU-bound inference in thread pool (keeps event loop free)
        result = await loop.run_in_executor(None, engine.analyze, req)
    except Exception as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc

    # Compute ROI using the grade distribution from inference
    listing_total = req.price + (req.shipping or 0.0)
    economics = compute_roi(
        title=req.title,
        listing_price=listing_total,
        grade_distribution=result["grade_estimate"]["distribution"],
    )
    decision = compute_decision(
        economics=economics,
        confidence=result["grade_estimate"]["confidence"],
    )

    return AnalyzeListingResponse(
        card_identity=result["card_identity"],
        grade_estimate=result["grade_estimate"],
        issues=result["issues"],
        image_quality=result["image_quality"],
        economics=economics,
        decision=decision,
    )


@app.post("/analyze-images", response_model=AnalyzeListingResponse)
async def analyze_images(req: AnalyzeListingRequest) -> AnalyzeListingResponse:
    """Alias for /analyze-listing — same contract, different semantic."""
    return await analyze_listing(req)


@app.post("/save-analysis")
async def save_analysis(body: dict) -> dict:
    # Stub — persist to Supabase in v2
    return {"saved": True, "id": "stub-id"}
