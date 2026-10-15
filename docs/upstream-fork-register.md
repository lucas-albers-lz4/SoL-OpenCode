# Upstream fork register

Reference: SoL-Pi at `e1a586af0ad8956f42ae5b26bba20e48fbf30e00` (README "Provenance").

This page records every point where this port does not follow SoL-Pi, and why.

## The rule

**Fix an upstream defect only when it is reachable in this host. Otherwise match upstream, and
retract any claim upstream never made.**

Add a row here before you merge a deviation. Cite the issue that decided it.

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

### Upstream defects, fixed because they are reachable

| Defect | Upstream behaviour | This port |
|---|---|---|
| Hardlink aliasing (#36) | `canonicalQueueKey` keys the canonical path only, so two hardlinked names interleave | inode key added |
| Dangling-symlink aliasing (#56) | the `ENOENT` ancestor walk gives the link and its missing target disjoint keys | link-chain keys |
| `ELOOP` out of key derivation | `canonicalQueueKey` throws for a cyclic link | falls back to the name key |
| Non-advancing recall page (#55) | same page | **matches upstream**: the shape needs `maxBytes <= 3` (the shipped caller passes 15,872), so the port's promise was the defect and the contract changed |

## Deviations kept on purpose

| Deviation | Reason | Owed |
|---|---|---|
| Recall start-snap and offset validation (`utf8AlignedOffset`, #34) | A page never starts inside a character. It moves a page boundary only: it cannot split one file across two keys and cannot produce a replacement character at a start. | none |
| Fusion runs for `patch` (#30) | Upstream drops fusion for `patch` because it cannot enumerate written paths. This port enumerates them with `Patch.parse`. A deliberate product divergence. | **a measured arm is owed**: `benchmarks/` off and on, median and spread (`docs/quality-guard.md` records the volume claim as unmeasured) |
| A malformed `then_run` is rejected visibly (#31, #35) | Upstream drops the value silently. The plugin advertises the property in the schema, so a malformed value must be visible to the model. | none |
| Quality guard page and schema-cost pin (#44) | No upstream counterpart. | none |

## Aligned against the host, not against upstream

The host is the truth for path and tool behaviour. Check the host before you port an upstream
convention.

| Item | Decision |
|---|---|
| Shell drive spellings (`/c/…`, `/mnt/c/…`, `/cygdrive/c/…`) | **Follow the host.** Apply `@opencode/util` `FSUtil.windowsPath` in `resolveMutationPath` (#61), instead of copying upstream's resolver. Otherwise one file holds two queue keys on Windows. |
| `@` and `file://` path syntax | **Stay dropped.** Pi-only syntax; the host does not use it. |
| `~` expansion | **Stay dropped.** `@opencode/util` expands no home directory, so expanding it in the queue would key a file the mutation does not write. |
| Unicode-space folding | **Stay dropped.** The host folds no spaces. Folding can only merge two names onto one key, which over-serializes; it adds no correctness. |
