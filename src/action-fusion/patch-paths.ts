/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { Patch } from "@opencode/util/patch";
import { Result } from "effect";

/**
 * Paths that receive content writes from a unified patch (add + update targets).
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
          paths.add(hunk.movePath ?? hunk.path);
        }
      }
      return [...paths].sort();
    },
  });
}
