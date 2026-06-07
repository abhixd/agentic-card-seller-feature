"""
CORAL fine-tune — the decisive 'is the wall the MODEL or the CAMERA?' gate.

Every prior method kept the backbone FROZEN (and frozen self-sup features are
condition-invariant). This UNFREEZES the last 2 transformer blocks of DINOv2 ViT-S
and trains a CORAL ordinal head on the 4-tier grade labels (≤6/7-8/9/10) over the
679 cached canonical warps — so the features themselves can learn a 1-D condition axis.

GATE (out-of-fold): does the learned scalar `s` separate the ADJACENT cuts that flat-photo
CV features can't?  Baselines (CV, 5-fold AUC): PSA9-vs-10 = 0.663, PSA8-vs-9 = 0.525.
If s's 9-vs-10 AUC clears ~0.7 (and fused exact% beats 44%), the wall was the MODEL.
If it stays ~0.55, the signal isn't in the flat photo → pivot to RakingLight capture.

Run: cd notebooks && KMP_DUPLICATE_LIB_OK=TRUE ../backend/venv/bin/python diag/coral_finetune.py
"""
import os, sys
os.environ.setdefault("KMP_DUPLICATE_LIB_OK", "TRUE"); os.environ["CARD_DETECTOR"] = "seg"
sys.path.insert(0, "."); sys.path.insert(0, "../backend")
from dotenv import load_dotenv
load_dotenv("../.env.local", override=True); load_dotenv("../backend/.env", override=False)
import numpy as np, pandas as pd, cv2, torch, timm, time
import torch.nn as nn, torch.nn.functional as F
import warp_cache as WC
from sklearn.model_selection import StratifiedKFold
from sklearn.metrics import roc_auc_score, accuracy_score
from scipy.stats import spearmanr

SEED = 7; torch.manual_seed(SEED); np.random.seed(SEED)
TIER = {5: 0, 6: 0, 7: 1, 8: 1, 9: 2, 10: 3}; K = 4
EPOCHS, FOLDS, BS, S = 25, 5, 16, 224
dev = "mps" if torch.backends.mps.is_available() else "cpu"
MEAN = np.array([0.485, 0.456, 0.406], np.float32); STD = np.array([0.229, 0.224, 0.225], np.float32)

# ── load 679 warps + labels into memory (resize once) ───────────────────────
df = pd.read_csv("feature_extraction_dataset/cv_raw.csv")
df = df[df.actual_psa.isin(TIER)].reset_index(drop=True)
imgs, ok = [], []
for p in df.path:
    d = WC.load_warp(p)
    if d is None:
        ok.append(False); continue
    imgs.append(cv2.cvtColor(cv2.resize(d["warped"], (S, S)), cv2.COLOR_BGR2RGB)); ok.append(True)
df = df[ok].reset_index(drop=True)
X_img = np.stack(imgs)                                  # (N,224,224,3) uint8
y = np.array([TIER[int(g)] for g in df.actual_psa]); psa = df.actual_psa.values
cvcols = [c for c in df.columns if c.startswith(("m.", "mag.", "conf.", "cen."))]
Xcv = df[cvcols].apply(pd.to_numeric, errors="coerce").fillna(0).values
print(f"loaded {len(df)} cards  tiers={np.bincount(y)}  device={dev}")

def aug(u8):                                            # light, wear-PRESERVING aug (no blur)
    h, w = u8.shape[:2]
    ang = np.random.uniform(-3, 3); sc = np.random.uniform(0.97, 1.03)
    tx, ty = np.random.uniform(-0.03, 0.03, 2) * [w, h]
    M = cv2.getRotationMatrix2D((w / 2, h / 2), ang, sc); M[:, 2] += [tx, ty]
    out = cv2.warpAffine(u8, M, (w, h), borderMode=cv2.BORDER_REFLECT)
    out = out.astype(np.float32) * np.random.uniform(0.9, 1.1) + np.random.uniform(-10, 10)  # bright/contrast
    return np.clip(out, 0, 255)

def to_tensor(batch_u8, train):
    arr = np.stack([aug(b) if train else b.astype(np.float32) for b in batch_u8]) / 255.
    arr = (arr - MEAN) / STD
    return torch.from_numpy(arr.transpose(0, 3, 1, 2)).float().to(dev)

