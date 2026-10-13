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
  Emits round-trips, billed context (total / avg per round-trip / peak), tool
  calls, completed `obs_recall` calls, verdict, and packed-object count.

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
   token win that corrupts deliverables is not a win.

## Reference runs behind the README numbers

Original campaign (2026-10-12/13): one review bundle (PR-diff review, luna-class
model) and a 5-area audit fan-out over a pinned OpenWrt repo, arms off /
imperative-wording 0.1.0 / neutral-wording local build, across three model
families (one paid-tier, two free-tier). 40+ measured runs; issue-tracker
discussion #25/#26/#27 in this repo carries the per-wave tables, the
consolidated wording-decision data, and the operational incidents (quota
exhaustion, watchdog behavior). `ab-run.py`/`measure.py` are the generalized,
committed form of that harness.

## Quick start

```bash
# throwaway clone; put your code under test in the working tree
python3 benchmarks/ab-run.py --repo /path/to/target \
    --prompt-file /path/to/prompt.md --model <provider/model> \
    --arms off,off2,neu,neu2 --out ./ab-$(date +%F)
# then, with each run's isolated store visible:
python3 benchmarks/measure.py ./ab-DATE/runs --xdg-dir ./ab-DATE/xdg
```
