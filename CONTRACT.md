# Decoupling the two work streams

This repo is developed as **two independent streams** that meet only at one boundary — the grading
service's HTTP contract. Either can move on its own machine without waiting on the other.

| Stream | Owns | Machine | Branches | Deploys to |
|---|---|---|---|---|
| **product** | `apps/web`, `apps/extension`, `packages/*` (except the contract source) | A | `product/*` | Vercel |
| **grading** | `services/grading-api`, `research/`, `Dockerfile.grading`, `railway.toml` | B (CV) | `grading/*` | Railway |
| **shared boundary** | `packages/grading-contract` + `services/grading-api/contract.py` | — | reviewed by both | — |

`turbo --affected` means each machine's CI only builds/tests what it touched.

## The boundary

The product never imports grading internals — it calls the service and uses the typed client:

```ts
import { gradeCard, type GradeResponse } from "@acs/grading-contract";
const grade = await gradeCard(process.env.GRADING_API_URL!, { image, title, price });
```

- **Source of truth:** `services/grading-api/contract.py` (`GradeResponse`). Regenerate the schema with
  `python services/grading-api/export_openapi.py` after any change.
- **Types/client:** `packages/grading-contract` (consumed by `apps/web`; add it to `transpilePackages`).
- **Endpoint:** `apps/web/app/api/grade` proxies to `GRADING_API_URL` (so the URL — not code — selects
  which grading backend the app talks to).

### Public response shape (v1.0.0)

| field | type | notes |
|---|---|---|
| `overall_score` | number? | 1..10 |
| `psa_equivalent` | string? | e.g. `"PSA 9 MINT"` |
| `centering` | `{ score, left_right, top_bottom, reliable, notes?, content_region?, confidence? }` | `left_right`/`top_bottom` are `"49/51"` strings; `confidence` (0..1) is the **planned** faint-edge/thin-border reliability — null until grading fills it in |
| `corners` / `edges` / `surface` | `{ score, worst_severity? }` | |
| `issues` | `{ corners[], edges[], surface[], centering[] }` | human-readable findings |
| `confidence` | `"low" \| "medium" \| "high"`? | overall grade confidence |
| `economics` / `decision` | object? | present when a title/identity is supplied; treat as opaque for now |

`_`-prefixed keys (`_warped_jpeg_b64`, `_source`, …) ride the wire but are **internal** — not part of the
contract. Don't depend on them from the product.

## Versioning rules

`CONTRACT_VERSION` must match in `contract.py` and `packages/grading-contract`.

- **Add an optional field** → backwards-compatible → bump MINOR, ship the two sides independently.
- **Rename / remove / retype a field** → BREAKING → bump MAJOR, update **both** streams in the same PR.

## So neither stream blocks the other

1. **Stable prod / moving dev (grading).** Run two Railway deploys: `production` (what the app points at)
   and `dev` (where stream B iterates). The app's `GRADING_API_URL` defaults to `production`
   (`https://card-grader-api-production.up.railway.app`). Promote `dev → production` **only** when the
   production-path validation harness passes (`research/notebooks/discriminants/disc_prodpath.py` /
   `disc_stages.py`). → grading-accuracy work can never destabilize the product.
2. **Mock (product).** `apps/web` ships a mock `/grade` returning canned, contract-shaped responses, so
   stream A develops and tests with zero dependency on machine B being online or grading being "done".
   Toggle with `GRADING_API_URL=mock` (or a `USE_MOCK_GRADING` flag).
3. **One rule:** never change the contract without bumping its version and updating both sides.

## Branching & deploy workflow

Each machine pushes its **own branch**; nothing deploys until it's merged to `main`. Because the streams
own disjoint directories, the merge is conflict-free (the only shared file is the contract — changed
deliberately with a version bump).

```
machine B (grading):  grading/<topic>  ── push ──┐
machine A (product):  product/<topic>  ── push ──┤── merge to main ──► deploy
                                                  │   (PR or fast-forward; disjoint paths = no conflicts)
```

- **`main` is the only deploy branch.** Feature branches get Vercel *preview* deploys (handy for the
  product) but never touch production.
- **Path-scoped deploys** — a merge to `main` only redeploys the service that changed:
  - **Railway (grading):** `railway.toml` `watchPatterns` (set ✓) — rebuilds only on
    `services/grading-api/**`, `Dockerfile.grading`, `railway.toml`.
  - **Vercel (product):** set the project's **Ignored Build Step** to `npx turbo-ignore` (machine A, in the
    Vercel dashboard) — rebuilds only when `@acs/web` or its deps changed. Note a contract change *does*
    rebuild the product (the contract is a dep of `@acs/web`) — which is correct.
- **Grading promotion gate:** merging grading to `main` deploys Railway `dev`; promote `dev → production`
  only when the production-path validation harness passes. So `main` can move without moving production.

Result: machine A and machine B each push and merge on their own cadence; the wrong service never
redeploys; and a merge is never blocked by the other stream's work.

## Working with Claude on each machine

Each stream has its own scoped `CLAUDE.md` so a Claude session on either machine sees only its world:

- `services/grading-api/CLAUDE.md` — grading stream.
- `apps/CLAUDE.md` — product stream.

Both point back here. The grading Claude honors this contract; the product Claude consumes it. The contract
file is the only thing they both touch — and only deliberately, with a version bump.
