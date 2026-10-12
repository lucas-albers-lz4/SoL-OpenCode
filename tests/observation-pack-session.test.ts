/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { StorageDomain, ToolContext, ToolEditor } from "../src/deps/opencode-plugin-types.js";
import type { Info } from "../src/deps/opencode-plugin-types.js";
import { registerObservationPack } from "../src/observation-pack/index.js";
import { createObservation, ensureStored } from "../src/observation-pack/observation.js";
import { observationPackObjectsRoot } from "../src/observation-pack/runtime-path.js";
import {
  loadSessionIndex,
  saveSessionIndex,
  type PackedToolResult,
} from "../src/observation-pack/session-index.js";
import {
  resetSessionIndexLocksForTests,
  withSessionIndexLock,
} from "../src/observation-pack/session-index-mutex.js";

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

function packedEntry(toolCallId: string, obsId: string): PackedToolResult {
  return {
    toolCallId,
    obsId,
    toolName: "bash",
    contentHash: "abc",
    bytes: 1025,
    httpSendCount: 0,
  };
}

function fakeToolContext(sessionID: string): ToolContext {
  return {
    sessionID,
    agent: "agent-1",
    messageID: "msg-1",
    id: "call-recall",
    signal: new AbortController().signal,
    progress: async () => {},
  };
}

async function captureObsRecallExecute(
  storage: StorageDomain,
): Promise<Info["execute"]> {
  let execute: Info["execute"] | undefined;
  const tool = {
    hook: async () => ({ dispose: async () => {} }),
    transform: async (fn: (editor: ToolEditor) => void) => {
      const editor = {
        add(toolInfo: Info) {
          execute = toolInfo.execute;
        },
        list: () => [],
        get: () => undefined,
        namespace: () => {},
        update: () => {},
        remove: () => {},
      };
      fn(editor as ToolEditor);
      return { dispose: async () => {} };
    },
  };
  const session = {
    hook: async () => ({ dispose: async () => {} }),
  };
  await registerObservationPack({ tool, session, storage } as Parameters<typeof registerObservationPack>[0]);
  if (execute === undefined) {
    throw new Error("obs_recall execute was not registered");
  }
  return execute;
}

describe("observation pack session index", () => {
  afterEach(() => {
    resetSessionIndexLocksForTests();
  });

  it("persists concurrent archive appends for different toolCallIds", async () => {
    const storage = memoryStorage();
    const sessionID = "sess-concurrent";

    await Promise.all([
      withSessionIndexLock(sessionID, async () => {
        const entries = await loadSessionIndex(storage, sessionID);
        await saveSessionIndex(storage, sessionID, [
          ...entries,
          packedEntry("tool-a", "obs_aaaaaaaaaaaaaaaaaaaaaaaa"),
        ]);
      }),
      withSessionIndexLock(sessionID, async () => {
        const entries = await loadSessionIndex(storage, sessionID);
        await saveSessionIndex(storage, sessionID, [
          ...entries,
          packedEntry("tool-b", "obs_bbbbbbbbbbbbbbbbbbbbbbbb"),
        ]);
      }),
    ]);

    const final = await loadSessionIndex(storage, sessionID);
    expect(final).toHaveLength(2);
    expect(final.map((entry) => entry.toolCallId).sort()).toEqual(["tool-a", "tool-b"]);
  });
});

describe("obs_recall session isolation", () => {
  afterEach(() => {
    resetSessionIndexLocksForTests();
  });

  it("rejects observation ids that belong to another session", async () => {
    const dataHome = await mkdtemp(join(tmpdir(), "sol-op-session-"));
    const prior = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = dataHome;

    try {
      const storage = memoryStorage();
      const text = "C".repeat(10_241);
      const objectsRoot = await observationPackObjectsRoot();
      const observation = createObservation(text, "bash", "call-a", objectsRoot)!;
      await ensureStored(observation);

      await saveSessionIndex(storage, "session-a", [packedEntry("call-a", observation.id)]);

      const execute = await captureObsRecallExecute(storage);

      await expect(
        execute({ id: observation.id }, fakeToolContext("session-b")),
      ).rejects.toThrow(`Unknown observation id: ${observation.id}`);

      const result = await execute({ id: observation.id }, fakeToolContext("session-a"));
      expect(result.content).toContain(observation.id);
    } finally {
      if (prior === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = prior;
    }
  });
});
