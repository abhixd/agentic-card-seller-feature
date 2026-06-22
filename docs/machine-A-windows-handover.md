# Machine A (product) — Windows handover

Start the **product** work stream on a Windows machine from a fresh GitHub clone. This is the
machine-specific companion to [`parallel-workstreams.md`](./parallel-workstreams.md) (the runbook) and
[`/CONTRACT.md`](../CONTRACT.md) (the boundary). Read those for the *why*; this file is the *do*, with the
corrections that matter on a clean checkout.

> Scope: you own `apps/web`, `apps/extension`, `packages/*` (you **consume** `@acs/grading-contract`, you
> don't edit its source). Never touch `services/`, `research/`, `Dockerfile.grading`, `railway.toml`,
> `contract.py` — those are the grading stream. See [`apps/CLAUDE.md`](../apps/CLAUDE.md).

## Two corrections to the runbook (true on a real checkout)

1. **Everything is under `src/`.** The runbook writes `apps/web/app/...` and `apps/web/lib/...`, but this
   app uses a `src/` directory and the `@/` alias maps to `src/`. Real paths:
   - route: `apps/web/src/app/api/grade/route.ts`
   - mock: `apps/web/src/lib/grading/mock.ts`  (`@/lib/grading/mock`)
2. **The grade route already exists — rewire it, don't create it.**
   `apps/web/src/app/api/grade/route.ts` already does Supabase auth + a 10 MB / image-type check, then calls
   the **legacy** `proxyGrade()` from `@/lib/grading/client`. Keep the auth and validation; replace only the
   grading call with `gradeCard()` from `@acs/grading-contract` (mock fallback). The old
   `lib/grading/client.ts` direct proxy is superseded by the contract client.

## 0. GitHub auth on Windows

The Mac's "chacha20 cipher" push note does **not** apply here. Set up auth fresh:

```powershell
gh auth login          # easiest; or add an SSH key, or clone over HTTPS
```

## 1. Clone + install

npm workspaces, packageManager `npm@11`. Match the Mac's toolchain: **Node 26 / npm 11**.

```powershell
git clone git@github.com:srdoddi/agentic-card-seller-os.git
cd agentic-card-seller-os
git checkout main; npm install          # root install hydrates all workspaces
git checkout -b product/bootstrap-grading-contract
```

## 2. The bootstrap edits (all confirmed still missing on `main`)

**a. Depend on the contract** — `apps/web/package.json`:
```jsonc
{ "dependencies": { "@acs/grading-contract": "*" } }
```

**b. Transpile it (ships raw TS)** — `apps/web/next.config.ts`:
```ts
const nextConfig = { transpilePackages: ["@acs/grading-contract"] };
export default nextConfig;
```

**c. Mock so you never wait on the grading service** — `apps/web/src/lib/grading/mock.ts` (NEW). Importing
the type means the mock can't drift from the contract:
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

**d. Route through the contract** — `apps/web/src/app/api/grade/route.ts`. Keep the existing auth +
`file`/size validation; swap the grading call:
```ts
import { gradeCard, type GradeResponse } from "@acs/grading-contract";
import { mockGrade } from "@/lib/grading/mock";

// ...after auth + file checks, with `file` (File) and optional `title`/`price` from the form:
const url = process.env.GRADING_API_URL ?? "mock";
const grade: GradeResponse =
  url === "mock" ? mockGrade() : await gradeCard(url, { image: file, title, price });
return Response.json(grade);
```

## 3. Env (root `.env.local`)

Minimum to develop the product against the mock:
```powershell
"GRADING_API_URL=mock" | Out-File -Append -Encoding utf8 .env.local
```

**Secrets are not in the clone** (gitignored). `GRADING_API_URL=mock` removes the dependency on the grading
service, **not** on auth — the `/grade` route requires a logged-in Supabase user, so you also need your own
Supabase keys to exercise it end-to-end. Other secrets used by the app on the Mac:
`ANTHROPIC_API_KEY`, `ROBOFLOW_API_KEY`, `ADMIN_TRAIN_TOKEN`, `ADMIN_EMAILS` (+ Supabase). Provision your
own; do not copy production secrets across machines.

## 4. Run + verify

```powershell
npm run web              # http://localhost:3000
```
POST a card image to `/api/grade` (while signed in) and confirm you get a `GradeResponse`-shaped payload
from the mock — no grading service required.

## 5. Branch → merge → deploy

- Work on `product/*` branches; merge to `main` (the only deploy branch). Feature branches get Vercel
  *preview* deploys, never production.
- Vercel rebuilds the product only when its files change: **Settings → Git → Ignored Build Step =
  `npx turbo-ignore`** (one-time dashboard setting). A `@acs/grading-contract` change *does* rebuild the
  product — correct, it's a dependency.

## Changing the contract (the one shared thing)

Don't edit the grader to get a new field. Adopt new **optional** fields when a MINOR `CONTRACT_VERSION` bump
lands in `@acs/grading-contract`; a MAJOR bump is a breaking change coordinated across both streams in one
PR. Full rules in [`/CONTRACT.md`](../CONTRACT.md).
