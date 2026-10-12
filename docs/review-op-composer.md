# Observation Pack — Composer 2.5 review notes

Issues addressed: [#5](https://github.com/lucas-albers-lz4/SoL-OpenCode/issues/5), [#7](https://github.com/lucas-albers-lz4/SoL-OpenCode/issues/7), [#8](https://github.com/lucas-albers-lz4/SoL-OpenCode/issues/8), [#9](https://github.com/lucas-albers-lz4/SoL-OpenCode/issues/9).

## Files changed

| File | Change |
|------|--------|
| `src/observation-pack/http-rewrite.ts` | Parse provider JSON; rewrite only matching tool messages (by `tool_call_id` / `toolCallId` when provided, else `role: tool` or undifferentiated single message); assign placeholders via object mutation + `JSON.stringify` (no raw `replaceAll`). Non-JSON bodies: fail-open (unchanged body, send counts still advance when text is present). |
| `src/observation-pack/session-index-mutex.ts` | **New** — per-`sessionID` promise-chain lock for session-index RMW. |
| `src/observation-pack/index.ts` | Wrap `execute.after` and `http.request` index updates in `withSessionIndexLock`; pass `toolCallId` into HTTP projection; `obs_recall` checks calling session index before reading object files. |
| `tests/observation-pack.test.ts` | New cases for real `placeholderFor`, user/tool dedup, non-JSON fail-open. |
| `tests/observation-pack-session.test.ts` | **New** — concurrent append regression; cross-session `obs_recall` rejection. |

Action Fusion paths were not modified.

## Tests added / updated

- **HTTP projection:** real multiline placeholder + `JSON.parse` safety; shared user/tool text with `tool_call_id`; non-JSON body unchanged with send-count increment; existing newline-escaped and `FULL_SENDS` tests retained.
- **Session index:** two overlapping locked appends for different `toolCallId`s both persist.
- **Recall isolation:** session B cannot read session A’s `obs_` id even when the object file exists on disk.

## Validation

```text
npm run typecheck   — pass
npm test            — 18 tests, 6 files, pass
```

## Residual risk / limitations

- **Provider JSON shape:** projection only rewrites string `content` or `{ type: "text", text }` blocks on objects under top-level `messages`. Provider payloads that embed archived text outside `messages` (or in non-text blocks) are not rewritten; send counts still increment when the raw/escaped text appears in the body string.
- **Ambiguous messages:** without `tool_call_id` / `toolCallId`, only messages with `role: "tool"` (or messages with no `role` field) are candidates. Identical archived text duplicated across multiple tool messages without ids could still be under-replaced.
- **Non-JSON bodies:** after `FULL_SENDS`, text remains full in the wire body (by design, fail-open).
- **Mutex scope:** in-process only; cross-process storage races are out of scope for this plugin.
