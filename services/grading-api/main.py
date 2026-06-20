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
import json
import time
import base64
import uuid
import numpy as np
import cv2
from fastapi import FastAPI, HTTPException, File, UploadFile, Form, Request
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
    print(f"[startup] Loading MLP model from {MODEL_PATH} ...")
    if not MODEL_PATH.exists():
        print(f"[startup] MLP model not found at {MODEL_PATH} — /analyze-listing disabled; /grade still works.")
    else:
        # Don't let an MLP/cache load failure block startup — /grade (YOLO+Claude)
        # is independent of the InferenceEngine.
        try:
            engine = InferenceEngine(model_path=MODEL_PATH, cache_path=CACHE_PATH)
        except Exception as e:
            print(f"[startup] WARNING: MLP engine init failed ({type(e).__name__}: {e}); "
                  "/analyze-listing disabled, /grade still works.")
            engine = None
    try:                                  # warm the per-side selector → applies the deployed detector settings at boot
        import cv_grader
        cv_grader._perside_selector()
    except Exception as e:
        print(f"[startup] per-side warm skipped: {type(e).__name__}: {e}")
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


@app.post("/admin/train")
async def admin_train(req: Request):
    """Retrain the per-side centering selector from the bundled base + posted corrections.
    Report-only: returns the leave-one-card-out accuracy BEFORE vs AFTER (the model hot-swap is P2b).
    Auth: if ADMIN_TRAIN_TOKEN is set, the caller must send a matching X-Admin-Token header."""
    token = os.environ.get("ADMIN_TRAIN_TOKEN")
    if token and req.headers.get("x-admin-token") != token:
        raise HTTPException(status_code=401, detail="bad admin token")
    try:
        body = await req.json()
    except Exception:
        body = {}
    corrections = body.get("corrections") or []
    deploy = bool(body.get("deploy"))
    from trainer import retrain
    import asyncio
    try:                                   # offload to a worker thread — the Phase-1 search must not block
        r = await asyncio.get_event_loop().run_in_executor(None, retrain, corrections)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"train failed: {type(e).__name__}: {e}")
    sel = r.pop("selector", None)  # the fitted model isn't JSON-serialisable
    deployed = False
    if deploy and sel is not None:
        try:
            import cv_grader
            cv_grader.swap_perside_selector(sel, r.get("config"))   # model + Phase-1 detector settings go live together
            deployed = True
            import joblib, io, base64
            buf = io.BytesIO(); joblib.dump({"model": sel.model}, buf)
            r["model_b64"] = base64.b64encode(buf.getvalue()).decode()   # web persists this → durable across restarts
        except Exception as e:
            r["deploy_error"] = f"{type(e).__name__}: {e}"
    r["deployed"] = deployed
    return r   # r["config"] already carries the chosen detector settings (from retrain)


@app.post("/admin/reload-model")
async def admin_reload_model(req: Request):
    """Reload the live per-side model from the NEWEST model_artifacts row — used by revert
    (the web re-deploys a prior checkpoint as the new latest, then calls this)."""
    token = os.environ.get("ADMIN_TRAIN_TOKEN")
    if token and req.headers.get("x-admin-token") != token:
        raise HTTPException(status_code=401, detail="bad admin token")
    try:
        import model_store, joblib, io, per_side_selector as PS, cv_grader
        art = model_store.latest_artifact()
        if not art or not art.get("model"):
            raise HTTPException(status_code=404, detail="no stored model to reload")
        blob = joblib.load(io.BytesIO(art["model"]))
        sel = PS.PerSideSelector(); sel.model = blob["model"]
        cv_grader.swap_perside_selector(sel, art.get("config"))   # restore that checkpoint's detector settings too
        return {"reloaded": True}
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"reload failed: {type(e).__name__}: {e}")


