"""
embed_eval_app.py — interactive Reference-Distance Eval (DINOv2).

Drop images into:
    embed_eval/
      reference/   one pristine image PER card (each = its own "case")
      psa10/ psa9/ ...   copies (folder name contains the grade)
…and this app warps (Model-C, cached), embeds (DINOv2), auto-assigns every copy to
its NEAREST reference by embedding (handles multiple cards in the same folders), and
shows distance(reference → copy) vs grade — per card — with a threshold line, a
below-threshold breakdown, the per-copy table, and per-copy heatmaps. Add more
examples and hit Rescan; only new images get embedded.

Run:  cd notebooks && ../backend/venv/bin/streamlit run embed_eval_app.py --server.port 8503
"""
import os
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")
os.environ.setdefault("CARD_DETECTOR", "seg")
import sys, re, glob
_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE); sys.path.insert(0, os.path.join(_HERE, "..", "backend"))
from pathlib import Path
import numpy as np, cv2, pandas as pd, torch, timm
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
import streamlit as st
from dotenv import load_dotenv
load_dotenv(os.path.join(_HERE, "..", ".env.local"), override=True)
load_dotenv(os.path.join(_HERE, "..", "backend", ".env"), override=False)
import warp_cache as WC

st.set_page_config(layout="wide", page_title="Reference Distance Eval", page_icon="📏")
EXT = (".jpg", ".jpeg", ".png", ".webp")
PAL = ["#4c9aff", "#e5544b", "#3fb37f", "#fdd835", "#b06cff", "#ff8c42", "#42d4d4", "#f58231"]


BACKBONES = {
    "DINOv2 ViT-S/14": ("vit", "vit_small_patch14_dinov2.lvd142m"),
    "DINOv3 ViT-S/16": ("vit", "vit_small_patch16_dinov3"),
    "WideResNet50 (PatchCore)": ("cnn", "wide_resnet50_2"),
}


@st.cache_resource(show_spinner="Loading backbone…")
def load_backbone(name, size):
    kind, mname = BACKBONES[name]
    dev = "mps" if torch.backends.mps.is_available() else ("cuda" if torch.cuda.is_available() else "cpu")
    if kind == "vit":
        model = timm.create_model(mname, pretrained=True, num_classes=0,
                                  img_size=size, dynamic_img_size=True).eval().to(dev)
    else:                                  # CNN: PatchCore-style mid-level feature maps (layer2 + layer3)
        model = timm.create_model(mname, pretrained=True, features_only=True, out_indices=(2, 3)).eval().to(dev)
    cfg = timm.data.resolve_model_data_config(model)
    return {"kind": kind, "model": model, "dev": dev, "prefix": getattr(model, "num_prefix_tokens", 1),
            "mean": np.array(cfg["mean"], np.float32), "std": np.array(cfg["std"], np.float32)}


def _forward(bundle, rgb, size):
    """Backbone-generic embed → {rgb, cls, patch(n,n,C)}. Grid n is derived from the model, not hard-coded."""
    inp = cv2.resize(rgb, (size, size)).astype(np.float32) / 255.
    x = torch.from_numpy(((inp - bundle["mean"]) / bundle["std"]).transpose(2, 0, 1))[None].to(bundle["dev"])
    with torch.no_grad():
        if bundle["kind"] == "vit":
            tok = bundle["model"].forward_features(x)[0].cpu().numpy()
            pt = tok[bundle["prefix"]:]; n = int(round(len(pt) ** 0.5))   # drop cls+register tokens
            return {"rgb": rgb, "cls": tok[0], "patch": pt.reshape(n, n, -1)}
        import torch.nn.functional as F                                   # CNN: concat feature maps at the finest grid
        fmaps = bundle["model"](x); base = fmaps[0].shape[-2:]
        feat = torch.cat([F.interpolate(f, size=base, mode="bilinear", align_corners=False) for f in fmaps], 1)
        patch = feat[0].permute(1, 2, 0).cpu().numpy()
        return {"rgb": rgb, "cls": patch.reshape(-1, patch.shape[-1]).mean(0), "patch": patch}


