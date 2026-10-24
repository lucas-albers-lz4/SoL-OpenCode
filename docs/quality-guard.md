# Quality guard for model-visible changes

A **model-visible change** changes text that a model reads. The text can be the tool
schema, a tool result, an archive chunk boundary, or a failure path that replaces a
silent drop. A green test suite does not show what such a change costs in context or
in provider round-trips.

This page states the rule for those changes. It also records the statements for the
fixes from the review pass of 2026-10-14.

## The rule

Before you merge a model-visible change, add two items.

1. **A unit assertion on the observable contract.** The assertion must fail when
   the contract breaks. It pins what the model can observe: the command ran, the
   marker carries its reason, the chunk boundary is clean, or the rejection is
   visible.
2. **A quality statement for the affected arm.**
   - If the change can alter model-visible volume or the number of provider
     round-trips, measure it with [`benchmarks/`](../benchmarks/README.md). Its
     arms are `off*` (no plugin) and `neu*` (this working tree), so one run does
     not produce the quality floor below: that floor compares this head with
     `main` at the base commit, which takes a second run in a clone of that
     commit. Compare the two `neu` arms with the model and the prompt bytes held
     fixed. Repeat each arm at least twice, and report the median and the spread
     only when the run count can support them.
   - If the change cannot alter volume or round-trips, state why. When you can
     count it, give the count.

A green `npm test` is not the quality proof. The suite proves behavior only.

## The quality floor

A measured result must be at least equal to the baseline. The baseline is `main` at
the base commit of the change.

- **Efficiency:** average context per provider round-trip, peak context, and total
  billed context. Use the metrics and the method rules in
  [`benchmarks/README.md`](../benchmarks/README.md).
- **Quality:** the verdicts and the findings must not regress. A token win that
  corrupts the deliverable is not a win.

One class of change cannot be equal to the baseline by design: a fix that restores
intended behavior. When a fused command moves from "never ran" to "ran", it adds
round-trips and output. For this class, state the intended behavior change and the
expected direction until a measurement exists.

## Recorded statements (upstream port, 2026-10-24)

| Fix | Unit assertion | Model-visible surface | Quality statement |
|---|---|---|---|
| A signal-killed fused command is a failure | `tests/then-run.test.ts` | The marker is `[then_run:failed]` (17 bytes) instead of `[then_run:succeeded]` (20 bytes); the command output is unchanged. | An intended behavior change: a kill no longer reads as success. Byte delta is -3. The round-trip direction is unmeasured: a model that sees the failure may retry, which is the point of the fix. |
| A single-line payload gets a placeholder excerpt | `tests/observation-pack.test.ts` | Head and tail excerpts of at most 512 bytes each, with a `[no complete line fits; …]` label. | Adds at most 1024 bytes where the placeholder previously carried two empty excerpts. The replaced payload is at least 10 KiB, so net context still falls. Multi-line output is byte-identical, which the same test pins. |
| Excerpting and line counting stop walking the whole payload | `tests/observation-pack.test.ts` (`countLines`, multi-line parity) | None; the placeholder text is unchanged. | Inert for volume and round-trips. CPU on 7 MiB: `countLines` 74.7 → 18.1 ms; `placeholderFor` 64.5 → 0.01 ms (multi-line) and 59.3 → 5.0 ms (single line). Rendering 20 entries for 10 requests: 12.6 s → 1.8 ms. Regenerate with [`benchmarks/placeholder-bench.mjs`](../benchmarks/placeholder-bench.mjs). |
| Objects publish atomically and are size-checked on read | `tests/observation-pack-storage.test.ts` | A missing or damaged object fails open: the original payload stays in the request instead of a truncated placeholder. | Inert in normal operation. On a damaged store the request keeps bytes it already carried; no new model-visible text. |
| Projection stops when `obs_recall` is not offered | `tests/observation-pack-tool-gate.test.ts` | No placeholder for that session; the full result stays. | Returns volume to the un-packed result for a session whose tool set excludes `obs_recall`. Count it per session from the packed entries; it prevents a pointer to a tool the model cannot call. |

