# Live gates on OpenCode 2.0.27

Re-verified 2026-10-12 against `@opencode/cli@2.0.27` via `opencode serve` + mock OpenAI-compatible provider (`spikes/live/`). Not a TUI click-through; same `Permission.assert` / HTTP request hooks the TUI uses. Isolated XDG under `spikes/live/.xdg/`.

Harness: `node spikes/live/run-live.mjs permission|context`

**Harness loading note:** OpenCode 2.0.27 requires local plugins to be directories with an `index.ts` entrypoint; direct `.ts` file paths are silently skipped. The runner now uses the directory entrypoints under `spikes/live/plugins/`. The `no-ask-once` result from the earlier file-path setup was a harness-loading failure, not a host permission failure.

**Root-entrypoint recheck:** With `dist/` absent, OpenCode 2.0.27 loaded the repository root as a local plugin directory; the mock provider's request included the `obs_recall` tool. This confirms the root `index.ts` re-export works in the host loader before `npm run build`.

## Action Fusion — **GO** (with implementer notes)

Captured `editor.get("shell").execute` from inside `sol_permission_probe` (`codemode: false`):

| Check | Result |
|-------|--------|
| Native permission request | `action: "shell"`, `resources: ["echo sol-opencode-permission-probe"]` |
| `source.id` | Parent tool call id (`call_sol_permission`), not a new shell id |
| `tool.execute.before` for `shell` | **0** (`nestedBeforeDelta: 0`) |
| Allow **once** | Command ran; `exit: 0`; output `sol-opencode-permission-probe` |
| **Reject** | Command did not run; probe `shell-threw` with **empty** `error` string (`DeclinedError` defect tunnel) |
| Dismiss / interrupt | Not run (same decline path as reject expected) |

Ship `then_run` via captured `shell.execute`. Map reject to a host-visible failure that still includes mutation output. Do not treat empty `catch` messages as success.

## Observation Pack — **GO via `http.request`**, not `context` messages

| Check | Result |
|-------|--------|
| `execute.after` size | `blobBytes: 10259`, `meetsGate: true` |
| Provider requests 1–2 after blob | `hasMarker: true`, `hasPlaceholder: false` (full host-visible text) |
| Mutating `session.hook("context")` messages | Hook `projected: true` on send 3, but **HTTP body still had the marker** (#44788-shaped) |
| Replacing `event.request` on `session.hook("http.request")` send 3 | `hasMarker: false`, `hasPlaceholder: true`, body shrank 36188 → 25950 |
| `GET /api/session/:id/context` after dispatch | `storedHasMarker: true`, `storedHasPlaceholder: false` |

Project by rewriting the **outgoing HTTP request body**. Do not rely on `session.hook("context")` message mutation reaching the provider on 2.0.27. Archive at `tool.execute.after`; join by `sessionID` + `toolCallID`. Restart-after-dispatch was not re-opened as a new process; the session-context read is the persistence oracle used here.

## Not claimed

- Live `tool.reload()` double-wrap
- GPT-only `patch` agents
- Parallel fused edits on one file
- TUI chrome (once/always/reject buttons) — HTTP `permission.reply` `decision` is the same service
