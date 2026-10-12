/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Plugin-owned archive root under XDG data or the system temp directory. */
export async function observationPackObjectsRoot(): Promise<string> {
  const base =
    process.env.XDG_DATA_HOME !== undefined && process.env.XDG_DATA_HOME.length > 0
      ? join(process.env.XDG_DATA_HOME, "sol-opencode", "observation-pack", "objects")
      : join(tmpdir(), "sol-opencode", "observation-pack", "objects");

  await mkdir(base, { recursive: true, mode: 0o700 });
  return base;
}

export function observationObjectPath(objectsRoot: string, id: string): string {
  return join(objectsRoot, `${id}.txt`);
}
