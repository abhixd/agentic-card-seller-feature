"""
grading_utils.py
================
Shared core functions for the card pre-grading notebooks.

Imported by all four notebooks:
    from grading_utils import *

Contents
--------
- Config constants (WEIGHTS, CARD_ASPECT_RATIO, PSA_LABELS, GRADE_COLORS)
- Data classes  (CenteringResult, CornerResult, EdgeResult, SurfaceResult, GradeReport)
- Card detection (order_points, four_point_transform, detect_card_contour,
                  detect_card_yolo, extract_card)
- Analyzers     (analyze_centering, analyze_corners, analyze_edges, analyze_surface)
- Grade math    (composite_to_psa, grade_card)
- Visualization (plot_report)
"""
import warnings
warnings.filterwarnings('ignore')

import cv2
import numpy as np
import matplotlib.pyplot as plt
import matplotlib.patches as patches
from matplotlib.gridspec import GridSpec
from PIL import Image
from pathlib import Path
from dataclasses import dataclass, field
from typing import Optional, Tuple, List
import warnings
warnings.filterwarnings('ignore')

# ── Display config ────────────────────────────────────────────────
plt.rcParams['figure.dpi'] = 120
plt.rcParams['axes.facecolor'] = '#0d1117'
plt.rcParams['figure.facecolor'] = '#0d1117'
plt.rcParams['text.color'] = 'white'
plt.rcParams['axes.labelcolor'] = 'white'
plt.rcParams['xtick.color'] = 'white'
plt.rcParams['ytick.color'] = 'white'

# ── Grading weights ───────────────────────────────────────────────
WEIGHTS = {
    'corners':   0.35,
    'centering': 0.25,
    'edges':     0.25,
    'surface':   0.15,
}

# Standard trading card dimensions (mm) — used only for aspect ratio check
CARD_ASPECT_RATIO = 88.0 / 63.0   # height / width ≈ 1.397
ASPECT_TOLERANCE  = 0.15           # allow ±15%

print('✅ Imports ready')

@dataclass
class CenteringResult:
    left_pct:   float   # left border as % of total width
    right_pct:  float
    top_pct:    float
    bottom_pct: float
    h_ratio:    float   # left/right (>1 = shifted right)
    v_ratio:    float   # top/bottom (>1 = shifted down)
    score:      float   # 0–100
    grade:      str


@dataclass
class CornerResult:
    scores:    List[float]   # TL, TR, BL, BR — each 0–100
    mean:      float
    worst:     float
    images:    List[np.ndarray] = field(default_factory=list)


@dataclass
class EdgeResult:
    scores:    List[float]   # top, right, bottom, left — each 0–100
    mean:      float
    worst:     float


@dataclass
class SurfaceResult:
    scratch_density: float   # 0–1
    gloss_variance:  float   # lower = more uniform surface
    defect_count:    int
    score:           float   # 0–100


@dataclass
class GradeReport:
    image_path:  str
    centering:   CenteringResult
    corners:     CornerResult
    edges:       EdgeResult
    surface:     SurfaceResult
    sub_scores:  dict        # per-dimension 0–100
    composite:   float       # weighted 0–100
    psa_estimate: float      # 1–10
    psa_label:   str         # e.g. "PSA 9 (Mint)"
    confidence:  str         # Low / Medium / High

print('✅ Data classes ready')

def order_points(pts: np.ndarray) -> np.ndarray:
    """Order 4 points as [TL, TR, BR, BL]."""
    rect = np.zeros((4, 2), dtype='float32')
    s = pts.sum(axis=1)
    rect[0] = pts[np.argmin(s)]   # TL — smallest sum
    rect[2] = pts[np.argmax(s)]   # BR — largest sum
    diff = np.diff(pts, axis=1)
    rect[1] = pts[np.argmin(diff)] # TR — smallest diff
    rect[3] = pts[np.argmax(diff)] # BL — largest diff
    return rect


