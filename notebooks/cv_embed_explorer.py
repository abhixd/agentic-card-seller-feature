"""
cv_embed_explorer.py — Embedding Distance Explorer (DINOv2).

Pick a card identity that appears at several PSA grades, pick a REFERENCE copy
(default = highest grade = best-available "source of truth"), and SEE how the
DINOv2 embedding distance to the reference varies across the graded copies —
globally (CLS cosine) and locally (per-patch cosine heatmap on the aligned warp).

CAVEAT (shown in-app): the dataset has NO same physical card across grades. These
are different physical COPIES of the same card identity (different eBay photos /
slabs), so distance reflects condition AND capture differences. That realism is
exactly what this tool lets you eyeball.

Run:  cd notebooks && ../backend/venv/bin/streamlit run cv_embed_explorer.py
"""
import os
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE")   # avoid torch/omp double-load crash on macOS
import sys, re
_HERE = os.path.dirname(os.path.abspath(__file__)); sys.path.insert(0, _HERE)
from pathlib import Path
import numpy as np, cv2, pandas as pd, torch, timm
import matplotlib; matplotlib.use("Agg"); import matplotlib.pyplot as plt
import streamlit as st
import warp_cache as WC

BASE = Path(_HERE) / "feature_extraction_dataset"
st.set_page_config(layout="wide", page_title="Embedding Distance Explorer", page_icon="📐")
_NUM = re.compile(r'\b(\d{1,3}/\d{1,3})\b')


@st.cache_resource(show_spinner="Loading DINOv2…")
def load_dino(size):
    dev = "mps" if torch.backends.mps.is_available() else "cpu"
    model = timm.create_model("vit_small_patch14_dinov2.lvd142m", pretrained=True,
                              num_classes=0, img_size=size, dynamic_img_size=True).eval().to(dev)
    cfg = timm.data.resolve_model_data_config(model)
    return model, dev, np.array(cfg["mean"], np.float32), np.array(cfg["std"], np.float32)


@st.cache_data(show_spinner=False)
def embed(path, size):
    det = WC.load_warp(path)
    if det is None:
        return None
    model, dev, mean, std = load_dino(size)
    warp = det["warped"]
    rgb = cv2.cvtColor(warp, cv2.COLOR_BGR2RGB)
    inp = cv2.resize(rgb, (size, size)).astype(np.float32) / 255.0
    x = torch.from_numpy(((inp - mean) / std).transpose(2, 0, 1))[None].to(dev)
    with torch.no_grad():
        tok = model.forward_features(x)[0].cpu().numpy()
    n = size // 14
    return {"rgb": rgb, "cls": tok[0], "patch": tok[1:].reshape(n, n, -1)}


@st.cache_data
def groups():
    m = pd.read_csv(BASE / "metadata.csv")
    m = m[m["filename"].str.contains("_front")].copy()
    m["num"] = m["ebay_title"].map(lambda t: (_NUM.search(str(t)).group(1) if _NUM.search(str(t)) else None))
    m["path"] = m.apply(lambda r: str(BASE / str(int(r["actual_psa"])) / r["filename"]), axis=1)
    m = m[m["num"].notna() & m["path"].map(os.path.exists)]
    return {num: sub.sort_values("actual_psa", ascending=False).reset_index(drop=True)
            for num, sub in m.groupby("num") if sub["actual_psa"].nunique() >= 2}


def cosdist(a, b):
    return float(1 - (a @ b) / (np.linalg.norm(a) * np.linalg.norm(b) + 1e-9))


def patch_distmap(pc, pr):
    a = pc / (np.linalg.norm(pc, axis=2, keepdims=True) + 1e-9)
    b = pr / (np.linalg.norm(pr, axis=2, keepdims=True) + 1e-9)
    return 1 - (a * b).sum(2)


