# Spike: fused-shell permission (OpenCode 2.0.27)

Author: Grok. Cross-check: Composer 2.5 (did not write this spike). Pin: `@opencode/cli@2.0.27` / `@opencode/plugin@2.0.27`. Upstream source: [anomalyco/opencode@v2.0.27](https://github.com/anomalyco/opencode/tree/v2.0.27).

## Gate

Action Fusion is **GO** only if a fused `then_run` shows a **real** shell permission prompt for the **exact command**, with allow / deny / dismissed outcomes. Undocumented `permission.ask` does not satisfy. `tool.execute.before` on the parent edit/write/patch call is not a substitute.

Status: **GO on 2.0.27 live serve** (allow once + reject). See [spike-live-results.md](./spike-live-results.md). Dismiss/interrupt not separately run. Map `DeclinedError` (often empty `catch` message) to a host-visible fused failure.

## Plugin surface on 2.0.27 (installed types)

| API | Present? | Use for fusion |
|-----|----------|----------------|
| `ctx.shell.execute` | **No.** `ShellDomain` is only `hook("create.before")` | Cannot call |
| `ctx.permission.ask` | **No.** Plugin domain is `list` / `get` / `reply` + `hook("evaluate")` | Cannot call |
| `ctx.permission.create` | Client has it; **plugin context does not expose it** | Cannot call |
| `ToolContext.ask` | **No** on V2 `Tool.Context` | Cannot call |
| `editor.get("shell").execute` | Yes, after host registers the built-in | **Required path** |
| Spawn `child_process` / `Bun.$` | Possible | **Forbidden** |

## What 2.0.27 source does inside `shell.execute`

Built-in plugin: `packages/core/src/tool/plugin/shell.ts`.

`execute` calls `shell.create(..., (invocation) => prepare(invocation, context))`. `prepare`:

1. Resolves cwd, scans the command (`ShellParse.scan`).
2. `access.authorizeExternal` for the workdir (+ scanned directories).
3. If the scan found command nodes: `permission.assert({ action: "shell", resources: scanned commands, save, sessionID, agent, source: { type: "tool", messageID, id } })`.

`Permission.assert` (`packages/core/src/permission.ts`):

- `deny` → `BlockedError` (no prompt).
- `allow` → return.
- `ask` → `bus.publish(Permission.Event.Asked)` and **await** the pending deferred (TUI once / always / reject).

Therefore a **direct** call to captured `shell.execute` still runs `permission.assert`. It does **not** go through the session processor’s `tool.execute.before` / snapshot wrapper. That matches the plan: sibling `execute.before` will not fire; internal assert can still prompt.

Default evaluate when no matching rule: **`ask`**.

## Source caveats (not live-disproved)

- If the scanner returns **zero** commands, 2.0.27 **skips** `permission.assert` (`if (parsed.commands.length > 0)`). Known host bugs (#49948, #54393). Fusion must use ordinary commands that scan to at least one node (`echo …` is enough). Do not rely on parse-failure bypass.
- Nested execute uses the **parent tool context** (`sessionID` / `messageID` / `id`). The permission `source.id` will be the **edit/write/patch call id**, not a new shell call id. Live check: prompt still names the exact command in `resources`.
- `ctx.shell.hook("create.before")` **does** run (via `shell.create`). Other plugins can rewrite command/cwd/timeout before `prepare`. Fusion should pass the user `then_run.command` unchanged.
- Non-zero exit does **not** throw; result is `{ output, content, metadata }` with `exit` / `signal` / `timeout`. Map `[then_run:succeeded|failed]` from metadata; keep the mutation; one observation.
- On reject without feedback, `Permission.assert` tunnels `DeclinedError` via `Effect.die`. A fused `try/catch` may see a defect, not a plain `Error`. Live TUI must confirm reject/dismiss still keep the mutation and surface a host-visible failure.

## Live TUI checklist (still open)

Throwaway plugin: [../spikes/permission-probe.ts](../spikes/permission-probe.ts). Load it **alongside** `sol.opencode` so one later trial can be a real fused edit + `then_run`, not only the probe tool.

1. Load `sol.opencode` + the probe in a 2.0.27 session with default `ask` for shell.
2. Invoke the probe tool (or a wrapped edit with `then_run: { command: "echo sol-opencode-permission-probe" }`).
3. Confirm a native permission prompt for that exact command.
4. **Allow once:** command runs; mutation (if any) kept.
5. **Reject:** command does not run; mutation kept; host-visible error (not success+marker).
6. **Dismiss / interrupt:** same as reject; queue released.
7. Confirm `tool.execute.before` for `tool === "shell"` does **not** fire on the nested call (log in the probe).
8. Confirm `permission.asked` event (or TUI) shows `action: "shell"` and the scanned resource.

Until 3–7 are observed, Action Fusion execution stays **NO-GO** even though source looks viable.
