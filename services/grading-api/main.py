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


def _grade_one(img_bgr, api_key: str = "", zoom: bool = False, raw_bytes: bytes | None = None,
               contour: list | None = None) -> dict:
    """Grade one card. GRADE_BACKEND=modal runs the WHOLE grade on Modal in one /fullgrade call (no warp bounce);
    otherwise the local detect_and_grade (which may still offload seg/detect to Modal). Identical return shape.
    raw_bytes = the ORIGINAL upload bytes, forwarded UNTOUCHED on the modal path — the previous decode→
    re-encode transcode measurably shifted the segmentation (see remote_grade.full_grade).
    contour = an optional MANUAL 4-corner boundary ([[x,y],...] in source px); when given, SAM3 is skipped and the
    grade runs on that boundary (Modal /gradecontour) — the user's override for an inaccurate auto-segmentation."""
    if os.environ.get("GRADE_BACKEND", "local").lower() == "modal":
        import remote_grade
        if contour:
            return remote_grade.grade_contour(img_bgr, contour, zoom, raw_bytes=raw_bytes)
        return remote_grade.full_grade(img_bgr, zoom, raw_bytes=raw_bytes)
    if contour:
        raise ValueError("Manual-boundary grading requires GRADE_BACKEND=modal")
    return _get_grader().detect_and_grade(img_bgr, api_key, zoom)

def _decode(raw: bytes):
    img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Unsupported image format")
    return img


# ── Stability probe (?stability=1): test–retest confidence for batch grading ──────────────────────────
# Grade the card a SECOND time on a label-preserving perturbation (resize 98% + JPEG q95 re-encode) and
# measure how far the centering read moves. The pipeline is deterministic on identical bytes, so any move
# is real sensitivity: Δ(margin shares) ≈ distance to the pipeline's decision boundary ≈ P(read error).
# Validated on 109 cards (2026-07-10): catches confidently-WRONG cards the existing confidence misses
# (card_017 sleeve: conf 0.944 but Δ=29pt — the majority side flips under a 2% resize; card_40 conf 0.976,
# Δ=24pt) while stable cards sit at Δ≈1pt. COMPLEMENTARY to the existing confidence (which catches
# stable-wrong cards like the sleeve-lip latch) → combine via MIN, never replace. Input-level perturbation
# only — contour-level jitter false-fires by toggling the crop-bypass outer logic on tight crops.

def _stability_probe_bytes(img_bgr):
    """The perturbed input: 98% resize + JPEG q95. Label-preserving (margin SHARES are scale-invariant)."""
    im2 = cv2.resize(img_bgr, None, fx=0.98, fy=0.98, interpolation=cv2.INTER_AREA)
    ok, buf = cv2.imencode(".jpg", im2, [int(cv2.IMWRITE_JPEG_QUALITY), 95])
    if not ok:
        raise ValueError("probe encode failed")
    return im2, buf.tobytes()


def _margin_shares(result: dict):
    """(L-share, T-share) in points from the content_region/_card_boundary FLOATS (the rounded '51/49'
    strings carry ±1pt quantization noise — never diff those)."""
    cb = result.get("_card_boundary")
    cr = (result.get("centering") or {}).get("content_region")
    if not cb or not cr:
        return None
    L = cr["x1"] - cb[0]; R = cb[2] - cr["x2"]; T = cr["y1"] - cb[1]; B = cb[3] - cr["y2"]
    if min(L, R, T, B) <= 0 or (L + R) <= 0 or (T + B) <= 0:
        return None
    return (L / (L + R) * 100.0, T / (T + B) * 100.0)


def _apply_stability(result: dict, probe: dict) -> None:
    """Attach centering.stability {delta_pts, confidence, probe_*} and demote centering.confidence via MIN.
    Non-fatal: if either read is unusable the block carries an error and confidence is left untouched."""
    cen = result.get("centering")
    if not isinstance(cen, dict):
        return
    a, b = _margin_shares(result), _margin_shares(probe)
    if a is None or b is None:
        cen["stability"] = {"delta_pts": None, "confidence": None, "error": "unreadable probe margins"}
        return
    # Like-for-like only: if the baseline and probe reads came from different methods (e.g. print
    # registration accepted on the original but fell back to the selector on the resized probe), the delta
    # measures METHOD disagreement, not test-retest fragility — report it but don't demote confidence.
    src_a = cen.get("_source"); src_b = (probe.get("centering") or {}).get("_source")
    d = max(abs(a[0] - b[0]), abs(a[1] - b[1]))
    if src_a != src_b:
        cen["stability"] = {"delta_pts": round(d, 2), "confidence": None,
                            "note": f"cross-method ({src_a} vs {src_b}) — delta not used for confidence"}
        return
    # Ramp calibrated on the 109-card probe run (clean ≈1pt, flippers 3–29pt), saturation re-tuned on user
    # feedback: saturating at 6 lumped a GOOD detection with a ±3pt wobble (card_025, Δ6.8 — boundaries
    # verified correct) together with catastrophic majority-side flippers (card_017 Δ29). Saturate at 15:
    # Δ6.8→0.68 (medium badge), Δ3.3→0.89, Δ≥15 (true flippers 24–29) still floored at 0.2.
    sconf = 1.0 if d <= 1.5 else (0.2 if d >= 15.0 else round(1.0 - (d - 1.5) / 13.5 * 0.8, 3))
    pc = probe.get("centering") or {}
    cen["stability"] = {"delta_pts": round(d, 2), "confidence": sconf,
                        "probe_left_right": pc.get("left_right"), "probe_top_bottom": pc.get("top_bottom")}
    old = cen.get("confidence")
    cen["confidence"] = sconf if old is None else round(min(float(old), sconf), 3)

