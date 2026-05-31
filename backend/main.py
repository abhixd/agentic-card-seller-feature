"""
Card Grading API — FastAPI entry point.

Run with:
    uvicorn main:app --reload --port 8000

Endpoints:
    GET  /health
    GET  /user/usage
    POST /analyze-listing
    POST /analyze-images
    POST /grade           ← YOLO + Claude PSA grading (new)
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
import traceback
import numpy as np
import cv2
from fastapi import FastAPI, HTTPException, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

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


# ── /grade — YOLO + Claude PSA detailed grading ──────────────────────────
# Lazy import so the server starts even if ultralytics/anthropic are absent.
_grader_module = None

def _get_grader():
    global _grader_module
    if _grader_module is None:
        try:
            import grader as _g
            _grader_module = _g
        except ImportError as e:
            raise HTTPException(
                status_code=503,
                detail=f"Grading module not available: {e}. "
                       "Install: pip install anthropic ultralytics",
            )
    return _grader_module


@app.post("/grade")
async def grade_card_endpoint(
    image: UploadFile = File(..., description="Card image (JPEG, PNG, WebP)"),
):
    """
    Detailed PSA grading via YOLO OBB detection + Claude (Opus) vision.

    Returns JSON with keys:
        centering, corners, edges, surface, overall_score, psa_equivalent, summary
    """
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not configured")

    # Decode image
    try:
        raw = await image.read()
        arr = np.frombuffer(raw, dtype=np.uint8)
        img_bgr = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        if img_bgr is None:
            raise ValueError("Unsupported image format")
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Image decode error: {e}")

    # Run pipeline in thread pool (CPU-bound YOLO + Claude I/O)
    grader = _get_grader()
    loop   = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(
            None, grader.detect_and_grade, img_bgr, api_key
        )
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Grading error: {type(e).__name__}: {e}")

    # Strip large debug fields before sending to client
    strip = {"_raw", "_analytical_centering"}
    return JSONResponse({k: v for k, v in result.items() if k not in strip})