def heat_overlay(rgb, dmap):
    H, W = rgb.shape[:2]
    n = (dmap - dmap.min()) / (np.ptp(dmap) + 1e-9)
    hm = cv2.applyColorMap((cv2.resize(n, (W, H)) * 255).astype(np.uint8), cv2.COLORMAP_JET)
    return cv2.addWeighted(rgb, 0.55, cv2.cvtColor(hm, cv2.COLOR_BGR2RGB), 0.45, 0)


def patch_crop(rgb, i, j, n, out=104):
    """Pixel region of warp cell (i,j) on the n×n patch grid, upscaled for display."""
    H, W = rgb.shape[:2]
    y0, y1 = int(i / n * H), int((i + 1) / n * H)
    x0, x1 = int(j / n * W), int((j + 1) / n * W)
    return cv2.resize(rgb[y0:y1, x0:x1], (out, out), interpolation=cv2.INTER_NEAREST)


def patch_pair(ref_rgb, usr_rgb, i, j, n):
    """ref-crop | user-crop, stacked side by side with a separator."""
    rc, uc = patch_crop(ref_rgb, i, j, n), patch_crop(usr_rgb, i, j, n)
    return np.hstack([rc, np.full((rc.shape[0], 5, 3), 70, np.uint8), uc])


G = groups()
st.title("📐 Embedding Distance Explorer")
st.caption("Different physical **copies** of the same card identity (different photos/slabs) — distance reflects "
           "condition **and** capture differences. No same-card-across-grades exists in the dataset.")
if not G:
    st.error("No multi-grade identities found."); st.stop()

with st.sidebar:
    st.header("Card identity")
    keys = list(G.keys())
    def glabel(k):
        sub = G[k]; nm = str(sub.iloc[0]["card_name_guess"])[:22]
        return f"#{k} · {nm} · {sorted(sub['actual_psa'].unique())}"
    key = st.selectbox("Card # (≥2 grades)", keys,
                       index=keys.index("5/64") if "5/64" in G else 0, format_func=glabel)
    sub = G[key]
    size = st.radio("DINOv2 input", [224, 518], horizontal=True,
                    help="224 = fast, 16×16 patch grid · 518 = finer, 37×37")
    ref_i = st.selectbox("Reference copy (source of truth)", range(len(sub)), index=0,
                         format_func=lambda i: f"PSA{int(sub.iloc[i]['actual_psa'])} · {sub.iloc[i]['filename']}")

embs = [embed(sub.iloc[i]["path"], size) for i in range(len(sub))]
ref = embs[ref_i]
if ref is None:
    st.error("Reference warp not cached."); st.stop()

R = pd.DataFrame([{"i": i, "grade": int(sub.iloc[i]["actual_psa"]), "is_ref": i == ref_i,
                   "cls": cosdist(e["cls"], ref["cls"]),
                   "patch": float(patch_distmap(e["patch"], ref["patch"]).mean())}
                  for i, e in enumerate(embs) if e is not None]).sort_values("grade", ascending=False)

cL, cR = st.columns([1, 1.4])
with cL:
    st.markdown(f"#### Reference — **PSA{int(sub.iloc[ref_i]['actual_psa'])}**")
    st.image(ref["rgb"], width=240, caption=sub.iloc[ref_i]["filename"])
    st.caption(str(sub.iloc[ref_i]["ebay_title"])[:90])
with cR:
    st.markdown("#### Distance to reference vs PSA grade")
    fig, ax = plt.subplots(figsize=(5.4, 3.1)); fig.patch.set_facecolor("#0e1117"); ax.set_facecolor("#0e1117")
    g_ = R[~R.is_ref]
    ax.scatter(g_["grade"], g_["cls"], s=80, c="#4c9aff", label="CLS (global)")
    ax.scatter(g_["grade"], g_["patch"], s=80, c="#3fb37f", marker="s", label="patch-mean (local)")
    ax.set_xlabel("PSA grade", color="#e8eaed"); ax.set_ylabel("cosine distance to reference", color="#e8eaed")
    ax.tick_params(colors="#e8eaed"); ax.legend(fontsize=8, facecolor="#0e1117", labelcolor="#e8eaed")
    for s in ax.spines.values():
        s.set_color("#3a3f47")
    fig.tight_layout(); st.pyplot(fig); plt.close(fig)
    st.caption("Hypothesis: distance should RISE as grade falls. With only a few copies it's anecdotal — "
               "watch whether the trend holds and how much capture noise scatters it.")

