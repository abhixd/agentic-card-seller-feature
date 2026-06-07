"""
self_anomaly.py — REFERENCE-FREE "card as its own reference" anomaly test.

Idea (ChatGPT's strongest point): a worse-graded card should contain MORE outlier
patches relative to the rest of ITS OWN patch field. No reference image, no
registration, no reference-mismatch. We embed each warped card with DINOv2
(16x16x384 patch grid) and, WITHIN that single card, score how anomalous each
patch is vs the same card's other patches. Two flavors:

  (a) CENTROID : cosine distance of each patch to the card's own patch centroid.
  (b) kNN (k=5): mean cosine distance of each patch to its k nearest OTHER patches
                 in the SAME card (PatchCore-within-one-image).

Card self-anomaly score = mean of the TOP-5% highest patch anomalies (most-outlier
patches = candidate defects). Reported with and without a ~12% border-ring drop
(the artwork border / card edge always looks "anomalous", so dropping it tests
whether the signal survives in the interior content).

Core question: does the per-card self-anomaly score INCREASE as grade DECREASES?
We report per-case scores by grade (image0..3), plus Spearman pooled and per-case.

Run:
  cd notebooks && KMP_DUPLICATE_LIB_OK=TRUE ../backend/venv/bin/python diag/self_anomaly.py
"""
import os
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("CARD_DETECTOR", "seg")
import sys, re, glob
_HERE = os.path.dirname(os.path.abspath(__file__))
_NB = os.path.dirname(_HERE)
sys.path.insert(0, _NB); sys.path.insert(0, os.path.join(_NB, "..", "backend"))
from dotenv import load_dotenv
load_dotenv(os.path.join(_NB, "..", ".env.local"), override=True)
load_dotenv(os.path.join(_NB, "..", "backend", ".env"), override=False)
import numpy as np, cv2
import warp_cache as WC
import torch, timm
from scipy.stats import spearmanr

ROOT = os.path.join(_NB, "embed_eval")
S = 224
NG = S // 14          # 16
PREFIX = 1            # dinov2 vit-s: 1 cls token before patches
TOPPCT = 0.05         # top-5% most-outlier patches define the card score
KNN = 5
BORDER_FRAC = 0.12    # drop a ~12% ring on each side for the interior variant
EXT = (".jpg", ".jpeg", ".png", ".webp")


def grade_of(name):
    m = re.search(r'psa[_\-]?(\d+)', name.lower())
    return int(m.group(1)) if m else None


# collect graded copies only (reference-free: references not needed for scoring)
items = []
for d in sorted(glob.glob(os.path.join(ROOT, "*"))):
    g = grade_of(os.path.basename(d))
    if os.path.isdir(d) and g is not None:
        for p in sorted(glob.glob(d + "/*")):
            if p.lower().endswith(EXT):
                items.append((g, p))
print(f"{len(items)} graded copies")

dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
model = timm.create_model("vit_small_patch14_dinov2.lvd142m", pretrained=True,
                          num_classes=0, img_size=S, dynamic_img_size=True).eval().to(dev)
cfg = timm.data.resolve_model_data_config(model)
MEAN = np.array(cfg["mean"], np.float32)
STD = np.array(cfg["std"], np.float32)
print(f"device={dev} grid={NG}x{NG} top%={TOPPCT} knn={KNN} border_frac={BORDER_FRAC}")


def embed_patches(path):
    det = WC.get_det(path)
    if det is None:
        return None
    rgb = cv2.cvtColor(det["warped"], cv2.COLOR_BGR2RGB)
    inp = cv2.resize(rgb, (S, S)).astype(np.float32) / 255.
    x = torch.from_numpy(((inp - MEAN) / STD).transpose(2, 0, 1))[None].to(dev)
    with torch.no_grad():
        tok = model.forward_features(x)[0].cpu().numpy()
    return tok[PREFIX:].reshape(NG, NG, -1)   # (16,16,384)


def l2n(v, ax):
    return v / (np.linalg.norm(v, axis=ax, keepdims=True) + 1e-9)


def interior_mask():
    """boolean (NG,NG): True for interior cells after dropping ~BORDER_FRAC ring."""
    b = max(1, int(round(NG * BORDER_FRAC)))
    m = np.zeros((NG, NG), bool)
    m[b:NG - b, b:NG - b] = True
    return m


