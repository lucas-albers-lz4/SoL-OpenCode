/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { lstat, mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { isObservationId } from "./observation.js";

function defaultDataHome(): string {
  if (process.platform === "win32") {
    return process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  }
  if (process.platform === "darwin") {
    return join(homedir(), "Library", "Application Support");
  }
  return join(homedir(), ".local", "share");
}

function isCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

async function assertOwnedDirectory(path: string, privateDirectory: boolean): Promise<void> {
  const stats = await lstat(path);
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    throw new Error("Observation storage path must be a real directory");
  }

  if (process.platform === "win32") return;

  const uid = process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new Error("Observation storage directory must be owned by the current user");
  }

  const disallowedMode = privateDirectory ? 0o077 : 0o022;
  if ((stats.mode & disallowedMode) !== 0 || (stats.mode & 0o700) !== 0o700) {
    throw new Error("Observation storage directory has unsafe permissions");
  }
}

async function ensurePrivateDirectory(path: string): Promise<void> {
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!isCode(error, "EEXIST")) throw error;
  }
  await assertOwnedDirectory(path, true);
}

/** Plugin-owned archive root under a per-user data directory, never the shared temp directory. */
export async function observationPackObjectsRoot(): Promise<string> {
  const configuredDataHome = process.env.XDG_DATA_HOME;
  const dataHome =
    configuredDataHome !== undefined && configuredDataHome.length > 0 && isAbsolute(configuredDataHome)
      ? configuredDataHome
      : defaultDataHome();

  await mkdir(dataHome, { recursive: true, mode: 0o700 });
  await assertOwnedDirectory(dataHome, false);

  const pluginRoot = join(dataHome, "sol-opencode");
  const packRoot = join(pluginRoot, "observation-pack");
  const objectsRoot = join(packRoot, "objects");
  await ensurePrivateDirectory(pluginRoot);
  await ensurePrivateDirectory(packRoot);
  await ensurePrivateDirectory(objectsRoot);
  return objectsRoot;
}

export function observationObjectPath(objectsRoot: string, id: string): string {
  if (!isObservationId(id)) throw new Error("Invalid observation id");
  return join(objectsRoot, `${id}.txt`);
}
