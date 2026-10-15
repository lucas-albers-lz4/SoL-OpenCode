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
     round-trips, measure both arms (off and on) with
     [`benchmarks/`](../benchmarks/README.md). Report the median and the spread.
     Do not quote a single run.
   - If the change cannot alter volume or round-trips, state why. Give the count
     when you can count it.

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
| #30 — path enumeration for delete and rename | `tests/patch-paths.test.ts`, `tests/then-run.test.ts` | A fused command now runs where it was dropped. A patch that touches no path reports a skip notice. | **Not inert.** It removes round-trips only when a model fuses. No landed run used `then_run`, so the volume claim stays unmeasured. |
| #31 — malformed `then_run` is rejected visibly | `tests/then-run-validation.test.ts`, `tests/then-run.test.ts` | A `[then_run:skipped]` marker with its reason. The serialized schema shows the `pattern` on the JSON family; the Effect serialization that the host sends for the built-in tools shows no keyword, so the runtime rejection carries the contract. | Inert for well-formed calls. The schema cost is countable (below). The marker appears only when the model sends a malformed `then_run`. |
| #34 — recall chunk alignment and offset validation | `tests/observation-recall.test.ts` | A chunk starts at a character boundary. An invalid offset fails with a clean message instead of a raw `ERR_OUT_OF_RANGE`. | Inert for volume in normal paging. Boundaries move only for an offset that does not start a character, which previously decoded to replacement characters. |
| #35 — `then_run` timeout validation | `tests/then-run-validation.test.ts` | A visible rejection of an invalid timeout. On the Effect family the serialized `timeout` also admits the strings `Infinity`, `-Infinity` and `NaN`, which the runtime check rejects. | Inert for valid calls. The schema cost is countable (below). |

## The countable part: schema bytes

The provider request carries the tool list. The model pays every byte of the
`then_run` description on every round-trip.

To measure the cost, extend the tool's own schema with the shipped description and
compare the serialized byte lengths. Use an empty base for one stable number per tool:

| Tool | JSON schema family | Effect-struct family |
|---|---|---|
| `edit` | 480 | 534 |
| `write` | 482 | 536 |
| `patch` | 516 | 570 |

Both columns extend a tool's own schema with the shipped description and compare serialized byte
lengths. The JSON column uses an empty object base, because those tools are not the shipped ones.
The Effect column uses a base with one string field, the shape a real tool input has: it is the cost
a request pays for one description, about 1.6 KiB for all three tools.

Do not read the Effect column off an empty struct base. That recipe reports 38 bytes more per tool
(572 / 574 / 608), because an empty struct serializes to `{"not":{"type":"null"}}` while the extended
document carries the full object skeleton. No real request pays that difference for a description.
The delta is stable across the non-empty bases measured here: one field and three fields both read
534 / 536 / 570. On the JSON family, a tool that already lists another property measures one byte
more per description (481 / 483 / 517), so that column keeps the empty-base recipe for one stable
number per tool.

`tests/schema-cost.test.ts` reads the shipped descriptions and pins both columns, plus a 700-byte
ceiling for one description. One assertion reads this table and compares it with those numbers. A
wording or keyword change that moves a byte fails the suite until the table moves with it.

The 10 KiB figure in the pack gate is the archive threshold that decides whether one
tool **result** becomes a stored observation (`THRESHOLD_BYTES`). The schema text above
is tool **definition** text that every request carries. Two different budgets: keep them
apart.

## Where the numbers come from

- [`benchmarks/README.md`](../benchmarks/README.md) — the measurement protocol and
  the method rules that make the numbers citable.
- The "Measured behavior" section of the [README](../README.md) — the campaign
  results, with the disclosures for the truncated and gate-crossing pairs.
