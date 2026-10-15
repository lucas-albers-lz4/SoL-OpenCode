/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { lstat, mkdtemp, readlink, realpath, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { withFusedFileQueue } from "../src/action-fusion/file-queue.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    lstat: vi.fn(actual.lstat),
    stat: vi.fn(actual.stat),
    readlink: vi.fn(actual.readlink),
  };
});

const mockedLstat = vi.mocked(lstat);
const mockedStat = vi.mocked(stat);
const mockedReadlink = vi.mocked(readlink);

type StatResult = Awaited<ReturnType<typeof stat>>;

afterEach(() => {
  mockedLstat.mockReset();
  mockedStat.mockReset();
  mockedReadlink.mockReset();
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
    const callsBefore = mockedStat.mock.calls.length;

    expect(await peakConcurrency([first, second])).toBe(2);
    // Without this the test would keep passing if the key derivation stopped calling stat.
    expect(mockedStat.mock.calls.length - callsBefore).toBe(2);
  });

  it("surfaces a stat failure that is neither ENOENT nor ENOTDIR", async () => {
    const [first] = await twoExistingPaths();
    // A permission or I/O failure must not silently drop the inode key: that would restore the
    // interleaving this module exists to prevent, with a green suite.
    mockedStat.mockRejectedValue(Object.assign(new Error("permission denied"), { code: "EACCES" }));

    await expect(withFusedFileQueue(first, async () => "never")).rejects.toThrow(/permission denied/u);
  });

  it("keeps two files apart when only the device differs", async () => {
    const [first, second] = await twoExistingPaths();
    // Same inode number on two devices is two different files; the key must carry `dev`.
    mockedStat.mockImplementation(
      async (path) => ({ dev: String(path) === first ? 1 : 2, ino: 7 }) as unknown as StatResult,
    );

    expect(await peakConcurrency([first, second])).toBe(2);
  });

  it("ends the walk on the name key when readlink fails", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fused-queue-readlink-"));
    const target = join(dir, "target.txt");
    const linkPath = join(dir, "link.txt");
    await writeFile(target, "x\n", "utf8");
    await symlink(target, linkPath);
    // `lstat` reported a link, so a `readlink` failure here is a race, a permission problem, or a
    // limit. Key derivation must not turn that into a plugin error before the host tool reports its
    // own. The pair then degrades to the name keys: weaker isolation, never a thrown error — and
    // without this fixture a rethrow stays green through every other test in the suite.
    mockedReadlink.mockRejectedValue(Object.assign(new Error("invalid argument"), { code: "EINVAL" }));

    await expect(withFusedFileQueue(linkPath, async () => "ran")).resolves.toBe("ran");
  });

  it("stops a cycle at two lstat calls instead of the depth bound", async () => {
    // The `seen` short-circuit is a cost guard: the depth bound alone also ends a cycle, at 64
    // hops. No other test would notice its removal, so pin the cost: 2 `lstat` calls here, 64
    // without the short-circuit.
    const dir = await mkdtemp(join(tmpdir(), "fused-queue-cycle-cost-"));
    const first = join(dir, "first.txt");
    const second = join(dir, "second.txt");
    await symlink(second, first);
    await symlink(first, second);

    mockedLstat.mockClear();
    await withFusedFileQueue(first, async () => "ran");
    const calls = mockedLstat.mock.calls.filter(([name]) => String(name).startsWith(dir)).length;

    expect(calls).toBeLessThanOrEqual(4);
  });
});
