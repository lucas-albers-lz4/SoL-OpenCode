/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, realpath, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFusedFileQueue } from "../src/action-fusion/file-queue.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return { ...actual, stat: vi.fn(actual.stat) };
});

const mockedStat = vi.mocked(stat);

type StatResult = Awaited<ReturnType<typeof stat>>;

afterEach(() => {
  mockedStat.mockReset();
});

async function twoExistingPaths(): Promise<readonly [string, string]> {
  const dir = await mkdtemp(join(tmpdir(), "fused-queue-keys-"));
  const first = join(dir, "a.txt");
  const second = join(dir, "b.txt");
  await writeFile(first, "a\n", "utf8");
  await writeFile(second, "b\n", "utf8");
  return [await realpath(first), await realpath(second)] as const;
}

/** 2 means one queue each; 1 would mean two unrelated files were collapsed onto one queue. */
async function peakConcurrency(paths: readonly string[]): Promise<number> {
  let concurrent = 0;
  let peak = 0;
  const section = async () => {
    concurrent += 1;
    peak = Math.max(peak, concurrent);
    await new Promise((resolve) => setTimeout(resolve, 30));
    concurrent -= 1;
  };

  await Promise.all(paths.map((path) => withFusedFileQueue(path, section)));
  return peak;
}

describe("queue keys from unusual stat results", () => {
  it("keeps two files apart when the platform reports no inode", async () => {
    const [first, second] = await twoExistingPaths();
    // `ino === 0` is "no inode reported" (some Windows and FUSE mounts). Without that escape
    // hatch both files key on `inode:<dev>:0` and unrelated work serializes behind them.
    mockedStat.mockResolvedValue({ dev: 1, ino: 0 } as unknown as StatResult);

    expect(await peakConcurrency([first, second])).toBe(2);
  });

  it("keeps two files apart when only the device differs", async () => {
    const [first, second] = await twoExistingPaths();
    // Same inode number on two devices is two different files; the key must carry `dev`.
    mockedStat.mockImplementation(
      async (path) => ({ dev: String(path) === first ? 1 : 2, ino: 7 }) as unknown as StatResult,
    );

    expect(await peakConcurrency([first, second])).toBe(2);
  });
});