@app.post("/admin/reset-baseline")
async def admin_reset_baseline(req: Request):
    """Swap the live model back to the ORIGINAL baked-in baseline + return it, so the web can record
    it as the new latest checkpoint. Always-available rollback, even after a single bad deploy."""
    token = os.environ.get("ADMIN_TRAIN_TOKEN")
    if token and req.headers.get("x-admin-token") != token:
        raise HTTPException(status_code=401, detail="bad admin token")
    try:
        import joblib, io, base64, cv_grader, per_side_selector as PS
        blob = cv_grader.baked_in_model_blob()
        sel = PS.PerSideSelector(); sel.model = blob["model"]
        PS.reset_detector_params()                          # baked-in baseline → default detector settings
        cv_grader.swap_perside_selector(sel)
        buf = io.BytesIO(); joblib.dump(blob, buf)
        return {"reset": True, "model_b64": base64.b64encode(buf.getvalue()).decode(), "config": PS.config_snapshot()}
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"reset failed: {type(e).__name__}: {e}")


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


# ── /grade — YOLO + Claude PSA detailed grading (front + optional back) ──────
# Lazy import so the server starts even if ultralytics/anthropic are absent.
_grader_module = None
_grade_mods = None  # (aggregator, grade_comps)

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

def _get_grade_mods():
    global _grade_mods
    if _grade_mods is None:
        import aggregator
        import grade_comps
        _grade_mods = (aggregator, grade_comps)
    return _grade_mods

_STRIP = {"_raw", "_analytical_centering"}

def _decode(raw: bytes):
    img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Unsupported image format")
    return img

FEEDBACK_DIR = _HERE / "feedback"


@app.post("/grade")
async def grade_card_endpoint(
    image: UploadFile = File(..., description="Front card image (JPEG, PNG, WebP)"),
    image_back: UploadFile = File(None, description="Optional back card image"),
    title:    str   = Form(""),
    price:    float = Form(0.0),
    shipping: float = Form(0.0),
):
    """
    Detailed PSA grading via YOLO OBB detection + Claude vision.

    Grades the front (and optional back) card image, combines worst-side-per-pillar
    via the Stage-B aggregator, and (when `title` is given) attaches eBay comps + ROI.
    Response keys: centering, corners, edges, surface, overall_score, psa_equivalent,
    summary, _warped_jpeg_b64, _corner_crops_b64, _combined, _back, economics, decision.
    """
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    if not api_key and os.getenv("GRADER_BACKEND", "cv").lower() == "vlm":
        raise HTTPException(status_code=500, detail="ANTHROPIC_API_KEY not configured (GRADER_BACKEND=vlm)")

    try:
        img_bgr = _decode(await image.read())
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Image decode error: {e}")

    grader = _get_grader()
    aggregator, grade_comps = _get_grade_mods()
    loop = asyncio.get_event_loop()
    try:
        result = await loop.run_in_executor(None, grader.detect_and_grade, img_bgr, api_key)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Grading error: {type(e).__name__}: {e}")

    # ── Optional back side → combined (worst-side) grade ──
    overall_for_econ = result.get("overall_score") or 0
    if image_back is not None:
        try:
            back_img = _decode(await image_back.read())
            back = await loop.run_in_executor(None, grader.detect_and_grade, back_img, api_key)
            for k in _STRIP:
                back.pop(k, None)
            result["_back"] = back
            combined = aggregator.merge_pillars(result, back)
            co = aggregator.aggregate_overall(combined)
            result["_combined"] = {
                **{f"{k}_score": combined[k] for k in aggregator.PILLARS},
                "overall_score":  co,
                "psa_equivalent": aggregator.psa_label(co),
            }
            if co:
                overall_for_econ = co
        except ValueError:
            result["_back_error"] = "no card detected on back image"
        except Exception as e:
            traceback.print_exc()
            result["_back_error"] = f"{type(e).__name__}: {e}"

    # ── eBay comps + ROI + decision (non-fatal) ──
    if title:
        try:
            confidence = "low" if result.get("_truncated") else "high"
            econ = grade_comps.compute_economics(
                title=title, price=price, shipping=shipping,
                overall_score=overall_for_econ, confidence=confidence,
            )
            result["economics"]     = econ["economics"]
            result["decision"]      = econ["decision"]
            result["_comps_source"] = econ["comps_source"]
            result["_comps_basis"]  = econ["comps_basis"]
        except Exception as e:
            traceback.print_exc()
            result["_comps_source"] = f"error: {type(e).__name__}"

    return JSONResponse({k: v for k, v in result.items() if k not in _STRIP})


