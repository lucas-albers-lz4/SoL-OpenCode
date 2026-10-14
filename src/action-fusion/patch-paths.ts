/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { Patch } from "@opencode/util/patch";
import { Result } from "effect";

/**
 * Paths a unified patch touches: add targets, both sides of an update (a moving
 * update names a source and a destination), and delete targets. Callers use this
 * for both the fused file queue and the interference guard, so a delete or a
 * rename source must appear here — otherwise it is neither locked nor checked.
 *
 * Returns undefined when patchText cannot be parsed (caller must omit or skip fused follow-up).
 */
export function enumeratePatchWrittenPaths(patchText: string): string[] | undefined {
  const parsed = Patch.parse(patchText);
  return Result.match(parsed, {
    onFailure: () => undefined,
    onSuccess: (hunks) => {
      const paths = new Set<string>();
      for (const hunk of hunks) {
        if (hunk.type === "add") {
          paths.add(hunk.path);
        } else if (hunk.type === "update") {
          paths.add(hunk.path);
          if (hunk.movePath !== undefined) {
            paths.add(hunk.movePath);
          }
        } else if (hunk.type === "delete") {
          paths.add(hunk.path);
        }
      }
      return [...paths].sort();
    },
  });
}
