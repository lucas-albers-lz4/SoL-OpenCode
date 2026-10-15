# Upstream fork register

Reference: SoL-Pi at `e1a586af0ad8956f42ae5b26bba20e48fbf30e00` (README "Provenance").

This page records every point where this port does not follow SoL-Pi, and why.

**Read the status column.** *Merged* rows describe code on the default branch. *In review* rows
describe work that is not there yet: read the code for what the port does today, this page for the
decision, and the named PR for the change. The column is a snapshot, not a live view: a later merge
moves a row, so check the default branch before you rely on one.

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
| `observation-pack/`: `session-index*`, `archive-gate`, `http-rewrite`, `runtime-path` | Pi hands an extension its session directory and a `context` hook; OpenCode gives neither, so the port needs its own index, archive gate and path resolution. Upstream's `observation.ts` carries no reducer import — the reducer is a separate upstream extension this port does not carry. |

Upstream extensions with no port: `evidence-preserving-reducer`, `online-context-compact`.

### Upstream defects this port fixes

| Defect | Upstream behaviour | This port | Status |
|---|---|---|---|
| Hardlink aliasing (#36) | `canonicalQueueKey` keys the canonical path only, so two hardlinked names interleave | inode key added | merged |
| Dangling-symlink aliasing (#56) | the `ENOENT` ancestor walk gives the link and its missing target disjoint keys | link-chain keys | in review (#58) |
| `ELOOP`, or any other unresolvable name, out of key derivation (decided in #58's review, part of #56's change) | `canonicalQueueKey` throws for a cyclic link; a fused `write` reaches it through `executeMutationThenRunSinglePath` | falls back to the name key | in review (#58) |

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
| Fusion runs for `patch` (#30) | Upstream composes Pi's `edit` and `write` only, and its `file-queue.ts` has no patch path, so it takes no position on fusion for a patch tool. This host has one, so the port adds fusion to it and enumerates the written paths with `Patch.parse`. A port addition: chosen, not forced. | merged |
| The recall placeholder drops upstream's instruction (#26) | Upstream's placeholder tells the model to call `obs_recall` for the full text. This port deletes that instruction and pins the deletion in `tests/observation-pack.test.ts`. Decided on measurement: the imperative wording measured +128 % round-trips against its control arm, and the neutral wording restored round-trip parity at -22 % average context. | merged |
| A malformed `then_run` is rejected visibly (#31, #35) | Upstream reserves `then_run` for itself and hands a value it did not shape straight to the shell, so nothing rejects it in the model's view. Here the plugin adds the property to the tool's own schema, so the host codec rejects most malformed shapes before `execute` — five of seven measured — but the strings `Infinity`, `-Infinity` and `NaN` pass the codec, and a codec rejection replaces the marker with a decode error. The runtime check carries the contract the model reads. | merged |
| Packing a payload that carries a Pi evidence receipt | Upstream refuses to pack a payload whose text carries an evidence receipt line (`containsReducerReceipt`); this port gates on size alone, so a `read` or `cat` of a Pi session file is excerpted here. This host has no receipt concept of its own. Whether such a payload should be packed is undecided. | undecided |

## Owed work

| Item | Owed |
|---|---|
| The #30 volume claim | A measured arm: `benchmarks/` off and on, median and spread. Treat it as unmeasured until it lands. `docs/quality-guard.md` records that, and that page is on the default branch (#57). |
| The quality guard page and its cost pin (#44) | `docs/quality-guard.md` and `tests/schema-cost.test.ts`: the recorded statements, and the pinned schema cost. No upstream counterpart. Merged (#57). |
| Whether a payload carrying a Pi evidence receipt should be packed | This port packs it on size alone; upstream refuses (`containsReducerReceipt`). Decide, or record why the port keeps packing it. |

## Aligned against the host, not against upstream

The host is the truth for path and tool behaviour. Check the host before you port an upstream
convention.

| Item | Decision | Status |
|---|---|---|
| A host tool that declares its own `then_run` | **Follow the declaration.** Upstream replaces tool definitions and reserves `then_run` for itself, so a declared value belongs to the host. The schema side has left the host's property alone since #42; the execute side must pass the value through instead of reinterpreting it. | merged: schema side (#42), execute side (#59, issue #48) |
| Shell drive spellings (`/c/…`, `/c:/…`, `/mnt/c/…`, `/cygdrive/c/…`) | **Follow the host.** Apply `@opencode/util` `FSUtil.windowsPath` in `resolveMutationPath` before `resolve`, instead of copying upstream's resolver. Otherwise one file holds two queue keys on Windows. | merged (#62, issue #61) |
| `@` and `file://` path syntax | **Stay dropped.** Pi-only syntax; the host does not use it. | — |
| `~` expansion | **Stay dropped in the queue.** `@opencode/util` expands no home directory, and the queue must key the name the operation uses. The host's own file-access resolver does expand `~` (CLI bundle), so a mutation that spells `~/x` is keyed on the spelled name. Known gap, unverified for tool inputs specifically. | — |
| Unicode-space folding | **Stay dropped.** The host folds no spaces when it resolves a path: `FSUtil.windowsPath` and the file-access resolver fold nothing. One `read`-tool fallback does fold U+00A0 and U+202F, which is not path resolution. Folding here can only merge two names onto one key, which over-serializes; it adds no correctness. | — |
