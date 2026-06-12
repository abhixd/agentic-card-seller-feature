# Dockerfile.grading — Python grading API for Railway
# Build context: repo root (so we can COPY model files from notebooks/)

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
COPY backend/requirements.txt /tmp/requirements.txt
RUN grep -vE "^torch|^torchvision" /tmp/requirements.txt \
    | sed 's/opencv-python/opencv-python-headless/' \
    | pip install --no-cache-dir -r /dev/stdin

# Copy backend source
# Backend source: product API (main/inference/schemas/comps) + the grading
# pipeline (grader/aggregator/grade_comps/grade_model) used by /grade.
COPY backend/main.py backend/inference.py backend/schemas.py backend/comps.py \
     backend/grader.py backend/aggregator.py backend/grade_comps.py \
     backend/card_segmenter.py \
     backend/cv_grader.py backend/nonvlm_cv.py backend/inner_frame.py \
     backend/grade_model.json backend/feedback_to_yolo.py ./

# Grading-only deploy. /grade defaults to the classical-CV backend (cv_grader +
# cv_xgb_raw.pkl); the YOLO weights stay for detection fallback and the Claude VLM
# path stays available behind GRADER_BACKEND=vlm. The MLP /analyze-listing path is
# NOT part of the Beta surface, so its artefacts are intentionally not bundled.
COPY backend/models/yolo_obb_best.pt ./models/yolo_obb_best.pt
COPY backend/models/cv_xgb_raw.pkl  ./models/cv_xgb_raw.pkl

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
