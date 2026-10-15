#!/usr/bin/env python3
"""Extract comparable metrics from `opencode run --format json` captures.

Usage:
    python3 measure.py RUNS_DIR [--xdg-dir XDG_DATA_HOME_used_by_the_runs]

For each *.ndjson in RUNS_DIR (one provider stream per run) prints a TSV with:
  run, round_trips, billed_ctx_total, avg_ctx_per_rt, peak_ctx, tail4_avg_ctx,
  output_tokens, tool_calls, big_results, completed_obs_recall_calls, verdict,
  observation_objects (needs --xdg-dir pointing at that run's XDG_DATA_HOME)

Definitions (what each number means, so docs can cite them honestly):
  round_trip            one provider step (step_finish) — the unit a context
                        projection acts on.
  billed_ctx_total      input + cache_read + cache_write summed per step and
                        totaled over the run: the definition the published
                        campaign tables use, so the README numbers reproduce
                        exactly with this script. `output` is reported
                        separately as output_tokens — it is agent verbosity,
                        which is itself arm-sensitive, and folding it into a
                        "projection-controlled" headline metric can flip the
                        sign on output-heavy workloads.
  avg_ctx_per_rt        billed_ctx_total / round_trips.
  peak_ctx              max per-step context within the run — session-length
                        headroom, the resource a long audit actually runs out
                        of.
  tail4_avg_ctx         mean per-step context of the last four steps — the
                        projection-compounding signal (where the session ends,
                        as opposed to what it averaged).
  big_results           tool results over 10 KiB — the pack-coverage
                        denominator (objects created over results past the
                        gate). The plugin-off arm cannot see this from its own
                        store, so it is counted from the stream.
  verdict               APPROVE / REQUEST_CHANGES / COMMENT parsed from the
                        text parts. Blank when the workload is not a review:
                        audit prompts report `STATUS:` in their report file,
                        so only review bundles populate this column.

The A/B method (arms, bundles, repetition, quality checks) is in
benchmarks/README.md; publish only numbers this script emitted.
"""
import json
import sys
import pathlib

BIG_RESULT_BYTES = 10 * 1024
TAIL_STEPS = 4


def step_finish(part):
    return isinstance(part, dict) and part.get("type") in ("step-finish", "step_finish")


def analyze(ndjson_path, xdg_dir=None):
    step_contexts = []
    output_tokens = 0
    tools = 0
    big_results = 0
    recall = 0
    final_texts = []
    for line in open(ndjson_path, errors="replace"):
        line = line.strip()
        if not line:
            continue
        try:
            o = json.loads(line)
        except ValueError:
            continue
        p = o.get("part")
        if not isinstance(p, dict):
            continue
        t = p.get("type")
        if step_finish(p):
            tok = p.get("tokens") or {}
            c = tok.get("cache") or {}
            ctx = (tok.get("input", 0) or 0) + (c.get("read", 0) or 0) + (
                c.get("write", 0) or 0)
            step_contexts.append(ctx)
            output_tokens += tok.get("output", 0) or 0
        elif t == "text" and p.get("text"):
            final_texts.append(p["text"])
        elif t == "tool":
            tools += 1
            st = p.get("state") or {}
            result = st.get("output")
            if isinstance(result, str) and len(result) > BIG_RESULT_BYTES:
                big_results += 1
            if p.get("tool") == "obs_recall" and st.get("status") == "completed":
                recall += 1
    billed = sum(step_contexts)
    steps = len(step_contexts)
    tail = step_contexts[-TAIL_STEPS:]
    verdict = ""
    joined = "\n".join(final_texts)
    for m in ("REQUEST_CHANGES", "APPROVE", "COMMENT"):
        if f"VERDICT: {m}" in joined:
            verdict = m
            break
    objs = 0
    if xdg_dir:
        # campaign layout: one XDG_DATA_HOME per run (dir named like the run);
        # ab-run layout: out/xdg/<arm>. Try both, fall back to a shared dir.
        base = pathlib.Path(xdg_dir)
        for cand in (base / ndjson_path.stem, base):
            d = cand / "sol-opencode" / "observation-pack" / "objects"
            if d.exists():
                objs = len([f for f in d.iterdir() if f.name.startswith("obs_")])
                break
    return {
        "round_trips": steps,
        "billed_ctx_total": billed,
        "avg_ctx_per_rt": round(billed / steps) if steps else 0,
        "peak_ctx": max(step_contexts) if step_contexts else 0,
        "tail4_avg_ctx": round(sum(tail) / len(tail)) if tail else 0,
        "output_tokens": output_tokens,
        "tool_calls": tools,
        "big_results": big_results,
        "recall_completed": recall,
        "verdict": verdict,
        "obs_objects": objs,
    }


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    runs = pathlib.Path(sys.argv[1])
    xdg = None
    if "--xdg-dir" in sys.argv:
        xdg = sys.argv[sys.argv.index("--xdg-dir") + 1]
    files = sorted(runs.glob("*.ndjson"))
    if not files:
        print(f"no *.ndjson under {runs}", file=sys.stderr)
        sys.exit(1)
    cols = ["round_trips", "billed_ctx_total", "avg_ctx_per_rt", "peak_ctx",
            "tail4_avg_ctx", "output_tokens", "tool_calls", "big_results",
            "recall_completed", "verdict", "obs_objects"]
    print("\t".join(["run"] + cols))
    for f in files:
        m = analyze(f, xdg)
        print("\t".join([f.stem] + [str(m[c]) for c in cols]))


if __name__ == "__main__":
    main()
