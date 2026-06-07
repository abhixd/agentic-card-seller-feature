"""
illum_invariant_preproc.py — Does illumination-invariance PREPROCESSING of the RGB warp
(applied BEFORE a frozen DINOv2 embedding) improve PSA8-10 surface-anomaly separation,
and/or make the embedding distance more brightness-invariant?

Same harness as embed_eval.py:
  - collect embed_eval/reference/* (grade=None) + embed_eval/psaNN/*  (grade via regex)
  - warp (cached, no API), DINOv2 ViT-S/14, patch_strict (l2-norm per cell over channels)
  - assign each copy to its NEAREST reference by CLS cosine distance, then patch_strict copy->ref
For each variant we apply the SAME preprocessing to BOTH copy and reference RGB before embedding.

Metric reported: PSA8-10 SEPARATION per case = patch_strict(PSA8->ref) - patch_strict(PSA10->ref)
  POSITIVE = worn(PSA8) is farther than pristine(PSA10) = CORRECT ordering.
KNOWN RAW BASELINE: image0 +0.044 | image1 +0.025 | image2 -0.023 | image3 ~ -0.013

ALSO: brightness-robustness — one mid copy (PSA9 of each case), embed it raw-bright vs preprocessed,
report patch_strict(orig vs brightened) under each variant (LOWER = more illumination-invariant).

Run:
  cd notebooks && KMP_DUPLICATE_LIB_OK=TRUE ../backend/venv/bin/python diag/illum_invariant_preproc.py
"""
import os
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("CARD_DETECTOR", "seg")
import sys, re, glob
_HERE = os.path.dirname(os.path.abspath(__file__))
_NB = os.path.abspath(os.path.join(_HERE, ".."))
sys.path.insert(0, _NB); sys.path.insert(0, os.path.join(_NB, "..", "backend"))
from dotenv import load_dotenv
load_dotenv(os.path.join(_NB, "..", ".env.local"), override=True)
load_dotenv(os.path.join(_NB, "..", "backend", ".env"), override=False)
import numpy as np, cv2, torch, timm
import warp_cache as WC

ROOT = os.path.join(_NB, "embed_eval")
EXT = (".jpg", ".jpeg", ".png", ".webp")
S = 224
NG = S // 14  # 16
dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")


def grade_of(name):
    m = re.search(r'psa[_\-]?(\d+)', name.lower())
    return int(m.group(1)) if m else None


# ── collect ──────────────────────────────────────────────────────────────────
items = [(None, p) for p in sorted(glob.glob(os.path.join(ROOT, "reference", "*"))) if p.lower().endswith(EXT)]
for d in sorted(glob.glob(os.path.join(ROOT, "*"))):
    g = grade_of(os.path.basename(d))
    if os.path.isdir(d) and g is not None:
        items += [(g, p) for p in sorted(glob.glob(d + "/*")) if p.lower().endswith(EXT)]
refs = [p for g, p in items if g is None]
print(f"collected {len(items)} images, {len(refs)} references")


def get_rgb(path):
    """Cached seg warp -> RGB uint8. No API for already-warped cards."""
    det = WC.get_det(path)
    if det is None:
        return None
    return cv2.cvtColor(det["warped"], cv2.COLOR_BGR2RGB)


# ── preprocessing variants (operate on RGB uint8 -> RGB uint8) ───────────────
def pp_raw(rgb):
    return rgb


def pp_lab_clahe(rgb):
    bgr = cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR)
    lab = cv2.cvtColor(bgr, cv2.COLOR_BGR2LAB)
    L, a, b = cv2.split(lab)
    clahe = cv2.createCLAHE(clipLimit=2.0, tileGridSize=(8, 8))
    L = clahe.apply(L)
    out = cv2.cvtColor(cv2.merge([L, a, b]), cv2.COLOR_LAB2BGR)
    return cv2.cvtColor(out, cv2.COLOR_BGR2RGB)


