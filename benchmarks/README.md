# Measurement protocol

Purpose: reproducible, honest A/B evidence for the two mechanisms, so the
README's "Measured behavior" numbers can be regenerated (and so new claims are
published only when they come from this pipeline, never from anecdotes).

## Tools

- `ab-run.py` — arm runner. Builds `off` (global config minus `plugins`) and
  `neu` (local-directory channel to *this working tree*) configs under a fresh
  output dir; each run gets isolated `XDG_CONFIG_HOME`/`XDG_DATA_HOME` so the
  observation store per run is countable. Run inside a **throwaway clone** — the
  `neu` arm executes uncommitted code.
- `measure.py` — metric extractor over `opencode run --format json` captures.
  Emits round-trips, billed context (total / avg per round-trip / peak /
  last-4-step average), output tokens, tool calls, over-10-KiB tool results
  (the pack-coverage denominator), completed `obs_recall` calls, verdict, and
  packed-object count. `billed` is input + cache read/write and **excludes**
  output: output is agent verbosity, and it is reported separately
  (`output_tokens`) so it cannot move a projection-controlled headline metric.
- `placeholder-bench.mjs` — CPU-only micro-benchmark for `countLines` and
  `placeholderFor` on a 7 MiB payload. It is not an arm pair and makes no
  context claim; the A/B protocol below is still the only source for those.

OpenCode 2.0.27 accepts the task as the positional message to `opencode run`;
`--repo` is an option to this harness, not a CLI positional argument. The runner
sets both the child process working directory and `PWD` to the target repo so
relative reads and writes use the fixture. `benchmarks/test_ab_run.py` pins this
contract.

## Method rules that make results citable

1. **Same model, same prompt bytes, same repo state** across arms. Compare an
   arm pair on one workload; a model family's results never merge into
   another's table.
2. **n ≥ 2 repetitions per arm per workload** before quoting direction; agents
   vary run-to-run (line-cites, verdicts). Single-run deltas are noise.
3. **Cite per-round-trip and peak as the projection-controlled metrics.** Run
   *totals* also scale with how many steps the agent chose to take, which is
   itself arm-sensitive — that is a finding, not a measurement error; report
   both and say which is which.
4. **Report inert cases as inert.** Payloads under 10 KiB pack nothing; a
   workload of only-small results must show ≈0 savings or the pipeline is
   being read wrong.
5. **Exit codes lie; the NDJSON doesn't.** `opencode run` can exit nonzero
   after delivering a complete stream (teardown noise). Parse the stream.
6. **Free-tier lanes have per-model daily quotas.** A throttled lane fails
   runs in ~10 s (empty/tiny NDJSON). Probe the lane before a batch and
   schedule replication across families (two families in one day may both be
   drained).
7. **Quality side-checks on every audit batch**: verdict distribution, finding
   count, report size, and at least one read of both arms' final reports — a
   token win that corrupts deliverables is not a win. (`verdict` is populated
   for review bundles only — audit prompts report `STATUS:` in their report
   file, so use report size and finding count there.)
8. **Exclude watchdog-truncated runs from totals.** A run killed at the timeout
   cap is not a shorter run, it is an unfinished one: pair totals drawn from it
   are not comparable and belong in the disclosures, not in a quoted range.
   Peak and per-round-trip figures survive truncation better than totals.

## Reference runs behind the README numbers

Original campaign (2026-10-12/13): one review bundle (PR-diff review,
`opencode-go/gpt-5.6-luna#high`) and a 5-area audit fan-out over a pinned OpenWrt
repo, arms off / imperative-wording 0.1.0 / neutral-wording local build. The
audit lanes were all free-tier (`opencode/mimo-v2.6-flash-free`,
`opencode/nemotron-3.5-lightning-free`, `opencode/nemotron-3-ultra-free`, plus
`opencode/muse-spark-1.3-contributor-free` on the plugin arm); the review bundle
used a different, non-free lane. Treat "free-tier" as the lane label — provider
pricing tiers were never checked against rate data (#25's B5 was not executed).
40+ measured runs; issue-tracker discussion #25/#26/#27 in this repo carries the
per-wave tables, the consolidated wording-decision data, and the operational
incidents (quota exhaustion, watchdog behavior: three `mimo` pairs were killed at
the 730 s cap and are excluded from the README's totals range).
`ab-run.py`/`measure.py` are the generalized, committed form of that harness.

## Quick start

```bash
# throwaway clone; put your code under test in the working tree
python3 benchmarks/ab-run.py --repo /path/to/target \
    --prompt-file /path/to/prompt.md --model <provider/model> \
    --arms off,off2,neu,neu2 --out ./ab-$(date +%F)
# then, with each run's isolated store visible:
python3 benchmarks/measure.py ./ab-DATE/runs --xdg-dir ./ab-DATE/xdg
```

## Reproducing issue #27 residual probes

The fixture generator creates six task fixtures. It removes a stale `SENTINEL_OUT.txt` from each recall fixture. The probe files use fixed prompts. The recall prompt does not contain the expected sentinel.

These runs require a working provider lane. CI does not run model-backed probes.

```bash
OUT="$HOME/.cache/sol-opencode-issue-27"
python3 benchmarks/probes/prepare-issue-27-fixtures.py --out "$OUT"
for rep in 1 2; do
  python3 benchmarks/ab-run.py --repo "$OUT/fixtures/fusion-off-$rep" \
    --prompt-file benchmarks/probes/issue-27-action-fusion.md \
    --model opencode-zen/nemotron-3.5-lightning-free --arms off --out "$OUT/fusion-off-$rep"
  python3 benchmarks/ab-run.py --repo "$OUT/fixtures/fusion-neu-$rep" \
    --prompt-file benchmarks/probes/issue-27-action-fusion.md \
    --model opencode-zen/nemotron-3.5-lightning-free --arms neu --out "$OUT/fusion-neu-$rep"
  python3 benchmarks/ab-run.py --repo "$OUT/fixtures/recall-neu-$rep" \
    --prompt-file benchmarks/probes/issue-27-forced-recall.md \
    --model opencode-zen/nemotron-3.5-lightning-free --arms neu --out "$OUT/recall-neu-$rep"
done
```

Compare each `SENTINEL_OUT.txt` with the fixture line outside the model prompt. Read the NDJSON trace to find the placeholder ID. Make sure that one `obs_recall` call completed and returned the `TARGET_SENTINEL=` line. The top-level README records the 2026-10-20 results. The repository does not include the raw captures.