def patch_anomaly_maps(P):
    """Return (centroid_map, knn_map) — per-patch cosine anomaly within this card.
    centroid: 1 - cos(patch, mean_unit_patch).
    knn: mean cosine distance to k nearest OTHER patches (exclude self)."""
    flat = P.reshape(-1, P.shape[-1])               # (256, 384)
    Pn = l2n(flat, 1)                                # unit patches
    # (a) centroid: unit-normalized mean direction
    c = l2n(flat.mean(0, keepdims=True), 1)          # (1,384)
    cen = (1 - (Pn @ c.T)[:, 0]).reshape(NG, NG)
    # (b) knn within the same card
    cos = Pn @ Pn.T                                  # (256,256)
    np.fill_diagonal(cos, -np.inf)                   # exclude self
    # nearest = highest cosine; take top-KNN, convert to distance, average
    idx = np.argpartition(-cos, KNN, axis=1)[:, :KNN]
    topcos = np.take_along_axis(cos, idx, axis=1)
    knn = (1 - topcos).mean(1).reshape(NG, NG)
    return cen, knn


def card_score(amap, mask=None):
    """mean of the TOP-TOPPCT highest patch anomalies (optionally interior-only)."""
    vals = amap[mask] if mask is not None else amap.reshape(-1)
    vals = np.sort(vals)[::-1]
    k = max(1, int(round(len(vals) * TOPPCT)))
    return float(vals[:k].mean())


INT = interior_mask()
rows = []
for g, p in items:
    P = embed_patches(p)
    if P is None:
        print("  ! failed:", os.path.basename(p)); continue
    cen, knn = patch_anomaly_maps(P)
    case = os.path.splitext(os.path.basename(p))[0]
    rows.append(dict(
        case=case, grade=g,
        cen_full=card_score(cen), cen_int=card_score(cen, INT),
        knn_full=card_score(knn), knn_int=card_score(knn, INT),
    ))
    print(f"  {case} PSA{g}: cen_full={rows[-1]['cen_full']:.4f} cen_int={rows[-1]['cen_int']:.4f} "
          f"knn_full={rows[-1]['knn_full']:.4f} knn_int={rows[-1]['knn_int']:.4f}", flush=True)

METRICS = ["cen_full", "cen_int", "knn_full", "knn_int"]
cases = sorted(set(r["case"] for r in rows))

print("\n" + "=" * 78)
print("PER-CASE scores by grade (worse grade => want HIGHER self-anomaly; "
      "Spearman(grade,score) should be NEGATIVE if it works)")
print("=" * 78)
for case in cases:
    cr = sorted([r for r in rows if r["case"] == case], key=lambda r: r["grade"])
    grades = [r["grade"] for r in cr]
    print(f"\ncase {case}  grades={grades}")
    for m in METRICS:
        vals = [r[m] for r in cr]
        rho = spearmanr(grades, vals)[0] if len(set(grades)) > 1 else float("nan")
        series = "  ".join(f"PSA{gr}:{v:.4f}" for gr, v in zip(grades, vals))
        # direction relative to BASELINE convention: + = correct (worse grade => higher)
        direction = "CORRECT(worse=higher)" if rho < 0 else ("INVERTED" if rho > 0 else "flat/na")
        print(f"  {m:9s} rho={rho:+.3f}  {direction:22s}  {series}")

print("\n" + "=" * 78)
print("POOLED across all cases (mixes cards — only meaningful if scores are comparable)")
print("=" * 78)
allg = [r["grade"] for r in rows]
for m in METRICS:
    vals = [r[m] for r in rows]
    rho = spearmanr(allg, vals)[0]
    print(f"  {m:9s} pooled rho(grade,score)={rho:+.3f}  ({'CORRECT' if rho<0 else 'INVERTED' if rho>0 else 'flat'})")

# Within-case rank agreement: for each case, does worst grade get highest score?
print("\n" + "=" * 78)
print("DIRECTION SUMMARY per metric: how many of the N cases are CORRECT (rho<0)?")
print("=" * 78)
for m in METRICS:
    perc = []
    for case in cases:
        cr = sorted([r for r in rows if r["case"] == case], key=lambda r: r["grade"])
        grades = [r["grade"] for r in cr]
        if len(set(grades)) < 2:
            continue
        rho = spearmanr(grades, [r[m] for r in cr])[0]
        perc.append((case, rho))
    nc = sum(1 for _, r in perc if r < 0)
    ni = sum(1 for _, r in perc if r > 0)
    print(f"  {m:9s}: correct={nc}  inverted={ni}  detail=" +
          " ".join(f"{c}:{r:+.2f}" for c, r in perc))

# save a compact csv
import csv
out = os.path.join(_HERE, "self_anomaly_scores.csv")
with open(out, "w", newline="") as f:
    w = csv.DictWriter(f, fieldnames=["case", "grade"] + METRICS)
    w.writeheader()
    for r in sorted(rows, key=lambda r: (r["case"], r["grade"])):
        w.writerow(r)
print(f"\nsaved -> {out}")
