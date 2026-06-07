"""
embed_eval.py — Reference-vs-grade embedding-distance harness.

Point it at a folder laid out like:
    embed_eval/
      reference/        1+ pristine images of the card  (the "source of truth")
      psa10/  psa9/  psa8/  ...   N copies each (folder name must contain the grade)
and it warps every image (Model-C seg, cached), embeds with DINOv2, and reports
    distance(reference  ->  each copy)  vs  PSA grade
for three metrics:
    cls          — global CLS-token cosine distance
    patch_strict — mean per-patch cosine distance, position-wise (alignment-sensitive)
    patch_nbr    — per-patch cosine distance with a neighborhood-min search (--win),
                   i.e. PatchCore-style, robust to small misalignment
plus per-grade mean±std, a Spearman trend (expect NEGATIVE: higher grade -> smaller
distance), a scatter plot (shows within-grade spread vs the across-grade trend), and
per-grade heatmaps.

Run:
    cd notebooks && ../backend/venv/bin/python embed_eval.py --dir embed_eval
Options: --size 224|518   --win 1   --no-warp (images are already cropped cards)
"""
import os
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")   # torch + any OMP lib coexistence (macOS)
os.environ.setdefault("CARD_DETECTOR", "seg")
import sys, re, glob, argparse
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE); sys.path.insert(0, os.path.join(_HERE, "..", "backend"))
from pathlib import Path
import numpy as np, cv2, pandas as pd
from dotenv import load_dotenv
load_dotenv(os.path.join(_HERE, "..", ".env.local"), override=True)
load_dotenv(os.path.join(_HERE, "..", "backend", ".env"), override=False)

ap = argparse.ArgumentParser()
ap.add_argument("--dir", default="embed_eval")
ap.add_argument("--size", type=int, default=224)
ap.add_argument("--win", type=int, default=1, help="neighborhood-min half-window in patches (0 = strict)")
ap.add_argument("--no-warp", action="store_true", help="images are already cropped cards (skip Model-C warp)")
A = ap.parse_args()
ROOT = Path(A.dir); OUT = ROOT / "results"; OUT.mkdir(parents=True, exist_ok=True)
S, WIN, NG = A.size, A.win, A.size // 14
EXT = (".jpg", ".jpeg", ".png", ".webp")


def grade_of(name):
    m = re.search(r'psa[_\-]?(\d+)', name.lower())
    return int(m.group(1)) if m else None


# ── collect images: reference/ + psaNN/ folders ─────────────────────────────
items = [(None, p) for p in sorted(glob.glob(str(ROOT / "reference" / "*"))) if p.lower().endswith(EXT)]
for d in sorted(glob.glob(str(ROOT / "*"))):
    g = grade_of(os.path.basename(d))
    if os.path.isdir(d) and g is not None:
        items += [(g, p) for p in sorted(glob.glob(d + "/*")) if p.lower().endswith(EXT)]
refs = [p for g, p in items if g is None]
if not items or not refs:
    sys.exit(f"Need {ROOT}/reference/*.jpg and {ROOT}/psaNN/*.jpg  (found {len(items)} imgs, {len(refs)} refs)")


def get_warp(path):
    if A.no_warp:
        return cv2.imread(path)
    import warp_cache as WC
    det = WC.get_det(path)
    return det["warped"] if det else None


# ── DINOv2 ──────────────────────────────────────────────────────────────────
import torch, timm
dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
print(f"device={dev}  size={S} (grid {NG}×{NG})  neighborhood-min win={WIN}")
model = timm.create_model("vit_small_patch14_dinov2.lvd142m", pretrained=True, num_classes=0,
                          img_size=S, dynamic_img_size=True).eval().to(dev)
cfg = timm.data.resolve_model_data_config(model)
MEAN = np.array(cfg["mean"], np.float32); STD = np.array(cfg["std"], np.float32)


def embed(path):
    w = get_warp(path)
    if w is None:
        return None
    rgb = cv2.cvtColor(w, cv2.COLOR_BGR2RGB)
    inp = cv2.resize(rgb, (S, S)).astype(np.float32) / 255.
    x = torch.from_numpy(((inp - MEAN) / STD).transpose(2, 0, 1))[None].to(dev)
    with torch.no_grad():
        tok = model.forward_features(x)[0].cpu().numpy()
    return {"rgb": rgb, "cls": tok[0], "patch": tok[1:].reshape(NG, NG, -1)}


E = {}
for g, p in items:
    e = embed(p)
    if e is None:
        print("  ! warp/embed failed:", os.path.basename(p)); continue
    E[p] = (g, e)
    print(f"  embedded {'REF ' if g is None else 'PSA'+str(g)}  {os.path.basename(p)}", flush=True)


def l2n(v, ax):
    return v / (np.linalg.norm(v, axis=ax, keepdims=True) + 1e-9)


