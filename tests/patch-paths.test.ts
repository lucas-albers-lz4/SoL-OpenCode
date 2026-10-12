/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { enumeratePatchWrittenPaths } from "../src/action-fusion/patch-paths.js";

describe("enumeratePatchWrittenPaths", () => {
  it("returns sorted written paths for add and update hunks", () => {
    const patchText = `*** Begin Patch
*** Add File: b.txt
+two
*** Update File: a.txt
@@
-old
+new
*** End Patch`;

    expect(enumeratePatchWrittenPaths(patchText)).toEqual(["a.txt", "b.txt"]);
  });

  it("returns undefined for unparseable patch text", () => {
    expect(enumeratePatchWrittenPaths("not a patch")).toBeUndefined();
  });
});
