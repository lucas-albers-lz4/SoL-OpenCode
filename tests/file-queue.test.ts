/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { link, mkdtemp, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  withFusedFileQueue,
  withFusedFileQueues,
} from "../src/action-fusion/file-queue.js";

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

  it("serializes hardlinked aliases of the same inode", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fused-queue-hardlink-"));
    const original = join(dir, "a.txt");
    const linked = join(dir, "b.txt");
    await writeFile(original, "shared bytes\n", "utf8");
    await link(original, linked);

    const events: string[] = [];
    // The singular entry point is the one `edit` and `write` use; the plural one is `patch`.
    // Both must find the same lock for the same bytes.
    const work = (label: string, path: string, delayMs: number) =>
      withFusedFileQueue(path, async () => {
        events.push(`${label}:start`);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        events.push(`${label}:end`);
        return label;
      });

    // Two names, one inode: realpath cannot tell them apart from unrelated files.
    await Promise.all([work("first", original, 20), work("second", linked, 20)]);

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

  it("does not collapse unrelated files onto one queue", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fused-queue-unrelated-"));
    const first = join(dir, "a.txt");
    const second = join(dir, "b.txt");
    await writeFile(first, "a\n", "utf8");
    await writeFile(second, "b\n", "utf8");

    const events: string[] = [];
    const work = (label: string, path: string) =>
      withFusedFileQueues([path], async () => {
        events.push(`${label}:start`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        events.push(`${label}:end`);
        return label;
      });

    // Different inodes must still run concurrently, or the fix would serialize everything.
    await Promise.all([work("first", first), work("second", second)]);

    expect(events).toHaveLength(4);
    expect(events.slice(0, 2).every((event) => event.endsWith(":start"))).toBe(true);
    expect(events.slice(2).every((event) => event.endsWith(":end"))).toBe(true);
    expect(
      events
        .slice(0, 2)
        .map((event) => event.slice(0, -":start".length))
        .sort(),
    ).toEqual(["first", "second"]);
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

  it("serializes the same path through the single-path and multi-path APIs", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fused-queue-mixed-"));
    const filePath = join(dir, "a.txt");
    await writeFile(filePath, "a\n", "utf8");

    const events: string[] = [];
    const work = (label: string) => async () => {
      events.push(`${label}:start`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push(`${label}:end`);
      return label;
    };

    // `edit`/`write` take the singular path, `patch` the plural one; one file, one lock.
    await Promise.all([
      withFusedFileQueue(filePath, work("edit")),
      withFusedFileQueues([filePath], work("patch")),
    ]);

    const starters = events
      .filter((event) => event.endsWith(":start"))
      .map((event) => event.slice(0, -":start".length));
    expect(starters.slice().sort()).toEqual(["edit", "patch"]);
    expect(events).toEqual([
      `${starters[0]}:start`,
      `${starters[0]}:end`,
      `${starters[1]}:start`,
      `${starters[1]}:end`,
    ]);
  });

  it("serializes a hardlink alias reached through the other API", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fused-queue-alias-mixed-"));
    const original = join(dir, "a.txt");
    const linked = join(dir, "b.txt");
    await writeFile(original, "shared bytes\n", "utf8");
    await link(original, linked);

    const events: string[] = [];
    const work = (label: string) => async () => {
      events.push(`${label}:start`);
      await new Promise((resolve) => setTimeout(resolve, 20));
      events.push(`${label}:end`);
      return label;
    };

    await Promise.all([
      withFusedFileQueue(linked, work("edit-via-alias")),
      withFusedFileQueues([original], work("patch-via-original")),
    ]);

    const starters = events
      .filter((event) => event.endsWith(":start"))
      .map((event) => event.slice(0, -":start".length));
    expect(starters.slice().sort()).toEqual(["edit-via-alias", "patch-via-original"]);
    expect(events).toEqual([
      `${starters[0]}:start`,
      `${starters[0]}:end`,
      `${starters[1]}:start`,
      `${starters[1]}:end`,
    ]);
  });

  it("still excludes a path renamed away inside the critical section", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fused-queue-renamed-"));
    const filePath = join(dir, "a.txt");
    await writeFile(filePath, "a\n", "utf8");

    let concurrent = 0;
    let peak = 0;
    const section = async (label: string, ms: number) => {
      concurrent += 1;
      peak = Math.max(peak, concurrent);
      await new Promise((resolve) => setTimeout(resolve, ms));
      concurrent -= 1;
      return label;
    };

    let renamed!: () => void;
    const renameHappened = new Promise<void>((resolveRenamed) => {
      renamed = resolveRenamed;
    });

    const holder = withFusedFileQueue(filePath, async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      await rename(filePath, `${filePath}.moved`);
      renamed();
      return section("holder", 40);
    });
    // Enqueued after the rename, while the holder still runs: the inode key no longer matches
    // the name, so only the retained path key keeps this out of the critical section.
    const late = renameHappened.then(() => withFusedFileQueue(filePath, () => section("late", 5)));

    await Promise.all([holder, late]);
    expect(peak).toBe(1);
  });
});

