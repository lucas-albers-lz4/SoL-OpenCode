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
is tool **definition** text that every request carries. Two different budgets: keep them
apart.

## Where the numbers come from

- [`benchmarks/README.md`](../benchmarks/README.md) — the measurement protocol and
  the method rules that make the numbers citable.
- The "Measured behavior" section of the [README](../README.md) — the campaign
  results, with the disclosures for the truncated and gate-crossing pairs.
