"""visual_id.py — visual candidate retrieval over the catalog renders (PRINT_REG_VISUAL_ID=1).

RAG over card artwork: every catalog render is pre-embedded with DINOv2-small (CLS token, L2-normalized)
into ptcg_dino.npz; at grade time the warped card is embedded the same way and the top-K nearest renders
become registration candidates. This makes candidate generation IMAGE-NATIVE — the vision-text identity
(Sonnet OCR of name/number under glare) stops being the gatekeeper for the whole anchor stack, and
registration remains the verifier exactly as before.

Feasibility probe (75-render gallery incl. the same-Pokémon distractor family): 6/6 hit@1, including the
three adversarial cases — ex_1_front glare foil (Sonnet hallucinates + SIFT sparse), card_035 in a case,
card_025 in a sleeve. Clean-render-vs-messy-photo domain gap is a non-issue for DINOv2.

Lazy singletons; every public call is non-fatal (returns [] on any failure) — the text path is untouched.
"""
import os
import numpy as np

ENABLED = os.environ.get("PRINT_REG_VISUAL_ID", "").strip().lower() in ("1", "true", "yes", "on")
_K = int(os.environ.get("PRINT_REG_VISUAL_K", "5"))
_MODEL_ID = "facebook/dinov2-small"
_NPZ = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ptcg_dino.npz")
_NPZ_TCGDEX = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tcgdex_dino.npz")   # optional:
# multi-language renders (ids "{lang}:{cid}") — same embedder, merged at load when present

_STATE: dict = {}


def _load():
    if "err" in _STATE:
        return None
    if "ids" not in _STATE:
        try:
            import torch
            from transformers import AutoImageProcessor, AutoModel
            z = np.load(_NPZ, allow_pickle=True)
            ids = [str(i) for i in z["ids"]]
            emb = z["emb"].astype(np.float32)                        # (N, 384), rows L2-normalized
            if os.path.exists(_NPZ_TCGDEX):
                z2 = np.load(_NPZ_TCGDEX, allow_pickle=True)
                ids += [str(i) for i in z2["ids"]]
                emb = np.vstack([emb, z2["emb"].astype(np.float32)])
            _STATE["ids"] = ids
            _STATE["emb"] = emb
            _STATE["proc"] = AutoImageProcessor.from_pretrained(_MODEL_ID)
            _STATE["model"] = AutoModel.from_pretrained(_MODEL_ID).eval()
            _STATE["torch"] = torch
        except Exception as e:
            _STATE["err"] = f"{type(e).__name__}: {e}"
            return None
    return _STATE


def candidates(card_bgr, k=None):
    """Warped card → top-k catalog ids by artwork similarity, [(cid, sim), ...]. [] on any failure."""
    st = _load()
    if st is None:
        return []
    try:
        import cv2
        rgb = cv2.cvtColor(card_bgr, cv2.COLOR_BGR2RGB)
        with st["torch"].no_grad():
            out = st["model"](**st["proc"](images=rgb, return_tensors="pt"))
        v = out.last_hidden_state[:, 0, :].squeeze().numpy().astype(np.float32)
        v /= (np.linalg.norm(v) + 1e-9)
        sims = st["emb"] @ v
        order = np.argsort(-sims)[: (k or _K)]
        return [(st["ids"][i], float(sims[i])) for i in order]
    except Exception:
        return []


def status():
    st = _STATE
    if "err" in st:
        return {"enabled": ENABLED, "error": st["err"]}
    return {"enabled": ENABLED, "loaded": "ids" in st, "n": len(st.get("ids") or [])}
