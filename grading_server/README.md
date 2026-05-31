# PSA Card Grader — Local API Server

FastAPI server that exposes the YOLO + Claude grading pipeline to the Chrome extension.

## Setup

```bash
# Install dependencies (once)
pip install fastapi "uvicorn[standard]" python-multipart anthropic ultralytics opencv-python

# Set your Anthropic API key
export ANTHROPIC_API_KEY=sk-ant-...

# Start the server
./start.sh
# or directly:
python server.py
```

Server runs at **http://127.0.0.1:8000**

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/health` | Liveness check |
| GET | `/config` | Show model + YOLO config |
| POST | `/grade` | Grade a card image (multipart file upload) |
| POST | `/feedback` | Persist a user boundary correction → `feedback/adjustments.jsonl` |
| GET | `/docs` | Swagger UI |

## Stage-B aggregator (pillar scores → overall grade)

Stage A (YOLO → warp → Claude) produces the four pillar scores. Stage B combines
them into the overall PSA grade. A tiny **linear** model does this so it can also
run **client-side in the extension** — letting a manual boundary adjustment
recompute centering (geometry) and re-grade instantly, with no Claude call.

```bash
# Train on the existing eval table (Phase 1) → emits grade_model.json
#  and ../agentic-card-seller-os/extension/grade_model.js
python train_aggregator.py /path/to/df_psa_claude.pkl
```

Benchmark (92 rows, PSA 8/9/10): linear CV **MAE 0.70 / within-1 97.8%**, beating
Claude's own overall (0.92) and a weakest-link rule (1.20).

### Phase 2 — calibrated retrain (optional, costs ~186 Claude calls)

The Phase-1 table uses Claude's centering score; at inference we serve the
*geometric* one. To train on the served signal, regenerate with the current pipeline:

```bash
python regenerate_training_data.py            # writes df_psa_geometric.pkl
python train_aggregator.py df_psa_geometric.pkl
```

## Collecting corrections for YOLO retraining

When a user drags the green (card edge) / gold (content) boxes and clicks
**Apply adjustment**, the extension POSTs the correction to `/feedback`, appended to
`feedback/adjustments.jsonl` (+ the warped image under `feedback/images/`).

Convert collected corrections into YOLO OBB labels (maps the corrected outer box
back to the original image via the stored warp):

```bash
python feedback_to_yolo.py        # → feedback/yolo_dataset/{images,labels}/
```

## Dev / offline dependencies

`train_aggregator.py` and `regenerate_training_data.py` need `pandas` +
`scikit-learn` (not required to *serve* — the linear weights are baked into
`grade_model.js`). `feedback_to_yolo.py` needs `requests` (already a serve dep).

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ANTHROPIC_API_KEY` | *(required)* | Your Anthropic API key |
| `CLAUDE_MODEL` | `claude-sonnet-4-5` | Claude model to use |
| `YOLO_WEIGHTS` | `/opt/homebrew/runs/obb/.../best.pt` | Path to YOLO OBB weights |
| `YOLO_CONF` | `0.25` | YOLO detection confidence threshold |
| `PORT` | `8000` | Server port |
| `EBAY_APP_ID` | *(optional)* | eBay Finding API app id (production, not SBX). Enables comps + ROI. |
| `EBAY_FINDING_API_BASE_URL` | `https://svcs.ebay.com/.../FindingService/v1` | eBay Finding API endpoint |

## Comps + ROI

When the `/grade` request includes a `title` form field (and ideally `price` /
`shipping`), and `EBAY_APP_ID` is set, the response also includes:

- `economics` — raw / PSA 8 / 9 / 10 estimates, max-buy prices, expected value
- `decision`  — `{ "label": "buy|maybe|skip", "reason": "..." }`
- `_comps_source` — e.g. `ebay (37 sales)` or `none`

eBay failures are non-fatal — grading still returns, just without economics.

## Quick test

```bash
# Health check
curl http://127.0.0.1:8000/health

# Grade an image
curl -X POST http://127.0.0.1:8000/grade \
  -F "image=@/path/to/card.jpg" | python -m json.tool
```
