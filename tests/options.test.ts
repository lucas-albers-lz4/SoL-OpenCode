/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from "vitest";
import { resolveMechanismOptions } from "../src/options.js";

describe("resolveMechanismOptions", () => {
  it("defaults both mechanisms to enabled", () => {
    expect(resolveMechanismOptions(undefined, vi.fn())).toEqual({
      actionFusion: true,
      observationPack: true,
    });
  });

  it("disables invalid mechanism flags without throwing", () => {
    const log = vi.fn();
    expect(
      resolveMechanismOptions({ actionFusion: "yes", observationPack: false }, log),
    ).toEqual({
      actionFusion: false,
      observationPack: false,
    });
    expect(log).toHaveBeenCalled();
  });
});
