# Grok review: Composer AF + OP port

Reviewer: Grok (did not author the port). `npm test` (12) and `npm run typecheck` re-run after review fixes: see below. SoL-Pi was not modified.

## Verdict

**Accept the port** as the first real AF + OP implementation on the live 2.0.27 gates. Captured `shell.execute`, mutation-preserving `THEN_RUN_FAILED`, `http.request` projection, `obs_recall` (`codemode: false`), and fail-open archive path are in the right shape.

Must-fixes applied in this review (not sent back for a second Composer round):

1. **Session index stored full observation text** in `ctx.storage`. Plan is pointers/ledger only; projection now reads object files.
2. **HTTP rewrite only searched raw text.** JSON provider bodies escape newlines/quotes; rewrite now matches JSON string contents as well.

## What was already correct

- `then_run` hidden when `editor.get("shell")` is missing; capture on the same transform pass.
- Timeout seconds → ms; empty command rejected.
- Non-zero/timeout shell results mapped to `[then_run:failed]` without throwing; permission reject throws with mutation output.
- Queue before mutation; unparseable patch skips fusion.
- Archive at `execute.after`; skip `obs_recall`, errors, mixed media, missing call id; `> 10 KiB` only.
- `http.request` replaces `event.request`; stored messages are not the projection surface.
- Fork without object files fail-opens that entry.

## Remaining nits / live gaps

- `wrap-tools.ts` SPDX was NVIDIA-only (port authors added in this review).
- README still said Observation Pack was unimplemented (updated).
- Dismiss/interrupt, live `tool.reload()`, and process-restart persistence still unproven (same as spike docs).
- Host-visible packing uses `result.content` only; if a tool ever returns `output` without `content`, it will not pack.
