/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { chmod, lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createObservation,
  ensureStored,
  readStoredObservation,
  THRESHOLD_BYTES,
} from "../src/observation-pack/observation.js";
import { observationObjectPath, observationPackObjectsRoot } from "../src/observation-pack/runtime-path.js";

const priorXdgDataHome = process.env.XDG_DATA_HOME;
const temporaryRoots: string[] = [];

afterEach(async () => {
  if (priorXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = priorXdgDataHome;
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sol-observation-storage-"));
  temporaryRoots.push(root);
  return root;
}

describe("private Observation Pack storage", () => {
  it("creates the archive under XDG data with a user-private object directory", async () => {
    const dataHome = await tempRoot();
    process.env.XDG_DATA_HOME = dataHome;

    const root = await observationPackObjectsRoot();
    expect(root).toBe(join(dataHome, "sol-opencode", "observation-pack", "objects"));

    const stats = await lstat(root);
    expect(stats.isDirectory()).toBe(true);
    if (process.platform !== "win32") expect(stats.mode & 0o777).toBe(0o700);
  });

  it("tightens an owned archive directory that already has group or world permissions", async () => {
    if (process.platform === "win32") return;

    const dataHome = await tempRoot();
    process.env.XDG_DATA_HOME = dataHome;
    const objectsRoot = join(dataHome, "sol-opencode", "observation-pack", "objects");
    await mkdir(objectsRoot, { recursive: true, mode: 0o700 });
    await chmod(objectsRoot, 0o755);

    const root = await observationPackObjectsRoot();
    const stats = await lstat(root);
    expect(stats.mode & 0o777).toBe(0o700);
  });

  it("rejects a data directory beneath a non-sticky shared parent", async () => {
    if (process.platform === "win32") return;

    const root = await tempRoot();
    const sharedParent = join(root, "shared");
    const dataHome = join(sharedParent, "data");
    await mkdir(dataHome, { recursive: true, mode: 0o700 });
    await chmod(sharedParent, 0o777);
    process.env.XDG_DATA_HOME = dataHome;

    await expect(observationPackObjectsRoot()).rejects.toThrow("unsafe parent directory");
  });

  it("rejects malformed IDs before constructing an object path", () => {
    expect(() => observationObjectPath("/private/objects", "../../etc/passwd")).toThrow(
      "Invalid observation id",
    );
  });

  it("refuses to follow symlinks when reading archived text", async () => {
    if (process.platform === "win32") return;

    const root = await tempRoot();
    const secretPath = join(root, "secret.txt");
    const linkedPath = join(root, "observation.txt");
    await writeFile(secretPath, "not an observation");
    await symlink(secretPath, linkedPath);

    await expect(readStoredObservation(linkedPath)).rejects.toThrow();
  });

  it("publishes an object atomically and leaves no temporary file", async () => {
    const dataHome = await tempRoot();
    process.env.XDG_DATA_HOME = dataHome;
    const root = await observationPackObjectsRoot();
    const text = `${"object-line\n".repeat(2_000)}`;
    const observation = createObservation(text, "bash", "call-atomic", root)!;

    await ensureStored(observation);

    await expect(readFile(observation.filePath, "utf8")).resolves.toBe(text);
    const leftovers = (await readdir(root)).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("removes its temporary file when the object name is already taken by a directory", async () => {
    const dataHome = await tempRoot();
    process.env.XDG_DATA_HOME = dataHome;
    const root = await observationPackObjectsRoot();
    const text = "x".repeat(THRESHOLD_BYTES + 100);
    const observation = createObservation(text, "bash", "call-blocked", root)!;
    await mkdir(observation.filePath);

    await expect(ensureStored(observation)).rejects.toThrow(/not a regular file/);
    const leftovers = (await readdir(root)).filter((name) => name.endsWith(".tmp"));
    expect(leftovers).toEqual([]);
  });

  it("rejects an object whose size no longer matches its index row", async () => {
    const dataHome = await tempRoot();
    process.env.XDG_DATA_HOME = dataHome;
    const root = await observationPackObjectsRoot();
    const filePath = join(root, "obs_0123456789abcdef01234567.txt");
    await writeFile(filePath, "truncated");

    await expect(readStoredObservation(filePath, 9_999)).rejects.toThrow(/size mismatch/);
  });
});
