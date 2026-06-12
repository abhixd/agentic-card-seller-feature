# Dockerfile — Python grading API for Railway
# Build context: this service dir (services/grading-api) — set the Railway service
# Root Directory to services/grading-api so these relative COPY paths resolve.

FROM python:3.11-slim

WORKDIR /app

# System deps required by OpenCV headless
RUN apt-get update && apt-get install -y --no-install-recommends \
    libglib2.0-0 libsm6 libxext6 libxrender1 libgomp1 libgl1 \
    && rm -rf /var/lib/apt/lists/*

# Install CPU-only PyTorch first — avoids pulling the 2 GB CUDA wheel.
# Unpinned so pip resolves a compatible torch/torchvision pair from the CPU index
# (the old 2.3.0+cpu pin was removed from the index). Pin later for reproducibility.
RUN pip install --no-cache-dir \
    torch torchvision \
    --index-url https://download.pytorch.org/whl/cpu

# Copy and install remaining deps (skip torch/torchvision — already installed)
COPY requirements.txt /tmp/requirements.txt
RUN grep -vE "^torch|^torchvision" /tmp/requirements.txt \
    | sed 's/opencv-python/opencv-python-headless/' \
    | pip install --no-cache-dir -r /dev/stdin

# Copy backend source
# Backend source: product API (main/inference/schemas/comps) + the grading
# pipeline (grader/aggregator/grade_comps/grade_model) used by /grade.
COPY main.py inference.py schemas.py comps.py \
     grader.py aggregator.py grade_comps.py \
     card_segmenter.py \
     cv_grader.py nonvlm_cv.py inner_frame.py \
     grade_model.json feedback_to_yolo.py ./

# Grading-only deploy. /grade defaults to the classical-CV backend (cv_grader +
# cv_xgb_raw.pkl); the YOLO weights stay for detection fallback and the Claude VLM
# path stays available behind GRADER_BACKEND=vlm. The MLP /analyze-listing path is
# NOT part of the Beta surface, so its artefacts are intentionally not bundled.
COPY models/yolo_obb_best.pt ./models/yolo_obb_best.pt
COPY models/cv_xgb_raw.pkl  ./models/cv_xgb_raw.pkl

# Default env — Railway overrides PORT at runtime
ENV YOLO_WEIGHTS=/app/models/yolo_obb_best.pt
# MODEL_PATH points at an absent file on purpose: the MLP /analyze-listing path
# stays disabled (lifespan tolerates it); /grade is unaffected.
ENV MODEL_PATH=/app/models/disabled-mlp.pt
ENV PYTHONUNBUFFERED=1
ENV PORT=8000

EXPOSE 8000

# Use shell form so Railway's $PORT is expanded at runtime
CMD uvicorn main:app --host 0.0.0.0 --port ${PORT}
