/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
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
  sessionIndexLockCountForTests,
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

describe("session-index lock lifecycle", () => {
  afterEach(() => {
    resetSessionIndexLocksForTests();
  });

  it("releases the entry once the work settles", async () => {
    resetSessionIndexLocksForTests();
    await withSessionIndexLock("sess-release", async () => 1);
    await vi.waitFor(() => expect(sessionIndexLockCountForTests()).toBe(0));
  });

  it("releases the entry when the work rejects", async () => {
    resetSessionIndexLocksForTests();
    await expect(
      withSessionIndexLock("sess-reject", async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    await vi.waitFor(() => expect(sessionIndexLockCountForTests()).toBe(0));
  });

  it("keeps a queued successor's entry while that successor still runs", async () => {
    resetSessionIndexLocksForTests();
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let releaseSecond!: () => void;
    const secondGate = new Promise<void>((resolve) => {
      releaseSecond = resolve;
    });
    let secondStarted = false;

    const first = withSessionIndexLock("sess-owner", async () => {
      await firstGate;
    });
    const second = withSessionIndexLock("sess-owner", async () => {
      secondStarted = true;
      await secondGate;
    });

    releaseFirst();
    await first;
    await vi.waitFor(() => expect(secondStarted).toBe(true));
    // The predecessor's cleanup must not remove the successor's entry: only the current
    // owner may delete, so this reads 1, not 0.
    expect(sessionIndexLockCountForTests()).toBe(1);

    releaseSecond();
    await second;
    await vi.waitFor(() => expect(sessionIndexLockCountForTests()).toBe(0));
  });

  it("runs a third call only after the second settles", async () => {
    resetSessionIndexLocksForTests();
    const order: string[] = [];

    const first = withSessionIndexLock("sess-order", async () => {
      order.push("first");
    });
    const second = withSessionIndexLock("sess-order", async () => {
      // A real hold, so an unqueued third call would run and finish first.
      await new Promise((resolve) => setTimeout(resolve, 20));
      order.push("second");
    });
    await first;
    // Let the predecessor's cleanup callback run before the third call reads the map.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const third = withSessionIndexLock("sess-order", async () => {
      order.push("third");
    });

    await Promise.all([second, third]);
    expect(order).toEqual(["first", "second", "third"]);
  });
});

let dataHomePromise: Promise<string> | undefined;

/**
 * One archive root for the whole file: the pack resolves its objects root once and keeps it,
 * so a second `XDG_DATA_HOME` would make the tool read from the first one.
 */
async function recallDataHome(): Promise<string> {
  dataHomePromise ??= (async () => {
    const dataHome = await mkdtemp(join(tmpdir(), "sol-op-recall-"));
    process.env.XDG_DATA_HOME = dataHome;
    return dataHome;
  })();
  return dataHomePromise;
}

async function withObservation(
  text: string,
  sessionID: string,
  run: (execute: Info["execute"], observationId: string) => Promise<void>,
): Promise<void> {
  await recallDataHome();

  const storage = memoryStorage();
  const objectsRoot = await observationPackObjectsRoot();
  const observation = createObservation(text, "bash", "call-a", objectsRoot)!;
  await ensureStored(observation);
  await saveSessionIndex(storage, sessionID, [packedEntry("call-a", observation.id)]);

  await run(await captureObsRecallExecute(storage), observation.id);
}

describe("obs_recall header", () => {
  afterEach(() => {
    resetSessionIndexLocksForTests();
  });

  it("reports the effective start and a cursor that pages forward", async () => {
    // "é" is two bytes, so offset 1 lands inside the first character.
    await withObservation(`${"é".repeat(6000)}\n`, "session-a", async (execute, id) => {
      const snapped = await execute({ id, offset: 1 }, fakeToolContext("session-a"));

      expect(snapped.content).toContain("offset=2 (requested 1, snapped to a character boundary)");

      const cursor = /next_offset=(\d+)/u.exec(snapped.content)?.[1];
      expect(cursor).toBeDefined();
      // The cursor must move past the character that was snapped. Reporting the requested
      // offset instead would make a paging model re-read the same bytes.
      expect(Number(cursor)).toBeGreaterThan(2);

      // Paging from the header's own cursor must continue instead of re-serving the same chunk.
      const continued = await execute({ id, offset: Number(cursor) }, fakeToolContext("session-a"));
      expect(continued.content).toContain(`offset=${String(cursor)} `);
      expect(continued.content).not.toContain("snapped");
      expect(continued.content).not.toBe(snapped.content);
    });
  });

  it("rejects a non-numeric offset instead of answering from the start", async () => {
    await withObservation("C".repeat(10_241), "session-a", async (execute, id) => {
      for (const offset of ["100", true, null, {}]) {
        await expect(execute({ id, offset }, fakeToolContext("session-a"))).rejects.toThrow(
          /must be an integer >= 0/u,
        );
      }

      // An absent offset still means "from the start".
      const result = await execute({ id }, fakeToolContext("session-a"));
      expect(result.content).toContain("offset=0 ");
    });
  });
});

describe("obs_recall session isolation", () => {
  afterEach(() => {
    resetSessionIndexLocksForTests();
  });

  it("rejects observation ids that belong to another session", async () => {
    await withObservation("C".repeat(10_241), "session-a", async (execute, id) => {
      await expect(execute({ id }, fakeToolContext("session-b"))).rejects.toThrow(
        `Unknown observation id: ${id}`,
      );

      const result = await execute({ id }, fakeToolContext("session-a"));
      expect(result.content).toContain(id);
    });
  });
});
