# Spike: tool execute wrap (Action Fusion)

Pinned build: `@opencode/cli@2.0.27` / `@opencode/plugin@2.0.27` ([pin.md](./pin.md)).

## Proved from installed types and adapter source

| Topic | Finding |
|-------|---------|
| Plugin entry | `Plugin.define({ id, setup })` in `@opencode/plugin/promise/plugin`; `setup` may be `async` and return a cleanup function ([`plugin.d.ts`](../node_modules/@opencode/plugin/dist/promise/plugin.d.ts)). |
| Tool transform | `ctx.tool.transform((editor) => void)` registers a callback; `Transform` returns `Registration` with `dispose` ([`registration.d.ts`](../node_modules/@opencode/plugin/dist/promise/registration.d.ts)). |
| `ToolEditor` | `get(id)`, `update(id, (tool) => void)` — missing IDs are ignored on update ([`tool.d.ts`](../node_modules/@opencode/plugin/dist/promise/tool.d.ts)). |
| `editor.update` / `execute` | Promise adapter wraps the **current** effect executor in `promiseExecutor`, passes a mutable `Info` into the update callback, then reassigns `tool.execute` to call the **post-update** promise executor ([`adapter.js`](../node_modules/@opencode/plugin/dist/promise/adapter.js) ~346–356). Wrap logic must capture `tool.execute` **inside** `update`, not outside. |
| Execute signature (promise API) | `(input, context: ToolContext) => Promise<Tool.Result>` where `ToolContext` adds `signal: AbortSignal` and async `progress` ([`tool.d.ts`](../node_modules/@opencode/plugin/dist/promise/tool.d.ts)). |
| JSON Schema input | Tool `input` is `Tool.ValueSchema` (JSON Schema allowed). This spike **replaces** top-level `input` with a shallow copy plus a new `properties.then_run`, skipped when the schema already declares one. |
| Path field | Host mutation tools use `path` (not Pi `filePath` / `@` paths). Queue + hash guard resolve with `path.resolve(cwd, path)` only. |
| Patch paths | `@opencode/util/patch` `Patch.parse(patchText)` yields hunks with `path` / `movePath`; written targets are enumerated for hash guard + queue ([`patch.d.ts`](../node_modules/@opencode/util/dist/patch.d.ts)). |
| `then_run.timeout` | Seconds in schema; converted to ms in stub (`thenRunTimeoutMs`) for future `shell` calls (OpenCode shell default 120_000 ms). |

## Proved in unit tests (no live OpenCode)

- `tests/wrap-replay.test.ts`: simulates transform **replay** by resetting the stored base `execute` between passes; two invocations call the base executor twice, not four (no double-wrap).
- `tests/wrap-replay.test.ts`: nested schema object is not mutated when adding `then_run`.
- `tests/patch-paths.test.ts`: patch path enumeration and parse failure handling.

## Patch `then_run` in schema

**Implemented (not omitted).** `@opencode/util` `Patch.parse` can list written paths for valid unified patch text, so `patch` receives the same optional `then_run` property as `edit` / `write`. At execute time, if parsing fails or no written paths are found, fused follow-up is skipped even when `then_run` is present.

## Still requires a live OpenCode session

- Confirm transform replay on real `tool.reload()` / plugin reload resets wrapped executors as documented.
- Inspect live `edit` / `write` / `patch` JSON Schema shapes after host registration (this spike clones whatever the editor exposes).
- Fused **`shell.execute`** permission path (go/no-go for real `then_run`; current code uses `[stub]` only).
- End-to-end tool call: strip `then_run`, mutation result shape, hash guard on real files, parallel fused edits on one file.
- GPT-only agents that expose `patch` but not `edit`/`write`.

## Out of scope in this spike

Observation Pack, `obs_recall`, context hooks, `tool.execute.after`, and calling built-in `shell.execute`.
