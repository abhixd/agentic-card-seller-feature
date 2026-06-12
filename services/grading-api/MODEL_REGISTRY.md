# Card Detection Model Registry

The card **detector** (which finds the card boundary before warp → Claude grading) is
pluggable in `grader.py` via the `CARD_DETECTOR` env var: `yolo` | `seg` | `seg_then_yolo`.

This file records each detector so we can retrain / swap / A-B compare later.

---

## Detector A — YOLO OBB  (`CARD_DETECTOR=yolo`)  — **STANDBY**

The original, currently-deployed detector. Kept as the standby/fallback.

| Field | Value |
|---|---|
| Type | Custom-trained **YOLOv8 OBB** (oriented bounding box) |
| Output | 4 oriented corners → perspective warp |
| Weights | `backend/models/yolo_obb_best.pt` (bundled in the Docker image, ~5.5 MB) |
| Env | `YOLO_WEIGHTS` (default `/app/models/yolo_obb_best.pt`), `YOLO_CONF=0.25`, `YOLO_IMGSZ=640` |
| Trained by | `notebooks/train_yolo_obb.ipynb` (our own dataset, not Roboflow-hosted) |
| Eval | `notebooks/yolo_obb_eval.ipynb` |
| Confidence on our test imgs | 0.62–0.92 |
| Known weakness | Hard quad can clip the card's real rounded corners; sometimes locks onto the PSA slab label strip |
| Code path | `grader.py::_detect_yolo` |

**This is the version to retrain later and re-compare against Detector C.**

---

## Detector C — Roboflow segmentation workflow  (`CARD_DETECTOR=seg`)  — **NEW (primary)**

Instance-segmentation workflow hosted on Roboflow. Returns a dense pixel contour that
follows the true card outline including its real **rounded corners**. We low-pass smooth
the contour (corner-preserving) in `card_segmenter.py`.

| Field | Value |
|---|---|
| Provider | Roboflow (hosted serverless **Workflow**) |
| Workspace (`workspace_name`) | `srinivas-doddi` |
| Workflow id (`workflow_id`) | `general-segmentation-api-6` |
| Task | Instance segmentation (promptable via `classes` text input) |
| Inference endpoint | `POST https://serverless.roboflow.com/infer/workflows/srinivas-doddi/general-segmentation-api-6` |
| Request body | `{ "api_key": <key>, "inputs": { "image": {"type":"base64","value":<b64>}, "classes": "card" }, "use_cache": true }` |
| Output | `outputs[0].predictions.predictions[*].points` (polygon) + `confidence`, plus `outputs[0].annotated_image` |
| Classes prompt | `card` (env `SEG_CLASSES`; can add set names e.g. `"card, Ancient Origins, Aquapolis"`) |
| Confidence on our test imgs | ~0.83–0.86 |
| API key | env `ROBOFLOW_API_KEY` (server-side only — never commit the literal key; rotate the eval key before prod) |
| SDK note | `inference-sdk` is NOT installable here (caps at Python <3.13); we call the workflow via plain `requests` |
| Code path | `grader.py::_detect_seg` → `card_segmenter.segment_card` |

### Smoothing (`card_segmenter.py`)
- `smooth_contour(poly, n=400, sigma=2.5)` — resample to even spacing → circular Gaussian
  low-pass (numpy-only, no scipy). Removes jpeg-staircase wiggle, **keeps rounded corners**.
  `sigma` env: `SEG_SIGMA` (default 2.5; higher = rounder).
- `quad_from_contour(poly)` — adaptive `approxPolyDP`→4 corners (minAreaRect fallback);
  used only for the quad-based perspective warp / corner crops / centering.
- `grade_card(..., contour=)` returns `_card_contour_warped` (smoothed outline in warped
  normalised space, same frame as `card_boundary`/`content_region`) + `_card_contour_orig`.

### Env to enable on Railway
```
CARD_DETECTOR=seg_then_yolo     # seg primary, auto-fallback to YOLO if Roboflow fails
ROBOFLOW_API_KEY=<key>
# optional overrides: SEG_WORKSPACE, SEG_WORKFLOW, SEG_CLASSES, SEG_SIGMA, SEG_RESAMPLE_N
```

`seg_then_yolo` is recommended over `seg` so a Roboflow outage degrades to the bundled
YOLO detector instead of failing the grade.

---

## Comparison notebook
`notebooks/14_model_comparison.ipynb` — A (YOLO OBB) vs C (seg workflow), with the
corner-preserving smoothing demo (imports `backend/card_segmenter` so notebook + backend
stay in sync). Detector B (Roboflow `pokemon-card-detector-cuyon`) was evaluated and
**dropped** (~0.06 confidence, axis-aligned boxes only).