def four_point_transform(image: np.ndarray, pts: np.ndarray) -> np.ndarray:
    """Perspective-warp image to a flat rectangle using 4 corner points."""
    rect = order_points(pts)
    (tl, tr, br, bl) = rect

    width_a  = np.linalg.norm(br - bl)
    width_b  = np.linalg.norm(tr - tl)
    max_w    = int(max(width_a, width_b))

    height_a = np.linalg.norm(tr - br)
    height_b = np.linalg.norm(tl - bl)
    max_h    = int(max(height_a, height_b))

    dst = np.array([
        [0, 0], [max_w - 1, 0],
        [max_w - 1, max_h - 1], [0, max_h - 1],
    ], dtype='float32')

    M    = cv2.getPerspectiveTransform(rect, dst)
    warp = cv2.warpPerspective(image, M, (max_w, max_h))
    return warp


def detect_card_contour(image: np.ndarray) -> Optional[np.ndarray]:
    """
    Find the card using edge detection + contour analysis.
    Returns 4-point numpy array (corners) or None.
    """
    h, w = image.shape[:2]
    gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)

    # ── Preprocessing ────────────────────────────────────────────
    blurred = cv2.GaussianBlur(gray, (5, 5), 0)
    # Adaptive threshold handles varying lighting
    thresh  = cv2.adaptiveThreshold(
        blurred, 255,
        cv2.ADAPTIVE_THRESH_GAUSSIAN_C,
        cv2.THRESH_BINARY_INV, 21, 10
    )
    # Also try Canny for cleaner edges
    edges   = cv2.Canny(blurred, 30, 120)
    combined = cv2.bitwise_or(thresh, edges)
    dilated  = cv2.dilate(combined, np.ones((3, 3), np.uint8), iterations=2)

    # ── Contour finding ───────────────────────────────────────────
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    contours = sorted(contours, key=cv2.contourArea, reverse=True)[:10]

    min_area = (w * h) * 0.05   # card must be at least 5% of image

    for cnt in contours:
        area = cv2.contourArea(cnt)
        if area < min_area:
            continue

        peri   = cv2.arcLength(cnt, True)
        approx = cv2.approxPolyDP(cnt, 0.02 * peri, True)

        if len(approx) == 4:
            pts = approx.reshape(4, 2).astype('float32')
            # Check aspect ratio
            rect    = order_points(pts)
            card_w  = np.linalg.norm(rect[1] - rect[0])
            card_h  = np.linalg.norm(rect[3] - rect[0])
            if card_w < 1:
                continue
            ratio = card_h / card_w
            # Accept portrait or landscape orientation
            if (abs(ratio - CARD_ASPECT_RATIO) < ASPECT_TOLERANCE or
                abs(ratio - 1/CARD_ASPECT_RATIO) < ASPECT_TOLERANCE):
                return pts

    return None


def detect_card_yolo(image: np.ndarray, model) -> Optional[np.ndarray]:
    """
    Use YOLOv8 segmentation to find the card.
    Falls back to bounding-box corners if no mask is returned.
    """
    results = model(image, verbose=False)
    if not results or results[0].masks is None:
        # Try bounding boxes
        if results and len(results[0].boxes) > 0:
            box = results[0].boxes[0].xyxy[0].cpu().numpy()
            x1, y1, x2, y2 = box
            return np.array([[x1,y1],[x2,y1],[x2,y2],[x1,y2]], dtype='float32')
        return None

    # Use largest mask
    masks = results[0].masks.xy
    if not masks:
        return None
    mask_pts = max(masks, key=lambda m: cv2.contourArea(m.astype(np.float32)))
    hull     = cv2.convexHull(mask_pts.astype(np.float32))
    peri     = cv2.arcLength(hull, True)
    approx   = cv2.approxPolyDP(hull, 0.02 * peri, True)
    if len(approx) == 4:
        return approx.reshape(4, 2).astype('float32')
    # Fit bounding rect of mask
    rect = cv2.minAreaRect(mask_pts.astype(np.float32))
    return cv2.boxPoints(rect).astype('float32')


