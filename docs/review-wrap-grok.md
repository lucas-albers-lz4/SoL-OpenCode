# Grok review: Composer wrap / scaffold

Reviewer: Grok (did not author the slice). Pinned types: `@opencode/plugin@2.0.27`. `npm test` (6) and `npm run typecheck` re-run 2026-10-11: pass. SoL-Pi working tree was not modified by this slice.

## Verdict

**Accept the scaffold and wrap spike** as the base for Action Fusion. Do not treat `then_run` as shipped: command execution is still a stub. Live reload, fused-shell permission, and E2E hash/mutation remain open.

## What is correct

- Names: repo `SoL-OpenCode`, npm `sol-opencode`, plugin id `sol.opencode`. Unofficial / not NVlabs.
- Pin recorded in `docs/pin.md` (`@opencode/cli` + `@opencode/plugin` 2.0.27).
- `Plugin.define` + async `setup` returning cleanup; `ctx.tool.transform` disposed on unload.
- Invalid `ctx.options` logs and disables that mechanism; `setup` does not throw.
- Per-file queue acquired **before** `mutate()`, held through hash + stub command, released in `finally`. Multi-path patch queues in sorted order.
- Wrap captures `tool.execute` **inside** `editor.update`, matching the promise adapter (`adapter.js` ~346–356).
- Mutation path field is `path` (not Pi `filePath`); resolve is `path.resolve(cwd, path)` only.
- `then_run.timeout` is schema-seconds, converted to ms for a future shell call.
- Patch `then_run` is present because `@opencode/util` `Patch.parse` enumerates add/update targets; unparseable or empty path lists skip fusion at execute time. That matches the locked “enumerate all written paths or omit” rule.
- NVIDIA MIT notice kept on copied algorithm files; LICENSE states unofficial port.

## Must-fix before the AF port (not this spike)

1. **`THEN_RUN_FAILED` drops mutation output.** SoL-Pi throws `[mutationOutput, THEN_RUN_FAILED, error]`. `executeMutationThenRunSinglePath` / `Patch` throw only the marker + error, so a failed fused command would hide the successful edit from the model. Wire this when replacing the stub.
2. **Shell is stubbed.** `ctx.shell` has no `execute`. Fused follow-up must call captured `editor.get("shell").execute` (see [spike-permission.md](./spike-permission.md)). Do not spawn `child_process`.
3. **Plugin `PermissionDomain` has no `ask` / `create`.** Do not invent `permission.ask`. Permission for fused commands must come from inside built-in `shell` execute (`permission.assert` in OpenCode 2.0.27 `packages/core/src/tool/plugin/shell.ts`).
4. **SPDX on copied files is NVIDIA-only.** LICENSE already names port authors. Add a second `SPDX-FileCopyrightText` (SoL-OpenCode contributors) on files copied from SoL-Pi, consistent with `src/options.ts` / `src/deps/opencode-plugin-types.ts`.

## Test gap (documented, not a wrap bug)

`tests/wrap-replay.test.ts` resets the stored tool to the **unwrapped** `execute` between transform passes. That matches the documented V2 contract (reload replays transforms onto a fresh editor). It does **not** prove live `tool.reload()`. If a live rebuild ever replayed onto an already-wrapped executor, capturing `tool.execute` inside `update` would double-wrap. Keep the live check.

## Nits (do not block gates)

- `observationPack` defaults to `true` but is a no-op. Fine until OP lands; README already says reserved.
- `src/deps/opencode-plugin-types.ts` deep-imports `node_modules/...`. Prefer `@opencode/plugin/promise/tool` (or the package `./*` export) so types survive install layout.
- `effect` is a direct dependency only for `Result.match` on `Patch.parse`. Acceptable; `@opencode/plugin` already depends on `effect@4.0.1`.
- Empty `then_run.command` is accepted. Harmless until real shell; reject empty string when wiring execute.
- Result merge uses `content`. Host `Tool.Result` also has `output` + `metadata`. When mapping real shell results, preserve `metadata` (exit/signal/timeout) and do not treat non-zero exit as throw (OpenCode shell does not throw on non-zero).
