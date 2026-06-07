import os, sys
os.environ["CARD_DETECTOR"] = "seg"
sys.path.insert(0, ".")
sys.path.insert(0, "../backend")
from dotenv import load_dotenv
load_dotenv("../.env.local", override=True)
load_dotenv("../backend/.env", override=False)
import cv2, numpy as np, warp_cache as WC, nonvlm_cv as N

DIAG = "/Users/srinivasdoddi/srini/agentic-card-seller-os/notebooks/diag"
os.makedirs(DIAG, exist_ok=True)

NOISY = ["scraped_023", "scraped_115", "scraped_164", "scraped_113", "scraped_161"]
CLEAN = ["scraped_011", "scraped_013", "scraped_037", "scraped_047", "scraped_060"]

# ─────────────────────────────────────────────────────────────────────────────
# GRADIENT PROJECTION-PROFILE RIDGE detector
#
# For each side we scan candidate INNER-FRAME offsets in a search band starting
# just inside the cut edge. At each offset we measure the LENGTH of contiguous
# straight edge-energy running PARALLEL to that side. The true printed frame line
# is full-span (tall, sharp run-length peak); an artwork edge (the sphere on
# scraped_023) is short/curved → low run-length.  We use ORIENTED gradient
# (not color) so foil / full-bleed art is handled the same as a printed border.
# ─────────────────────────────────────────────────────────────────────────────

def _oriented_edge(gray, axis):
    """Edge magnitude of the gradient component PERPENDICULAR to the line we seek.
    For a vertical line (L/R sides) we want |d/dx| (horizontal gradient).
    For a horizontal line (T/B sides) we want |d/dy| (vertical gradient).
    axis='v' -> vertical line  -> Sobel x.  axis='h' -> horizontal line -> Sobel y.
    """
    g = cv2.GaussianBlur(gray, (0, 0), 1.2)
    if axis == "v":
        d = cv2.Sobel(g, cv2.CV_32F, 1, 0, ksize=3)
    else:
        d = cv2.Sobel(g, cv2.CV_32F, 0, 1, ksize=3)
    return np.abs(d)


def _ridge_profile(emag, axis, span_lo, span_hi):
    """For each offset (column if axis='v', row if axis='h') within [span_lo,span_hi)
    of the perpendicular extent, return (runlen, strength).
      runlen   = longest contiguous run of 'on' pixels along the line direction
                 (fraction of the side length)  -> the geometric full-span cue
      strength = mean edge magnitude along that offset                       """
    if axis == "v":
        # lines are vertical; offset indexes columns; run along rows (axis 0)
        sub = emag  # rows x cols
        along_len = sub.shape[0]
        # adaptive 'on' threshold from the band itself
        band = sub[:, span_lo:span_hi]
    else:
        # lines are horizontal; offset indexes rows; run along cols
        sub = emag.T  # now offset indexes first axis too: cols x rows -> treat rows
        # we want per-row strength scanning rows; transpose so columns=along
        sub = emag  # rows x cols ; offset = row, along = col
        along_len = emag.shape[1]
        band = emag[span_lo:span_hi, :]

    thr = np.percentile(band, 80)  # local edge-on threshold
    thr = max(thr, 6.0)

    n = span_hi - span_lo
    runlen = np.zeros(n, np.float32)
    strength = np.zeros(n, np.float32)
    for i in range(n):
        off = span_lo + i
        if axis == "v":
            line = emag[:, off]
        else:
            line = emag[off, :]
        on = line >= thr
        strength[i] = line.mean()
        # longest contiguous run of True
        if on.any():
            # run lengths via diff of cumulative
            idx = np.flatnonzero(np.diff(np.concatenate(([0], on.view(np.int8), [0]))))
            runs = idx[1::2] - idx[0::2]
            runlen[i] = runs.max() / float(along_len)
    return runlen, strength


