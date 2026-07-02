"""
local_rfdetr.py — self-hosted RF-DETR inference (NO Roboflow, no per-call cost, no 402s). Loads a fine-tuned
RF-DETR checkpoint and runs detection in-process on CPU. Validated at ~0.1-0.4 s/card depending on cores.

Why this is cheap on Railway: torch/torchvision/timm already ship in the grading image (Dockerfile.grading,
CPU wheels); this adds only `transformers` + the ~130 MB weights file. Lazy-loads + caches per checkpoint
(thread-safe), so the first call pays the load and the rest are warm.

  from local_rfdetr import get_model
  boxes = get_model(ckpt_dir).detect(warp_bgr, threshold=0.3)
  # -> [{"box": [x1,y1,x2,y2] px on the input image, "conf": float, "label": str}, ...]  (conf-desc)
"""
import os
import threading
import cv2
import torch

torch.set_num_threads(int(os.environ.get("RFDETR_THREADS", os.cpu_count() or 4)))
_LOCK = threading.Lock()
_CACHE: dict = {}


class LocalRFDETR:
    def __init__(self, ckpt_dir: str):
        self.ckpt = ckpt_dir
        self._proc = None
        self._model = None

    def _load(self):
        if self._model is not None:
            return
        with _LOCK:
            if self._model is not None:
                return
            from transformers import AutoModelForObjectDetection, AutoImageProcessor
            proc = AutoImageProcessor.from_pretrained(self.ckpt)
            model = AutoModelForObjectDetection.from_pretrained(self.ckpt)
            model.eval()
            # Use the GPU when one is present (e.g. the Modal L4 container); on CPU-only hosts (Railway) this
            # resolves to "cpu" and behaviour is unchanged.
            self._device = "cuda" if torch.cuda.is_available() else "cpu"
            model.to(self._device)
            self._proc, self._model = proc, model

    def detect(self, img_bgr, threshold: float = 0.3):
        """All detections on `img_bgr` (BGR). Boxes are pixel xyxy in the input image's own dimensions."""
        self._load()
        rgb = cv2.cvtColor(img_bgr, cv2.COLOR_BGR2RGB)
        inp = self._proc(images=rgb, return_tensors="pt").to(self._device)
        with torch.no_grad():
            out = self._model(**inp)
        res = self._proc.post_process_object_detection(
            out, threshold=threshold, target_sizes=[(img_bgr.shape[0], img_bgr.shape[1])])[0]
        id2label = self._model.config.id2label
        boxes = [
            {"box": [float(x) for x in b], "conf": float(s), "label": id2label.get(int(l), str(int(l)))}
            for b, s, l in zip(res["boxes"].tolist(), res["scores"].tolist(), res["labels"].tolist())
        ]
        return sorted(boxes, key=lambda d: -d["conf"])


def get_model(ckpt_dir: str) -> "LocalRFDETR":
    """Process-wide cached loader — one model instance per checkpoint dir."""
    with _LOCK:
        if ckpt_dir not in _CACHE:
            _CACHE[ckpt_dir] = LocalRFDETR(ckpt_dir)
    return _CACHE[ckpt_dir]