class Net(nn.Module):
    def __init__(self):
        super().__init__()
        self.bb = timm.create_model("vit_small_patch14_dinov2.lvd142m", pretrained=True,
                                    num_classes=0, img_size=S, dynamic_img_size=True)
        for p in self.bb.parameters(): p.requires_grad = False
        for blk in self.bb.blocks[-2:]:
            for p in blk.parameters(): p.requires_grad = True
        for p in self.bb.norm.parameters(): p.requires_grad = True
        self.head = nn.Sequential(nn.Linear(384, 128), nn.GELU(), nn.Dropout(0.3), nn.Linear(128, 1))
        self.bias = nn.Parameter(torch.zeros(K - 1))
    def forward(self, x):
        s = self.head(self.bb.forward_features(x)[:, 0]).squeeze(-1)      # condition scalar
        return s, s[:, None] - self.bias[None, :]                        # logits P(tier>k)

def coral_loss(logits, t, w):
    lev = (t[:, None] > torch.arange(K - 1, device=t.device)[None, :]).float()
    l = F.binary_cross_entropy_with_logits(logits, lev, reduction="none").mean(1)
    return (l * w).mean()

# ── 5-fold CV, collect out-of-fold scalar + tier prediction ─────────────────
oof_s = np.zeros(len(df)); oof_tier = np.zeros(len(df), int)
clsw = len(y) / (K * np.bincount(y))                    # inverse-freq class weights
skf = StratifiedKFold(FOLDS, shuffle=True, random_state=SEED)
t0 = time.time()
for fold, (tr, te) in enumerate(skf.split(X_img, y)):
    net = Net().to(dev)
    opt = torch.optim.Adam([
        {"params": [p for p in net.bb.parameters() if p.requires_grad], "lr": 1e-5},
        {"params": list(net.head.parameters()) + [net.bias], "lr": 1e-3}], weight_decay=1e-4)
    wtr = torch.tensor(clsw[y[tr]], dtype=torch.float32, device=dev)
    for ep in range(EPOCHS):
        net.train(); perm = np.random.permutation(len(tr))
        for i in range(0, len(tr), BS):
            idx = tr[perm[i:i + BS]]
            xb = to_tensor(X_img[idx], train=True); tb = torch.tensor(y[idx], device=dev)
            wb = torch.tensor(clsw[y[idx]], dtype=torch.float32, device=dev)
            opt.zero_grad(); s, lo = net(xb); coral_loss(lo, tb, wb).backward(); opt.step()
    net.eval()
    with torch.no_grad():
        for i in range(0, len(te), BS):
            idx = te[i:i + BS]; s, lo = net(to_tensor(X_img[idx], train=False))
            oof_s[idx] = s.cpu().numpy(); oof_tier[idx] = (torch.sigmoid(lo) > 0.5).sum(1).cpu().numpy()
    print(f"  fold {fold+1}/{FOLDS} done ({time.time()-t0:.0f}s)", flush=True)

# ── SAVE FIRST (results survive any later crash), then print gate metrics FLUSHED.
#    NO xgboost here — torch+xgboost share OpenMP and segfault (exit 139) in one process.
#    The CV-fusion runs separately in diag/coral_fuse.py.
pd.DataFrame({"file": df.file, "actual_psa": psa, "tier": y, "oof_s": oof_s, "oof_tier": oof_tier}
             ).to_csv("diag/coral_oof.csv", index=False)
def cut_auc(a, b):
    m = np.isin(psa, [a, b]); return roc_auc_score((psa[m] == b).astype(int), oof_s[m])
ex = accuracy_score(y, oof_tier); w1 = np.mean(np.abs(oof_tier - y) <= 1)
print("\n================ CORAL fine-tune — OUT-OF-FOLD gate ================", flush=True)
print(f"learned scalar s — Spearman(s, PSA) = {spearmanr(oof_s, psa)[0]:+.3f}", flush=True)
print("ADJACENT-CUT AUC of s   (CV-feature baseline in parens):", flush=True)
print(f"   PSA9 vs 10 : {cut_auc(9,10):.3f}   (CV 0.663)   <- the ceiling cut; GATE >~0.70", flush=True)
print(f"   PSA8 vs 9  : {cut_auc(8,9):.3f}   (CV 0.525)", flush=True)
print(f"   PSA5 vs 10 : {cut_auc(5,10):.3f}   (CV 0.871)", flush=True)
print(f"\nCORAL tier head: EXACT={100*ex:.1f}%  within-1={100*w1:.1f}%   (CV baseline 44% / 87%)", flush=True)
print("saved diag/coral_oof.csv  →  now run: ../backend/venv/bin/python diag/coral_fuse.py", flush=True)
