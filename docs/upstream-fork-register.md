# Upstream fork register

Reference: SoL-Pi at `e1a586af0ad8956f42ae5b26bba20e48fbf30e00` (README "Provenance").

This page records every point where this port does not follow SoL-Pi, and why.

**Read the status column.** *Merged* rows describe code on the default branch. *In review* rows
describe work that is not there yet: read the code for what the port does today, this page for the
decision, and the named PR for the change.

## The rule

**Fix an upstream defect only when it is reachable in this host. Otherwise match upstream, and
retract any claim upstream never made.**

Add a row here before you merge a deviation. Cite the issue that decided it, and its status.

## Why the fork exists

### Host architecture — unavoidable

A Pi extension **replaces** tool definitions, owns its TUI, and resolves Pi path syntax (`@`,
`file://`). An OpenCode plugin only **transforms** the host's definitions through a `ToolEditor`.
This difference forces the port-only modules and the port-only shapes:

| Port-only code | Why it must exist |
|---|---|
| `src/action-fusion/wrap-tools.ts` | The transform entry point: `editor.get` / `editor.update`, captured executors. |
| `src/action-fusion/then-run-schema.ts` | The plugin extends a schema it does not own. |
| `src/deps/opencode-plugin-types.ts`, `src/options.ts` | OpenCode plugin types and options. |
| `then-run.ts`: split executors, `mapShellResultToObservation`, `appendThenRunSkipNotice` | OpenCode result and shell shapes; `patch` needs a multi-path executor. |
| `observation-pack/`: `session-index*`, `archive-gate`, `http-rewrite`, `runtime-path` | Upstream's `observation.ts` depends on `evidence-preserving-reducer`, which this port does not carry. |

Upstream extensions with no port: `evidence-preserving-reducer`, `online-context-compact`.

### Upstream defects this port fixes

| Defect | Upstream behaviour | This port | Status |
|---|---|---|---|
| Hardlink aliasing (#36) | `canonicalQueueKey` keys the canonical path only, so two hardlinked names interleave | inode key added | merged |
| Dangling-symlink aliasing (#56) | the `ENOENT` ancestor walk gives the link and its missing target disjoint keys | link-chain keys | in review (#58) |
| `ELOOP`, or any other unresolvable name, out of key derivation (#56) | `canonicalQueueKey` throws for a cyclic link; a fused `write` reaches it through `executeMutationThenRunSinglePath` | falls back to the name key | in review (#58) |

On the default branch today, a dangling symlink keeps its own path key (`src/action-fusion/file-queue.ts`
says so), and a cyclic link makes the queue throw. Both change in #58.

### One claim retracted, not a defect fixed

The recall page does not advance when no character fits the window (#55). Upstream returns the same
page, and the shape needs `maxBytes` of 3 or less — the shipped caller passes 15,872. Upstream makes no
character-alignment or U+FFFD promise either, so the promise in this port's comment was the defect.
#60 corrected the contract, and it is **merged**: the default branch no longer carries the promise.

## Deviations kept on purpose

| Deviation | Reason | Status |
|---|---|---|
| Recall start-snap and offset validation (#34) | A page never starts inside a character, and a start inside one would decode as a replacement character. | merged |
| Fusion runs for `patch` (#30) | Upstream drops fusion for `patch`, because it cannot enumerate written paths. This port enumerates them with `Patch.parse`. A deliberate product divergence. | merged |
| A malformed `then_run` is rejected visibly (#31, #35) | Upstream drops the value silently. The plugin advertises the property in the schema, so a malformed value must be visible to the model. | merged |

## Owed work

| Item | Owed |
|---|---|
| The #30 volume claim | A measured arm: `benchmarks/` off and on, median and spread. Treat it as unmeasured until it lands. `docs/quality-guard.md` records that, and arrives with #44 in review (#57). |
| The quality guard page and its cost pin (#44) | `docs/quality-guard.md` and `tests/schema-cost.test.ts`: the recorded statements, and the pinned schema cost. No upstream counterpart. Arrives with #44, in review (#57). |

## Aligned against the host, not against upstream

The host is the truth for path and tool behaviour. Check the host before you port an upstream
convention.

| Item | Decision | Status |
|---|---|---|
| A host tool that declares its own `then_run` | **Follow the declaration.** Upstream replaces tool definitions and reserves `then_run` for itself, so a declared value belongs to the host. The schema side has left the host's property alone since #42; the execute side must pass the value through instead of reinterpreting it. | merged: schema side (#42), execute side (#59, issue #48) |
| Shell drive spellings (`/c/…`, `/mnt/c/…`, `/cygdrive/c/…`) | **Follow the host.** Apply `@opencode/util` `FSUtil.windowsPath` in `resolveMutationPath` before `resolve`, instead of copying upstream's resolver. Otherwise one file holds two queue keys on Windows. | in review (#62, issue #61) |
| `@` and `file://` path syntax | **Stay dropped.** Pi-only syntax; the host does not use it. | — |
| `~` expansion | **Stay dropped in the queue.** `@opencode/util` expands no home directory, and the queue must key the name the operation uses. The host's own file-access resolver does expand `~` (CLI bundle), so a mutation that spells `~/x` is keyed on the spelled name. Known gap, unverified for tool inputs specifically. | — |
| Unicode-space folding | **Stay dropped.** The host folds no spaces. Folding can only merge two names onto one key, which over-serializes; it adds no correctness. | — |