def extract_card(
    image_path: str,
    yolo_model=None,
    target_h: int = 1000,
) -> Tuple[np.ndarray, np.ndarray, str]:
    """
    Load image, detect card, return (original_bgr, warped_bgr, method).
    If detection fails, crops to center 80% of image.
    """
    img = cv2.imread(str(image_path))
    if img is None:
        raise FileNotFoundError(f'Cannot load image: {image_path}')

    # Downscale for speed while keeping detection quality
    h, w = img.shape[:2]
    scale = min(1.0, 1200 / max(h, w))
    small = cv2.resize(img, (int(w*scale), int(h*scale)))

    corners = None
    method  = 'unknown'

    # 1. Try YOLOv8
    if yolo_model is not None:
        corners = detect_card_yolo(small, yolo_model)
        if corners is not None:
            corners = corners / scale   # scale back to full res
            method  = 'yolo'

    # 2. Fallback: contour
    if corners is None:
        corners = detect_card_contour(small)
        if corners is not None:
            corners = corners / scale
            method  = 'contour'

    # 3. Last resort: center crop
    if corners is None:
        pad_h, pad_w = int(h * 0.1), int(w * 0.1)
        warped = img[pad_h:h-pad_h, pad_w:w-pad_w]
        method = 'center_crop'
    else:
        warped = four_point_transform(img, corners)

    # Ensure portrait orientation
    wh, ww = warped.shape[:2]
    if ww > wh:
        warped = cv2.rotate(warped, cv2.ROTATE_90_CLOCKWISE)

    # Resize to standard height
    wh, ww = warped.shape[:2]
    new_w   = int(target_h * ww / wh)
    warped  = cv2.resize(warped, (new_w, target_h))

    return img, warped, method


print('✅ Card detection helpers ready')

