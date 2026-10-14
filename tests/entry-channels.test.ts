/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import rootPlugin from "../index.js";
import sourcePlugin from "../src/index.js";

const { registerActionFusion, registerObservationPack } = vi.hoisted(() => ({
  registerActionFusion: vi.fn(),
  registerObservationPack: vi.fn(),
}));

const disposers: Array<ReturnType<typeof vi.fn<() => Promise<void>>>> = [];

vi.mock("../src/action-fusion/index.js", () => ({ registerActionFusion }));
vi.mock("../src/observation-pack/index.js", () => ({ registerObservationPack }));

const stubContext = () =>
  ({
    options: {},
    tool: {},
    session: {},
    storage: {},
    location: { directory: "/tmp/project" },
  }) as unknown as Parameters<typeof sourcePlugin.setup>[0];

describe("entry channels", () => {
  beforeEach(() => {
    disposers.length = 0;
    registerActionFusion.mockReset();
    registerObservationPack.mockReset();

    // Each registration hands back its own disposer, so the entry point's cleanup is observable.
    for (const register of [registerActionFusion, registerObservationPack]) {
      register.mockImplementation(async () => {
        const dispose = vi.fn(async () => undefined);
        disposers.push(dispose);
        return { dispose };
      });
    }
  });

  it("exposes one plugin: the root entrypoint re-exports the source entrypoint", () => {
    expect(rootPlugin).toBe(sourcePlugin);
    expect(rootPlugin.id).toBe("sol.opencode");
  });

  it("registers the same mechanisms through both channels and disposes them", async () => {
    const rootCtx = stubContext();
    const sourceCtx = stubContext();

    const rootDispose = await rootPlugin.setup(rootCtx);
    const sourceDispose = await sourcePlugin.setup(sourceCtx);

    expect(registerActionFusion).toHaveBeenCalledTimes(2);
    expect(registerObservationPack).toHaveBeenCalledTimes(2);
    // Identity, not deep equality: a copy the entry point invented must not pass for the
    // caller's ctx even when it looks the same.
    expect(registerActionFusion.mock.calls[0]?.[0]).toBe(rootCtx);
    expect(registerActionFusion.mock.calls[1]?.[0]).toBe(sourceCtx);
    expect(registerObservationPack.mock.calls[0]?.[0]).toBe(rootCtx);
    expect(registerObservationPack.mock.calls[1]?.[0]).toBe(sourceCtx);

    await rootDispose();
    await sourceDispose();
    expect(disposers).toHaveLength(4);
    for (const dispose of disposers) {
      // `register...` returning a disposer is not cleanup; calling it is.
      expect(dispose).toHaveBeenCalledTimes(1);
    }
  });
});
