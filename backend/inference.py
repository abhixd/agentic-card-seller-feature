"""
Inference engine: loads grade_mlp_best.pt + ConvNeXT backbone,
downloads listing images, extracts features, and returns grade predictions.

Ported from notebooks/06_inference.ipynb — kept in sync with
05_feature_model.ipynb feature extractor definitions.
"""
from __future__ import annotations

import pickle
import re
import urllib.request
import urllib.error
import tempfile
import os
from pathlib import Path
from typing import Optional

import cv2
import numpy as np
import torch
import torch.nn as nn
import torch.nn.functional as F

from schemas import (
    AnalyzeListingRequest,
    CardIdentity,
    GradeEstimate,
    ImageQuality,
)

CARD_H, CARD_W = 420, 300

BUCKET_TO_GRADES: list[tuple[int, int]] = [(1, 2), (3, 4), (5, 6), (7, 8), (9, 10)]

FEATURE_NAMES_BASE = [
    "corner_mean", "corner_TL", "corner_TR", "corner_BL", "corner_BR",
    "edge_mean", "edge_top", "edge_bottom", "edge_left", "edge_right",
    "surface_score", "scratch_density", "color_uniformity", "stain_score",
    "centering", "lr_ratio", "tb_ratio",
    "brightness", "contrast", "blur_score",
]

FEATURE_NAMES_EXT = [
    "ext_corner_white_mean", "ext_corner_white_TL", "ext_corner_white_TR",
    "ext_corner_white_BL", "ext_corner_white_BR",
    "ext_corner_round_mean", "ext_corner_round_TL", "ext_corner_round_TR",
    "ext_corner_round_BL", "ext_corner_round_BR",
    "ext_corner_entr_mean", "ext_corner_entr_TL", "ext_corner_entr_TR",
    "ext_corner_entr_BL", "ext_corner_entr_BR",
    "ext_edge_chip_mean", "ext_edge_chip_top", "ext_edge_chip_bot",
    "ext_edge_chip_left", "ext_edge_chip_right",
    "ext_edge_white_mean", "ext_edge_white_top", "ext_edge_white_bot",
    "ext_edge_white_left", "ext_edge_white_right",
    "ext_scratch_hough", "ext_scratch_count",
    "ext_print_line", "ext_fft_h_periodic", "ext_fft_v_periodic",
    "ext_glcm_homogeneity", "ext_glcm_energy", "ext_glcm_contrast", "ext_glcm_correlation",
    "ext_gabor_max", "ext_gabor_anisotropy",
    "ext_r_mean", "ext_g_mean", "ext_b_mean",
    "ext_r_std", "ext_g_std", "ext_b_std",
    "ext_sat_mean", "ext_sat_std", "ext_hue_std",
    "ext_bw_left", "ext_bw_right", "ext_bw_top", "ext_bw_bottom",
    "ext_aspect_dev", "ext_hf_ratio",
]

ALL_FEATURE_NAMES = FEATURE_NAMES_BASE + FEATURE_NAMES_EXT


# ── MLP architecture (mirrors 05_feature_model.ipynb) ────────────

class GradeMLP(nn.Module):
    def __init__(self, input_dim: int, num_classes: int = 5,
                 hidden_dims=(256, 128, 64), dropout: float = 0.4):
        super().__init__()
        layers, in_dim = [], input_dim
        for h in hidden_dims:
            layers += [nn.Linear(in_dim, h), nn.BatchNorm1d(h),
                       nn.ReLU(inplace=True), nn.Dropout(dropout)]
            in_dim = h
        layers.append(nn.Linear(in_dim, num_classes))
        self.net = nn.Sequential(*layers)

    def forward(self, x: torch.Tensor) -> torch.Tensor:
        return self.net(x)


# ── CV feature extraction (mirrors 05/06 notebooks) ─────────────

