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
     [`benchmarks/`](./benchmarks/README.md). Report the median and the spread.
     Do not quote a single run.
   - If the change cannot alter volume or round-trips, state why. Give the count
     when you can count it.

A green `npm test` is not the quality proof. The suite proves behavior only.

## The quality floor

A measured result must be at least equal to the baseline. The baseline is `main` at
the base commit of the change.

- **Efficiency:** average context per provider round-trip, peak context, and total
  billed context. Use the metrics and the method rules in
  [`benchmarks/README.md`](./benchmarks/README.md).
- **Quality:** the verdicts and the findings must not regress. A token win that
  corrupts the deliverable is not a win.

One class of change cannot be equal to the baseline by design: a fix that restores
intended behavior. When a fused command moves from "never ran" to "ran", it adds
round-trips and output. For this class, state the intended behavior change and the
expected direction until a measurement exists.

## Recorded statements (review pass of 2026-10-14)

| Fix | Unit assertion | Model-visible surface | Quality statement |
|---|---|---|---|
| #30 — path enumeration for delete and rename | `tests/patch-paths.test.ts` | A fused command now runs where it was dropped. A patch that touches no path reports a skip notice. | **Not inert.** It removes round-trips only when a model fuses. No landed run used `then_run`, so the volume claim stays unmeasured. |
| #31 — malformed `then_run` is rejected visibly | `tests/then-run-validation.test.ts` | Schema keywords, plus a `[then_run:skipped]` marker with its reason. | Inert for well-formed calls. The schema cost is countable (below). The marker appears only when the model sends a malformed `then_run`. |
| #34 — recall chunk alignment and offset validation | `tests/observation-recall.test.ts` | A chunk starts at a character boundary. An invalid offset fails with a clean message instead of a raw `ERR_OUT_OF_RANGE`. | Inert for volume in normal paging. Boundaries move only for an offset that does not start a character, which previously decoded to `U+FFFD` garbage. |
| #35 — `then_run` timeout validation | `tests/then-run-validation.test.ts` | Schema keywords, plus a visible rejection of an invalid timeout. | Inert for valid calls. The schema cost is countable (below). |

## The countable part: schema bytes

The tool list is sent on every provider request. Every byte of the `then_run`
description is therefore paid on every round-trip.

To measure the cost, extend an empty object schema with the shipped description and
compare the JSON byte lengths:

| Tool | Added bytes |
|---|---|
| `edit` | 480 |
| `write` | 482 |
| `patch` | 516 |

A session that carries all three mutation tools therefore pays about 1.5 KiB per
request, which is about 15% of the 10 KiB pack gate. `tests/schema-cost.test.ts`
pins the exact numbers above and a 600-byte ceiling per tool. The test fails when a
wording or keyword change grows the text, so the growth becomes a decision and not
an accident.

## Where the numbers come from

- [`benchmarks/README.md`](./benchmarks/README.md) — the measurement protocol and
  the method rules that make the numbers citable.
- The "Measured behavior" section of the [README](../README.md) — the campaign
  results, with the disclosures for the truncated and non-crossing pairs.