FEEDBACK_DIR = _HERE / "feedback"


@app.post("/grade")
async def grade_card_endpoint(
    image: UploadFile = File(..., description="Front card image (JPEG, PNG, WebP)"),
    image_back: UploadFile = File(None, description="Optional back card image"),
    title:    str   = Form(""),
    price:    float = Form(0.0),
    shipping: float = Form(0.0),
    contour:  str   = Form(""),   # optional JSON [[x,y],...] MANUAL card outline in source px → skip SAM3, grade on it
    zoom:     int   = 0,          # query param: ?zoom=1 → attach high-res per-defect close-ups (pillar_zooms)
    stability: int  = 0,          # query param: ?stability=1 → grade a 2nd, perturbed copy (resize98+jpeg95) and
):                                #   report centering.stability {delta_pts, confidence}; confidence = MIN-combined.
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
        raw_front = await image.read()
        img_bgr = _decode(raw_front)                     # decode = validation + local-path input; the modal
    except Exception as e:                                # path forwards raw_front untouched (no transcode)
        raise HTTPException(status_code=400, detail=f"Image decode error: {e}")

    ct = None
    if contour:
        try:
            ct = json.loads(contour)
            assert isinstance(ct, list) and len(ct) >= 4 and all(len(p) == 2 for p in ct)
        except Exception:
            raise HTTPException(status_code=400, detail="contour must be JSON [[x,y],...] with >= 4 points")

    aggregator, grade_comps = _get_grade_mods()
    loop = asyncio.get_event_loop()
    # Stability probe (skipped for manual-contour grades — the human already intervened, and the contour's
    # source-pixel coordinates wouldn't survive the resize). Probe runs CONCURRENTLY with the baseline, so
    # the added latency is ~0 on the modal path.
    probe_task = None
    if stability and not ct:
        try:
            probe_img, probe_bytes = _stability_probe_bytes(img_bgr)
            probe_task = loop.run_in_executor(None, _grade_one, probe_img, api_key, False, probe_bytes, None)
        except Exception:
            probe_task = None
    # Print-registration (PRINT_REG=1): identity-anchored centering needs to know WHICH card this is.
    # /grade has no identify step normally, so under the flag we vision-ID concurrently with the grade.
    ident_task = None
    import print_registration as _preg
    if _preg.ENABLED and not ct:
        try:
            import identify as _identify
            ident_task = loop.run_in_executor(None, _identify.identify_card, img_bgr, api_key)
        except Exception:
            ident_task = None
    try:
        result = await loop.run_in_executor(None, _grade_one, img_bgr, api_key, bool(zoom), raw_front, ct)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Grading error: {type(e).__name__}: {e}")
    probe_res = None
    if probe_task is not None:
        try:
            probe_res = await probe_task
        except Exception as e:                            # non-fatal by construction
            cen = result.get("centering")
            if isinstance(cen, dict):
                cen["stability"] = {"delta_pts": None, "confidence": None,
                                    "error": f"probe failed: {type(e).__name__}"}
    if ident_task is not None:
        try:
            ident = await ident_task
            # Registration applies to the PROBE result too, so the stability delta measures the
            # registration read's test-retest (not selector-vs-registration disagreement).
            _preg.apply_to_result(result, ident)
            if probe_res is not None:
                _preg.apply_to_result(probe_res, ident)
        except Exception:
            pass
    if probe_res is not None:
        try:
            _apply_stability(result, probe_res)
        except Exception:
            pass

    # ── Optional back side → combined (worst-side) grade ──
    overall_for_econ = result.get("overall_score") or 0
    if image_back is not None:
        try:
            raw_back = await image_back.read()
            back_img = _decode(raw_back)
            back = await loop.run_in_executor(None, _grade_one, back_img, api_key, False, raw_back)
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
        raw_front = await image.read()
        img_bgr = _decode(raw_front)
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

    # ── grade — the SAME path as /grade (_grade_one → Modal when GRADE_BACKEND=modal, original bytes
    # forwarded) plus the stability probe, so a card scores and reports confidence IDENTICALLY whether it
    # comes through Scout batch or the grade page. (Previously scout graded locally on Railway with a
    # different seg backend → grades/confidence could disagree with /grade for the same image.) Scout IS
    # the batch-triage flow, so the test–retest probe is always on here.
    aggregator, grade_comps = _get_grade_mods()
    probe_task = None
    try:
        probe_img, probe_bytes = _stability_probe_bytes(img_bgr)
        probe_task = loop.run_in_executor(None, _grade_one, probe_img, api_key, False, probe_bytes, None)
    except Exception:
        probe_task = None
    try:
        result = await loop.run_in_executor(None, _grade_one, img_bgr, api_key, False, raw_front, None)
    except ValueError as e:
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Grading error: {type(e).__name__}: {e}")
    probe_res = None
    if probe_task is not None:
        try:
            probe_res = await probe_task
        except Exception:
            probe_res = None
    # Print-registration (PRINT_REG=1): scout already has the identity — anchor the centering on the
    # official render when the match passes the gate (applied to the probe too so Δ is like-for-like).
    try:
        import print_registration as _preg
        if _preg.ENABLED:
            _preg.apply_to_result(result, identity)
            if probe_res is not None:
                _preg.apply_to_result(probe_res, identity)
    except Exception:
        pass
    if probe_res is not None:
        try:
            _apply_stability(result, probe_res)
        except Exception:
            pass

    overall = result.get("overall_score") or 0
    confidence = result.get("_confidence") or ("low" if result.get("_truncated") else "high")

    # ── economics → EV / max-bid. Source priority (price_sources.lookup): Pokémon Price Tracker real PSA
    # SOLD comps (basis 'sold') > eBay graded asks (basis 'active') > pokemontcg raw + modeled (basis
    # 'raw+estimated', flagged "estimated") > NO DATA. ──
    economics = decision = comps_source = comps_basis = price_matched = price_confidence = None
    price_detail = None
    estimated = asking = False
    if identity.get("name"):
        try:
            import price_sources
            pr = price_sources.lookup(identity)
            dist = grade_comps.distribution_from_overall(overall)
            economics = grade_comps.compute_roi((ask or 0) + (shipping or 0), dist, pr["prices"])
            db = {"sold": "sold", "active": "active", "raw+estimated": "estimated"}.get(pr["basis"], "none")
            decision = grade_comps.compute_decision(
                economics, confidence, has_prices=(pr["basis"] != "none"), basis=db)
            comps_source, comps_basis = pr["source"], pr["basis"]
            price_matched, estimated, asking = pr["matched"], pr["estimated"], pr.get("asking", False)
            price_confidence = pr.get("confidence")
            price_detail = pr.get("detail")
        except Exception as e:
            traceback.print_exc()
            comps_source = f"error: {type(e).__name__}"

    return JSONResponse({
        "identity": {k: identity.get(k) for k in
                     ("name", "set", "number", "year", "variant", "language", "title", "confidence")},
        "identify_error": identity.get("error"),
        "grade": {"overall_score": overall, "psa_equivalent": result.get("psa_equivalent"),
                  "confidence": confidence, "tier_distribution": result.get("_tier_distribution"),
                  "summary": result.get("summary"), "border_type": result.get("_border_type")},
        # full per-pillar breakdown so the worklist can show "why this grade" on click (builds trust)
        "pillars": {k: result.get(k) for k in ("centering", "corners", "edges", "surface")},
        "card_boundary": result.get("_card_boundary"),   # outer card edge for the centering overlay
        "issues": result.get("issues"),
        "economics": economics, "decision": decision,
        "comps_source": comps_source, "comps_basis": comps_basis,
        "estimated": estimated, "asking": asking, "price_matched": price_matched,
        "price_confidence": price_confidence, "comps_detail": price_detail,
        "ask": ask, "shipping": shipping,
        "thumb_b64": result.get("_warped_jpeg_b64"),
        "pillar_visuals": result.get("pillar_visuals"),   # per-pillar overlays for click-to-inspect
    })


