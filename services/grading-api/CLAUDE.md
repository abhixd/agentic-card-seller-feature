# Grading stream — scope for Claude on this machine

You are working on the **grading** work stream only. See [`/CONTRACT.md`](../../CONTRACT.md) for how this
fits with the product stream.

## What you own

- `services/grading-api/` — the FastAPI grading service (deployed on Railway via `/Dockerfile.grading` +
  `/railway.toml`). Detector: `CARD_DETECTOR=seg` (Roboflow). Backend: `GRADER_BACKEND=cv`.
  Per-side centering selector gated by `PERSIDE_CENTERING=1`.
- `research/` — the CV lab: ground truth, warp cache, the per-side selector experiments, the Streamlit
  diagnostic apps (`research/notebooks/discriminants/*`). This is gitignored lab space, not deployed.

## What you must NOT break

- **The contract.** `contract.py` (`GradeResponse`) is the boundary the product depends on. If `/grade`'s
  response shape changes, update `contract.py`, run `python export_openapi.py`, and follow the versioning
  rules in `/CONTRACT.md` (optional field = MINOR; rename/remove/retype = MAJOR + coordinate). Never
  silently change the shape of `centering`, the pillar scores, `overall_score`, or `psa_equivalent`.
- **Production.** Improve grading on the Railway `dev` deploy. Promote to `production` only after the
  production-path validation harness passes — never validate on cached lab warps alone (lab≠prod has
  bitten us: see `research/.../project notes`). The harness: `disc_prodpath.py` / `disc_stages.py`.

## Conventions learned the hard way

- Validate centering changes on the **production path** (raw image → live segment→warp→cb→select), not
  cached warps. A win on cached warps is not a win in production.
- The hard cards (faint card↔background contrast, thin borders) are hard at the **image** level, not the
  pipeline level. The product answer is the centering `confidence` field, not more CV tuning.
- Secrets (`ROBOFLOW_API_KEY`, `ANTHROPIC_API_KEY`, `POKEMON_PRICE_TRACKER_TOKEN`, eBay creds) live in env
  on the Railway `card-grader-api` service. Never paste secret values; never commit `.env.local`.
- Run lab Python with `services/grading-api/venv/bin/python`.

## Don't touch (other stream)

`apps/`, the Next.js product, the Vercel deploy, the mock. If a change there is needed, it goes through the
contract — flag it, don't reach across.