def pp_highpass(rgb):
    f = rgb.astype(np.float32)
    hp = f - cv2.GaussianBlur(f, (0, 0), 9)
    return np.clip(hp + 128, 0, 255).astype(np.uint8)


def pp_gradmag(rgb):
    out = np.zeros_like(rgb, np.float32)
    for c in range(3):
        ch = rgb[:, :, c].astype(np.float32)
        dx = cv2.Sobel(ch, cv2.CV_32F, 1, 0, ksize=3)
        dy = cv2.Sobel(ch, cv2.CV_32F, 0, 1, ksize=3)
        out[:, :, c] = np.sqrt(dx * dx + dy * dy)
    # normalize each channel to 0..255
    for c in range(3):
        m = out[:, :, c].max()
        if m > 1e-6:
            out[:, :, c] = out[:, :, c] / m * 255.0
    return np.clip(out, 0, 255).astype(np.uint8)


def pp_lcn(rgb):
    k = 15
    f = rgb.astype(np.float32)
    out = np.zeros_like(f)
    for c in range(3):
        ch = f[:, :, c]
        mu = cv2.boxFilter(ch, -1, (k, k), normalize=True, borderType=cv2.BORDER_REFLECT)
        mu2 = cv2.boxFilter(ch * ch, -1, (k, k), normalize=True, borderType=cv2.BORDER_REFLECT)
        var = np.maximum(mu2 - mu * mu, 0.0)
        sd = np.sqrt(var) + 1e-3
        out[:, :, c] = (ch - mu) / sd
    # rescale to 0..255 using a robust range (per whole image)
    lo, hi = np.percentile(out, 1), np.percentile(out, 99)
    if hi - lo < 1e-6:
        hi = lo + 1.0
    out = np.clip((out - lo) / (hi - lo), 0, 1) * 255.0
    return out.astype(np.uint8)


VARIANTS = [
    ("raw", pp_raw),
    ("LAB+CLAHE", pp_lab_clahe),
    ("high-pass", pp_highpass),
    ("gradient-magnitude", pp_gradmag),
    ("local-contrast-norm", pp_lcn),
]

# ── DINOv2 ───────────────────────────────────────────────────────────────────
print(f"device={dev}  loading DINOv2 ViT-S/14 ...")
model = timm.create_model("vit_small_patch14_dinov2.lvd142m", pretrained=True, num_classes=0,
                          img_size=S, dynamic_img_size=True).eval().to(dev)
cfg = timm.data.resolve_model_data_config(model)
MEAN = np.array(cfg["mean"], np.float32)
STD = np.array(cfg["std"], np.float32)


def embed_rgb(rgb):
    inp = cv2.resize(rgb, (S, S)).astype(np.float32) / 255.0
    x = torch.from_numpy(((inp - MEAN) / STD).transpose(2, 0, 1))[None].to(dev)
    with torch.no_grad():
        tok = model.forward_features(x)[0].cpu().numpy()
    return tok[0], tok[1:].reshape(NG, NG, -1)  # cls, patch


def l2n(v, ax):
    return v / (np.linalg.norm(v, axis=ax, keepdims=True) + 1e-9)


