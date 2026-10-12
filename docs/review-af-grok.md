# Grok: Action Fusion #4 and #6

Implementer: Grok. Cross-check: Composer 2.5 (did not write these files). Observation Pack is out of scope here.

## #4 Effect input schemas

`extendToolInputWithThenRun` now extends Effect `Schema.Struct` via `mapFields` + `Schema.optionalKey`, in addition to JSON Schema `{ type: "object" }`.

- Effect schemas are functions at runtime; the struct guard uses `Schema.isSchema` + `fields`/`mapFields` (not `typeof === "object"`).
- Replay is idempotent: a struct that already has `then_run` is returned unchanged.
- JSON Schema path still clones and does not mutate nested `properties`.
- Non-struct / non-object schemas are unchanged.

Tests: `tests/then-run-schema.test.ts`, wrap path in `tests/wrap-replay.test.ts`.

## #6 aliased patch deadlock

`withFusedFileQueues` canonicalizes (`realpath` walk), **dedupes**, then sorts before the first nested acquire. `a.txt` and `./a.txt` take one lock.

Tests: `tests/file-queue.test.ts` (aliased paths must finish within 1s; two distinct files still run).

## Files

- `src/action-fusion/then-run-schema.ts`
- `src/action-fusion/file-queue.ts`
- `tests/then-run-schema.test.ts`
- `tests/file-queue.test.ts`
- `tests/wrap-replay.test.ts`

AF-only vitest: 13 passed. Did not run Observation Pack tests in this slice.

## Leftover

- StandardSchemaV1 inputs that are not Effect structs still cannot grow `then_run`. 2.0.27 built-ins are `Schema.Struct`.
- Live `edit`/`write`/`patch` schema inspection remains issue #2 Phase 3.