def analyze_centering(card: np.ndarray, border_frac: float = 0.08) -> CenteringResult:
    """
    Measure the inner artwork border by scanning inward from each edge
    until hitting the artwork area.

    Strategy:
      - Convert to LAB color space
      - The card border is typically a uniform color (white, yellow, black)
      - Scan from each edge inward; detect first significant color change
    """
    h, w = card.shape[:2]
    lab   = cv2.cvtColor(card, cv2.COLOR_BGR2LAB)

    def find_border_width(strip: np.ndarray, from_start=True) -> int:
        """Scan 1D strip, return width of uniform region at one end."""
        n = len(strip)
        if n < 4:
            return 0
        ref = strip[0] if from_start else strip[-1]
        direction = range(n) if from_start else range(n-1, -1, -1)
        for i in direction:
            diff = float(np.linalg.norm(strip[i].astype(float) - ref.astype(float)))
            if diff > 18:   # color threshold
                return abs(i - (0 if from_start else n-1))
        return n // 4   # fallback: assume 25% border

    # Sample multiple column/row strips and take the median
    n_samples = 10

    # Left / right borders: scan horizontally along the card midpoint area
    row_samples = np.linspace(h * 0.3, h * 0.7, n_samples, dtype=int)
    left_widths  = [find_border_width(lab[r, :w//2, :], from_start=True)  for r in row_samples]
    right_widths = [find_border_width(lab[r, w//2:, :], from_start=False) for r in row_samples]
    left_w  = int(np.median(left_widths))
    right_w = int(np.median(right_widths))

    # Top / bottom borders
    col_samples = np.linspace(w * 0.3, w * 0.7, n_samples, dtype=int)
    top_widths    = [find_border_width(lab[:h//2, c, :], from_start=True)  for c in col_samples]
    bottom_widths = [find_border_width(lab[h//2:, c, :], from_start=False) for c in col_samples]
    top_h    = int(np.median(top_widths))
    bottom_h = int(np.median(bottom_widths))

    # Convert to percentages
    total_w = max(left_w + right_w, 1)
    total_h = max(top_h + bottom_h, 1)
    left_pct   = left_w   / total_w
    right_pct  = right_w  / total_w
    top_pct    = top_h    / total_h
    bottom_pct = bottom_h / total_h

    h_ratio = left_pct / right_pct  if right_pct > 0 else 1.0
    v_ratio = top_pct  / bottom_pct if bottom_pct > 0 else 1.0

    # Score: PSA centering standards
    # PSA 10: 55/45 front, 75/25 back
    # PSA 9:  60/40
    # PSA 8:  65/35
    def centering_score(ratio: float) -> float:
        """ratio = larger/smaller side (always >= 1). Returns 0-100."""
        r = max(ratio, 1/ratio)   # normalize to >= 1
        if r <= 1.10: return 100.0   # 55/45 — gem mint
        if r <= 1.22: return  90.0   # 55/45 — mint 9
        if r <= 1.40: return  80.0   # 58/42 — NM-MT 8
        if r <= 1.60: return  65.0   # 60/40
        if r <= 2.00: return  50.0   # 67/33
        if r <= 2.50: return  35.0   # 71/29
        if r <= 3.00: return  20.0
        return 10.0

    h_score = centering_score(h_ratio)
    v_score = centering_score(v_ratio)
    score   = (h_score + v_score) / 2

    # PSA grade label for centering
    r = max(max(h_ratio, 1/h_ratio), max(v_ratio, 1/v_ratio))
    grade = ('55/45' if r <= 1.22 else
             '60/40' if r <= 1.50 else
             '65/35' if r <= 1.86 else
             '70/30' if r <= 2.33 else '75/25+')

    return CenteringResult(
        left_pct=left_pct, right_pct=right_pct,
        top_pct=top_pct,   bottom_pct=bottom_pct,
        h_ratio=h_ratio,   v_ratio=v_ratio,
        score=score,       grade=grade,
    )

print('✅ Centering analyzer ready')

def analyze_corners(card: np.ndarray, corner_pct: float = 0.10) -> CornerResult:
    """
    Assess each corner for sharpness vs rounding/fraying.

    Metrics per corner:
      - Edge sharpness: Laplacian variance (high = sharp)
      - Corner acuteness: angle of the corner point detected by Harris
      - Fraying: high-frequency noise in the corner patch
    """
    h, w = card.shape[:2]
    ch   = int(h * corner_pct)
    cw   = int(w * corner_pct)

    # Extract the four corner patches
    corners_patches = [
        card[:ch,    :cw   ],   # TL
        card[:ch,    w-cw: ],   # TR
        card[h-ch:,  :cw   ],   # BL
        card[h-ch:,  w-cw: ],   # BR
    ]
    labels = ['TL', 'TR', 'BL', 'BR']

    scores = []
    corner_images = []

    for i, patch in enumerate(corners_patches):
        gray_p = cv2.cvtColor(patch, cv2.COLOR_BGR2GRAY)  # uint8

        # ── Sharpness via Laplacian ───────────────────────────────
        lap_var = cv2.Laplacian(gray_p, cv2.CV_32F).var()  # uint8→float32 (CV_64F breaks on float32 src in OpenCV 4.13)
        # A sharp corner has high variance (lots of edge energy)
        # Normalize: 0=no edges (rounded/worn), 100=very sharp
        sharpness = min(100.0, lap_var / 4.0)

        # ── Corner point detection via Harris ─────────────────────
        harris = cv2.cornerHarris(gray_p.astype(np.float32) / 255.0, blockSize=3, ksize=3, k=0.04)
        harris_norm = cv2.normalize(harris, None, 0, 255, cv2.NORM_MINMAX).astype(np.uint8)
        # Count strong corner responses — a worn corner has fewer
        strong_corners = np.sum(harris_norm > 200) / harris_norm.size
        corner_presence = min(100.0, strong_corners * 5000)

        # ── Fraying: high-freq noise at the very tip ──────────────
        # Detect white/light pixels straying into the corner tip
        # (fraying shows as white fibers against the card border color)
        # Take the innermost 20% of the corner patch
        tip_h = max(4, int(gray_p.shape[0] * 0.20))
        tip_w = max(4, int(gray_p.shape[1] * 0.20))
        # The actual corner tip position depends on which corner
        tips = {
            0: gray_p[-tip_h:, -tip_w:],   # TL → bottom-right of patch
            1: gray_p[-tip_h:,  :tip_w ],   # TR → bottom-left
            2: gray_p[ :tip_h,  -tip_w:],   # BL → top-right
            3: gray_p[ :tip_h,   :tip_w],   # BR → top-left
        }
        tip = tips[i]
        # High std of the tip relative to border color = fraying
        tip_std = tip.std()
        fray_penalty = min(30.0, tip_std * 0.5)

        # ── Composite corner score ────────────────────────────────
        raw = sharpness * 0.5 + corner_presence * 0.4
        score = max(0.0, min(100.0, raw - fray_penalty))
        scores.append(score)

        # Save annotated patch for visualization
        annotated = patch.copy()
        cv2.putText(annotated, f'{labels[i]} {score:.0f}',
                    (2, 12), cv2.FONT_HERSHEY_SIMPLEX, 0.4,
                    (0, 255, 0) if score > 70 else (0, 165, 255) if score > 40 else (0, 0, 255),
                    1, cv2.LINE_AA)
        corner_images.append(annotated)

    return CornerResult(
        scores=scores,
        mean=float(np.mean(scores)),
        worst=float(np.min(scores)),
        images=corner_images,
    )

print('✅ Corner analyzer ready')

def analyze_edges(card: np.ndarray, edge_pct: float = 0.05) -> EdgeResult:
    """
    Scan each edge strip for:
      - Chipping: localized brightness spikes (white paper showing)
      - Roughness: high variation along the edge
      - Dents: local dark depressions
    """
    h, w = card.shape[:2]
    ep_h = max(4, int(h * edge_pct))
    ep_w = max(4, int(w * edge_pct))

    # Edge strips: top, right, bottom, left
    strips = [
        card[:ep_h,      ep_w:w-ep_w],   # top
        card[ep_h:h-ep_h, w-ep_w:    ],  # right
        card[h-ep_h:,    ep_w:w-ep_w],   # bottom
        card[ep_h:h-ep_h, :ep_w      ],  # left
    ]

    scores = []
    for strip in strips:
        if strip.size == 0:
            scores.append(50.0)
            continue

        gray   = cv2.cvtColor(strip, cv2.COLOR_BGR2GRAY).astype(float)

        # ── Roughness: std along the innermost edge row/col ───────
        # High std = rough, chipped edge
        if strip.shape[0] >= strip.shape[1]:  # tall strip (left/right)
            edge_line = gray[:, 0]   # innermost column
        else:                                  # wide strip (top/bottom)
            edge_line = gray[0, :]   # innermost row

        roughness = edge_line.std()
        roughness_score = max(0.0, 100.0 - roughness * 2.0)

        # ── Chip detection: sudden bright spikes ──────────────────
        # Paper core shows as white when edge chips
        bright_threshold = np.percentile(gray, 85) + 20
        chip_pixels = np.sum(gray > min(bright_threshold, 240))
        chip_density = chip_pixels / gray.size
        chip_penalty = min(40.0, chip_density * 800)

        # ── Straightness: line fit residual ──────────────────────
        # A perfectly straight edge fits a line with low residual
        ys = np.arange(len(edge_line))
        if len(ys) > 2:
            coeffs   = np.polyfit(ys, edge_line, 1)
            residual = np.abs(edge_line - np.polyval(coeffs, ys)).mean()
            straightness = max(0.0, 100.0 - residual * 3.0)
        else:
            straightness = 80.0

        score = roughness_score * 0.45 + straightness * 0.35 - chip_penalty * 0.20
        scores.append(max(0.0, min(100.0, score)))

    return EdgeResult(
        scores=scores,
        mean=float(np.mean(scores)),
        worst=float(np.min(scores)),
    )

print('✅ Edge analyzer ready')

def analyze_surface(card: np.ndarray, border_pct: float = 0.12) -> SurfaceResult:
    """
    Detect scratches, print lines, and surface defects on the artwork area.

    Approach:
      - Crop to inner artwork (exclude border)
      - Detect linear scratch artifacts via Hough line transform
      - Measure surface gloss uniformity (scratches disrupt gloss)
      - Count blob defects (stains, print spots)
    """
    h, w = card.shape[:2]
    ph   = int(h * border_pct)
    pw   = int(w * border_pct)
    # Crop to artwork area only
    artwork = card[ph:h-ph, pw:w-pw]
    if artwork.size == 0:
        return SurfaceResult(0, 0, 0, 80.0)

    gray = cv2.cvtColor(artwork, cv2.COLOR_BGR2GRAY)

    # ── Scratch detection via Hough lines ─────────────────────────
    # Scratches appear as thin, straight, high-contrast lines
    edges = cv2.Canny(gray, 40, 120)
    lines = cv2.HoughLinesP(
        edges, rho=1, theta=np.pi/180,
        threshold=30, minLineLength=gray.shape[1]//6, maxLineGap=8
    )
    scratch_count = len(lines) if lines is not None else 0
    # Filter out card art lines (very horizontal/vertical in artwork are normal)
    if lines is not None:
        real_scratches = 0
        for line in lines:
            x1, y1, x2, y2 = line[0]
            angle = abs(np.degrees(np.arctan2(y2-y1, x2-x1)))
            # Diagonal lines (15–75°) are more likely scratches
            if 15 < angle < 75:
                real_scratches += 1
        scratch_count = real_scratches
    scratch_density = scratch_count / max(artwork.shape[0] * artwork.shape[1] / 10000, 1)

    # ── Gloss / surface uniformity ────────────────────────────────
    # Convert to HSV; V channel captures brightness uniformity
    hsv      = cv2.cvtColor(artwork, cv2.COLOR_BGR2HSV)
    v_chan   = hsv[:, :, 2].astype(float)
    # Use local standard deviation as a proxy for surface texture variation
    from scipy.ndimage import uniform_filter
    local_mean = uniform_filter(v_chan, size=15)
    local_var  = uniform_filter((v_chan - local_mean) ** 2, size=15)
    gloss_var  = float(np.mean(local_var))

    # ── Blob / stain detection ─────────────────────────────────────
    params = cv2.SimpleBlobDetector_Params()
    params.filterByArea    = True
    params.minArea         = 30
    params.maxArea         = gray.shape[0] * gray.shape[1] * 0.02
    params.filterByColor   = True
    params.blobColor       = 0       # dark blobs (stains, dirt)
    params.filterByCircularity = False
    detector    = cv2.SimpleBlobDetector_create(params)
    keypoints   = detector.detect(gray)
    defect_count = len(keypoints)

    # ── Composite score ───────────────────────────────────────────
    scratch_penalty = min(50.0, scratch_density * 25.0)
    gloss_penalty   = min(20.0, gloss_var / 100.0)
    defect_penalty  = min(30.0, defect_count * 3.0)

    score = max(0.0, 100.0 - scratch_penalty - gloss_penalty - defect_penalty)

    return SurfaceResult(
        scratch_density=scratch_density,
        gloss_variance=gloss_var,
        defect_count=defect_count,
        score=score,
    )

print('✅ Surface analyzer ready')

PSA_LABELS = {
    10: 'Gem Mint',
     9: 'Mint',
     8: 'Near Mint-Mint',
     7: 'Near Mint',
     6: 'Excellent-Mint',
     5: 'Excellent',
     4: 'Very Good-Excellent',
     3: 'Very Good',
     2: 'Good',
     1: 'Poor',
}

def composite_to_psa(composite: float, worst_corner: float) -> float:
    """
    Map 0-100 composite score to PSA 1-10.

    A single very bad corner can cap the grade (PSA is strict).
    """
    # Base grade from composite
    thresholds = [
        (95, 10.0), (88, 9.5), (82, 9.0),
        (75, 8.0),  (67, 7.0), (58, 6.0),
        (48, 5.0),  (38, 4.0), (28, 3.0),
        (18, 2.0),  (0,  1.0),
    ]
    grade = 1.0
    for threshold, g in thresholds:
        if composite >= threshold:
            grade = g
            break

    # Worst-corner cap: one ruined corner limits the overall grade
    # (mirrors PSA practice — one bad corner = can't be a 9)
    corner_cap = (
        10.0 if worst_corner > 85 else
         9.0 if worst_corner > 70 else
         8.0 if worst_corner > 55 else
         6.0 if worst_corner > 40 else
         4.0 if worst_corner > 25 else 2.0
    )
    grade = min(grade, corner_cap)

    # Snap to nearest integer grade (PSA doesn't give half-grades except 1.5)
    return round(max(1.0, min(10.0, grade)))


def grade_card(
    image_path: str,
    yolo_model=None,
) -> GradeReport:
    """
    Full pipeline: detect → deskew → analyze → grade.
    """
    _, card, method = extract_card(image_path, yolo_model)

    centering = analyze_centering(card)
    corners   = analyze_corners(card)
    edges     = analyze_edges(card)
    surface   = analyze_surface(card)

    # Corner score: blend mean and worst (worst matters more)
    corner_score = corners.mean * 0.4 + corners.worst * 0.6
    edge_score   = edges.mean   * 0.5 + edges.worst   * 0.5

    sub_scores = {
        'corners':   corner_score,
        'centering': centering.score,
        'edges':     edge_score,
        'surface':   surface.score,
    }

    composite = sum(sub_scores[k] * WEIGHTS[k] for k in WEIGHTS)
    psa_est   = composite_to_psa(composite, corners.worst)
    psa_int   = int(psa_est)
    psa_label = f'PSA {psa_int} ({PSA_LABELS[psa_int]})'

    # Confidence: low if detection method was fallback
    confidence = (
        'High'   if method in ('yolo', 'contour') else
        'Medium' if method == 'contour' else 'Low'
    )
    confidence = 'Low' if method == 'center_crop' else 'High'

    return GradeReport(
        image_path   = str(image_path),
        centering    = centering,
        corners      = corners,
        edges        = edges,
        surface      = surface,
        sub_scores   = sub_scores,
        composite    = composite,
        psa_estimate = psa_est,
        psa_label    = psa_label,
        confidence   = confidence,
    )

print('✅ Grade calculator ready')

GRADE_COLORS = {
    10: '#22c55e', 9: '#4ade80', 8: '#86efac',
     7: '#fbbf24', 6: '#fb923c', 5: '#f97316',
     4: '#ef4444', 3: '#dc2626', 2: '#b91c1c', 1: '#7f1d1d',
}

def plot_report(report: GradeReport, image_path: str):
    """Full visual dashboard for a single card grade report."""
    _, card, _ = extract_card(image_path)
    card_rgb   = cv2.cvtColor(card, cv2.COLOR_BGR2RGB)

    fig = plt.figure(figsize=(18, 11))
    fig.patch.set_facecolor('#0d1117')
    gs  = GridSpec(3, 5, figure=fig, hspace=0.5, wspace=0.4)

    grade_color = GRADE_COLORS.get(int(report.psa_estimate), '#888')

    # ── Card image ────────────────────────────────────────────────
    ax_card = fig.add_subplot(gs[:, 0])
    ax_card.imshow(card_rgb)
    ax_card.set_title(Path(image_path).name, color='white', fontsize=8, pad=4)
    ax_card.axis('off')

    # ── Grade badge ───────────────────────────────────────────────
    ax_grade = fig.add_subplot(gs[0, 1:3])
    ax_grade.set_facecolor('#161b22')
    ax_grade.text(0.5, 0.62, report.psa_label,
                  ha='center', va='center', fontsize=18, fontweight='bold',
                  color=grade_color, transform=ax_grade.transAxes)
    ax_grade.text(0.5, 0.25,
                  f'Composite: {report.composite:.1f}/100  ·  Confidence: {report.confidence}',
                  ha='center', va='center', fontsize=9, color='#8b949e',
                  transform=ax_grade.transAxes)
    ax_grade.set_xticks([]); ax_grade.set_yticks([])
    for spine in ax_grade.spines.values():
        spine.set_edgecolor(grade_color)
        spine.set_linewidth(2)

    # ── Sub-score bars ────────────────────────────────────────────
    ax_bars = fig.add_subplot(gs[0, 3:])
    ax_bars.set_facecolor('#161b22')
    dims   = ['Corners', 'Centering', 'Edges', 'Surface']
    keys   = ['corners', 'centering', 'edges', 'surface']
    vals   = [report.sub_scores[k] for k in keys]
    colors = ['#22c55e' if v >= 80 else '#fbbf24' if v >= 55 else '#ef4444' for v in vals]
    bars   = ax_bars.barh(dims, vals, color=colors, height=0.5)
    ax_bars.set_xlim(0, 100)
    ax_bars.set_xlabel('Score', color='white', fontsize=8)
    ax_bars.set_title('Sub-scores', color='white', fontsize=9)
    for bar, val in zip(bars, vals):
        ax_bars.text(bar.get_width() + 1, bar.get_y() + bar.get_height()/2,
                     f'{val:.0f}', va='center', color='white', fontsize=8)
    ax_bars.tick_params(colors='white')

    # ── Centering diagram ─────────────────────────────────────────
    ax_cen = fig.add_subplot(gs[1, 1:3])
    ax_cen.set_facecolor('#161b22')
    ax_cen.set_xlim(0, 1); ax_cen.set_ylim(0, 1)
    ax_cen.set_aspect('equal')
    ax_cen.set_title(f'Centering  ({report.centering.grade})', color='white', fontsize=9)
    c = report.centering
    # Outer border (full card)
    ax_cen.add_patch(patches.Rectangle((0.05, 0.05), 0.90, 0.90,
                      linewidth=1, edgecolor='#30363d', facecolor='#21262d'))
    # Inner artwork area
    x0 = 0.05 + c.left_pct  * 0.90
    y0 = 0.05 + c.top_pct   * 0.90
    x1 = 0.05 + (1 - c.right_pct)  * 0.90
    y1 = 0.05 + (1 - c.bottom_pct) * 0.90
    ax_cen.add_patch(patches.Rectangle(
        (x0, y0), x1-x0, y1-y0,
        linewidth=1.5,
        edgecolor='#22c55e' if c.score >= 80 else '#fbbf24' if c.score >= 55 else '#ef4444',
        facecolor='#1c3a2a' if c.score >= 80 else '#3a2e1c' if c.score >= 55 else '#3a1c1c',
    ))
    border_clr = '#8b949e'
    ax_cen.text(0.5, 0.01, f'L {c.left_pct:.0%}  R {c.right_pct:.0%}',
                ha='center', fontsize=7, color=border_clr, transform=ax_cen.transAxes)
    ax_cen.text(0.5, 0.96, f'T {c.top_pct:.0%}  B {c.bottom_pct:.0%}',
                ha='center', fontsize=7, color=border_clr, transform=ax_cen.transAxes)
    ax_cen.axis('off')

    # ── Corner patches ────────────────────────────────────────────
    corner_labels = ['TL', 'TR', 'BL', 'BR']
    corner_axes   = [
        fig.add_subplot(gs[2, 1]),
        fig.add_subplot(gs[2, 2]),
        fig.add_subplot(gs[2, 3]),
        fig.add_subplot(gs[2, 4]),
    ]
    for i, (ax_c, lbl, img, score) in enumerate(
        zip(corner_axes, corner_labels, report.corners.images, report.corners.scores)
    ):
        clr = '#22c55e' if score > 70 else '#fbbf24' if score > 40 else '#ef4444'
        ax_c.imshow(cv2.cvtColor(img, cv2.COLOR_BGR2RGB))
        ax_c.set_title(f'{lbl}  {score:.0f}', color=clr, fontsize=8)
        ax_c.axis('off')
        for spine in ax_c.spines.values():
            spine.set_edgecolor(clr)
            spine.set_linewidth(1.5)

    # ── Edge scores radar ─────────────────────────────────────────
    ax_edge = fig.add_subplot(gs[1, 3:])
    ax_edge.set_facecolor('#161b22')
    edge_lbls = ['Top', 'Right', 'Bottom', 'Left']
    edge_clrs = ['#22c55e' if s > 70 else '#fbbf24' if s > 40 else '#ef4444'
                 for s in report.edges.scores]
    ax_edge.bar(edge_lbls, report.edges.scores, color=edge_clrs)
    ax_edge.set_ylim(0, 100)
    ax_edge.set_title(f'Edges  (mean {report.edges.mean:.0f})', color='white', fontsize=9)
    ax_edge.tick_params(colors='white')
    for i, (lbl, val) in enumerate(zip(edge_lbls, report.edges.scores)):
        ax_edge.text(i, val + 2, f'{val:.0f}', ha='center', color='white', fontsize=8)

    # ── Surface metrics ───────────────────────────────────────────
    ax_surf = fig.add_subplot(gs[1, 1])
    ax_surf.set_facecolor('#161b22')
    surf = report.surface
    lines = [
        f"Score:    {surf.score:.0f}/100",
        f"Scratches: {surf.scratch_density:.2f}",
        f"Defects:   {surf.defect_count}",
        f"Gloss var: {surf.gloss_variance:.0f}",
    ]
    ax_surf.set_title('Surface', color='white', fontsize=9)
    for j, txt in enumerate(lines):
        clr = '#22c55e' if j == 0 and surf.score >= 80 else \
              '#fbbf24' if j == 0 and surf.score >= 55 else \
              '#ef4444' if j == 0 else '#8b949e'
        ax_surf.text(0.05, 0.82 - j*0.22, txt, transform=ax_surf.transAxes,
                     color=clr, fontsize=8)
    ax_surf.set_xticks([]); ax_surf.set_yticks([])

    fig.suptitle('Card Pre-Grading Report', color='white', fontsize=14, y=0.98)
    plt.tight_layout()
    plt.show()

print('✅ Visualization ready')