# Gate review: permission + context spikes (Composer 2.5)

Cross-review of Grok’s fused-shell permission and context-persistence spikes. Pinned host: `@opencode/cli@2.0.27` / `@opencode/plugin@2.0.27`. Upstream checked: [shell.ts@v2.0.27](https://github.com/anomalyco/opencode/blob/v2.0.27/packages/core/src/tool/plugin/shell.ts), [permission.ts@v2.0.27](https://github.com/anomalyco/opencode/blob/v2.0.27/packages/core/src/permission.ts). Composer did not author the spike docs or original probes; [review-wrap-grok.md](./review-wrap-grok.md) is cited only where the gate docs align or misstate that wrap review.

**This document does not grant Action Fusion or Observation Pack GO/NO-GO.** Live TUI (and, for OP, provider-payload + restart oracles) is still required.

---

## Verdicts

| Spike | Verdict | Summary |
|-------|---------|---------|
| [spike-permission.md](./spike-permission.md) | **Accurate** (minor nits) | Plugin-surface and upstream `permission.assert` narrative matches installed types and v2.0.27 core source. PRE-GO wording is acceptable if read as “source-aligned, not shipped.” |
| [spike-context.md](./spike-context.md) | **Needs fix** (doc + probe; probe patched) | Contract framing and checklist are sound; original [context-probe.ts](../spikes/context-probe.ts) did not implement its own checklist (no blob tool, no `execute.after`, no `http.request`, replace mode was not object replacement). |
| [permission-probe.ts](../spikes/permission-probe.ts) | **Accurate** as a narrow probe | Fair analog for captured `shell.execute` + parent `ToolContext`; not the full fused edit/write/patch path. |

---

## Review questions

### 1. Plugin-API claims on 2.0.27 types

**Accurate.**

- `Context.shell` is `ShellDomain`: only `hook("create.before")` — no `execute` ([shell.d.ts](../node_modules/@opencode/plugin/dist/promise/shell.d.ts)).
- Plugin `permission` is `Pick<PermissionApi, "list" | "get" | "reply">` plus `hook("evaluate")` — no `ask` / `create` ([permission.d.ts](../node_modules/@opencode/plugin/dist/promise/permission.d.ts)). Client `permission.create` exists on the HTTP client ([client.d.ts](../node_modules/@opencode/client/dist/promise/client.d.ts)) but is not on the plugin context ([plugin.d.ts](../node_modules/@opencode/plugin/dist/promise/plugin.d.ts)).
- V2 `ToolContext` extends `Omit<Tool.Context, "progress">`; schema `Tool.Context` has `sessionID`, `agent`, `messageID`, `id`, `progress` only — no `ask` ([tool.d.ts](../node_modules/@opencode/schema/dist/tool.d.ts), [tool.d.ts](../node_modules/@opencode/plugin/dist/promise/tool.d.ts)).
- Captured `editor.get("shell").execute` after host registration remains the required fusion path (consistent with [review-wrap-grok.md](./review-wrap-grok.md) and [wrap-tools.ts](../src/action-fusion/wrap-tools.ts)).

### 2. `permission.assert` inside captured `shell.execute` and scanner caveat

**Correct.**

Upstream `prepare` (shell plugin) runs `ShellParse.scan`, `access.authorizeExternal`, then:

```ts
if (parsed.commands.length > 0)
  yield* permission.assert({ action: name, resources: ..., sessionID, agent, source: { type: "tool", messageID, id } })
```

(`name === "shell"`.)

`Permission.assert` on v2.0.27: `deny` → `BlockedError`; `allow` → return; `ask` → publish `Permission.Event.Asked` and await the pending deferred (with `DeclinedError` tunneled via `Effect.die` on user reject without feedback).

**Scanner-zero-commands caveat:** Correct. Empty `parsed.commands` skips `permission.assert` entirely. Grok’s warning not to rely on parse-failure bypass and to use scannable commands (e.g. `echo …`) matches the source guard.

**Nits:**

- **must-fix (implementer awareness):** On reject/dismiss, upstream may surface `DeclinedError` as a defect through the Effect runtime, not always a plain `Error` in `try/catch`. The permission probe’s `try/catch` may still pass on allow-once; live TUI must confirm reject/dismiss behavior for fused calls.
- **nit:** Spike table says `action: "shell"` in checklist item 8; upstream uses the tool `name` constant (`"shell"`) — equivalent.

Nested call does not imply sibling `tool.execute.before` for `tool === "shell"`; that matches the plan (assert inside execute, not the session processor wrapper).

### 3. Permission probe vs fused path

**Mostly fair, incomplete.**

What it tests well:

- Capture `shell.execute` inside `ctx.tool.transform` (same pattern as [wrap-tools.ts](../src/action-fusion/wrap-tools.ts)).
- Passes the **parent** tool call’s `ToolContext` into `capturedExecute` (same shape fusion will use after mutation).
- Counts `tool.execute.before` for `shell` during nested execute (expect 0).

Gaps (live checklist still required):

- **must-fix (coverage):** Does not run through `sol.opencode` / `executeMutationThenRun*` — no queue, hash gate, or `THEN_RUN_*` merge behavior.
- **must-fix (coverage):** No simultaneous load with production wrap; permission + queue ordering untested.
- **nit:** No subscription to `permission` evaluate / `Permission.Event.Asked` logging (checklist item 8 is manual).
- **nit:** Does not assert `resources` contain the exact command string (TUI-only).

### 4. Context probe: `replace` vs `inplace`, blob detection, counting, JSON replace

**Original probe had bugs/gaps; probe updated in this review.**

| Topic | Assessment |
|-------|------------|
| **Blob detection** | `findBlobText` returns substring from `MARKER`; stable key for `seen` Map if the same blob string appears. Does not verify **strictly > 10 KiB** by itself — **fixed:** `BLOB = MARKER + 10241×'A'` and `tool.execute.after` logs `blobBytes` / `meetsGate`. |
| **FULL_SENDS** | Logic `count > FULL_SENDS` → project on 3rd hook fire **with blob present** is consistent with spike doc (“first two full, third placeholder”). **Caveat:** fires before the tool result is assembled increment `send` only when `hadBlob`; operator must interpret logs relative to the blob tool call. |
| **inplace** | Correctly mutates existing `text` fields in place (#43731 repro). |
| **replace (original)** | **Incorrect vs stated intent:** comment claimed “swap tool-message object” but implemented `JSON.parse(JSON.stringify(...).replaceAll(blob, …))` — deep-clones **all** messages and replaces every occurrence of the blob string in serialized form (fragile if blob appears in IDs/metadata; not “one new message object”). **Fixed:** `replaceFirstBlobMessage` clones only the first matching message; siblings keep prior references. |
| **JSON.stringify replace** | Avoided in fixed replace path. Residual risk: `structuredClone` on the message still in-place-replaces text inside the clone (acceptable for “new message object, same part ids inside clone” — closer to OP than global stringify). |
| **Missing harness** | Original probe had **no** tool to emit the blob, **no** `execute.after`, **no** `http.request` — checklist items 1 and 3 were impossible without external shell. **Fixed** in [context-probe.ts](../spikes/context-probe.ts). |
| **Persistence oracle** | Still manual: `ctx.session.context({ sessionID })` and restart (checklist 4–5) not automated — acceptable for throwaway probe. |

### 5. PRE-GO over-claim?

**Slightly strong wording; substance is OK.**

- Permission **“source PRE-GO, live TUI still required”** is reasonable: upstream path to `permission.assert` is clear; gate explicitly remains NO-GO until live prompt/outcomes.
- Context **“documented contract PRE-GO”** is optimistic given #43731 / #44788 — better labeled **“doc-contract hypothesis; live pin required.”** The spike body already says neither issue is 2.0.27 proof and keeps OP at NO-GO until steps 3–5 pass.

Composer does **not** upgrade either spike to GO.

### 6. Trip hazards for AF/OP implementers

- **THEN_RUN_FAILED drops mutation** ([then-run.ts](../src/action-fusion/then-run.ts)) — already in [review-wrap-grok.md](./review-wrap-grok.md); still true when wiring real shell.
- **Capture `shell.execute` inside `editor.update` only** — do not close over stale execute across reloads.
- **Do not use `permission.ask` / client-only APIs** from plugin code.
- **Scanner-empty commands** → silent skip of assert; use normal scannable commands for `then_run`.
- **Permission `source.id`** is parent mutation tool call id, not a new shell call id — UX/logging may confuse; not a blocker.
- **`shell.create.before` hooks** from other plugins can rewrite command/cwd — pass user command unchanged when possible.
- **Non-zero exit** does not throw; map `[then_run:failed]` from metadata, keep mutation ([spike-permission.md](./spike-permission.md) aligns with upstream `toolResult`).
- **OP:** hook `messages` are LLM-shaped; join archives on `tool.execute.after` + `event.id`; placeholder must appear in **provider** payload (`http.request` or equivalent), not hook logs alone.
- **OP:** if **both** replace and inplace persist placeholder to storage, product rule is NO-GO — probe modes exist to distinguish; live step 6 still required.
- **OP:** `FULL_SENDS = 2` is probe policy, not host guarantee — real pack timing may differ; do not hard-code “3rd hook” in production without live calibration.

---

## Findings (severity)

### spike-permission.md

- **nit:** Clarify that PRE-GO means “upstream path credible,” not “fusion execution enabled.”
- **nit:** Mention `DeclinedError` / defect tunnel for dismiss path so live failures are not misread as probe bugs.

### spike-context.md

- **must-fix (doc):** State that the throwaway probe must emit the blob and observe `http.request` — was implied but original probe did not implement it (now fixed in probe; doc should reference `sol_context_blob` and new log lines).
- **nit:** Soften “documented contract PRE-GO” to “hypothesis pending live pin.”

### permission-probe.ts

- **nit:** Recommend loading alongside `sol.opencode` for one fused edit+`then_run` trial before AF GO.

### context-probe.ts (Composer patch)

- **must-fix (fixed):** Added `sol_context_blob`, `tool.execute.after` size gate log, `session.http.request` body scan, and true single-message replace path (removed global `JSON.stringify` replace).

---

## Probe fix note

Composer updated [../spikes/context-probe.ts](../spikes/context-probe.ts) only (no production `src/` changes):

1. Export `BLOB` and tool `sol_context_blob` for deterministic >10 KiB host-visible UTF-8.
2. Log `tool.execute.after` `blobBytes` / `meetsGate`.
3. Log `session.http.request` for marker vs placeholder in provider body.
4. Implement `replace` as first matching message replaced with `structuredClone` + in-clone text swap; leave other message references untouched.

[permission-probe.ts](../spikes/permission-probe.ts) unchanged — gaps are coverage nits, not probe logic errors.

---

## Explicit gate statement

- **Live TUI still required** for shell permission prompt (allow / deny / dismiss) and for Observation Pack persistence vs provider projection.
- **No GO/NO-GO** for Action Fusion or Observation Pack from this static review alone.