@app.post("/scout")
async def scout_card(
    image:    UploadFile = File(..., description="One card photo (front)"),
    ask:      float = Form(0.0),     # asking price (optional → enables buy/pass against the max-bid)
    shipping: float = Form(0.0),
    title:    str   = Form(""),      # optional identity override; else Claude vision-ID
):
    """Sourcing scout, one card: identify → grade → economics. Compact result for the buy/pass worklist.
    Identity comes from Claude vision (a photo dump has no listing title); the economics reuse the same
    compute_economics() as /grade and degrade to NO DATA when comps are unavailable."""
    api_key = os.getenv("ANTHROPIC_API_KEY", "")
    try:
        img_bgr = _decode(await image.read())
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Image decode error: {e}")

    loop = asyncio.get_event_loop()
    # ── identify (vision) unless a title was supplied ──
    identity = {"title": title} if title else {}
    if not title:
        try:
            import identify as _identify
            identity = await loop.run_in_executor(None, _identify.identify_card, img_bgr, api_key)
        except Exception as e:
            identity = {"title": "", "error": f"{type(e).__name__}: {e}"}
    use_title = (identity.get("title") or title or "").strip()

    # ── grade (reuses the production grader) ──
    grader = _get_grader()
    aggregator, grade_comps = _get_grade_mods()
    try:
        result = await loop.run_in_executor(None, grader.detect_and_grade, img_bgr, api_key)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Grading error: {type(e).__name__}: {e}")

    overall = result.get("overall_score") or 0
    confidence = result.get("_confidence") or ("low" if result.get("_truncated") else "high")

    # ── economics (same path as /grade; NO DATA until a comp feed is wired) ──
    economics = decision = comps_source = comps_basis = None
    if use_title:
        try:
            econ = grade_comps.compute_economics(title=use_title, price=ask, shipping=shipping,
                                                 overall_score=overall, confidence=confidence)
            economics, decision = econ["economics"], econ["decision"]
            comps_source, comps_basis = econ["comps_source"], econ["comps_basis"]
        except Exception as e:
            comps_source = f"error: {type(e).__name__}"

    return JSONResponse({
        "identity": {k: identity.get(k) for k in
                     ("name", "set", "number", "year", "variant", "language", "title", "confidence")},
        "identify_error": identity.get("error"),
        "grade": {"overall_score": overall, "psa_equivalent": result.get("psa_equivalent"),
                  "confidence": confidence, "tier_distribution": result.get("_tier_distribution")},
        "economics": economics, "decision": decision,
        "comps_source": comps_source, "comps_basis": comps_basis,
        "ask": ask, "shipping": shipping,
        "thumb_b64": result.get("_warped_jpeg_b64"),
    })


@app.post("/feedback")
async def feedback_endpoint(request: Request):
    """Persist a user boundary correction for YOLO retraining (see feedback_to_yolo.py)."""
    try:
        record = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    img_dir = FEEDBACK_DIR / "images"
    img_dir.mkdir(parents=True, exist_ok=True)
    rec_id = uuid.uuid4().hex[:12]
    record["id"] = rec_id
    record["server_ts"] = time.time()

    b64 = record.pop("warped_jpeg_b64", None)
    if b64:
        try:
            (img_dir / f"{rec_id}.jpg").write_bytes(base64.b64decode(b64))
            record["warped_image"] = f"images/{rec_id}.jpg"
        except Exception as e:
            record["warped_image_error"] = str(e)

    try:
        with open(FEEDBACK_DIR / "adjustments.jsonl", "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Could not write feedback: {e}")
    return {"ok": True, "id": rec_id}
