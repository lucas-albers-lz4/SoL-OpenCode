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
});
