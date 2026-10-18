# Upstream fork register

Reference: SoL-Pi at `e1a586af0ad8956f42ae5b26bba20e48fbf30e00` (README "Provenance").

This page records every point where this port does not follow SoL-Pi, and why.

**Read the status column.** *Merged* rows describe code on the default branch, and *merged (#NN)* also names the PR that landed it. *In review (#NN)* marks a change that is not there yet: read the code for what the port does today, this page for the decision, and the named PR for the change. *Undecided* marks behaviour nobody has chosen yet, listed under Owed work. A dash marks a decision that needs no change. The column is a snapshot, not a live view: a later merge moves a row, so check the default branch before you rely on one.

## The rule

**Fix an upstream defect only when it is reachable in this host. Otherwise match upstream, and
retract any claim upstream never made.**

Add a row here before you merge a deviation. Cite the issue that decided it, and its status.

## Why the fork exists

### Host architecture — unavoidable

A Pi extension **replaces** tool definitions, owns its TUI, and resolves Pi path syntax (`@`,
`file://`). An OpenCode plugin edits the host's definitions through a `ToolEditor` — `add`, `update`
and `remove`, alongside `list`, `get` and `namespace` — and owns no TUI.
This difference forces the port-only modules and the port-only shapes:

| Port-only code | Why it must exist |
|---|---|
| `src/action-fusion/wrap-tools.ts` | The transform entry point: `editor.get` / `editor.update`, captured executors. |
| `src/action-fusion/then-run-schema.ts` | The plugin extends a schema it does not own. |
| `src/deps/opencode-plugin-types.ts`, `src/options.ts` | OpenCode plugin types and options. |
| `then-run.ts`: split executors, `mapShellResultToObservation`, `appendThenRunSkipNotice` | OpenCode result and shell shapes; `patch` needs a multi-path executor. |
| `observation-pack/`: `session-index*`, `archive-gate`, `http-rewrite`, `runtime-path` | Pi hands an extension its session directory, and its `context` hook can change what the provider receives. This host has the hook, but mutating its messages does not reach the provider body (`docs/spike-context.md`), so the port needs its own index, archive gate and path resolution. Upstream's `observation.ts` carries no reducer import — the reducer is a separate upstream extension this port does not carry. |

Upstream artifacts with no port: the append-only observation ledger
(`observation-pack/ledger.ts`; the port keeps ledger pointers only and writes no ledger file), and the
extensions `evidence-preserving-reducer` and `online-context-compact`.

### Upstream defects this port fixes

The queue is also structurally different. Upstream's `canonicalQueueKey` returns one string; this
port's `queueKeysFor` returns a set — the path key always, plus the inode key when the file exists — so
a spelled name and an aliased name for one file exclude each other. Every aliasing row below follows
from that design, and a future one will too: issue #65's `..` through a symlinked directory.

| Defect | Upstream behaviour | This port | Status |
|---|---|---|---|
| Hardlink aliasing (#36) | `canonicalQueueKey` keys the canonical path only, so two hardlinked names interleave | inode key added | merged |
| Dangling-symlink aliasing (#56) | the missing-path ancestor walk (`ENOENT` or `ENOTDIR`) gives the link and its missing target disjoint keys | link-chain keys | merged (#58) |
| `ELOOP`, or any other unresolvable name, out of key derivation (decided in #58's review, part of #56's change) | `canonicalQueueKey` throws for a cyclic link; a fused `write` reaches key derivation through `executeMutationThenRun` | falls back to the name key | merged (#58) |

Before #58, the default branch kept a dangling symlink on its own path key (`src/action-fusion/file-queue.ts`
said so), and a cyclic link made the queue throw. Both landed in #58, so a link and its missing target
now share a queue and an unresolvable name falls back to its name key.

### One claim retracted, not a defect fixed

The recall page does not advance when no character fits the window (#55). Upstream returns the same
page. The shape needs `maxBytes` of 3 or less, **or a run of `maxBytes` or more continuation bytes at
the offset** — so well-formed UTF-8 cannot reach it, and a damaged payload can: upstream's
`readRecallChunk` returns a non-advancing page at the shipped cap of 15,872 bytes when the bytes ahead
are continuation bytes. Upstream makes no character-alignment or U+FFFD promise either, so the promise
in this port's comment was the defect.
#60 corrected the contract, and it is **merged**: the default branch no longer carries the promise.

## Deviations kept on purpose

| Deviation | Reason | Status |
|---|---|---|
| Recall start-snap and offset validation (#34) | A page never starts inside a character, and a start inside one would decode as a replacement character. | merged |
| Fusion runs for `patch` (#30) | Upstream composes Pi's `edit` and `write` only, and its `file-queue.ts` has no patch path, so it takes no position on fusion for a patch tool. This host has one, so the port adds fusion to it and enumerates the written paths with `Patch.parse`. A port addition: chosen, not forced. | merged |
| The recall placeholder drops upstream's instruction (#26) | Upstream's placeholder tells the model to call `obs_recall` with the observation id and continue at the returned `next_offset`. This port deletes that instruction and pins the deletion in `tests/observation-pack.test.ts`. Decided on measurement: the imperative wording measured +128 % round-trips against its control arm (recorded in `tests/observation-pack.test.ts` from issue #27's B1 arm), and the shipped neutral wording replaced it at ~1.5× the control's round-trips (median 14 → 21) against the imperative arm's ~2.4× (14 → 33) — "the wording buys round-trips, not only context" (README, "Measured behavior"). | merged |
| Re-packing the recall tool's own output | **Refuse it.** Upstream's projection loop filters on `isPureTextResult` alone, so a recall page over the threshold is packed again. This port skips `obs_recall` output (`archive-gate.ts`), and `tests/observation-pack.test.ts` pins that. Reachable here: a recall page is capped at 15,872 bytes, above the 10 KiB threshold. | merged |
| A malformed `then_run` is rejected visibly (#31, #35) | Upstream reserves `then_run` for itself and hands a value it did not shape straight to the shell, so nothing rejects it in the model's view. Here the plugin adds the property to the tool's own schema, so the codec rejects most malformed shapes before `execute`, including the strings that the serialized `timeout` permits. What the codec admits — a numeric `Infinity` — the runtime check rejects, and a codec rejection would replace the marker with a decode error. The runtime check therefore carries the contract the model reads. | merged |
| Packing a payload that carries a Pi evidence receipt | Upstream refuses to pack a payload whose text carries an evidence receipt line (`containsReducerReceipt`); this port gates on size alone, so a `read` or `cat` of a Pi session file is excerpted here. This host has no receipt concept of its own. Whether such a payload should be packed is undecided. | undecided |

## Owed work

| Item | Owed |
|---|---|
| The #30 volume claim | A measured arm: `benchmarks/` off and on, median and spread. Treat it as unmeasured until it lands. `docs/quality-guard.md` records that, and that page is on the default branch (#57). |
| The quality guard page and its cost pin (#44) | `docs/quality-guard.md` and `tests/schema-cost.test.ts`: the recorded statements, and the pinned schema cost. No upstream counterpart. Merged (#57). |
| Whether a payload carrying a Pi evidence receipt should be packed | This port packs it on size alone; upstream refuses (`containsReducerReceipt`). Decide, or record why the port keeps packing it. |
| `~` expansion in the queue | Establish whether the host's mutation tools resolve a spelled `~/x` through the file-access resolver. If they do, key the resolved name; if not, record why the spelled name is the right key. |

## Aligned against the host, not against upstream

The host is the truth for path and tool behaviour. Check the host before you port an upstream
convention.

| Item | Decision | Status |
|---|---|---|
| A host tool that declares its own `then_run` | **Follow the declaration.** Upstream replaces tool definitions and reserves `then_run` for itself, so a declared value belongs to the host. The schema side has left the host's property alone since issue #42 (landed in #47); the execute side must pass the value through instead of reinterpreting it. | merged (#59, and #47 for the schema side; issue #48) |
| Shell drive spellings (`/c/…`, `/c:/…`, `/mnt/c/…`, `/cygdrive/c/…`) | **Follow the host.** Apply `@opencode/util` `FSUtil.windowsPath` in `resolveMutationPath` before `resolve`, instead of copying upstream's resolver. Otherwise one file holds two queue keys on Windows. | merged (#62, issue #61) |
| `@` and `file://` path syntax | **Stay dropped.** Pi-only syntax; the host does not use it. | — |
| A `..` in the input name | **Key both spellings.** Upstream resolves the input name with `path.resolve`, which collapses `..` against the spelled directory. This port's queue keys the spelled name (what the host resolves before it writes) *and* the literal spelling the kernel resolves, so a dotted name through a symlinked component shares a queue with the file the kernel writes and with its lexical collapse. Scoped: the built-in wrapper still normalizes before the queue is acquired, so no shipped tool behaviour changes yet. | merged (#66, issue #65) |
| `~` expansion | **Dropped in the queue, and not settled.** `@opencode/util` expands no home directory, but the host's own file-access resolver does expand `~` (CLI bundle). If a mutation tool routes a spelled `~/x` through that resolver, the queue keys a name the kernel never sees and two names for one file interleave — the class the rows above fix. Whether the mutation tools route there is unverified. | undecided |
| Unicode-space folding | **Stay dropped.** The host folds no spaces when it resolves a path: `FSUtil.windowsPath` and the file-access resolver fold nothing. One `read`-tool fallback does fold U+00A0 and U+202F, which is not path resolution. Folding here can only merge two names onto one key, which over-serializes; it adds no correctness. | — |
