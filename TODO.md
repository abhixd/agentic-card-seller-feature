# TODO / Roadmap — agentic-card-seller-os

## 🔜 Now: deploy seg detector (API approach)
- [ ] Add `card_segmenter.py` to `Dockerfile.grading` COPY list ✅ (done)
- [ ] Commit + push seg detector changes to GitHub `main`
- [ ] Railway `card-grader-api` (production): set `CARD_DETECTOR=seg_then_yolo` + `ROBOFLOW_API_KEY`
- [ ] `railway up`; verify `/grade` returns `_detector=seg` + `_card_contour_warped`
- Standby: previous YOLO-only deployment kept in Railway history (rollback to restore)

## 🧪 Later: distill Detector C → local YOLO-seg model  ← (added per request)
Goal: remove the **runtime Roboflow dependency** so the seg detector runs fully
in-container like Detector A (no per-grade API call, no external latency/quota).

Why it's needed: `general-segmentation-api-6` is a **hosted foundation-model
workflow** (forked from a Roboflow template, promptable by `classes`) — there is
no small custom weight file to download (workspace has no trained seg model).

Plan (knowledge distillation):
1. **Auto-label** a corpus of card images by running them through the
   `general-segmentation-api-6` workflow → use its smoothed polygons as
   ground-truth masks. Augment with boundary corrections collected via `/feedback`.
2. **Train** a small `YOLO11n-seg` on that dataset (new notebook, mirror
   `notebooks/train_yolo_obb.ipynb`).
3. **Export** `best.pt` (~6–25 MB) → bundle in the image like `yolo_obb_best.pt`.
4. Add a **local seg branch** in `backend/card_segmenter.py` (load local YOLO-seg,
   mask → contour) so `CARD_DETECTOR=seg` runs in-container with no API call.
5. Compare the local seg model vs the Roboflow workflow vs the (retrained) YOLO-OBB
   in `notebooks/14_model_comparison.ipynb`.

See `backend/MODEL_REGISTRY.md` for both detectors' identities/config.

## 🧰 Other flagged follow-ups (non-blocking)
- [ ] Render `_card_contour_warped` (rounded-corner outline) in the extension
      sidepanel centering audit (backend already returns it; client still draws
      the axis-aligned `card_boundary` box).
- [ ] eBay comps: move off the decommissioned Finding API to the **Browse API**
      (needs production OAuth creds); comps currently show "NO DATA".
- [ ] Re-pin `torch`/`torchvision` in `Dockerfile.grading` for reproducible builds
      (currently unpinned after the 2.3.0+cpu index removal).
- [ ] Stage-B aggregator recalibration via `regenerate_training_data.py`.
- [ ] Retrain Detector A (YOLO-OBB) and re-compare against Detector C.
- [ ] Rotate the Roboflow eval API key before high-volume production use.
