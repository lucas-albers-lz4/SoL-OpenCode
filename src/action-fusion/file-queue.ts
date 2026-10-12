/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { realpath } from "node:fs/promises";
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

async function canonicalQueueKey(filePath: string): Promise<string> {
  const resolvedPath = resolve(filePath);
  let current = resolvedPath;
  const missingSegments: string[] = [];

  while (true) {
    try {
      return resolve(await realpath(current), ...missingSegments);
    } catch (error) {
      if (!isMissingPathError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return resolvedPath;
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
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
