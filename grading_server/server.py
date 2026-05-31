"""
server.py
=========
FastAPI server exposing the PSA card grading pipeline to the Chrome extension.

Endpoints:
  POST /grade     — accepts multipart image upload, returns grading JSON
  GET  /health    — liveness check
  GET  /config    — returns current model + YOLO config

Usage:
  python server.py
  # or
  uvicorn server:app --host 127.0.0.1 --port 8000 --reload
"""

import os
import io
import json
import time
import base64
import uuid
import traceback
from pathlib import Path

import cv2
import numpy as np
from fastapi import FastAPI, File, UploadFile, HTTPException, Form, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import uvicorn

from grader import detect_and_grade, MODEL, YOLO_WEIGHTS, YOLO_CONF
from comps import compute_economics
from aggregator import aggregate_overall, psa_label, merge_pillars, PILLARS

# Where boundary corrections are collected for YOLO retraining
FEEDBACK_DIR = Path(__file__).parent / "feedback"
FEEDBACK_IMG_DIR = FEEDBACK_DIR / "images"
FEEDBACK_JSONL = FEEDBACK_DIR / "adjustments.jsonl"

# ── App setup ─────────────────────────────────────────────────────────────────
app = FastAPI(
    title="PSA Card Grader API",
    description="YOLO + Claude vision grading pipeline for collectible cards",
    version="1.0.0",
)

# Allow Chrome extension (chrome-extension://*) and localhost origins
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],          # chrome-extension:// origins need wildcard
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# ── Helpers ───────────────────────────────────────────────────────────────────
def _decode_image(data: bytes) -> np.ndarray:
    """Decode raw image bytes (JPEG, PNG, WebP, etc.) to BGR numpy array."""
    arr = np.frombuffer(data, dtype=np.uint8)
    img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError("Could not decode image — unsupported format or corrupt data")
    return img


# ── Routes ────────────────────────────────────────────────────────────────────
@app.get("/health")
async def health():
    return {"status": "ok", "model": MODEL}


@app.get("/config")
async def config():
    return {
        "model":        MODEL,
        "yolo_weights": str(YOLO_WEIGHTS),
        "yolo_conf":    YOLO_CONF,
        "yolo_weights_exists": Path(YOLO_WEIGHTS).exists(),
        "api_key_set":  bool(os.environ.get("ANTHROPIC_API_KEY")),
    }


