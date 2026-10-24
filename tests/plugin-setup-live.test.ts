/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import plugin from "../src/index.js";

type SetupContext = Parameters<typeof plugin.setup>[0];
type Domain = "tool" | "session" | "storage" | "location";

interface HostOptions {
  /** Host domains the stub provides; anything omitted is missing, as on a host that lacks it. */
  readonly domains?: readonly Domain[];
  /** 1-based index of the `tool.transform` registration that rejects. */
  readonly failTransformAt?: number;
  /** 1-based index of the registration whose disposer rejects. */
  readonly failDisposeAt?: number;
}

/**
 * A stub host with real mechanism modules behind it: the mocked-out setup test cannot see any
 * of this, which is why one throwing hook or a missing domain used to leave no trace in CI.
 */
function createHost(options: HostOptions = {}) {
  const domains = new Set<Domain>(options.domains ?? ["tool", "session", "storage", "location"]);
  const events: string[] = [];
  let registrations = 0;
  let transforms = 0;

  const registration = (label: string) => {
    registrations += 1;
    const index = registrations;
    events.push(`register:${label}`);
    return {
      async dispose() {
        events.push(`dispose:${label}`);
        if (options.failDisposeAt === index) throw new Error(`dispose boom in ${label}`);
      },
    };
  };

  const transform = async (fn: (editor: unknown) => void) => {
    transforms += 1;
    if (options.failTransformAt === transforms) {
      events.push(`fail:tool.transform#${transforms}`);
      throw new Error(`REAL ROOT CAUSE: transform #${transforms} rejected`);
    }

    fn({
      add: (info: { id?: unknown }) => events.push(`add:${String(info?.id)}`),
      update: () => {},
      get: () => undefined,
      list: () => [],
      remove: () => {},
      namespace: () => {},
    });
    return registration(`tool.transform#${transforms}`);
  };

  const ctx = {
    options: {},
    tool: domains.has("tool")
      ? { hook: async (name: string) => registration(`tool.hook:${name}`), transform }
      : undefined,
    session: domains.has("session")
      ? { hook: async (name: string) => registration(`session.hook:${name}`) }
      : undefined,
    storage: domains.has("storage")
      ? {
          get: async () => undefined,
          set: async () => {},
          remove: async () => {},
          scan: async () => ({ entries: [] }),
        }
      : undefined,
    location: domains.has("location") ? { directory: "/tmp/project" } : undefined,
  } as unknown as SetupContext;

  return { ctx, events };
}

async function captureWarnings<T>(
  run: () => Promise<T>,
): Promise<{ readonly value: T; readonly warnings: string }> {
  const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  try {
    const value = await run();
    return { value, warnings: warn.mock.calls.flat().join(" ") };
  } finally {
    warn.mockRestore();
  }
}

/** `setup` may legitimately return no disposer; every test here expects one. */
async function setup(ctx: SetupContext): Promise<() => Promise<void>> {
  const cleanup = await plugin.setup(ctx);
  if (typeof cleanup !== "function") throw new Error("setup returned no disposer");
  return cleanup as () => Promise<void>;
}

function disposalsOf(events: readonly string[]): string[] {
  return events.filter((event) => event.startsWith("dispose:"));
}

beforeAll(async () => {
  process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "sol-op-setup-live-"));
});

describe("plugin setup with the real mechanisms", () => {
  it("keeps the mechanism whose host domains are present", async () => {
    const host = createHost({ domains: ["tool", "session", "location"] });

    const { value: dispose, warnings } = await captureWarnings(() => setup(host.ctx));

    expect(typeof dispose).toBe("function");
    expect(host.events.some((event) => event.includes("tool.transform#1"))).toBe(true);
    expect(warnings).toContain("Observation Pack could not register");
    expect(warnings).toContain("storage host domain");
    expect(warnings).not.toContain("Cannot read properties");
  });

  it("names the workspace directory requirement instead of failing later", async () => {
    const host = createHost({ domains: ["tool", "session", "storage"] });

    const { value: dispose, warnings } = await captureWarnings(() => setup(host.ctx));

    expect(typeof dispose).toBe("function");
    expect(warnings).toContain("ctx.location.directory");
    expect(warnings).not.toContain("Cannot read properties");
  });

  it("refuses to load when no mechanism could register", async () => {
    const host = createHost({ domains: ["location"] });

    await expect(plugin.setup(host.ctx)).rejects.toThrow(/no mechanism could register/u);
  });

  it("disposes in reverse registration order", async () => {
    const host = createHost();
    const dispose = await setup(host.ctx);

    host.events.length = 0;
    await dispose();

    const disposals = disposalsOf(host.events);
    expect(disposals).toHaveLength(5);
    expect(disposals[0]).toContain("tool.transform#2");
    expect(disposals[1]).toContain("session.hook");
    expect(disposals[2]).toContain("session.hook");
    expect(disposals[3]).toContain("tool.hook");
    expect(disposals[4]).toContain("tool.transform#1");
  });

  it("unwinds a mechanism's partial work and still reports the real cause", async () => {
    // The second transform registration belongs to Observation Pack, which has already taken
    // effect through two hooks when it fails; its cleanup throws as well.
    const host = createHost({ failTransformAt: 2, failDisposeAt: 3 });

    const { warnings } = await captureWarnings(() => setup(host.ctx));

    expect(warnings).toContain("REAL ROOT CAUSE");
    expect(warnings).toContain("cleanup also failed");

    const disposals = disposalsOf(host.events);
    expect(disposals.some((event) => event.includes("session.hook"))).toBe(true);
    expect(disposals.some((event) => event.includes("tool.hook"))).toBe(true);
    // Action Fusion's transform stays registered with the host: it is not this failure's cost.
    expect(disposals.some((event) => event.includes("tool.transform#1"))).toBe(false);
  });

  it("attempts every disposer even when one throws", async () => {
    const host = createHost({ failDisposeAt: 3 });
    const dispose = await setup(host.ctx);

    host.events.length = 0;
    await expect(dispose()).rejects.toThrow(/disposal failed/u);

    const disposals = disposalsOf(host.events);
    expect(disposals).toHaveLength(5);
    expect(disposals.some((event) => event.includes("tool.transform#1"))).toBe(true);
  });
});