@st.cache_data(show_spinner=False)
def embed(path, size, mtime, backbone):   # mtime + backbone in the key → re-embed on file/model change
    det = WC.get_det(path)
    if det is None:
        return None
    return _forward(load_backbone(backbone, size), cv2.cvtColor(det["warped"], cv2.COLOR_BGR2RGB), size)


def embed_rgb_inline(rgb, size, backbone):
    """Embed an in-memory RGB warp (for the ORB-registered image; not path-cached)."""
    return _forward(load_backbone(backbone, size), rgb, size)["patch"]


def register(user, ref):
    """Global ORB+RANSAC homography aligning `user` warp onto `ref` warp.
    Returns (aligned_rgb, n_inliers); falls back to the original if matching fails."""
    g1 = cv2.cvtColor(user, cv2.COLOR_RGB2GRAY); g2 = cv2.cvtColor(ref, cv2.COLOR_RGB2GRAY)
    orb = cv2.ORB_create(3000)
    k1, d1 = orb.detectAndCompute(g1, None); k2, d2 = orb.detectAndCompute(g2, None)
    if d1 is None or d2 is None or len(k1) < 12 or len(k2) < 12:
        return user, 0
    matches = sorted(cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(d1, d2), key=lambda m: m.distance)[:300]
    if len(matches) < 12:
        return user, len(matches)
    src = np.float32([k1[m.queryIdx].pt for m in matches]).reshape(-1, 1, 2)
    dst = np.float32([k2[m.trainIdx].pt for m in matches]).reshape(-1, 1, 2)
    H, mask = cv2.findHomography(src, dst, cv2.RANSAC, 5.0)
    if H is None:
        return user, 0
    aligned = cv2.warpPerspective(user, H, (ref.shape[1], ref.shape[0]), borderMode=cv2.BORDER_REPLICATE)
    return aligned, int(mask.sum())


def _hist_match_ch(src, ref):
    """Match src channel's intensity histogram to ref's (CDF interpolation)."""
    s = src.ravel()
    s_vals, s_idx, s_counts = np.unique(s, return_inverse=True, return_counts=True)
    r_vals, r_counts = np.unique(ref.ravel(), return_counts=True)
    s_cdf = np.cumsum(s_counts).astype(np.float64) / s.size
    r_cdf = np.cumsum(r_counts).astype(np.float64) / ref.size
    return np.interp(s_cdf, r_cdf, r_vals)[s_idx].reshape(src.shape).astype(np.uint8)


def photo_match(src, ref, mode):
    """Equalize src's exposure/WB to ref so brightness diffs don't create false hotspots.
    mean/std = mild per-channel affine (safe for whitening); histogram = stronger CDF match."""
    if mode == "mean/std":
        o = src.astype(np.float32)
        for c in range(3):
            s = src[..., c]
            o[..., c] = (o[..., c] - s.mean()) / (s.std() + 1e-6) * (ref[..., c].std() + 1e-6) + ref[..., c].mean()
        return np.clip(o, 0, 255).astype(np.uint8)
    if mode == "histogram":
        return np.stack([_hist_match_ch(src[..., c], ref[..., c]) for c in range(3)], -1)
    return src


def grade_of(name):
    m = re.search(r'psa[_\-]?(\d+)', name.lower()); return int(m.group(1)) if m else None


def l2n(v, ax):
    return v / (np.linalg.norm(v, axis=ax, keepdims=True) + 1e-9)


