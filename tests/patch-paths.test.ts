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

  it("includes delete targets", () => {
    const patchText = `*** Begin Patch
*** Delete File: gone.txt
*** End Patch`;

    expect(enumeratePatchWrittenPaths(patchText)).toEqual(["gone.txt"]);
  });

  it("includes both sides of a move", () => {
    const patchText = `*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
@@
-old
+new
*** End Patch`;

    expect(enumeratePatchWrittenPaths(patchText)).toEqual(["new.txt", "old.txt"]);
  });

  it("keeps delete and update targets alongside each other", () => {
    const patchText = `*** Begin Patch
*** Delete File: a.txt
*** Update File: b.txt
@@
-old
+new
*** End Patch`;

    expect(enumeratePatchWrittenPaths(patchText)).toEqual(["a.txt", "b.txt"]);
  });

  it("returns an empty list for a parsed patch with no hunks", () => {
    expect(enumeratePatchWrittenPaths("*** Begin Patch\n*** End Patch")).toEqual([]);
  });
});
