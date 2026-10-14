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
 * Identify a file by its inode: `realpath` resolves symlinks and the ancestor walk covers
 * missing files, but neither sees that two names are the same bytes through a hardlink. Two
 * aliases sharing one inode must share one queue or two fused operations on the same bytes
 * interleave.
 *
 * `ino === 0` means the platform did not report an inode (some Windows and FUSE mounts), so
 * the file keeps its path key rather than collapsing every file onto one queue.
 */
function inodeQueueKey(stats: { dev: number; ino: number }): string | undefined {
  if (stats.ino === 0) return undefined;
  return `inode:${stats.dev}:${stats.ino}`;
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

/**
 * Every key that must be held to own a path: the path key always, plus the inode key when the
 * file exists. Retaining the path key is what keeps the exclusion alive across a section that
 * renames or deletes its own path — an inode key alone stops matching the moment the name is
 * gone, which would let a later operation start inside the critical section.
 *
 * These keys are opaque queue names, not paths: nothing may canonicalize them a second time.
 */
async function queueKeysFor(filePath: string): Promise<string[]> {
  const resolvedPath = resolve(filePath);
  const pathKey = await pathQueueKey(resolvedPath);

  let stats: { dev: number; ino: number };
  try {
    stats = await stat(resolvedPath);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    return [pathKey];
  }

  const inodeKey = inodeQueueKey(stats);
  return inodeKey === undefined ? [pathKey] : [pathKey, inodeKey];
}

async function withQueueKey<T>(key: string, work: () => Promise<T>): Promise<T> {
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

/** Take every key in one stable sorted order, so overlapping acquisitions queue instead of deadlocking. */
async function withQueueKeys<T>(keys: readonly string[], work: () => Promise<T>): Promise<T> {
  const uniqueKeys = [...new Set(keys)].sort();
  if (uniqueKeys.length === 0) return work();

  const runChain = async (index: number): Promise<T> => {
    if (index >= uniqueKeys.length) return work();
    return withQueueKey(uniqueKeys[index]!, () => runChain(index + 1));
  };

  return runChain(0);
}

/** The queue behind a single mutation tool call (`edit` / `write`). */
export async function withFusedFileQueue<T>(filePath: string, work: () => Promise<T>): Promise<T> {
  return withQueueKeys(await queueKeysFor(filePath), work);
}

/** Acquire per-file queues in stable sorted order (multi-file patch). */
export async function withFusedFileQueues<T>(
  paths: readonly string[],
  work: () => Promise<T>,
): Promise<T> {
  const keySets = await Promise.all(paths.map((path) => queueKeysFor(path)));
  return withQueueKeys(keySets.flat(), work);
}
