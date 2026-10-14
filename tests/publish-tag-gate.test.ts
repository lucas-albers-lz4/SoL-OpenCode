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

  // Both spellings of the same step count: a block script and a single-line one. Freezing the
  // YAML shape would make a valid reformat of the gate look like a regression.
  let runIndex = -1;
  for (let index = stepIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (/^\s*-\s/u.test(line)) break; // the next step
    if (/^\s+run:\s*\|\s*$/u.test(line)) {
      runIndex = index;
      break;
    }
    const inline = /^\s+run:\s*(?!\|)(\S.*)$/u.exec(line);
    if (inline !== null) return inline[1]!.trim();
  }
  if (runIndex < 0) throw new Error(`the "${STEP_NAME}" step has no run script`);

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

async function runScript(script: string, version: string, tag: string) {
  const dir = await mkdtemp(join(tmpdir(), "publish-gate-"));
  await writeFile(join(dir, "package.json"), JSON.stringify({ name: "fixture", version }), "utf8");

  const result = spawnSync("bash", ["-e", "-c", script], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_REF_NAME: tag },
  });

  return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

async function runTagGate(version: string, tag: string) {
  return runScript(extractTagGate(await readFile(WORKFLOW_PATH, "utf8")), version, tag);
}

describe("publish workflow tag gate", () => {
  it("executes the shipped step and rejects a skewed tag", async () => {
    const matching = await runTagGate("0.1.1", "v0.1.1");
    expect(matching.status).toBe(0);

    const skewed = await runTagGate("0.1.1", "v0.1.2");
    expect(skewed.status).not.toBe(0);
    // It must say which versions disagreed, but the exact wording is not the contract.
    expect(skewed.output).toContain("0.1.2");
    expect(skewed.output).toContain("0.1.1");
  });

  it("still rejects a skewed tag when the step is reformatted or reworded", async () => {
    const reworded = [
      "jobs:",
      "  publish:",
      "    steps:",
      `      - name: ${STEP_NAME}`,
      "        run: |",
      "          PKG=$(node -p \"require('./package.json').version\")",
      "          TAG=\"${GITHUB_REF_NAME#v}\"",
      "          [ \"$PKG\" = \"$TAG\" ] || { echo \"version skew: $TAG vs $PKG\"; exit 1; }",
    ].join("\n");

    const result = await runScript(extractTagGate(reworded), "0.1.1", "v0.1.2");

    expect(result.status).not.toBe(0);
    expect(result.output).toContain("0.1.1");
  });

  it("reads a single-line run script for the same step", () => {
    const singleLine = [
      "jobs:",
      "  publish:",
      "    steps:",
      `      - name: ${STEP_NAME}`,
      "        run: PKG=$(node -p \"require('./package.json').version\"); [ \"$PKG\" = \"0.1.1\" ] || exit 1",
      "      - name: After",
      "        run: echo done",
    ].join("\n");

    const script = extractTagGate(singleLine);

    expect(script).toContain("exit 1");
    expect(script).not.toContain("echo done");
  });

  it("fails loudly if the workflow loses the step", () => {
    expect(() => extractTagGate("jobs:\n  publish:\n    steps:\n      - run: echo hi\n")).toThrow(
      new RegExp(STEP_NAME, "u"),
    );
  });
});
