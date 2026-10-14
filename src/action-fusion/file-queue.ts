/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { realpath, stat } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

const queueTails = new Map<string, Promise<void>>();

/** OpenCode mutation tools use `path` relative to the workspace directory (no Pi `@` / `file://` resolver). */
export function resolveMutationPath(cwd: string, path: string): string {
  return resolve(cwd, path);
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error.code === "ENOENT" || error.code === "ENOTDIR")
  );
}

/**
 * Identify a file by its inode when it exists: `realpath` resolves symlinks, the ancestor
 * walk covers missing files and `resolve` folds `./` prefixes, but none of them sees that
 * two names are the same bytes through a hardlink. Two aliases sharing one inode must share
 * one queue or two fused operations on the same bytes interleave.
 *
 * `ino === 0` means the platform did not report an inode (some Windows and FUSE mounts), so
 * fall back to the path key rather than collapsing every file onto one queue.
 */
async function fileIdentity(resolvedPath: string): Promise<string | undefined> {
  try {
    const stats = await stat(resolvedPath);
    if (stats.ino === 0) return undefined;
    return `inode:${stats.dev}:${stats.ino}`;
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return undefined;
  }
}

async function pathQueueKey(resolvedPath: string): Promise<string> {
  let current = resolvedPath;
  const missingSegments: string[] = [];

  while (true) {
    try {
      return `path:${resolve(await realpath(current), ...missingSegments)}`;
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return `path:${resolvedPath}`;
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

async function canonicalQueueKey(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath);
  return (await fileIdentity(resolvedPath)) ?? pathQueueKey(resolvedPath);
}

export async function withFusedFileQueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
  const key = await canonicalQueueKey(filePath);
  const previous = queueTails.get(key) ?? Promise.resolve();
  let release!: () => void;
  const owned = new Promise<void>((resolveOwned) => {
    release = resolveOwned;
  });
  const tail = previous.then(() => owned);
  queueTails.set(key, tail);

  await previous;
  try {
    return await work();
  } finally {
    release();
    if (queueTails.get(key) === tail) queueTails.delete(key);
  }
}

/** Acquire per-file queues in stable sorted order (multi-file patch). */
export async function withFusedFileQueues<T>(
  paths: readonly string[],
  work: () => Promise<T>,
): Promise<T> {
  const uniqueKeys = [
    ...new Set(await Promise.all(paths.map((path) => canonicalQueueKey(path)))),
  ].sort();
  if (uniqueKeys.length === 0) return work();

  const runChain = async (index: number): Promise<T> => {
    if (index >= uniqueKeys.length) return work();
    return withFusedFileQueue(uniqueKeys[index]!, () => runChain(index + 1));
  };

  return runChain(0);
}