def cls_d(a, b):
    return float(1 - (a @ b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def patch_strict_map(P, rp):
    return 1 - (l2n(P, 2) * l2n(rp, 2)).sum(2)            # (n,n) position-wise per-patch cosine distance


def region_mask(n, border_frac, region):
    """Boolean n×n mask of which patch cells to score (cell-center based)."""
    c = (np.arange(n) + 0.5) / n
    inner = (c >= border_frac) & (c <= 1 - border_frac)
    content = np.outer(inner, inner)
    if region.startswith("content"):
        return content if content.any() else np.ones((n, n), bool)
    if region.startswith("border"):
        return ~content if (~content).any() else np.ones((n, n), bool)
    return np.ones((n, n), bool)


def pool(m, mode):
    """Combine an n×n (or already-masked 1-D) per-patch distance map into one score."""
    f = np.asarray(m).ravel()
    if mode == "max":
        return float(f.max())
    if mode == "p95":
        return float(np.percentile(f, 95))
    if mode == "top-5% mean":
        k = max(1, int(round(0.05 * f.size))); return float(np.sort(f)[-k:].mean())
    return float(f.mean())                                # "mean" (default)


def patch_nbr_map(P, rp, win):
    Pn, Rn = l2n(P, 2), l2n(rp, 2); n = P.shape[0]; out = np.zeros((n, n))
    for i in range(n):
        for j in range(n):
            out[i, j] = 1 - max(float(Pn[i, j] @ Rn[a, b])
                                for a in range(max(0, i - win), min(n, i + win + 1))
                                for b in range(max(0, j - win), min(n, j + win + 1)))
    return out


def overlay(rgb, nm, vmax=0.4):
    """ABSOLUTE-scale heatmap with value-based transparency: a near-zero map renders BLANK
    (raw card shows through), so reference-vs-itself is blank — and heatmaps are comparable
    across cards. (The old min-max normalize stretched float noise into false hotspots.)"""
    H, W = rgb.shape[:2]
    a = np.clip(cv2.resize(nm.astype(np.float32), (W, H)) / max(vmax, 1e-6), 0, 1)
    hm = cv2.cvtColor(cv2.applyColorMap((a * 255).astype(np.uint8), cv2.COLORMAP_JET), cv2.COLOR_BGR2RGB)
    a3 = (a * 0.6)[..., None]                       # 0 distance → transparent; hottest → 60% overlay
    return (rgb.astype(np.float32) * (1 - a3) + hm.astype(np.float32) * a3).astype(np.uint8)


with st.sidebar:
    st.header("Dataset")
    root = st.text_input("Folder", "embed_eval")
    backbone = st.selectbox("backbone", list(BACKBONES),
                            help="DINOv2/v3 = ViT dense patch tokens; WideResNet50 = PatchCore-style mid-level "
                                 "CNN features (more texture-sensitive, finer grid). Switching re-embeds (cached per model).")
    size = st.radio("input size (px)", [224, 518], horizontal=True,
                    help="larger = finer patch grid (slower; WideResNet at 518 is heavy)")
    win = st.select_slider("neighborhood-min window", [0, 1, 2], value=1,
                           help="patch_nbr tolerance to misalignment (0 = strict)")
    pool_mode = st.radio("patch pooling", ["mean", "top-5% mean", "p95", "max"],
                         help="how per-patch distances become one score. mean dilutes localized "
                              "defects; max / top-k / p95 are sensitive to the worst patches "
                              "(grades hinge on the worst region). cls is unaffected.")
    region = st.radio("region scored", ["whole card", "content (inner)", "border ring"],
                      help="restrict which patches count. content isolates surface/art (capture-stable); "
                           "border isolates whitening + edge/corner wear. cls is always whole-card.")
    border_frac = st.slider("border fraction", 0.05, 0.30, 0.12, 0.01,
                            help="outer ring width treated as 'border' (content/border modes only)")
    heat_vmax = st.slider("heatmap scale (max distance)", 0.1, 1.0, 0.4, 0.05,
                          help="ABSOLUTE colour scale: a patch at this distance is full red; ~0 renders blank. "
                               "Makes reference-vs-itself blank and heatmaps comparable across cards.")
    register_on = st.checkbox("register to reference (ORB)",
                              help="globally align each copy to its reference (ORB+RANSAC homography) before "
                                   "scoring — removes shift/scale/perspective without the per-patch signal "
                                   "erosion of neighborhood-min. Adds 'orb_inliers' (higher = better align).")
    photometric = st.selectbox("photometric match to ref", ["off", "mean/std", "histogram"],
                               help="equalize the copy's exposure/white-balance to the reference before scoring so "
                                    "brightness diffs don't create false hotspots. mean/std = mild (safe for whitening); "
                                    "histogram = stronger (can dampen real whitening). Matters most for WideResNet.")
    if st.button("🔄 Rescan / clear cache"):
        st.cache_data.clear(); st.rerun()

ROOT = Path(root)
items = [(None, p) for p in sorted(glob.glob(str(ROOT / "reference" / "*"))) if p.lower().endswith(EXT)]
for d in sorted(glob.glob(str(ROOT / "*"))):
    g = grade_of(os.path.basename(d))
    if os.path.isdir(d) and g is not None:
        items += [(g, p) for p in sorted(glob.glob(d + "/*")) if p.lower().endswith(EXT)]
refs = [p for g, p in items if g is None]
if not refs:
    st.warning(f"Put a pristine image per card in `{ROOT}/reference/` and copies in `{ROOT}/psaNN/`."); st.stop()

with st.spinner("Warping + embedding (new images only)…"):
    E = {p: (g, embed(p, size, os.path.getmtime(p), backbone)) for g, p in items}
E = {p: v for p, v in E.items() if v[1] is not None}
REFS = [(Path(p).stem, E[p][1]) for p in refs if p in E]
if not REFS:
    st.error("No reference embeddings (warp failed?)."); st.stop()

rows, heat = [], {}
for p, (g, e) in E.items():
    if g is None:
        continue
    ranked = sorted(((cls_d(e["cls"], rb["cls"]), nm, rb) for nm, rb in REFS), key=lambda t: t[0])
    cls, case, refe = ranked[0]
    margin = round(ranked[1][0] - cls, 3) if len(ranked) > 1 else None
    cp_patch, disp_rgb, inliers = e["patch"], e["rgb"], None
    proc, reembed = e["rgb"], False
    if register_on:                                                 # global ORB-homography alignment
        proc, inliers = register(proc, refe["rgb"]); reembed = True
    if photometric != "off":                                        # exposure/WB match → brightness invariance
        proc = photo_match(proc, refe["rgb"], photometric); reembed = True
    if reembed:
        disp_rgb = proc; cp_patch = embed_rgb_inline(proc, size, backbone)
    nmap = patch_nbr_map(cp_patch, refe["patch"], win)
    smap = patch_strict_map(cp_patch, refe["patch"])
    rmask = region_mask(smap.shape[0], border_frac, region)         # which patches to score
    rec = {"case": case, "grade": g, "file": os.path.basename(p), "cls": round(cls, 3),
           "patch_strict": round(pool(smap[rmask], pool_mode), 3),
           "patch_nbr": round(pool(nmap[rmask], pool_mode), 3), "ref_margin": margin}
    if register_on:
        rec["orb_inliers"] = inliers
    rows.append(rec)
    heat[(case, g, os.path.basename(p))] = (disp_rgb, nmap, refe["rgb"], rmask)
df = pd.DataFrame(rows).sort_values(["case", "grade", "file"])

st.title("📏 Reference-Distance Eval")
if df.empty:
    st.info("References loaded, but no graded copies yet — add images to psaNN/ folders."); st.stop()
st.caption(f"{len(REFS)} reference identit{'y' if len(REFS)==1 else 'ies'} ({', '.join(n for n,_ in REFS)})  ·  "
           f"{len(df)} graded copies  ·  grades {sorted(df.grade.unique())}  ·  **{backbone}**, size {size}, win {win}, "
           f"pooling **{pool_mode}**, region **{region}**, photometric **{photometric}**"
           f"{', ORB' if register_on else ''}.  Each copy auto-assigned to its nearest reference.")

metric = st.radio("metric", ["patch_strict", "patch_nbr", "cls"], horizontal=True,
                  help=f"patch_* are pooled with '{pool_mode}' (sidebar); cls is the global token (unpooled).")
thr = st.slider("distance threshold", 0.0, 0.6, 0.25, 0.01,
                help="you noticed PSA10 looked < 0.25 — see which grades fall below a cutoff")

c1, c2 = st.columns([1.5, 1])
with c1:
    fig, ax = plt.subplots(figsize=(6.4, 4.2)); fig.patch.set_facecolor("#0e1117"); ax.set_facecolor("#0e1117")
    for ci, case in enumerate(df.case.unique()):
        dc = df[df.case == case]; col = PAL[ci % len(PAL)]
        ax.scatter(dc.grade, dc[metric], c=col, s=55, alpha=.85, label=case)
        gm = dc.groupby("grade")[metric].mean(); ax.plot(gm.index, gm.values, color=col, lw=1.5)
    ax.axhline(thr, color="#9aa0a6", ls="--", lw=1.2)
    ax.set_xlabel("PSA grade", color="#e8eaed"); ax.set_ylabel(f"{metric} distance to reference", color="#e8eaed")
    ax.tick_params(colors="#e8eaed"); ax.legend(fontsize=7, facecolor="#0e1117", labelcolor="#e8eaed")
    for s in ax.spines.values():
        s.set_color("#3a3f47")
    ax.set_title("distance vs grade — expect it to rise as grade falls", color="#e8eaed", fontsize=10)
    fig.tight_layout(); st.pyplot(fig); plt.close(fig)
with c2:
    st.markdown(f"**`{metric} < {thr}` by grade**")
    gb = df.assign(below=df[metric] < thr).groupby("grade")
    tab = pd.DataFrame({"grade": gb.size().index, "copies": gb.size().values,
                        "below_thr": gb["below"].sum().values,
                        "mean": gb[metric].mean().round(3).values})
    st.dataframe(tab, hide_index=True, use_container_width=True)
    st.caption("If a cutoff cleanly isolates a grade band, that's your separator.")

st.markdown("#### Per-copy distances")
st.dataframe(df, hide_index=True, use_container_width=True)

st.markdown("#### Reference · investigated · heatmap — all at the EXACT model input")
keys = list(heat.keys())
k = st.selectbox("copy", keys, format_func=lambda t: f"{t[0]} · PSA{t[1]} · {t[2]}")
rgb, nm, refrgb, rmask = heat[k]
disp = nm.copy()
if not rmask.all():                       # cool the un-scored region so red shows only where it counts
    disp[~rmask] = 0.0                        # un-scored region → transparent under the absolute scale
# show all three at the EXACT square crop the model embedded (S×S) so patches correspond 1:1
ref_in = cv2.resize(refrgb, (size, size))
cop_in = cv2.resize(rgb, (size, size))    # rgb is the (ORB-aligned, if on) warp actually embedded
h1, h2, h3 = st.columns(3)
h1.image(ref_in, width=250, caption=f"reference · {k[0]} ({size}×{size})")
h2.image(cop_in, width=250, caption=f"investigated · PSA{k[1]} · {k[2]} — exact {size}×{size} input"
                                     f"{' · ORB-aligned' if register_on else ''}")
h3.image(overlay(cop_in, disp, heat_vmax), width=250, caption=f"heatmap — red = worst in [{region}] (scale 0–{heat_vmax})")
st.caption("All three are the exact square the backbone sees (aspect-squished on purpose); the heatmap grid "
           "lines up 1:1 with the investigated crop.")
