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

  it("warns about unrecognized keys instead of failing open", () => {
    const log = vi.fn();
    expect(resolveMechanismOptions({ actionfusion: false, observation_pack: false }, log)).toEqual({
      actionFusion: true,
      observationPack: true,
    });

    const messages = log.mock.calls.map((call) => String(call[0])).join(" | ");
    expect(messages).toContain("actionfusion");
    expect(messages).toContain("observation_pack");
  });

  it("treats a non-plain object as invalid options rather than both-enabled", () => {
    const log = vi.fn();
    expect(resolveMechanismOptions([], log)).toEqual({ actionFusion: false, observationPack: false });
    expect(log).toHaveBeenCalledTimes(1);
  });

  it("leaves a genuine boolean opt-out silent", () => {
    const log = vi.fn();
    expect(resolveMechanismOptions({ actionFusion: false }, log)).toEqual({
      actionFusion: false,
      observationPack: true,
    });
    expect(log).not.toHaveBeenCalled();
  });
});
