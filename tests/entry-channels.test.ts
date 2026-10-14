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
    registerActionFusion.mockReset();
    registerObservationPack.mockReset();
    registerActionFusion.mockResolvedValue({ dispose: async () => undefined });
    registerObservationPack.mockResolvedValue({ dispose: async () => undefined });
  });

  it("exposes one plugin: the root entrypoint re-exports the source entrypoint", () => {
    expect(rootPlugin).toBe(sourcePlugin);
    expect(rootPlugin.id).toBe("sol.opencode");
  });

  it("registers the same mechanisms through both channels against a stub ctx", async () => {
    const rootDispose = await rootPlugin.setup(stubContext());
    const sourceDispose = await sourcePlugin.setup(stubContext());

    expect(registerActionFusion).toHaveBeenCalledTimes(2);
    expect(registerObservationPack).toHaveBeenCalledTimes(2);
    expect(typeof rootDispose).toBe("function");
    expect(typeof sourceDispose).toBe("function");
  });
});
