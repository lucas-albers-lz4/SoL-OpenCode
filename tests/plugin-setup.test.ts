/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const registerActionFusion = vi.fn();
const registerObservationPack = vi.fn();

vi.mock("../src/action-fusion/index.js", () => ({ registerActionFusion }));
vi.mock("../src/observation-pack/index.js", () => ({ registerObservationPack }));

const { default: plugin } = await import("../src/index.js");

type PluginContext = Parameters<typeof plugin.setup>[0];

function stubContext(options: unknown = {}): PluginContext {
  return {
    options,
    tool: { hook: vi.fn(), transform: vi.fn() },
    session: { hook: vi.fn() },
    storage: { get: vi.fn(), set: vi.fn() },
    location: { directory: "/tmp/project" },
  } as unknown as PluginContext;
}

describe("plugin setup resilience", () => {
  beforeEach(() => {
    registerActionFusion.mockReset();
    registerObservationPack.mockReset();
  });

  it("keeps the surviving mechanism when a later registration fails", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const actionFusionDispose = vi.fn(async () => undefined);
    registerActionFusion.mockResolvedValue({ dispose: actionFusionDispose });
    registerObservationPack.mockRejectedValue(new Error("storage boom"));

    const dispose = await plugin.setup(stubContext());

    // Setup must resolve: the host needs a disposer for the mechanism that did register.
    expect(registerActionFusion).toHaveBeenCalledTimes(1);
    expect(registerObservationPack).toHaveBeenCalledTimes(1);
    expect(warnings.mock.calls.flat().join(" ")).toContain("Observation Pack");
    expect(warnings.mock.calls.flat().join(" ")).toContain("storage boom");

    await dispose();
    expect(actionFusionDispose).toHaveBeenCalledTimes(1);
    warnings.mockRestore();
  });

  it("fails setup only when nothing registered but a mechanism was enabled", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registerActionFusion.mockRejectedValue(new Error("tool domain missing"));
    registerObservationPack.mockRejectedValue(new Error("session domain missing"));

    await expect(plugin.setup(stubContext())).rejects.toThrow(/no mechanism could register/u);
    warnings.mockRestore();
  });

  it("returns a no-op disposer when both mechanisms are disabled", async () => {
    const dispose = await plugin.setup(
      stubContext({ actionFusion: false, observationPack: false }),
    );

    expect(registerActionFusion).not.toHaveBeenCalled();
    expect(registerObservationPack).not.toHaveBeenCalled();
    await expect(dispose()).resolves.toBeUndefined();
  });

  it("throws when the only enabled mechanism fails, without touching the disabled one", async () => {
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    registerActionFusion.mockRejectedValue(new Error("tool domain missing"));

    await expect(plugin.setup(stubContext({ observationPack: false }))).rejects.toThrow(
      /no mechanism could register/u,
    );
    expect(registerObservationPack).not.toHaveBeenCalled();
    warnings.mockRestore();
  });
});