@app.post("/grade")
async def grade_endpoint(
    image: UploadFile = File(..., description="Front card image (JPEG, PNG, WebP)"),
    image_back: UploadFile = File(None, description="Optional back card image"),
    title:    str   = Form("", description="Listing title — used for eBay comps"),
    price:    float = Form(0.0, description="Listing price (USD)"),
    shipping: float = Form(0.0, description="Shipping cost (USD)"),
):
    """
    Grade a trading card image using the full YOLO + Claude pipeline.

    Returns the PSA grading JSON with keys:
      centering, corners, edges, surface, overall_score, psa_equivalent, summary

    When `title` (and ideally `price`) are provided, also attaches eBay sold-comps
    economics + a buy/maybe/skip decision:
      economics, decision, _comps_source
    """
    api_key = os.environ.get("ANTHROPIC_API_KEY", "")
    if not api_key:
        raise HTTPException(
            status_code=500,
            detail="ANTHROPIC_API_KEY not configured on the server"
        )

    try:
        raw_bytes = await image.read()
        img_bgr   = _decode_image(raw_bytes)
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Image decode error: {e}")

    try:
        result = detect_and_grade(img_bgr, api_key=api_key)
    except ValueError as e:
        # User-visible errors (no card detected, no API key, etc.)
        raise HTTPException(status_code=422, detail=str(e))
    except Exception as e:
        # Unexpected errors — log server-side, return 500
        traceback.print_exc()
        raise HTTPException(
            status_code=500,
            detail=f"Grading pipeline error: {type(e).__name__}: {e}"
        )

    # ── Optional back side: grade it and compute a combined (worst-side) grade ──
    overall_for_econ = result.get("overall_score") or 0
    if image_back is not None:
        try:
            back_bytes = await image_back.read()
            back_bgr   = _decode_image(back_bytes)
            back = detect_and_grade(back_bgr, api_key=api_key)
            # Drop heavy debug fields from the nested back result
            for k in ("_raw", "_analytical_centering"):
                back.pop(k, None)
            result["_back"] = back

            combined = merge_pillars(result, back)
            co = aggregate_overall(combined)
            result["_combined"] = {
                **{f"{k}_score": combined[k] for k in PILLARS},
                "overall_score":  co,
                "psa_equivalent": psa_label(co),
            }
            if co:
                overall_for_econ = co
        except ValueError:
            # No card detected on the back — keep front-only result.
            result["_back_error"] = "no card detected on back image"
        except Exception as e:
            traceback.print_exc()
            result["_back_error"] = f"{type(e).__name__}: {e}"

    # ── eBay comps + ROI + decision (non-fatal — grading still returns) ────────
    if title:
        try:
            confidence = "low" if result.get("_truncated") else "high"
            econ = compute_economics(
                title=title,
                price=price,
                shipping=shipping,
                overall_score=overall_for_econ,
                confidence=confidence,
            )
            result["economics"]     = econ["economics"]
            result["decision"]      = econ["decision"]
            result["_comps_source"] = econ["comps_source"]
            result["_comps_basis"]  = econ["comps_basis"]
        except Exception as e:
            traceback.print_exc()
            result["_comps_source"] = f"error: {type(e).__name__}"

    # Strip large private debug fields before sending to client
    strip_keys = {"_raw", "_analytical_centering"}
    clean = {k: v for k, v in result.items() if k not in strip_keys}
    return JSONResponse(content=clean)


@app.post("/feedback")
async def feedback_endpoint(request: Request):
    """
    Persist a user boundary correction for YOLO retraining.

    The corrected outer (card) boundary is YOLO's target; the stored warp context
    (`warp.quad_padded` + `warp.orig_dims`) lets `feedback_to_yolo.py` map the
    warped-space box back to original-image OBB labels. The warped JPEG is saved
    alongside for inspection. Appends one JSON line to feedback/adjustments.jsonl.
    """
    try:
        record = await request.json()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid JSON")

    FEEDBACK_IMG_DIR.mkdir(parents=True, exist_ok=True)
    rec_id = uuid.uuid4().hex[:12]
    record["id"] = rec_id
    record["server_ts"] = time.time()

    # Save the warped image to disk; keep the JSONL light by dropping the b64 blob.
    b64 = record.pop("warped_jpeg_b64", None)
    if b64:
        try:
            (FEEDBACK_IMG_DIR / f"{rec_id}.jpg").write_bytes(base64.b64decode(b64))
            record["warped_image"] = f"images/{rec_id}.jpg"
        except Exception as e:
            record["warped_image_error"] = str(e)

    try:
        with open(FEEDBACK_JSONL, "a") as f:
            f.write(json.dumps(record) + "\n")
    except Exception as e:
        traceback.print_exc()
        raise HTTPException(status_code=500, detail=f"Could not write feedback: {e}")

    return {"ok": True, "id": rec_id}


# ── Run ───────────────────────────────────────────────────────────────────────
if __name__ == "__main__":
    port = int(os.environ.get("PORT", 8000))
    print(f"Starting PSA Card Grader API on http://127.0.0.1:{port}")
    print(f"  Model        : {MODEL}")
    print(f"  YOLO weights : {YOLO_WEIGHTS}")
    print(f"  API key set  : {bool(os.environ.get('ANTHROPIC_API_KEY'))}")
    uvicorn.run("server:app", host="127.0.0.1", port=port, reload=False)