st.markdown("#### All copies (sorted by grade) — distance to reference")
for col, (_, r) in zip(st.columns(len(R)), R.iterrows()):
    with col:
        st.image(embs[r["i"]]["rgb"], width=140)
        st.markdown(f"**PSA{r['grade']}**" + (" ⭐REF" if r["is_ref"] else ""))
        if not r["is_ref"]:
            st.caption(f"CLS **{r['cls']:.3f}**\npatch **{r['patch']:.3f}**")

st.markdown("#### Per-patch distance heatmap — *where* a copy differs from the reference")
others = [i for i in range(len(sub)) if i != ref_i and embs[i] is not None]
if others:
    sel = st.selectbox("Show heatmap for", others,
                       format_func=lambda i: f"PSA{int(sub.iloc[i]['actual_psa'])} · {sub.iloc[i]['filename']}")
    dm = patch_distmap(embs[sel]["patch"], ref["patch"])
    n = dm.shape[0]
    h1, h2 = st.columns(2)
    h1.image(ref["rgb"], width=300, caption=f"reference PSA{int(sub.iloc[ref_i]['actual_psa'])}")
    h2.image(heat_overlay(embs[sel]["rgb"], dm), width=300,
             caption=f"PSA{int(sub.iloc[sel]['actual_psa'])} · red = most different (condition + photo + residual misalignment)")

    # (3) distribution of the n×n per-patch cosine distances
    st.markdown("#### Distribution of per-patch cosine distances")
    flat = dm.flatten()
    fig, ax = plt.subplots(figsize=(6.4, 2.6)); fig.patch.set_facecolor("#0e1117"); ax.set_facecolor("#0e1117")
    ax.hist(flat, bins=30, color="#4c9aff", edgecolor="#0e1117")
    for v, c, lab in [(flat.mean(), "#e5544b", "mean"), (np.median(flat), "#fdd835", "median")]:
        ax.axvline(v, color=c, lw=1.4, label=f"{lab} {v:.2f}")
    ax.set_xlabel("cosine distance (1 − cos)  ·  one value per patch", color="#e8eaed")
    ax.set_ylabel(f"# patches (of {flat.size})", color="#e8eaed")
    ax.tick_params(colors="#e8eaed"); ax.legend(fontsize=8, facecolor="#0e1117", labelcolor="#e8eaed")
    for s in ax.spines.values():
        s.set_color("#3a3f47")
    fig.tight_layout(); st.pyplot(fig); plt.close(fig)
    st.caption(f"{n}×{n} patch grid → {flat.size} distances.  range [{flat.min():.2f}, {flat.max():.2f}].  "
               "A right-shifted/heavy-tailed spread = lots of patches differ (capture noise or real wear).")

    # (4) the actual most-similar and most-different patches (reference | user)
    K = st.slider("patches to show per group", 4, 12, 8)
    order = np.argsort(flat)
    st.markdown("##### 🟩 Most SIMILAR patches  ·  *reference | user*")
    for col, idx in zip(st.columns(K), order[:K]):
        i, j = divmod(int(idx), n)
        col.image(patch_pair(ref["rgb"], embs[sel]["rgb"], i, j, n), caption=f"d={flat[idx]:.2f}")
    st.markdown("##### 🟥 Most DIFFERENT patches  ·  *reference | user*")
    for col, idx in zip(st.columns(K), order[::-1][:K]):
        i, j = divmod(int(idx), n)
        col.image(patch_pair(ref["rgb"], embs[sel]["rgb"], i, j, n), caption=f"d={flat[idx]:.2f}")
    st.caption("Each tile = the SAME grid cell (i,j) in the reference (left) and the user copy (right). "
               "If 'different' patches look visually identical, that distance is misalignment/capture, not damage.")