def _glcm(patch: np.ndarray, levels: int = 32) -> tuple[float, float, float, float]:
    q = np.clip((patch.astype(np.float32) / 8).astype(np.int32), 0, levels - 1)
    g = np.zeros((levels, levels), dtype=np.float32)
    g[q[:-1, :].ravel(), q[1:, :].ravel()] += 1
    g += g.T
    g /= g.sum() + 1e-10
    i, j = np.mgrid[0:levels, 0:levels]
    hom = float(np.sum(g / (1 + (i - j) ** 2)))
    ene = float(np.sqrt(np.sum(g ** 2)))
    con = float(np.sum(g * (i - j) ** 2))
    mi, mj = float(np.sum(i * g)), float(np.sum(j * g))
    si = float(np.sqrt(np.sum(g * (i - mi) ** 2) + 1e-10))
    sj = float(np.sqrt(np.sum(g * (j - mj) ** 2) + 1e-10))
    cor = float(np.sum(g * (i - mi) * (j - mj)) / (si * sj + 1e-10))
    return hom, ene, con, cor


def extract_cv_base(img: np.ndarray) -> np.ndarray:
    img = cv2.resize(img, (CARD_W, CARD_H))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV)
    h, w = gray.shape
    cs = max(20, h // 14)
    brd = max(8, h // 50)

    corners = [gray[:cs, :cs], gray[:cs, w - cs:],
               gray[h - cs:, :cs], gray[h - cs:, w - cs:]]
    cscores = [float(np.clip(cv2.Laplacian(p, cv2.CV_32F).var() / 500 * 100, 0, 100))
               for p in corners]

    strips = [gray[:brd, :], gray[h - brd:, :], gray[:, :brd], gray[:, w - brd:]]
    escores = []
    for s in strips:
        sob = cv2.Sobel(s.astype(np.float32), cv2.CV_32F, 1, 0, ksize=3)
        escores.append(float(np.clip(
            (1 - np.std(sob) / (np.mean(np.abs(sob)) + 1e-6) / 10) * 100, 0, 100)))

    inner = gray[brd * 2:h - brd * 2, brd * 2:w - brd * 2]
    diff = cv2.absdiff(inner, cv2.GaussianBlur(inner, (3, 3), 0))
    scratch_density = float(np.sum(diff > 15) / diff.size)
    surface_score = float(np.clip((1 - scratch_density * 20) * 100, 0, 100))
    color_unif = float(np.std(hsv[brd * 2:h - brd * 2, brd * 2:w - brd * 2, 2].astype(np.float32)))
    _, thr = cv2.threshold(inner, 30, 255, cv2.THRESH_BINARY_INV)
    cnts, _ = cv2.findContours(thr, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    stain_score = float(np.clip(100 - sum(1 for c in cnts if cv2.contourArea(c) > 100) * 5, 0, 100))

    col_proj = gray.mean(axis=0).astype(np.float32)
    row_proj = gray.mean(axis=1).astype(np.float32)
    tv = col_proj.mean() * 0.85

    def _bw(proj: np.ndarray, rev: bool = False) -> int:
        seq = proj[::-1] if rev else proj
        for i, v in enumerate(seq):
            if v > tv:
                return max(i, 1)
        return len(proj) // 4

    l, r, t, b = _bw(col_proj), _bw(col_proj, True), _bw(row_proj), _bw(row_proj, True)
    lr = min(l, r) / max(l, r) if max(l, r) > 0 else 1.0
    tb = min(t, b) / max(t, b) if max(t, b) > 0 else 1.0

    blur = float(np.clip(cv2.Laplacian(gray, cv2.CV_32F).var() / 1000 * 100, 0, 100))

    return np.array([
        float(np.mean(cscores)), *cscores,
        float(np.mean(escores)), *escores,
        surface_score, scratch_density * 100, color_unif, stain_score,
        (lr * 0.5 + tb * 0.5) * 100, lr * 100, tb * 100,
        float(gray.mean()), float(gray.std()), blur,
    ], dtype=np.float32)


def extract_cv_extended(img: np.ndarray) -> np.ndarray:
    img = cv2.resize(img, (CARD_W, CARD_H))
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    hsv = cv2.cvtColor(img, cv2.COLOR_BGR2HSV).astype(np.float32)
    h, w = gray.shape
    gray_f = gray.astype(np.float32)
    brd = max(8, h // 50)
    cs = max(20, h // 14)
    cy, cx, csz = h // 2, w // 2, max(20, h // 10)
    center_bright = float(gray_f[cy - csz:cy + csz, cx - csz:cx + csz].mean()) + 1e-6

    patches = [gray[:cs, :cs], gray[:cs, w - cs:],
               gray[h - cs:, :cs], gray[h - cs:, w - cs:]]

    cw = [float(np.clip(p.mean() / center_bright, 0, 3)) for p in patches]
    cr = []
    for p in patches:
        _, thr = cv2.threshold(p, 200, 255, cv2.THRESH_BINARY)
        cnts, _ = cv2.findContours(thr, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        cr.append(float(cv2.contourArea(max(cnts, key=cv2.contourArea)) / cs ** 2) if cnts else 0.0)
    ce = []
    for p in patches:
        hist = cv2.calcHist([p], [0], None, [32], [0, 256]).ravel()
        hist /= hist.sum() + 1e-6
        ce.append(-float(np.sum(hist * np.log2(hist + 1e-10))))

    strips = [gray[:brd * 2, :], gray[h - brd * 2:, :], gray[:, :brd * 2], gray[:, w - brd * 2:]]
    axes = [0, 0, 1, 1]
    chip = [float(np.clip(100 - np.sum(np.abs(np.diff(s.astype(np.float32).mean(axis=ax))) > 20) * 2, 0, 100))
            for s, ax in zip(strips, axes)]
    ewh = [float(np.clip(s.astype(np.float32).mean() / center_bright, 0, 3)) for s in strips]

    inner = gray[brd * 3:h - brd * 3, brd * 3:w - brd * 3]
    ec = cv2.Canny(inner, 30, 80)
    lines = cv2.HoughLinesP(ec, 1, np.pi / 180, 20, minLineLength=20, maxLineGap=5)
    sc = float(len(lines)) if lines is not None else 0.0

    fft = np.abs(np.fft.fftshift(np.fft.fft2(inner.astype(np.float32))))
    fy, fx = fft.shape[0] // 2, fft.shape[1] // 2
    fft[fy - 2:fy + 2, fx - 2:fx + 2] = 0
    hb = fft[fy - 20:fy + 20, :].max(axis=0)
    vb = fft[:, fx - 20:fx + 20].max(axis=1)
    hp = float(hb.max() / (hb.mean() + 1e-6))
    vp = float(vb.max() / (vb.mean() + 1e-6))

    gh, ge, gc, gcor = _glcm(inner)
    gr = [float(cv2.filter2D(inner.astype(np.float32), cv2.CV_32F,
                             cv2.getGaborKernel((15, 15), 3, t, 8, 0.5, 0)).mean())
          for t in (0, np.pi / 4, np.pi / 2, 3 * np.pi / 4)]

    b_ch, g_ch, r_ch = cv2.split(img)
    rm, gm, bm = r_ch.astype(np.float32).mean(), g_ch.astype(np.float32).mean(), b_ch.astype(np.float32).mean()
    rs, gs, bs = r_ch.astype(np.float32).std(), g_ch.astype(np.float32).std(), b_ch.astype(np.float32).std()
    sm, ss, hs = hsv[:, :, 1].mean(), hsv[:, :, 1].std(), hsv[:, :, 0].std()

    cp, rp, tv2 = gray_f.mean(axis=0), gray_f.mean(axis=1), gray_f.mean(axis=0).mean() * 0.85

    def _bw2(p: np.ndarray, rev: bool = False) -> float:
        seq = p[::-1] if rev else p
        for i, v in enumerate(seq):
            if v > tv2:
                return max(i, 1)
        return len(p) // 4

    bwl, bwr = _bw2(cp) / w, _bw2(cp, True) / w
    bwt, bwb = _bw2(rp) / h, _bw2(rp, True) / h
    hfr = float(np.abs(gray_f - cv2.GaussianBlur(gray_f, (15, 15), 0)).mean() / (gray_f.mean() + 1e-6))

    return np.array([
        float(np.mean(cw)), *cw,
        float(np.mean(cr)), *cr,
        float(np.mean(ce)), *ce,
        float(np.mean(chip)), *chip,
        float(np.mean(ewh)), *ewh,
        float(np.clip(100 - sc * 2, 0, 100)), sc,
        float(np.clip(100 - (max(hp, vp) - 1) * 2, 0, 100)), hp, vp,
        gh, ge, gc, gcor,
        float(max(gr)), float(np.var(gr)),
        float(rm), float(gm), float(bm),
        float(rs), float(gs), float(bs),
        float(sm), float(ss), float(hs),
        bwl, bwr, bwt, bwb,
        float(abs(w / h - 0.714)), hfr,
    ], dtype=np.float32)


# ── Issue detection from CV features ─────────────────────────────

def detect_issues(cv_feats: np.ndarray, feat_names: list[str]) -> list[str]:
    f = dict(zip(feat_names, cv_feats.tolist()))
    issues: list[str] = []

    # Corner whitening (most important PSA factor)
    if f.get("ext_corner_white_mean", 1.0) > 1.2:
        corners = [("ext_corner_white_TL", "top-left"), ("ext_corner_white_TR", "top-right"),
                   ("ext_corner_white_BL", "bottom-left"), ("ext_corner_white_BR", "bottom-right")]
        bad = [label for key, label in corners if f.get(key, 1.0) > 1.2]
        issues.append(f"{', '.join(bad)} corner whitening" if bad else "corner whitening")

    # Corner sharpness / wear
    if f.get("corner_mean", 100) < 20:
        issues.append("corner wear / soft corners")

    # Edge chipping
    if f.get("ext_edge_chip_mean", 100) < 70:
        edges = [("ext_edge_chip_top", "top"), ("ext_edge_chip_bot", "bottom"),
                 ("ext_edge_chip_left", "left"), ("ext_edge_chip_right", "right")]
        bad = [label for key, label in edges if f.get(key, 100) < 65]
        issues.append(f"{', '.join(bad)} edge chipping" if bad else "edge chipping")

    # Edge whitening
    if f.get("ext_edge_white_mean", 1.0) > 1.3:
        issues.append("edge whitening / wear")

    # Centering (from normalised border widths)
    bwl, bwr = f.get("ext_bw_left", 0.05), f.get("ext_bw_right", 0.05)
    bwt, bwb = f.get("ext_bw_top", 0.05), f.get("ext_bw_bottom", 0.05)
    if max(bwl, bwr) > 0:
        lr = min(bwl, bwr) / max(bwl, bwr)
        if lr < 0.75:
            issues.append("right-heavy centering" if bwr > bwl else "left-heavy centering")
    if max(bwt, bwb) > 0:
        tb = min(bwt, bwb) / max(bwt, bwb)
        if tb < 0.75:
            issues.append("bottom-heavy centering" if bwb > bwt else "top-heavy centering")

    # Surface scratches
    if f.get("ext_scratch_hough", 100) < 80 or f.get("scratch_density", 0) > 15:
        issues.append("surface scratches")

    # Surface staining
    if f.get("stain_score", 100) < 80:
        issues.append("surface staining")

    # Print line artifacts
    if f.get("ext_print_line", 100) < 70:
        issues.append("print line artifacts")

    # Image quality / blur (warn rather than deduct)
    if f.get("blur_score", 100) < 20:
        issues.append("low image sharpness (photo quality)")

    return issues


# ── Grade band + confidence helpers ──────────────────────────────

def probs_to_band(probs: np.ndarray) -> str:
    top = int(probs.argmax())
    second = int(np.argsort(probs)[-2])
    # Span two adjacent buckets if they together exceed 75%
    if abs(top - second) == 1 and probs[top] + probs[second] > 0.75:
        lo, hi = sorted([top, second])
        return f"PSA {BUCKET_TO_GRADES[lo][0]}-{BUCKET_TO_GRADES[hi][1]}"
    g1, g2 = BUCKET_TO_GRADES[top]
    return f"PSA {g1}-{g2}"


def probs_to_confidence(probs: np.ndarray) -> str:
    m = float(probs.max())
    if m >= 0.65:
        return "high"
    if m >= 0.40:
        return "medium"
    return "low"


def probs_to_distribution(probs: np.ndarray) -> dict[str, float]:
    dist: dict[str, float] = {}
    for bucket, (g1, g2) in enumerate(BUCKET_TO_GRADES):
        p = float(probs[bucket])
        dist[str(g1)] = round(p * 0.5, 3)
        dist[str(g2)] = round(p * 0.5, 3)
    return dist


# ── Card identity from eBay listing title ────────────────────────

_SETS = {
    "base set": "Base Set", "jungle": "Jungle", "fossil": "Fossil",
    "team rocket": "Team Rocket", "gym heroes": "Gym Heroes",
    "gym challenge": "Gym Challenge", "neo genesis": "Neo Genesis",
    "neo discovery": "Neo Discovery", "neo revelation": "Neo Revelation",
    "neo destiny": "Neo Destiny", "legendary collection": "Legendary Collection",
    "aquapolis": "Aquapolis", "skyridge": "Skyridge",
    "sword shield": "Sword & Shield", "sword & shield": "Sword & Shield",
    "scarlet violet": "Scarlet & Violet", "scarlet & violet": "Scarlet & Violet",
    "surging sparks": "Surging Sparks", "stellar crown": "Stellar Crown",
    "paldea evolved": "Paldea Evolved", "obsidian flames": "Obsidian Flames",
    "paradox rift": "Paradox Rift", "temporal forces": "Temporal Forces",
    "twilight masquerade": "Twilight Masquerade",
}


def parse_card_identity(title: str) -> CardIdentity:
    tl = title.lower()

    year_m = re.search(r"\b(19|20)\d{2}\b", title)
    year = year_m.group(0) if year_m else None

    num_m = re.search(r"#(\d+(?:/\d+)?)", title)
    card_num = num_m.group(1) if num_m else "—"

    detected_set = next((name for key, name in _SETS.items() if key in tl), "Unknown")

    # Strip noise to isolate card name
    clean = re.sub(r"\bpsa\s*\d+\b", "", title, flags=re.IGNORECASE)
    clean = re.sub(r"\b(raw|holo|reverse|1st edition|shadowless|unlimited|graded|mint|gem)\b",
                   "", clean, flags=re.IGNORECASE)
    clean = re.sub(r"\b(19|20)\d{2}\b", "", clean)
    clean = re.sub(r"#\d+(?:/\d+)?", "", clean)
    clean = re.sub(r"\bpokemon\s*(tcg|card|cards)?\b", "", clean, flags=re.IGNORECASE)
    for key in _SETS:
        clean = re.sub(re.escape(key), "", clean, flags=re.IGNORECASE)
    clean = re.sub(r"\s+", " ", clean).strip(" -,|")

    return CardIdentity(
        name=clean[:60] if clean else title[:60],
        set=detected_set,
        number=card_num,
        year=year,
    )


# ── Image download ────────────────────────────────────────────────

_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                  "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
}


def download_image(url: str) -> Optional[np.ndarray]:
    try:
        req = urllib.request.Request(url, headers=_HEADERS)
        with urllib.request.urlopen(req, timeout=10) as resp:
            data = resp.read()
        arr = np.frombuffer(data, dtype=np.uint8)
        img = cv2.imdecode(arr, cv2.IMREAD_COLOR)
        return img
    except Exception:
        return None


def assess_image_quality(image_urls: list[str],
                         imgs: list[Optional[np.ndarray]]) -> ImageQuality:
    loaded = [img for img in imgs if img is not None]
    if not loaded:
        return ImageQuality(status="insufficient",
                            warnings=["could not download any images"])

    warnings: list[str] = []
    if len(loaded) < 2:
        warnings.append("back image missing — confidence reduced")

    for img in loaded:
        h, w = img.shape[:2]
        if min(h, w) < 300:
            warnings.append(f"low resolution ({w}×{h}px) — analysis may be inaccurate")
            break

    # Glare check: high-brightness saturation in small region
    for img in loaded:
        gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        overexp = float(np.sum(gray > 245) / gray.size)
        if overexp > 0.05:
            warnings.append("potential glare / overexposure detected")
            break

    status = "poor" if any("low resolution" in w or "glare" in w for w in warnings) else "usable"
    return ImageQuality(status=status, warnings=warnings)


# ── Main inference engine ─────────────────────────────────────────

class InferenceEngine:
    def __init__(self, model_path: Path, cache_path: Path):
        self.device = torch.device(
            "cuda" if torch.cuda.is_available() else
            "mps" if torch.backends.mps.is_available() else "cpu"
        )
        self._load_model(model_path)
        self._load_normalizer(cache_path)
        self._load_backbone()
        print(f"[InferenceEngine] ready on {self.device}  "
              f"model={self.model_name}  val_acc={self.val_acc:.3f}")

    def _load_model(self, path: Path) -> None:
        ckpt = torch.load(path, map_location="cpu", weights_only=False)
        self.model_name: str = ckpt["model_name"]
        self.model_mode: str = ckpt["mode"]
        self.cv_mode: str = ckpt.get("cv_mode", "base")
        self.backbone_name: str = ckpt.get("backbone", "convnext_tiny.fb_in22k_ft_in1k")
        self.feat_names: list[str] = ckpt.get("feature_names", ALL_FEATURE_NAMES)
        self.val_acc: float = float(ckpt.get("val_acc", 0.0))

        self.mlp = GradeMLP(
            input_dim=ckpt["input_dim"],
            num_classes=ckpt["num_classes"],
            hidden_dims=ckpt["hidden_dims"],
            dropout=ckpt["dropout"],
        )
        self.mlp.load_state_dict(ckpt["model_state"])
        self.mlp = self.mlp.to(self.device).eval()

    def _load_normalizer(self, cache_path: Path) -> None:
        self.cv_mean = self.cv_std = None
        self.cnn_mean = self.cnn_std = None

        if not cache_path.exists():
            # Try to find any matching pkl
            for p in cache_path.parent.glob("*.pkl"):
                cache_path = p
                break

        if cache_path.exists():
            with open(cache_path, "rb") as f:
                cache = pickle.load(f)
            self.cv_mean = cache["cv_features"].mean(0, keepdims=True).astype(np.float32)
            self.cv_std = (cache["cv_features"].std(0, keepdims=True) + 1e-6).astype(np.float32)
            self.cnn_mean = cache["cnn_features"].mean(0, keepdims=True).astype(np.float32)
            self.cnn_std = (cache["cnn_features"].std(0, keepdims=True) + 1e-6).astype(np.float32)
            print(f"[InferenceEngine] normalizer loaded from {cache_path.name}")
        else:
            print("[InferenceEngine] WARNING: no feature cache found — skipping normalization")

    def _load_backbone(self) -> None:
        self.cnn_model = None
        self.cnn_transform = None

        if self.model_mode not in ("cnn", "combined"):
            return

        import timm
        from PIL import Image as _PIL  # noqa: F401 — ensure available

        self.cnn_model = timm.create_model(
            self.backbone_name, pretrained=True, num_classes=0
        )
        self.cnn_model = self.cnn_model.to(self.device).eval()
        for p in self.cnn_model.parameters():
            p.requires_grad = False

        data_cfg = timm.data.resolve_model_data_config(self.cnn_model)
        self.cnn_transform = timm.data.create_transform(**data_cfg, is_training=False)
        print(f"[InferenceEngine] backbone {self.backbone_name} loaded")

    def _norm(self, arr: np.ndarray, mean, std) -> np.ndarray:
        if mean is None:
            return arr
        return (arr - mean) / std

    def _extract_cv(self, img: np.ndarray) -> np.ndarray:
        base = extract_cv_base(img)
        if self.cv_mode == "ext":
            ext = extract_cv_extended(img)
            return np.concatenate([base, ext])
        return base

    def _extract_cnn(self, img: np.ndarray) -> np.ndarray:
        from PIL import Image as _PIL
        rgb = cv2.cvtColor(img, cv2.COLOR_BGR2RGB)
        pil = _PIL.fromarray(rgb)
        t = self.cnn_transform(pil).unsqueeze(0).to(self.device)
        with torch.no_grad():
            emb = self.cnn_model(t).squeeze(0).cpu().numpy()
        return emb.astype(np.float32)

    def _predict(self, cv_raw: np.ndarray,
                 cnn_raw: Optional[np.ndarray]) -> np.ndarray:
        cv_n = self._norm(cv_raw[None], self.cv_mean, self.cv_std).ravel()

        if self.model_mode == "cv":
            feat = cv_n
        elif self.model_mode == "cnn":
            feat = self._norm(cnn_raw[None], self.cnn_mean, self.cnn_std).ravel()
        else:
            feat = np.concatenate([
                cv_n,
                self._norm(cnn_raw[None], self.cnn_mean, self.cnn_std).ravel(),
            ])

        x = torch.tensor(feat, dtype=torch.float32).unsqueeze(0).to(self.device)
        with torch.no_grad():
            logits = self.mlp(x)
        return F.softmax(logits, dim=1).squeeze(0).cpu().numpy()

    # ── Public API ────────────────────────────────────────────────

    def analyze(self, req: AnalyzeListingRequest) -> dict:
        """
        Download images, run extraction + inference, return structured dict
        (without economics — added by main.py via CompsEngine).
        """
        # Download all images
        imgs = [download_image(url) for url in req.image_urls[:4]]  # cap at 4
        loaded = [img for img in imgs if img is not None]

        image_quality = assess_image_quality(req.image_urls, imgs)

        if not loaded:
            return self._low_confidence_response(req, image_quality,
                                                 reason="could not download any images")

        # Prefer the highest-resolution image for inference
        best_img = max(loaded, key=lambda im: im.shape[0] * im.shape[1])

        # Feature extraction
        cv_raw = self._extract_cv(best_img)
        cnn_raw = self._extract_cnn(best_img) if self.cnn_model else None

        # If low-confidence from image quality, still run but flag it
        probs = self._predict(cv_raw, cnn_raw)

        # Downgrade confidence if image quality is poor
        confidence = probs_to_confidence(probs)
        if image_quality.status == "poor":
            confidence = "low" if confidence == "medium" else confidence
        if image_quality.status == "insufficient":
            confidence = "low"

        issues = detect_issues(cv_raw, self.feat_names)

        return {
            "card_identity": parse_card_identity(req.title).model_dump(),
            "grade_estimate": GradeEstimate(
                band=probs_to_band(probs),
                confidence=confidence,
                distribution=probs_to_distribution(probs),
            ).model_dump(),
            "issues": issues,
            "image_quality": image_quality.model_dump(),
        }

    def _low_confidence_response(self, req: AnalyzeListingRequest,
                                 image_quality: ImageQuality,
                                 reason: str) -> dict:
        flat = {str(g): 0.1 for pair in BUCKET_TO_GRADES for g in pair}
        return {
            "card_identity": parse_card_identity(req.title).model_dump(),
            "grade_estimate": GradeEstimate(
                band="PSA ?",
                confidence="low",
                distribution=flat,
            ).model_dump(),
            "issues": [reason],
            "image_quality": image_quality.model_dump(),
        }
