# Parallel work streams — product (machine A) ↔ grading (machine B)

This repo is developed as **two independent streams that meet only at one boundary** (the grading
service's HTTP contract), so they can progress in parallel on separate machines and merge without
conflicts. This doc is the runbook. The authoritative rules live in [`/CONTRACT.md`](../CONTRACT.md);
each stream also has a scoped `CLAUDE.md`.

## Current state (as of the foundation commit `28539f6` on `main`)

- ✅ **Machine B (grading)** foundation is done and merged to `main`:
  - `services/grading-api/contract.py` — `GradeResponse`, the source of truth (`CONTRACT_VERSION = 1.0.0`).
  - `packages/grading-contract` — `@acs/grading-contract`: TS types + `gradeCard()` client + JSON schema.
  - `railway.toml` `watchPatterns` — grading redeploys only on grading-path changes.
  - `CONTRACT.md`, `services/grading-api/CLAUDE.md`, `apps/CLAUDE.md`.
- ⬜ **Machine A (product)** — not started. The steps below bootstrap it.

## Who owns what

| Stream | Owns | Machine | Branches | Deploys |
|---|---|---|---|---|
| product | `apps/web`, `apps/extension`, `packages/*` (consumes the contract) | **A** | `product/*` | Vercel |
| grading | `services/grading-api`, `research/` (gitignored lab), `Dockerfile.grading`, `railway.toml` | **B** (this machine) | `grading/*` | Railway |
| shared | `packages/grading-contract` + `services/grading-api/contract.py` | both, by version bump | — | — |

## Getting machine A going (product stream)

> Run these **on machine A**. They are also captured for that machine's Claude in `apps/CLAUDE.md`.

**0. Clone + install**
```bash
git clone git@github.com:srdoddi/agentic-card-seller-os.git && cd agentic-card-seller-os
git checkout main && npm install        # npm workspaces; main already has @acs/grading-contract
```

**1. Depend on the contract package** — `apps/web/package.json`:
```json
{ "dependencies": { "@acs/grading-contract": "*" } }
```

**2. Transpile it (ships raw TS)** — `apps/web/next.config.ts`:
```ts
const nextConfig = { transpilePackages: ["@acs/grading-contract"] };
export default nextConfig;
```

**3. Call grading only through the client** — `apps/web/app/api/grade/route.ts`:
```ts
import { gradeCard, type GradeResponse } from "@acs/grading-contract";
import { mockGrade } from "@/lib/grading/mock";

export async function POST(req: Request) {
  const form = await req.formData();
  const url = process.env.GRADING_API_URL ?? "mock";
  const grade: GradeResponse =
    url === "mock"
      ? mockGrade()
      : await gradeCard(url, {
          image: form.get("image") as File,
          title: String(form.get("title") ?? ""),
          price: Number(form.get("price") ?? 0),
        });
  return Response.json(grade);
}
```

**4. Add the mock so you never wait on machine B** — `apps/web/lib/grading/mock.ts`:
```ts
import type { GradeResponse } from "@acs/grading-contract";
export function mockGrade(): GradeResponse {
  return {
    overall_score: 9, psa_equivalent: "PSA 9 MINT", summary: "mock",
    centering: { score: 7, left_right: "52/48", top_bottom: "60/40", reliable: true, confidence: 0.8 },
    corners: { score: 9, worst_severity: 1 }, edges: { score: 9, worst_severity: 1 },
    surface: { score: 10, worst_severity: 0 },
    issues: { corners: [], edges: [], surface: [], centering: [] }, confidence: "high",
  };
}
```
Importing the type means the mock cannot drift from the contract.

**5. Env** — `apps/web/.env.local` (and Vercel project env):
```bash
GRADING_API_URL=mock                                          # local dev: no dependency on machine B
# GRADING_API_URL=https://card-grader-api-production.up.railway.app   # staging/prod: the stable grader
```

**6. Vercel: path-scoped deploys** — in the Vercel project (dashboard → Settings → Git → Ignored Build
Step), set:
```
npx turbo-ignore
```
so the product rebuilds only when `@acs/web` or its deps changed. (A contract change *does* rebuild the
product — correct, it's a dep.)

## Branch → merge → deploy (both machines)

```
machine B (grading):  grading/<topic>  ── push ──┐
machine A (product):  product/<topic>  ── push ──┤── merge to main ──► deploy (path-scoped)
                                                  │   disjoint dirs ⇒ no conflicts
```

- `main` is the **only** deploy branch. Feature branches get Vercel *preview* deploys, never production.
- A merge only redeploys the service that changed: Railway via `watchPatterns` (grading), Vercel via
  `turbo-ignore` (product). A docs-only or cross-stream merge deploys nothing.
- **Grading promotion gate:** a grading merge deploys Railway `dev`; promote `dev → production` only when
  the production-path harness passes (`research/notebooks/discriminants/disc_prodpath.py` / `disc_stages.py`).
- Push from this machine needs the chacha20 cipher (see the git-push memory / repo note).

## Changing the contract (the one shared thing)

1. Edit `services/grading-api/contract.py`; run `python services/grading-api/export_openapi.py`.
2. Update `packages/grading-contract/src/types.ts` + bump `CONTRACT_VERSION` in both files.
3. **Optional field added** → MINOR → ship the two sides independently.
   **Rename / remove / retype** → MAJOR → update both streams in the same PR.

## Machine A onboarding checklist

- [ ] `@acs/grading-contract` in `apps/web` deps + `transpilePackages`
- [ ] `app/api/grade` uses `gradeCard()` behind `GRADING_API_URL`
- [ ] mock `/grade` + `GRADING_API_URL=mock` working locally
- [ ] Vercel Ignored Build Step = `npx turbo-ignore`
- [ ] first `product/*` branch pushed → preview deploy verified → merged to `main`

## Reference

- [`/CONTRACT.md`](../CONTRACT.md) — authoritative rules + public response shape table.
- `services/grading-api/CLAUDE.md` — grading scope (machine B). `apps/CLAUDE.md` — product scope (machine A).
- Grading prod: `https://card-grader-api-production.up.railway.app` (Railway `card-grader-api`).