## Recorded statements (review pass of 2026-10-14)

| Fix | Unit assertion | Model-visible surface | Quality statement |
|---|---|---|---|
| #30 — path enumeration for delete and rename | `tests/patch-paths.test.ts`, `tests/then-run.test.ts` | A fused command now runs where the plugin previously dropped it. A patch that touches no path reports a skip notice. | **Not inert, and the direction depends on the comparison.** Against the base commit, the command output or the skip notice adds bytes where the result was plain success. Against a model that would have issued the same command unfused, it removes a round-trip. No landed run used `then_run`, so the volume claim stays unmeasured. |
| #31 — malformed `then_run` is rejected visibly | `tests/then-run-validation.test.ts`, `tests/then-run.test.ts` | A `[then_run:skipped]` marker with its reason. On the JSON family the serialized schema shows the `pattern`. The Effect serialization shows no keyword for the built-in tools, so the runtime rejection carries the contract. | Inert for well-formed calls. The schema cost is countable (below). The marker appears only when the model sends a malformed `then_run`. |
| #34 — recall chunk alignment and offset validation | `tests/observation-recall.test.ts` | A chunk starts at a character boundary. An invalid offset fails with a clean message instead of a raw `ERR_OUT_OF_RANGE`. | Inert for volume in normal paging. Boundaries move only for an offset that does not start a character, which previously decoded to replacement characters. |
| #35 — `then_run` timeout validation | `tests/then-run-validation.test.ts` | A visible rejection of an invalid timeout. On the Effect family the serialized `timeout` also admits the strings `Infinity`, `-Infinity` and `NaN`, which the runtime check rejects. | Inert for valid calls. The schema cost is countable (below). |

## The countable part: schema bytes

The plugin extends a built-in mutation schema only when it can. It skips the extension when no
`shell` tool was captured, and it skips `patch` when the patch paths cannot be enumerated
([`wrap-tools.ts`](../src/action-fusion/wrap-tools.ts)). When it extends them, every provider
round-trip carries the added property text.

To measure that cost, extend the tool's own schema with the shipped text and compare the serialized
byte lengths. Use the base each family really has:

- **JSON schema family:** an empty object schema.
- **Effect-struct family:** a struct with one string field, the shape a real tool input has.

| Tool | JSON schema family | Effect-struct family |
|---|---|---|
| `edit` | 480 | 534 |
| `write` | 482 | 536 |
| `patch` | 516 | 570 |

Each figure is the cost of the whole `then_run` property. It is not the cost of the description text
alone. The fixed command and timeout sub-schema accounts for 421 bytes of the Effect column and 367
of the JSON column. The three descriptions account for the rest: 113 / 115 / 149 bytes. The per-tool
ceiling in the test is 700 bytes for the property, which leaves about 333 bytes of text on the JSON
column and 279 on the Effect column.

For the Effect column, do not use an empty struct base: an empty base and a one-field base disagree
by about 38 bytes per tool. Among non-empty bases the delta does not move — one field and three
fields both read 534 / 536 / 570 — so the one-field figure is the one to record. On the JSON family
a tool that already lists another property measures one byte more (481 / 483 / 517).

`tests/schema-cost.test.ts` reads the shipped descriptions and pins both columns, plus a 700-byte
ceiling for one property. One assertion reads this table and compares it with those numbers. A
wording or keyword change that moves a byte fails the suite until the table moves with it. That
includes a change to an Effect-only annotation that a schema-side copy would miss.

The 10 KiB figure in the pack gate is the archive threshold that decides whether one
tool **result** becomes a stored observation (`THRESHOLD_BYTES`). The schema text above
is tool **definition** text that every provider round-trip carries. Two different
budgets: keep them apart.

## Where the numbers come from

- [`benchmarks/README.md`](../benchmarks/README.md) — the measurement protocol and
  the method rules that make the numbers citable.
- The "Measured behavior" section of the [README](../README.md) — the campaign
  results, with the disclosures for the truncated and gate-crossing pairs.
