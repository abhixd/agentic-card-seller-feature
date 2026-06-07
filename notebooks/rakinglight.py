"""
rakinglight.py — RakingLight analysis harness (the bet on the PSA9-vs-10 cut).

A single flat photo lacks the surface signal that separates gem-mint from near-mint
(CORAL fine-tune confirmed: 9-vs-10 AUC stuck at 0.67 on flat photos). PSA reads it under
RAKING light. This harness takes a phone-torch TILT-SWEEP video (or a folder of frames) of
one card, canonicalizes every frame into our rectangle, and computes a SPECULAR-RESIDUAL map
(max - median over the sweep) — scratches / dents / whitening flare at grazing angles and
vanish at others, so they POP in the residual while uniform gloss cancels out.

  Per card: a specular-residual heatmap + a scalar "surface-activity" score (worn => higher).
  If scores rank-order with grade across your slabs, the new sensor unlocked the money cut.

Usage:
  Real clips:  put videos/frame-folders in embed_eval/rakinglight/<grade>/<card>.(mp4|folder)
               cd notebooks && KMP_DUPLICATE_LIB_OK=TRUE ../backend/venv/bin/python rakinglight.py
  Validate:    ../backend/venv/bin/python rakinglight.py --selftest
"""
import os, sys, glob, argparse
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE"); os.environ["CARD_DETECTOR"] = "seg"
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
from dotenv import load_dotenv
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".env.local"), override=True)
load_dotenv(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend", ".env"), override=False)
import numpy as np, cv2
CANON = (630, 880)                       # canonical card rectangle (w,h)


def read_frames(path, max_frames=36):
    """Video file OR folder of images → list of BGR frames (subsampled to ~max_frames)."""
    if os.path.isdir(path):
        fs = sorted(glob.glob(path + "/*"))
        fs = [f for f in fs if f.lower().endswith((".jpg", ".jpeg", ".png", ".webp"))]
        ims = [cv2.imread(f) for f in fs]
        return [im for im in ims if im is not None]
    cap = cv2.VideoCapture(path); n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT)) or 1
    step = max(1, n // max_frames); out = []
    i = 0
    while True:
        ok, fr = cap.read()
        if not ok:
            break
        if i % step == 0:
            out.append(fr)
        i += 1
    cap.release(); return out


def _orb_homography(src, dst):
    """Homography mapping src -> dst via ORB+RANSAC (gray)."""
    g1, g2 = cv2.cvtColor(src, cv2.COLOR_BGR2GRAY), cv2.cvtColor(dst, cv2.COLOR_BGR2GRAY)
    orb = cv2.ORB_create(3000)
    k1, d1 = orb.detectAndCompute(g1, None); k2, d2 = orb.detectAndCompute(g2, None)
    if d1 is None or d2 is None or len(k1) < 12 or len(k2) < 12:
        return None
    mt = sorted(cv2.BFMatcher(cv2.NORM_HAMMING, crossCheck=True).match(d1, d2), key=lambda m: m.distance)[:400]
    if len(mt) < 12:
        return None
    s = np.float32([k1[m.queryIdx].pt for m in mt]).reshape(-1, 1, 2)
    d = np.float32([k2[m.trainIdx].pt for m in mt]).reshape(-1, 1, 2)
    H, _ = cv2.findHomography(s, d, cv2.RANSAC, 5.0)
    return H


def canonicalize(frames, warped0=None):
    """All frames → the canonical rectangle. frame0 via Model-C seg (1 API call); the rest
    ORB-aligned to warped0 (no API, robust to the card moving during the tilt-sweep)."""
    if warped0 is None:
        import nonvlm_cv as N
        warped0 = cv2.resize(N.detect_and_warp(frames[0], detector="seg")["warped"], CANON)
    out = [warped0]
    for fr in frames[1:]:
        H = _orb_homography(fr, warped0)
        if H is None:
            continue
        out.append(cv2.warpPerspective(fr, H, CANON, borderMode=cv2.BORDER_REFLECT))
    return np.stack(out)                 # (T, H, W, 3)


def specular_maps(canon):
    """(T,H,W,3) aligned frames → (defect_map, diffuse).
    raw residual = max-median luminance over the sweep (specular flare). A clean card flares
    SMOOTHLY/uniformly; a defect flares as a LOCALIZED, high-frequency streak. So we HIGH-PASS
    the residual (subtract a large Gaussian) to keep only localized flare and cancel the smooth
    swept gloss — that high-passed map is the candidate-defect signal."""
    L = np.stack([cv2.cvtColor(f, cv2.COLOR_BGR2GRAY) for f in canon]).astype(np.float32)
    med = np.median(L, 0); resid = np.clip(L.max(0) - med, 0, None)
    defect = np.clip(resid - cv2.GaussianBlur(resid, (0, 0), 15), 0, None)   # localized flare only
    return defect, med.astype(np.uint8)


def activity_score(defect, border=0.12, top=0.002):
    """Surface-activity scalar = mean of the brightest `top` fraction of the localized-flare
    map in the content interior. Mean-of-top-k (vs a fixed percentile) is tolerant to defect
    SIZE — a thin scratch occupies a tiny pixel fraction but flares brightly."""
    h, w = defect.shape; b = int(border * min(h, w))
    inner = defect[b:h-b, b:w-b].ravel()
    k = max(50, int(top * inner.size))
    return float(np.sort(inner)[-k:].mean())


def overlay(diffuse, resid, vmax=None):
    vmax = vmax or (np.percentile(resid, 99.7) + 1e-6)
    a = np.clip(resid / vmax, 0, 1)
    hm = cv2.applyColorMap((a*255).astype(np.uint8), cv2.COLORMAP_JET)
    base = cv2.cvtColor(diffuse, cv2.COLOR_GRAY2BGR)
    a3 = (a*0.65)[..., None]
    return (base*(1-a3) + hm*a3).astype(np.uint8)


# ─────────────────────────── self-test (no real clips needed) ───────────────
def selftest():
    import warp_cache as WC
    # a real clean card warp as the canvas
    p = sorted(glob.glob("feature_extraction_dataset/10/*_front.jpeg"))[0]
    base = cv2.resize(WC.get_det(p)["warped"], CANON)
    H, W = base.shape[:2]
    def sweep(worn):
        frames = []
        for t in np.linspace(0, 1, 28):
            f = base.astype(np.float32).copy()
            # moving specular highlight band (raking light sweeping across)
            yy, xx = np.mgrid[0:H, 0:W]
            cx = W * t; band = np.exp(-((xx - cx) ** 2) / (2 * (0.12 * W) ** 2))
            f += (band[..., None] * 70)
            if worn:                       # a thin scratch that FLARES only when the band crosses it
                sx = int(0.55 * W); flare = np.exp(-((cx - sx) ** 2) / (2 * (0.10 * W) ** 2))
                f[int(0.3*H):int(0.7*H), sx:sx+3] += 150 * flare
            frames.append(np.clip(f, 0, 255).astype(np.uint8))
        return np.stack(frames)
    out = {}
    for name in ("clean", "worn"):
        canon = sweep(name == "worn")     # already aligned (synthetic)
        resid, diff = specular_maps(canon)
        out[name] = (resid, diff, activity_score(resid))
    print(f"self-test scores — clean={out['clean'][2]:.1f}  worn={out['worn'][2]:.1f}  "
          f"(worn should be HIGHER: {'PASS' if out['worn'][2] > out['clean'][2]*1.3 else 'FAIL'})")
    # alignment test: jitter a frame, ORB-realign, residual should be small
    M = cv2.getPerspectiveTransform(np.float32([[0,0],[W,0],[W,H],[0,H]]),
                                    np.float32([[6,3],[W-4,-2],[W-7,H-5],[2,H-3]]))
    jit = cv2.warpPerspective(base, M, (W, H), borderMode=cv2.BORDER_REFLECT)
    Hb = _orb_homography(jit, base); realigned = cv2.warpPerspective(jit, Hb, (W, H), borderMode=cv2.BORDER_REFLECT) if Hb is not None else jit
    err = lambda a, b: float(np.abs(cv2.cvtColor(a,cv2.COLOR_BGR2GRAY).astype(int)-cv2.cvtColor(b,cv2.COLOR_BGR2GRAY).astype(int)).mean())
    print(f"alignment test — before={err(jit,base):.1f}  after ORB-realign={err(realigned,base):.1f}  "
          f"({'PASS' if err(realigned,base) < err(jit,base)*0.5 else 'FAIL'})")
    mont = np.hstack([overlay(out["clean"][1], out["clean"][0]),
                      np.full((H, 6, 3), 60, np.uint8), overlay(out["worn"][1], out["worn"][0])])
    cv2.imwrite("diag/rakinglight_selftest.png", mont)
    print("saved diag/rakinglight_selftest.png  (left=clean, right=worn — scratch should glow on the right)")


def run_dir(root="embed_eval/rakinglight"):
    import re, pandas as pd
    rows = []
    for d in sorted(glob.glob(root + "/*")):
        m = re.search(r'(\d+)', os.path.basename(d)); grade = int(m.group(1)) if m else None
        if not os.path.isdir(d):
            continue
        for item in sorted(glob.glob(d + "/*")):
            try:
                frames = read_frames(item)
                if len(frames) < 4:
                    print(f"  ! {item}: too few frames"); continue
                canon = canonicalize(frames)
                resid, diff = specular_maps(canon)
                sc = activity_score(resid)
                name = os.path.splitext(os.path.basename(item))[0]
                cv2.imwrite(f"{root}/results_{grade}_{name}.png", overlay(diff, resid))
                rows.append({"grade": grade, "card": name, "frames": len(canon), "activity_score": round(sc, 2)})
                print(f"  PSA{grade} {name}: {len(canon)} frames, activity={sc:.1f}", flush=True)
            except Exception as e:
                print(f"  ! {item}: {str(e)[:80]}")
    if rows:
        df = pd.DataFrame(rows).sort_values(["grade", "card"]); df.to_csv(root + "/scores.csv", index=False)
        print("\n", df.to_string(index=False))
        if df.grade.nunique() > 1:
            from scipy.stats import spearmanr
            print(f"\nSpearman(grade, activity) = {spearmanr(df.grade, df.activity_score)[0]:+.3f}  "
                  "(want NEGATIVE: higher grade => less surface activity)")
    else:
        print(f"No clips found under {root}/ — add videos or frame-folders in {root}/psaNN/ (or <grade>/).")


if __name__ == "__main__":
    ap = argparse.ArgumentParser(); ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--dir", default="embed_eval/rakinglight")
    a = ap.parse_args()
    (selftest if a.selftest else lambda: run_dir(a.dir))()