# reference prototypes: ONE per reference image → auto multi-case (no averaging across cards)
REFS = [(os.path.splitext(os.path.basename(p))[0], E[p][1]) for p in refs if p in E]
print(f"\n{len(REFS)} reference identit{'y' if len(REFS) == 1 else 'ies'}: {[n for n, _ in REFS]}"
      "  (each graded copy is auto-assigned to its NEAREST reference by embedding)")


def cls_d(a, b):
    return float(1 - (a @ b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def patch_strict(P, rp):
    return float((1 - (l2n(P, 2) * l2n(rp, 2)).sum(2)).mean())


def patch_nbr(P, rp):
    Pn, Rn = l2n(P, 2), l2n(rp, 2); out = np.zeros((NG, NG))
    for i in range(NG):
        for j in range(NG):
            out[i, j] = 1 - max(float(Pn[i, j] @ Rn[a, b])
                                for a in range(max(0, i - WIN), min(NG, i + WIN + 1))
                                for b in range(max(0, j - WIN), min(NG, j + WIN + 1)))
    return out


rows, nbrmaps = [], {}
for p, (g, e) in E.items():
    if g is None:
        continue
    ranked = sorted(((cls_d(e["cls"], rb["cls"]), nm, rb) for nm, rb in REFS), key=lambda t: t[0])
    cls, case, ref_e = ranked[0]
    margin = round(ranked[1][0] - ranked[0][0], 3) if len(ranked) > 1 else None   # gap to 2nd-nearest ref
    nm = patch_nbr(e["patch"], ref_e["patch"])
    rows.append({"case": case, "grade": g, "file": os.path.basename(p), "cls": round(cls, 3),
                 "patch_strict": round(patch_strict(e["patch"], ref_e["patch"]), 3),
                 "patch_nbr": round(float(nm.mean()), 3), "ref_margin": margin})
    nbrmaps[(case, g)] = (e["rgb"], nm)
df = pd.DataFrame(rows).sort_values(["case", "grade", "file"])
df.to_csv(OUT / "distances.csv", index=False)
print("\nper-copy distances (auto-assigned to nearest reference; ref_margin = gap to 2nd-nearest):\n",
      df.to_string(index=False))

from scipy.stats import spearmanr
for case in df["case"].unique():
    dc = df[df["case"] == case]
    print(f"\n=== case '{case}' — per-grade mean (Spearman expects NEGATIVE = higher grade ⇒ closer) ===")
    for metric in ["cls", "patch_strict", "patch_nbr"]:
        rho = spearmanr(dc["grade"], dc[metric])[0] if dc["grade"].nunique() > 1 else float("nan")
        trend = "  ".join(f"PSA{int(gr)}:{v:.3f}" for gr, v in dc.groupby('grade')[metric].mean().items())
        print(f"  {metric:13s} rho={rho:+.3f}   {trend}")

# ── plot: one panel per metric, one line per case ───────────────────────────
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
PAL = ["#4c9aff", "#e5544b", "#3fb37f", "#fdd835", "#b06cff", "#ff8c42"]
cases = list(df["case"].unique())
fig, axes = plt.subplots(1, 3, figsize=(14, 4.2)); fig.patch.set_facecolor("#0e1117")
for ax, metric in zip(axes, ["cls", "patch_strict", "patch_nbr"]):
    ax.set_facecolor("#0e1117")
    for ci, case in enumerate(cases):
        dc = df[df["case"] == case]; col = PAL[ci % len(PAL)]
        ax.scatter(dc["grade"], dc[metric], c=col, s=55, alpha=.85, label=case)
        gm = dc.groupby("grade")[metric].mean(); ax.plot(gm.index, gm.values, color=col, lw=1.6)
    ax.set_title(metric, color="#e8eaed"); ax.set_xlabel("PSA grade", color="#e8eaed")
    ax.set_ylabel("distance to reference", color="#e8eaed"); ax.tick_params(colors="#e8eaed")
    ax.legend(fontsize=7, facecolor="#0e1117", labelcolor="#e8eaed")
    for s_ in ax.spines.values():
        s_.set_color("#3a3f47")
fig.suptitle("distance(reference → copy) vs PSA grade — expect it to RISE as grade falls (one line per card)",
             color="#e8eaed")
fig.tight_layout(); fig.savefig(OUT / "distance_vs_grade.png", dpi=120, facecolor="#0e1117"); plt.close(fig)

# ── per-(case, grade) exemplar heatmap (neighborhood-min) ───────────────────
for (case, g), (rgb, nm) in sorted(nbrmaps.items()):
    H, W = rgb.shape[:2]
    nrm = (nm - nm.min()) / (np.ptp(nm) + 1e-9)
    hm = cv2.applyColorMap((cv2.resize(nrm, (W, H)) * 255).astype(np.uint8), cv2.COLORMAP_JET)
    ov = cv2.addWeighted(cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), 0.55, hm, 0.45, 0)
    cv2.imwrite(str(OUT / f"heatmap_{case}_psa{g}.png"), ov)
print(f"\nsaved → {OUT}/distances.csv · distance_vs_grade.png · heatmap_*.png")
