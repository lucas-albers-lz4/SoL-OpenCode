# Spike: context-hook persistence (OpenCode 2.0.27)

Author: Grok. Cross-check: Composer 2.5 (did not write this spike). Pin: `@opencode/cli@2.0.27` / `@opencode/plugin@2.0.27`.

## Gate

Observation Pack is **GO** only if:

1. Request 3’s **captured provider payload** contains the placeholder, not the original >10 KiB host-visible text.
2. **Persisted session** (`ctx.session.context` / restart) still has the original text (or an equivalent host-visible original, not the placeholder).
3. Mutating nested part IDs in the hook must **not** persist the rewrite. If the host writes rewritten parts back to storage and no transient projection exists, Observation Pack is **NO-GO**.

Status: **GO on 2.0.27** only if projection is done on `session.hook("http.request")` by replacing `event.request`. `session.hook("context")` message mutation did **not** reach the provider body (see [spike-live-results.md](./spike-live-results.md)). Stored session context kept the original blob.

## Documented contract (V2 plugin docs)

`ctx.session.hook("context", …)` runs for the agent loop, including tool-driven continuations. The event is mutable `system` / `messages` / `tools` / `options`.

Docs: *“Changes affect only the outgoing model call, not persisted history or configuration.”*

That is the contract Observation Pack needs (project on the way out; archive separately).

`ctx.session.context({ sessionID })` is a **read** of stored/assembled session context, not the hook. Use it as the persistence oracle after dispatch.

Archive join: **`tool.execute.after`** + `sessionID` + `event.id` (tool call id). Context-hook `messages` are LLM-shaped and generally lack `metadata.truncated` / `outputPath`.

## Conflicting reports (do not treat as 2.0.27)

| Issue | Claim | Implication if true on 2.0.27 |
|-------|--------|-------------------------------|
| [Docs / PR #48043](https://github.com/anomalyco/opencode/pull/48043) | Hook transforms outgoing messages; do not rewrite stored history | GO-shaped |
| [#43731](https://github.com/anomalyco/opencode/issues/43731) | In-place mutation of **existing part IDs** is written back to session storage | NO-GO unless we copy messages/parts (new objects, new ids) instead of mutating in place |
| [#44788](https://github.com/anomalyco/opencode/issues/44788) (beta-18050) | Hook mutations never reach the model prompt | NO-GO (placeholder never seen by the provider) |

Working hypothesis for the port: **replace** the large tool-result message (or its content array) with a **new object**, do not mutate `text` on an existing part id. Still must prove both (1) and (2) on 2.0.27.

## Plugin types on 2.0.27

`SessionContext` (`@opencode/plugin` session.d.ts): `messages: Array<Message>` (mutable), `tools`, `system`, `options`. No documented “transient projection” flag.

`tool.execute.after` event includes `id: Tool.CallID` and either `result` or `error`. Pack only `status: "completed"` pure-text host-visible UTF-8 **strictly greater than 10 KiB**.

## Live TUI / HTTP checklist (still open)

Throwaway plugin: [../spikes/context-probe.ts](../spikes/context-probe.ts). Ask the model to call `sol_context_blob` (emits `BLOB`, marker + 10241 `A` bytes). Logs: `tool.execute.after` (`blobBytes` / `meetsGate`), `session.context` (`send` / `projected`), `session.http.request` (`hasMarker` / `hasPlaceholder`). Option `{ "mutate": "inplace" }` for step 6.

1. Call `sol_context_blob`. Confirm `execute.after` logs `meetsGate: true` (host-visible UTF-8 **> 10 KiB**).
2. First two `session.hook("context")` fires after that call: event `messages` still contain the full text (FULL_SENDS=2).
3. Third fire: event `messages` contain the placeholder token, **not** the original blob. Confirm `session.http.request` logs `hasPlaceholder: true` and `hasMarker: false` so the assertion is the **provider payload**, not only the hook input.
4. Immediately after that dispatch: `ctx.session.context({ sessionID })` still contains the original blob (or file-backed original), **not** the placeholder.
5. Restart OpenCode, reopen the session: stored transcript still has the original, not the placeholder.
6. Repeat step 3 by **mutating an existing part’s `text` in place** (same part id). If step 4 then shows the placeholder in storage, in-place mutation is forbidden; only object replacement is allowed. If replacement also persists, OP is **NO-GO**.

Until 3–5 pass on 2.0.27, Observation Pack stays **NO-GO**.
