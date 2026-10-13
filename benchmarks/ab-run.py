#!/usr/bin/env python3
"""Fair A/B harness for sol-opencode arm comparison on any real workload.

Usage (run inside a throwaway git clone of this repo):

  python3 benchmarks/ab-run.py \
      --repo /path/to/target-repo \
      --prompt-file /path/to/prompt.md \
      --model opencode/some-model \
      --arms off,off2,neu,neu2 \
      --out ./ab-$(date +%F)

Arms:
  off   no plugin   (generated config = your global opencode config minus any
                     "plugins" key, so providers/auth stay identical)
  neu   plugin ON   (this clone's root index.ts entrypoint = the working-tree
                     code under test)
Repeat an arm (off,off2) for run-to-run variance sampling.

Each run gets an isolated XDG_CONFIG_HOME (arm config) and XDG_DATA_HOME
(observation store, keeps packed-object counts per run). Wall time and exit
code are recorded per run; analyze with:

  python3 benchmarks/measure.py ./ab-DATE/runs

Notes / gotchas learned the hard way:
  * OpenCode 2 takes the work dir as a POSITIONAL arg right after `run`, and
    model variants as `--model provider/model#variant`.
  * `opencode run` may exit nonzero after a COMPLETE JSON stream (teardown
    noise). Trust the NDJSON, not the exit code.
  * The host rewrites/extends the config file you point at; the harness always
    generates fresh copies under --out, never edits your global config.
  * Free-tier models have per-lane daily quotas; a rate-limited lane fails
    runs in ~10 s (small/empty NDJSON). Re-run that arm when the lane recovers,
    or probe first: opencode run 'Say OK' --model <lane> --standalone
  * For honest totals comparison, normalize per round-trip and peak; totals
    scale with agent-chosen steps, which is itself arm-sensitive (see README).
"""
import argparse
import json
import os
import pathlib
import shutil
import subprocess
import sys
import time

HERE = pathlib.Path(__file__).resolve().parent
REPO_ROOT = HERE.parent  # throwaway clone of sol-opencode (has root index.ts)


def arm_config(arm_name, out_dir, base_global_config):
    cfg_dir = out_dir / "cfg" / arm_name / "opencode"
    cfg_dir.mkdir(parents=True, exist_ok=True)
    target = cfg_dir / "opencode.jsonc"
    if arm_name.startswith("off"):
        data = json.loads(pathlib.Path(base_global_config).read_text())
        data.pop("plugins", None)
        target.write_text(json.dumps(data, indent=2))
        return cfg_dir.parent  # XDG_CONFIG_HOME value
    if arm_name.startswith("neu"):
        entry = str(REPO_ROOT)  # local-directory channel -> root index.ts
        data = json.loads(pathlib.Path(base_global_config).read_text())
        data["plugins"] = [{"package": entry,
                            "options": {"actionFusion": True, "observationPack": True}}]
        target.write_text(json.dumps(data, indent=2))
        subprocess.run(["npm", "run", "build"], cwd=REPO_ROOT, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.STDOUT,
                       timeout=600)
        return cfg_dir.parent
    sys.exit(f"unknown arm prefix: {arm_name} (use off*/neu*)")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, help="target repo/worktree to run in")
    ap.add_argument("--prompt-file", required=True)
    ap.add_argument("--model", required=True)
    ap.add_argument("--arms", default="off,off2,neu,neu2")
    ap.add_argument("--out", default="./ab-out")
    ap.add_argument("--timeout", type=int, default=1300)
    args = ap.parse_args()

    out = pathlib.Path(args.out).resolve()
    runs = out / "runs"
    runs.mkdir(parents=True, exist_ok=True)
    global_cfg = os.environ.get(
        "OPENCODE_GLOBAL_CONFIG",
        os.path.expanduser("~/.config/opencode/opencode.jsonc"),
    )
    prompt = pathlib.Path(args.prompt_file).read_text()

    results = []
    for arm in args.arms.split(","):
        cfg_home = arm_config(arm.strip(), out, global_cfg)
        data_home = out / "xdg" / arm.strip()
        data_home.mkdir(parents=True, exist_ok=True)
        env = dict(os.environ)
        env["XDG_CONFIG_HOME"] = str(cfg_home)
        env["XDG_DATA_HOME"] = str(data_home)
        t0 = time.time()
        ndjson = runs / f"{arm.strip()}.ndjson"
        with open(ndjson, "wb") as f:
            rc = subprocess.call(
                ["opencode", "run", args.repo, prompt, "-m", args.model,
                 "--format", "json", "--standalone", "--print-logs", "--auto",
                 "--title", f"ab-{arm.strip()}-{int(t0)}"],
                env=env, stdout=f,
                stderr=open(runs / f"{arm.strip()}.err", "wb"),
                timeout=args.timeout)
        wall = round(time.time() - t0)
        size = ndjson.stat().st_size
        results.append((arm.strip(), rc, wall, size))
        print(f"{arm.strip()}: rc={rc} wall={wall}s ndjson_bytes={size}", flush=True)

    print("\n-- measure --")
    subprocess.run([sys.executable, str(HERE / "measure.py"), str(runs),
                    "--xdg-dir", str(out / "xdg")])


if __name__ == "__main__":
    main()
