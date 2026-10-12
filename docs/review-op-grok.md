# Grok review: Composer Observation Pack #5 #7 #8 #9

Reviewer: Grok (did not author the OP slice). AF files were not re-reviewed here.

## Verdict

**Accept.** JSON-aware projection, per-session index lock, and session-scoped `obs_recall` match the triage. No must-fixes applied in this review.

## What is correct

- `#5`: `JSON.parse` + field assign + `JSON.stringify` inserts the real multiline `placeholderFor()` without corrupting JSON. The old raw `replaceAll` path is gone.
- `#7`: rewrite is gated on `tool_call_id` / `toolCallId` when the ledger supplies it; user messages with the same bytes stay intact. No `$&` replacement interpolation.
- Non-JSON bodies fail open (unchanged) while still counting sends when the archived text is present.
- `#8`: `withSessionIndexLock` chains work synchronously onto the per-session tail (no await between get and set), covering both archive append and HTTP send-count save.
- `#9`: `obs_recall` consults the calling session index before `readRecallChunk`; foreign ids use the same `Unknown observation id` error and do not probe the object file first.
- Tests cover the real placeholder, user/tool dedup, non-JSON, concurrent appends, and cross-session recall.

## Nits (do not block)

- Projection only walks `messages[]` string/`text` content. Anthropic-shaped `tool_result` parts (`tool_use_id` on a user content block) are not rewritten; OpenAI-compatible `role: tool` + `tool_call_id` is. Documented; live 2.0.27 gate used the OpenAI-compatible mock.
- Session mutex never deletes idle keys (unlike the file queue). Harmless for a plugin process.
- `cachedObjectsRoot` in `index.ts` is process-lifetime; tests that change `XDG_DATA_HOME` after first recall could see a stale path.

## Leftover (same as Composer)

In-process lock only. Bodies that put the blob outside `messages` increment send counts without projecting.
