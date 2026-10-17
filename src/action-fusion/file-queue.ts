/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { FSUtil } from "@opencode/util/fs-util";
import { lstat, readlink, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";

const queueTails = new Map<string, Promise<void>>();

/**
 * Bound on followed symlinks, so a link cycle cannot loop the key derivation. Linux
 * resolves at most 40 links (`ELOOP` beyond that), so the bound sits above the OS limit:
 * every chain the kernel can resolve is walked, and a longer one is bounded here.
 */
const MAX_LINK_DEPTH = 64;

/**
 * OpenCode mutation tools use `path` relative to the workspace directory (no Pi `@` /
 * `file://` resolver). The host still converts the drive spellings a shell hands it before
 * it resolves a path — `@opencode/util` `FSUtil.windowsPath`, `win32` only, covering `/c/…`,
 * `/c:/…`, `/mnt/c/…` and `/cygdrive/c/…`. Apply the host's own conversion, so the queue and the hash
 * guard address the file the mutation writes: otherwise `/c/src/app.ts` and `C:/src/app.ts`
 * name one file and hold two queue keys, which lets two fused operations interleave (issue
 * #61). Do not copy upstream SoL-Pi's resolver: it also strips `@`, expands `~` and folds
 * Unicode spaces, which are Pi behaviours this host does not share.
 */
export function resolveMutationPath(cwd: string, path: string): string {
  return resolve(cwd, FSUtil.windowsPath(path));
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
 * A name the filesystem cannot resolve at all: it is absent, or it is a symlink cycle
 * (`ELOOP`). Both fall back to the name-based key, so for these two shapes key derivation
 * does not turn a broken workspace path into a plugin error before the host tool reports its
 * own. Any other error, a permission problem or a filesystem fault, still propagates.
 */
function isUnresolvablePathError(error: unknown): boolean {
  return (
    isMissingPathError(error) ||
    (typeof error === "object" && error !== null && "code" in error && error.code === "ELOOP")
  );
}

/**
 * Identify a file by its inode: `realpath` resolves a symlink whose target exists, and the
 * ancestor walk covers missing files, but neither sees that two names are the same bytes
 * through a hardlink. Two aliases sharing one inode must share one queue or two fused
 * operations on the same bytes interleave.
 *
 * Not covered: a dangling symlink is handled by the link-chain walk in `queueKeysFor`,
 * which keys the link name and its resolved target name together (issue #56).
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
      if (!isUnresolvablePathError(error)) throw error;
      const parent = dirname(current);
      if (parent === current) return `path:${resolvedPath}`;
      missingSegments.unshift(basename(current));
      current = parent;
    }
  }
}

/**
 * Join a link target to the physical directory the link lives in, resolving the target's own
 * symlinked components the way the kernel does. The final component stays lexical: the target
 * often does not exist yet, which is the shape this walk exists for.
 *
 * The split is on the platform separator only. Off Windows a backslash is an ordinary name
 * character, so `g\h.txt` is one component: splitting on it too would key the phantom `g/h.txt`,
 * a real file the link never reaches. A UNC target on win32 (`\\server\share\…`) is not handled
 * here; no test in this environment can exercise that shape.
 */
async function physicalTarget(linkDirectory: string, target: string): Promise<string> {
  const separator = sep === "\\" ? /[\\/]+/ : "/";
  const segments = target.split(separator).filter((segment) => segment !== "" && segment !== ".");
  let current = isAbsolute(target) ? sep : linkDirectory;

  for (const [index, segment] of segments.entries()) {
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const candidate = resolve(current, segment);
    if (index === segments.length - 1) return candidate;
    try {
      current = await realpath(candidate);
    } catch (error) {
      if (!isUnresolvablePathError(error)) throw error;
      // Nothing below this prefix exists either, so the remaining target stays lexical.
      current = candidate;
    }
  }

  return current;
}

/**
 * Every name one operation can reach through symlinks, starting at `resolvedPath`.
 *
 * `realpath` cannot resolve a link whose target does not exist yet, so a dangling link
 * and its missing target would otherwise hold disjoint queue keys and two fused
 * operations through them would interleave (issue #56). `lstat` sees the link itself and
 * `readlink` gives its target, so the chain is walked by hand: relative targets resolve
 * against the link's directory, and the walk stops at the first non-link, at a repeated
 * name, or at the depth bound.
 */
async function linkChain(resolvedPath: string): Promise<string[]> {
  const chain: string[] = [resolvedPath];
  const seen = new Set<string>([resolvedPath]);
  let current = resolvedPath;

  for (let depth = 0; depth < MAX_LINK_DEPTH; depth += 1) {
    let isLink = false;
    try {
      isLink = (await lstat(current)).isSymbolicLink();
    } catch (error) {
      if (!isUnresolvablePathError(error)) throw error;
      return chain;
    }
    if (!isLink) return chain;

    let target: string;
    try {
      target = await readlink(current);
    } catch {
      // `lstat` reported a link, so a `readlink` failure here is a race (the name was
      // swapped for a regular file, `EINVAL`), a permission problem, or a limit: end the
      // walk on the name key rather than turn a transient filesystem state into a plugin
      // error before the host tool reports its own.
      return chain;
    }

    // The kernel resolves a target against the link's directory **as it really is**, and it
    // resolves every symlink inside the target too. `path.resolve` does neither: it collapses
    // `..` against the spelled name, so `sub/../target.txt` through a symlinked `sub`, or
    // `lib/../include/y.h` through a symlinked `lib`, names a file the kernel never reaches —
    // and then two names for one file hold disjoint keys, which is issue #56's failure mode
    // again. Walk the target's components and resolve each non-final prefix physically.
    // Cost: one `lstat` per acquisition, plus `readlink` and `realpath` per link hop or prefix.
    let linkDirectory = dirname(current);
    try {
      linkDirectory = await realpath(linkDirectory);
    } catch (error) {
      if (!isUnresolvablePathError(error)) throw error;
    }
    current = await physicalTarget(linkDirectory, target);
    // A repeated name ends the walk. The depth bound alone would also stop a cycle, but
    // the early exit keeps it at two `lstat` calls instead of the full bound.
    if (seen.has(current)) return chain;
    seen.add(current);
    chain.push(current);
  }

  return chain;
}

/**
 * Every key that must be held to own a path: the path key always, plus the inode key when the
 * file exists. Retaining the path key keeps the exclusion alive for the locked *name* across a
 * section that renames or deletes it — an inode key alone stops matching the moment the name is
 * gone, which would let a later operation start inside the critical section.
 *
 * A path that is a symlink contributes a key for the link name and for the resolved target
 * name, so a fused section on either name excludes the other.
 *
 * Keys are derived when an operation is enqueued, so an alias that appears while a section is
 * already running contributes no inode key and is not covered by it.
 *
 * These keys are opaque queue names, not paths: nothing may canonicalize them a second time.
 */
async function queueKeysFor(filePath: string): Promise<string[]> {
  // Keep `..` in the spelling until the filesystem resolves it. `path.resolve` is only
  // lexical: when an earlier component is a symlink, the kernel applies `..` to the
  // symlink target's directory instead. Collapsing it here can therefore give two names
  // for the same file disjoint queue keys.
  const absolutePath = isAbsolute(filePath) ? filePath : `${process.cwd()}${sep}${filePath}`;
  const pathKeys = new Set<string>();
  for (const name of await linkChain(absolutePath)) {
    pathKeys.add(await pathQueueKey(name));
  }

  let stats: { dev: number; ino: number };
  try {
    stats = await stat(absolutePath);
  } catch (error) {
    if (!isUnresolvablePathError(error)) throw error;
    return [...pathKeys];
  }

  const inodeKey = inodeQueueKey(stats);
  return inodeKey === undefined ? [...pathKeys] : [...pathKeys, inodeKey];
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