def cls_d(a, b):
    return float(1 - (a @ b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def patch_strict(P, R):
    return float((1 - (l2n(P, 2) * l2n(R, 2)).sum(2)).mean())


# ── preload raw RGB warps once (cache reuse) ─────────────────────────────────
RGB = {}
for g, p in items:
    r = get_rgb(p)
    if r is None:
        print("  ! warp failed:", os.path.basename(p)); continue
    RGB[p] = (g, r)
ref_paths = [p for p in refs if p in RGB]

# brightness-robustness probe: pick PSA9 copy per case (mid grade), brightened *1.3 clipped
def brighten(rgb):
    return np.clip(rgb.astype(np.float32) * 1.3, 0, 255).astype(np.uint8)

print("\n" + "=" * 96)
print("PSA8-10 SEPARATION per case  (= patch_strict(PSA8) - patch_strict(PSA10);  + = CORRECT)")
print("=" * 96)

results = {}        # variant -> {case: {grade: dist}}
robustness = {}     # variant -> mean patch_strict(orig vs brightened) over PSA9 copies

for vname, pp in VARIANTS:
    # embed all under this preprocessing
    EMB = {}
    for p, (g, rgb) in RGB.items():
        cls, patch = embed_rgb(pp(rgb))
        EMB[p] = (g, cls, patch)
    # reference identities
    REFS = [(os.path.splitext(os.path.basename(p))[0], EMB[p][1], EMB[p][2]) for p in ref_paths]
    # per-copy: nearest ref by cls, then patch_strict
    per = {}  # case -> {grade: dist}
    mis = []  # copies routed to a ref whose name != the copy's own stem (identity break)
    for p, (g, cls, patch) in EMB.items():
        if g is None:
            continue
        own = os.path.splitext(os.path.basename(p))[0]
        ranked = sorted(((cls_d(cls, rcls), nm, rpatch) for nm, rcls, rpatch in REFS), key=lambda t: t[0])
        _, case, ref_patch = ranked[0]
        if case != own:
            mis.append(f"{own}/PSA{g}->{case}")
        d = patch_strict(patch, ref_patch)
        per.setdefault(case, {})[g] = d
    results[vname] = per
    if mis:
        print(f"[{vname}] nearest-ref MISROUTES ({len(mis)}): {mis}")

    # brightness robustness over PSA9 copies (mid grade)
    robs = []
    for p, (g, rgb) in RGB.items():
        if g != 9:
            continue
        c0, p0 = embed_rgb(pp(rgb))
        c1, p1 = embed_rgb(pp(brighten(rgb)))
        robs.append(patch_strict(p0, p1))
    robustness[vname] = float(np.mean(robs)) if robs else float("nan")

# ── report ───────────────────────────────────────────────────────────────────
cases = ["image0", "image1", "image2", "image3"]
for vname, _ in VARIANTS:
    per = results[vname]
    print(f"\n--- {vname} ---")
    line_seps = []
    n_correct = 0
    for case in cases:
        d = per.get(case, {})
        d8, d10 = d.get(8), d.get(10)
        d9 = d.get(9)
        if d8 is not None and d10 is not None:
            sep = d8 - d10
            line_seps.append(sep)
            if sep > 0:
                n_correct += 1
            extra = f"  (P8={d8:.3f} P9={d9:.3f} P10={d10:.3f})" if d9 is not None else f"  (P8={d8:.3f} P10={d10:.3f})"
            print(f"  {case}: sep={sep:+.4f}{extra}")
        else:
            line_seps.append(float("nan"))
            print(f"  {case}: n/a (missing PSA8 or PSA10)  have={sorted(d)}")
    print(f"  -> {n_correct}/4 cases CORRECT (positive sep)   brightness-robustness(PSA9 orig vs *1.3)={robustness[vname]:.4f}")

# machine-readable summary
print("\n" + "=" * 96)
print("SUMMARY (variant | sep image0..3 | n_correct | brightness_robustness)")
print("=" * 96)
raw_rob = robustness["raw"]
for vname, _ in VARIANTS:
    per = results[vname]
    seps = []
    for case in cases:
        d = per.get(case, {})
        d8, d10 = d.get(8), d.get(10)
        seps.append((d8 - d10) if (d8 is not None and d10 is not None) else float("nan"))
    nc = sum(1 for s in seps if not np.isnan(s) and s > 0)
    rob = robustness[vname]
    rob_vs_raw = "" if vname == "raw" else f"  (raw={raw_rob:.4f}, {'-' if rob < raw_rob else '+'}{abs(rob-raw_rob):.4f})"
    print(f"{vname:22s} | " + " ".join(f"{s:+.4f}" if not np.isnan(s) else "  n/a  " for s in seps) +
          f" | {nc}/4 | rob={rob:.4f}{rob_vs_raw}")