def detect_frame_ridge(warped, cb):
    h, w = warped.shape[:2]
    gray = cv2.cvtColor(warped, cv2.COLOR_BGR2GRAY).astype(np.float32)
    x1, y1, x2, y2 = [int(round(v * d)) for v, d in zip(cb, [w, h, w, h])]
    iw, ih = x2 - x1, y2 - y1

    # search band: from a tiny inset off the cut edge inward to MAX_FRAC of the dim.
    MIN_FRAC, MAX_FRAC = 0.004, 0.14
    EXCL = 0.06  # exclude corners when measuring the perpendicular gradient field

    emag_v = _oriented_edge(gray, "v")  # for L/R (vertical lines)
    emag_h = _oriented_edge(gray, "h")  # for T/B (horizontal lines)

    # Restrict the "along" extent to the central part of each side (corner excl.)
    cx, cy = int(iw * EXCL), int(ih * EXCL)
    res = {}

    def pick(runlen, strength, span_lo, reverse=False):
        """Pick the offset of the FULL-SPAN ridge NEAREST the cut edge.
        Score = runlen (geometric) gated; among offsets with runlen above a
        fraction of the max runlen, take the one nearest the edge (smallest off)."""
        if reverse:
            runlen = runlen[::-1]
            strength = strength[::-1]
        # combined ridge score: full-span AND strong
        sc = runlen * (0.5 + 0.5 * strength / (strength.max() + 1e-6))
        peak = sc.max()
        # candidates that are clearly full-span ridges
        good = np.flatnonzero((runlen >= 0.62) & (sc >= 0.55 * peak))
        if len(good) == 0:
            good = np.flatnonzero(sc >= 0.7 * peak)
        chosen = int(good[0])  # nearest the edge (band scanned edge->inward)
        return chosen, sc

    # LEFT: vertical line, scan columns from x1 inward
    band = emag_v[y1 + cy:y2 - cy, :]
    lo, hi = x1 + int(iw * MIN_FRAC), x1 + int(iw * MAX_FRAC)
    rl, st = _ridge_profile(band, "v", lo, hi)
    cL, scL = pick(rl, st, lo)
    OL = cL  # offset within band index == columns from lo
    res["xL"] = lo + cL

    # RIGHT: vertical line, scan columns from x2 inward (reverse)
    rl, st = _ridge_profile(band, "v", x1 + int(iw * (1 - MAX_FRAC)), x1 + int(iw * (1 - MIN_FRAC)))
    cR, scR = pick(rl, st, 0, reverse=True)
    spanR_hi = x1 + int(iw * (1 - MIN_FRAC))
    res["xR"] = spanR_hi - cR

    # TOP: horizontal line, scan rows from y1 inward
    bandH = emag_h[:, x1 + cx:x2 - cx]
    lo, hi = y1 + int(ih * MIN_FRAC), y1 + int(ih * MAX_FRAC)
    rl, st = _ridge_profile(bandH, "h", lo, hi)
    cT, scT = pick(rl, st, lo)
    res["yT"] = lo + cT

    # BOTTOM: horizontal line, scan rows from y2 inward (reverse)
    rl, st = _ridge_profile(bandH, "h", y1 + int(ih * (1 - MAX_FRAC)), y1 + int(ih * (1 - MIN_FRAC)))
    cB, scB = pick(rl, st, 0, reverse=True)
    spanB_hi = y1 + int(ih * (1 - MIN_FRAC))
    res["yB"] = spanB_hi - cB

    cr = {"x1": res["xL"] / w, "y1": res["yT"] / h,
          "x2": res["xR"] / w, "y2": res["yB"] / h}
    return cr, res


def split(cb, cr):
    x1, y1, x2, y2 = cb
    bl = max(0., cr["x1"] - x1); br = max(0., x2 - cr["x2"])
    bt = max(0., cr["y1"] - y1); bb = max(0., y2 - cr["y2"])
    lr = int(round(bl / (bl + br) * 100)) if (bl + br) > 1e-6 else 50
    tb = int(round(bt / (bt + bb) * 100)) if (bt + bb) > 1e-6 else 50
    return f"{lr}/{100-lr}", f"{tb}/{100-tb}"


def run(name, save=False):
    p = f"feature_extraction_dataset/10/{name}_front.jpeg"
    det = WC.get_det(p); warped = det["warped"]; cb = det["cb"]
    cen = N.compute_centering_hybrid(warped, cb)
    cr_new, _ = detect_frame_ridge(warped, cb)
    lr_old, tb_old = cen["left_right"], cen["top_bottom"]
    lr_new, tb_new = split(cb, cr_new)
    print(f"{name:14s}  OLD L/R={lr_old:7s} T/B={tb_old:7s}   "
          f"NEW L/R={lr_new:7s} T/B={tb_new:7s}")
    if save:
        h, w = warped.shape[:2]
        viz = warped.copy()
        # old (red) and new (green)
        cro = cen["content_region"]
        cv2.rectangle(viz, (int(cro["x1"]*w), int(cro["y1"]*h)),
                      (int(cro["x2"]*w), int(cro["y2"]*h)), (0, 0, 255), 3)
        cv2.rectangle(viz, (int(cr_new["x1"]*w), int(cr_new["y1"]*h)),
                      (int(cr_new["x2"]*w), int(cr_new["y2"]*h)), (0, 255, 0), 3)
        cv2.imwrite(f"{DIAG}/ridge_{name}.png", viz)
    return (lr_new, tb_new)


if __name__ == "__main__":
    print("=== NOISY (should move toward 50/50) ===")
    for n in NOISY:
        run(n, save=(n in ("scraped_023", "scraped_164")))
    print("=== CLEAN (should stay ~50/50) ===")
    for n in CLEAN:
        run(n, save=(n == "scraped_011"))
