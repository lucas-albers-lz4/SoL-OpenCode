# Composer 2.5: Action Fusion #4 and #6 review

Reviewer: Composer 2.5 (did not implement this slice). Implementer: Grok. Scope: `src/action-fusion/then-run-schema.ts`, `src/action-fusion/file-queue.ts`, and associated AF tests only.

## Verdict

**Accept**

No must-fix code changes applied. The Effect struct extension and pre-lock canonical dedupe match the issue findings; regression tests and manual probes align with Effect 4 APIs.

## Issue #4 — Effect input schemas

### Review answers

1. **`extendToolInputWithThenRun` and Effect 4** — Yes. Effect tool schemas are runtime functions; `Schema.isSchema` plus `fields` / `mapFields` is the correct struct guard (not `typeof === "object"`). `mapFields` spreads existing fields and adds `then_run` via `Schema.optionalKey(Schema.Struct({ command, timeout: Schema.optionalKey(...) }))`. `Schema.decodeUnknownSync` accepts `{ path }` without `then_run` and accepts `{ path, then_run: { command, timeout? } }`; invalid `then_run` shapes are rejected at decode time (verified with Effect `^4.0.1` in `node_modules/effect`).

2. **2.0.27 built-ins after wrap** — Host `Tool.ValueSchema` includes `Schema.Codec` (structs qualify). Extended struct remains a valid codec; optional `then_run` should pass host validation when `shellExecute` is present and schema patching is enabled. Wrapped `execute` still receives the decoded object and `stripThenRun` destructures `then_run` before calling the inner `mutate` with `mutationInput` only (`wrap-tools.ts`).

3. **Replay / double transform** — Idempotent for Effect: `"then_run" in input.fields` returns the same struct reference. No nested `then_run` field. Covered by `tests/then-run-schema.test.ts` and `tests/wrap-replay.test.ts`.

### Notes

- JSON Schema `{ type: "object" }` path unchanged in spirit: `structuredClone`, nested `properties` not mutated; `!Schema.isSchema(input)` avoids misclassifying codecs.
- JSON Schema path is not reference-idempotent on replay (each call clones again) but still adds a single `then_run` property; lower risk because 2.0.27 mutation tools use Effect structs.

## Issue #6 — Aliased patch paths / file queue

### Review answers

4. **Double canonicalization** — `withFusedFileQueues` builds deduped sorted `uniqueKeys` via `canonicalQueueKey`, then calls `withFusedFileQueue` per key, which canonicalizes again. Re-entry is stable for resolved paths; alias pairs (`a.txt` / `./a.txt`) collapse to one lock. Missing-path ENOENT walk still completes without deadlock (manual probe: two aliased missing paths under the same tree).

5. **Distinct files and empty list** — Distinct files still nest locks in sorted key order (no dropped work). `uniqueKeys.length === 0` runs `work()` with no acquire (empty patch path list after resolution).

6. **Tests** — Aliased existing-file deadlock regression is strong (1s race). Gaps listed below; none justify blocking accept.

## Must-fixes applied

None.

## Nits

- `tests/file-queue.test.ts`: multi-file case only asserts completion, not lock ordering or overlap; acceptable for #6 but weak as a serialization contract.
- No in-repo vitest for empty `paths` or missing-file alias dedupe (behaviour checked manually this review).
- `tests/then-run-schema.test.ts` decodes happy-path `timeout` but does not assert decode failure for non-number `timeout` (Effect rejects it; optional one-liner).
- JSON Schema replay could clone repeatedly; consider a `then_run` guard mirroring Effect if JSON fixtures ever ship in production tools.

## Leftover live gaps (unchanged by this slice)

- `StandardSchemaV1` inputs that are not Effect structs still cannot gain `then_run`.
- No integration test decoding real `@opencode` 2.0.27 `edit` / `write` / `patch` tool schemas from the host bundle (wrap-replay uses a local `Schema.Struct` stand-in).
- Live schema inspection for built-ins remains tracked separately (issue #2 Phase 3).

## Validation run (reviewer)

```
npx vitest run tests/then-run-schema.test.ts tests/file-queue.test.ts tests/wrap-replay.test.ts tests/then-run.test.ts tests/patch-paths.test.ts
# 5 files, 13 tests passed

npm run typecheck
# clean
```
