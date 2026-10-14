/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const WORKFLOW_PATH = fileURLToPath(
  new URL("../.github/workflows/publish.yml", import.meta.url),
);
const STEP_NAME = "Verify tag matches package version";

/**
 * Pull the shipped tag gate out of the workflow rather than re-implementing it: three lines
 * copied into a test would keep passing after the workflow changed, and would guard nothing.
 */
export function extractTagGate(workflow: string): string {
  const lines = workflow.split("\n");
  const stepIndex = lines.findIndex((line) => line.includes(STEP_NAME));
  if (stepIndex < 0) throw new Error(`publish.yml has no "${STEP_NAME}" step`);

  const runIndex = lines.findIndex((line, index) => index > stepIndex && /^\s+run:\s*\|/.test(line));
  if (runIndex < 0) throw new Error(`the "${STEP_NAME}" step has no block run script`);

  const indent = (lines[runIndex] ?? "").match(/^\s*/u)?.[0].length ?? 0;
  const body: string[] = [];
  for (let index = runIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    const lineIndent = line.match(/^\s*/u)?.[0].length ?? 0;
    if (line.trim() !== "" && lineIndent <= indent) break;
    body.push(line.slice(Math.min(indent + 2, line.length)));
  }
  return body.join("\n").trim();
}

async function runTagGate(version: string, tag: string) {
  const script = extractTagGate(await readFile(WORKFLOW_PATH, "utf8"));
  const dir = await mkdtemp(join(tmpdir(), "publish-gate-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture", version }), "utf8");

  const result = spawnSync("bash", ["-e", "-c", script], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF_NAME: tag },
  });

  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

describe("publish workflow tag gate", () => {
  it("executes the shipped step and rejects a skewed tag", async () => {
    const matching = await runTagGate("0.1.1", "v0.1.1");
    expect(matching.status).toBe(0);

    const skewed = await runTagGate("0.1.1", "v0.1.2");
    expect(skewed.status).not.toBe(0);
    expect(skewed.output).toContain("tag v0.1.2 != package 0.1.1");
  });

  it("fails loudly if the workflow loses the step", () => {
    expect(() => extractTagGate("jobs:\n  publish:\n    steps:\n      - run: echo hi\n")).toThrow(
      new RegExp(STEP_NAME, "u"),
    );
  });
});
