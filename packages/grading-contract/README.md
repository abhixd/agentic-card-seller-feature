# @acs/grading-contract

The stable boundary between the two work streams:

- **product** (`apps/web`, `apps/extension`) — *consumes* the types + client here.
- **grading** (`services/grading-api`, `research/`) — *produces* a `/grade` response that conforms.

So either stream can move independently as long as this contract holds.

## Use it (product side)

```ts
import { gradeCard, CONTRACT_VERSION, type GradeResponse } from "@acs/grading-contract";

const grade = await gradeCard(process.env.GRADING_API_URL!, { image, title, price });
//    ^ GradeResponse — point GRADING_API_URL at Railway `production`, a `dev` deploy, or the local mock.
```

`apps/web` consumes raw TypeScript from this package, so add it to `transpilePackages` in `next.config`:

```js
transpilePackages: ["@acs/grading-contract"]
```

## Source of truth & regeneration

`services/grading-api/contract.py` is the source of truth. The JSON Schema in `schema/` is generated from it:

```bash
cd services/grading-api && python export_openapi.py   # regenerates schema/grade-response.schema.json
```

`src/types.ts` is hand-authored to mirror the schema. To verify it hasn't drifted:

```bash
npm run generate   # writes src/types.generated.ts via json-schema-to-typescript; diff against types.ts
```

## Versioning

`CONTRACT_VERSION` here must equal `CONTRACT_VERSION` in `contract.py`.

- **Optional field added** → backwards-compatible → bump MINOR, update both, ship independently.
- **Field renamed/removed/retyped** → BREAKING → bump MAJOR, update both streams in the **same** change.

Internal `_`-prefixed keys (e.g. `_warped_jpeg_b64`, `_source`) ride on the wire but are **not** part of the
contract — do not depend on them from the product.

See [`/CONTRACT.md`](../../CONTRACT.md) for the full workflow.
