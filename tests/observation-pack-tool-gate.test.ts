/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import type { StorageDomain, ToolEditor } from "../src/deps/opencode-plugin-types.js";
import { registerObservationPack } from "../src/observation-pack/index.js";
import { createObservation, ensureStored, FULL_SENDS } from "../src/observation-pack/observation.js";
import { observationPackObjectsRoot } from "../src/observation-pack/runtime-path.js";
import { saveSessionIndex } from "../src/observation-pack/session-index.js";

type Hook = (event: Record<string, unknown>) => Promise<void> | void;

function memoryStorage(): StorageDomain {
  const map = new Map<string, unknown>();
  return {
    async get(key) {
      return map.get(key) as Awaited<ReturnType<StorageDomain["get"]>>;
    },
    async set(key, value) {
      map.set(key, value);
    },
    async remove(key) {
      map.delete(key);
    },
    async scan() {
      return { entries: [] };
    },
  };
}

async function setupPack(): Promise<{
  readonly storage: StorageDomain;
  readonly hooks: Map<string, Hook>;
}> {
  const storage = memoryStorage();
  const hooks = new Map<string, Hook>();
  const registration = { dispose: async () => {} };
  const tool = {
    hook: async (name: string, callback: Hook) => {
      hooks.set(name, callback);
      return registration;
    },
    transform: async (fn: (editor: ToolEditor) => void) => {
      fn({
        add: () => {},
        list: () => [],
        get: () => undefined,
        namespace: () => {},
        update: () => {},
        remove: () => {},
      } as unknown as ToolEditor);
      return registration;
    },
  };
  const session = {
    hook: async (name: string, callback: Hook) => {
      hooks.set(`session:${name}`, callback);
      return registration;
    },
  };
  await registerObservationPack({
    tool,
    session,
    storage,
  } as Parameters<typeof registerObservationPack>[0]);
  return { storage, hooks };
}

function requestWith(blob: string): Request {
  return new Request("http://localhost/v1/messages", {
    method: "POST",
    body: JSON.stringify({
      messages: [{ role: "tool", tool_call_id: "call-gate", content: blob }],
    }),
  });
}

describe("observation pack tool availability gate", () => {
  beforeAll(async () => {
    process.env.XDG_DATA_HOME = await mkdtemp(join(tmpdir(), "sol-op-gate-"));
  });

  it("leaves the payload packed out when obs_recall is not offered", async () => {
    const { storage, hooks } = await setupPack();
    const blob = "G".repeat(10_241);
    const root = await observationPackObjectsRoot();
    const observation = createObservation(blob, "bash", "call-gate", root)!;
    await ensureStored(observation);
    await saveSessionIndex(storage, "session-gate-off", [
      {
        toolCallId: "call-gate",
        obsId: observation.id,
        toolName: "bash",
        contentHash: observation.contentHash,
        bytes: observation.bytes,
        httpSendCount: FULL_SENDS,
      },
    ]);

    const context = hooks.get("session:context");
    const httpRequest = hooks.get("session:http.request");
    if (context === undefined || httpRequest === undefined) throw new Error("hooks were not registered");

    await context({
      sessionID: "session-gate-off",
      tools: { bash: { description: "bash", input: { type: "object" } } },
    });

    const event = { sessionID: "session-gate-off", request: requestWith(blob) };
    await httpRequest(event);

    // No placeholder may point at a tool the request does not offer; the full
    // result staying in the body is the fail-open shape.
    expect(await event.request.text()).toContain(blob);
  });

  it("resumes packing when obs_recall is offered again", async () => {
    const { storage, hooks } = await setupPack();
    const blob = "H".repeat(10_241);
    const root = await observationPackObjectsRoot();
    const observation = createObservation(blob, "bash", "call-gate", root)!;
    await ensureStored(observation);
    await saveSessionIndex(storage, "session-gate-on", [
      {
        toolCallId: "call-gate",
        obsId: observation.id,
        toolName: "bash",
        contentHash: observation.contentHash,
        bytes: observation.bytes,
        httpSendCount: FULL_SENDS,
      },
    ]);

    const context = hooks.get("session:context");
    const httpRequest = hooks.get("session:http.request");
    if (context === undefined || httpRequest === undefined) throw new Error("hooks were not registered");

    await context({
      sessionID: "session-gate-on",
      tools: {
        bash: { description: "bash", input: { type: "object" } },
        obs_recall: { description: "recall", input: { type: "object" } },
      },
    });

    const event = { sessionID: "session-gate-on", request: requestWith(blob) };
    await httpRequest(event);

    const body = await event.request.text();
    expect(body).not.toContain(blob);
    expect(body).toContain("archived: full text is retrievable from the local observation store");
  });
});
