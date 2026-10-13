#!/usr/bin/env python3
"""Extract comparable metrics from `opencode run --format json` captures.

Usage:
    python3 measure.py RUNS_DIR [--xdg-dir XDG_DATA_HOME_used_by_the_runs]

For each *.ndjson in RUNS_DIR (one provider stream per run) prints a TSV with:
  run, round_trips, billed_context_tokens_total, avg_context_per_round_trip,
  peak_context_tokens, tool_calls, completed_obs_recall_calls, verdict,
  observation_objects (needs --xdg-dir pointing at that run's XDG_DATA_HOME)

Definitions (what each number means, so docs can cite them honestly):
  round_trip            one provider step (step_finish) — the unit a context
                        projection acts on.
  billed_context_tokens input + cache_read + cache_write + output summed per
                        step and totaled over the run. On prompt-cached
                        providers cache_read dominates; per-step and peak
                        figures are the projection-controlled metrics, while
                        totals scale with how many steps the agent chose.
  peak_context          max per-step context within the run — session-length
                        headroom, the resource a long audit actually runs out
                        of.
  verdict               APPROVE / REQUEST_CHANGES / COMMENT parsed from the
                        final assistant text (blank when the workload isn't
                        a review).

The A/B method (arms, bundles, repetition, quality checks) is in
benchmarks/README.md; publish only numbers this script emitted.
"""
import json
import sys
import pathlib


def step_finish(part):
    return isinstance(part, dict) and part.get("type") in ("step-finish", "step_finish")


def analyze(ndjson_path, xdg_dir=None):
    steps = 0
    billed = 0
    peak = 0
    tools = 0
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
                c.get("write", 0) or 0) + (tok.get("output", 0) or 0)
            steps += 1
            billed += ctx
            peak = max(peak, ctx)
        elif t == "text" and p.get("text"):
            final_texts.append(p["text"])
        elif t == "tool":
            tools += 1
            st = p.get("state") or {}
            if p.get("tool") == "obs_recall" and st.get("status") == "completed":
                recall += 1
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
        "peak_ctx": peak,
        "tool_calls": tools,
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
            "tool_calls", "recall_completed", "verdict", "obs_objects"]
    print("\t".join(["run"] + cols))
    for f in files:
        m = analyze(f, xdg)
        print("\t".join([f.stem] + [str(m[c]) for c in cols]))


if __name__ == "__main__":
    main()
