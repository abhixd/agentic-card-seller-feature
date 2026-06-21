# Product stream — scope for Claude on this machine

You are working on the **product** work stream only. See [`/CONTRACT.md`](../CONTRACT.md) for how this fits
with the grading stream.

## What you own

- `apps/web` — the Next.js product app (Vercel). `@acs/web`.
- `apps/extension` — the Chrome extension. `@acs/extension`.
- `packages/*` — shared product packages (but **not** `packages/grading-contract`'s contents, which the
  grading stream owns the source of — you consume it).

## The grading boundary — never reach across it

Do not call the Python grader, the Railway internals, or anything in `services/`/`research/`. Grade a card
only through the typed client:

```ts
import { gradeCard, type GradeResponse } from "@acs/grading-contract";
const grade = await gradeCard(process.env.GRADING_API_URL!, { image, title, price });
```

- `GRADING_API_URL` selects the backend — Railway `production` (default), a `dev` deploy, or the local
  **mock**. The app's `app/api/grade` route is the single proxy point.
- Add `@acs/grading-contract` to `transpilePackages` in `next.config` (it ships raw TypeScript).
- Treat `economics`/`decision` as opaque for now; don't depend on `_`-prefixed keys.

## Develop without depending on machine B

Build against the **mock** so you never wait on the grading service:

- A mock `/grade` that returns canned, `GradeResponse`-shaped fixtures (import the types from
  `@acs/grading-contract` so the mock can't drift from the contract).
- Toggle via `GRADING_API_URL=mock` or a `USE_MOCK_GRADING` flag.

When the grading stream ships a new contract version, you'll see a `CONTRACT_VERSION` bump in
`@acs/grading-contract` — adopt new optional fields (like centering `confidence`) when you're ready; a MAJOR
bump means a breaking change that was coordinated with you.

## Don't touch (other stream)

`services/grading-api`, `research/`, `Dockerfile.grading`, `railway.toml`, `contract.py`. Need a response
shape change? Request it via the contract (version bump), don't edit the grader.
