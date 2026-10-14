/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { withFusedFileQueues } from "../src/action-fusion/file-queue.js";

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
  });
}

describe("withFusedFileQueues", () => {
  it("deduplicates aliased paths so work runs instead of deadlocking", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fused-queue-"));
    const filePath = join(dir, "a.txt");
    await writeFile(filePath, "same file\n", "utf8");
    const aliased = join(dir, ".", "a.txt");

    let workRan = false;
    const result = await Promise.race([
      withFusedFileQueues([filePath, aliased], async () => {
        workRan = true;
        return "ok";
      }),
      timeout(1000),
    ]);

    expect(result).toBe("ok");
    expect(workRan).toBe(true);
  });

  it("still serializes distinct files without dropping work", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fused-queue-multi-"));
    const first = join(dir, "a.txt");
    const second = join(dir, "b.txt");
    await writeFile(first, "a\n", "utf8");
    await writeFile(second, "b\n", "utf8");

    const result = await withFusedFileQueues([second, first], async () => "both");
    expect(result).toBe("both");
  });

  it("serializes overlapping work on the same path instead of interleaving", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fused-queue-serial-"));
    const filePath = join(dir, "a.txt");
    await writeFile(filePath, "a\n", "utf8");

    const events: string[] = [];
    const work = (label: string, delayMs: number) =>
      withFusedFileQueues([filePath], async () => {
        events.push(`${label}:start`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        events.push(`${label}:end`);
        return label;
      });

    // Which call wins the lock is not specified; that the two runs never interleave is.
    await Promise.all([work("first", 20), work("second", 20)]);

    const starters = events
      .filter((event) => event.endsWith(":start"))
      .map((event) => event.slice(0, -":start".length));
    expect(starters.slice().sort()).toEqual(["first", "second"]);
    expect(events).toEqual([
      `${starters[0]}:start`,
      `${starters[0]}:end`,
      `${starters[1]}:start`,
      `${starters[1]}:end`,
    ]);
  });

  it("serializes work on a path that does not exist yet or any more", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fused-queue-missing-"));
    const missing = join(dir, "gone.txt");

    const events: string[] = [];
    const work = (label: string, delayMs: number) =>
      withFusedFileQueues([missing], async () => {
        events.push(`${label}:start`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        events.push(`${label}:end`);
        return label;
      });

    await Promise.all([work("first", 20), work("second", 20)]);

    const starters = events
      .filter((event) => event.endsWith(":start"))
      .map((event) => event.slice(0, -":start".length));
    expect(starters.slice().sort()).toEqual(["first", "second"]);
    expect(events).toEqual([
      `${starters[0]}:start`,
      `${starters[0]}:end`,
      `${starters[1]}:start`,
      `${starters[1]}:end`,
    ]);
  });
});