@app.get("/price-lookup")
async def price_lookup_endpoint(name: str, card_set: str = "", number: str = "", variant: str = ""):
    """Diagnostic: run the price feed for an identity (no image/grade) so the eBay/pokemontcg integration
    can be verified directly. Read-only public price data; reports whether the eBay token resolved."""
    import price_sources
    ident = {"name": name, "set": card_set or None, "number": number or None, "variant": variant or None}
    loop = asyncio.get_event_loop()
    try:
        res = await loop.run_in_executor(None, price_sources.lookup, ident)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"{type(e).__name__}: {e}")
    res["ebay_auth"] = await loop.run_in_executor(None, price_sources.ebay_auth_debug)
    if res["ebay_auth"].get("ok"):                            # token works → show the raw graded asks
        asks = await loop.run_in_executor(
            None, price_sources.ebay_graded_asks, name, card_set or None, number or None)
        res["ebay_asks_raw"] = asks
        res["ebay_asks_sane"] = price_sources._ebay_asks_sane(asks, res["prices"].get("raw")) if asks else None
    res["ppt_token_ok"] = bool(price_sources._ppt_token())   # lookup() above already used PPT if available
    res["ppt_last"] = dict(price_sources._PPT_LAST)           # why PPT did/didn't return data (status/count)
    return res


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
