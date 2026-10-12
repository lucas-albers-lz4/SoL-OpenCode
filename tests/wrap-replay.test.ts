/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it, vi } from "vitest";
import type { Info as ToolInfo, ToolContext } from "../src/deps/opencode-plugin-types.js";
import { applyActionFusionToEditor } from "../src/action-fusion/wrap-tools.js";

const mockContext = {
  sessionID: "ses_test",
  agent: "agent_test",
  messageID: "msg_test",
  id: "call_test",
  signal: new AbortController().signal,
  progress: async () => {},
} satisfies ToolContext;

function baseEditTool(execute: ToolInfo["execute"]): ToolInfo & { id: string } {
  return {
    id: "edit",
    name: "edit",
    description: "edit file",
    input: {
      type: "object",
      properties: {
        path: { type: "string" },
        oldText: { type: "string" },
        newText: { type: "string" },
      },
      required: ["path"],
    },
    execute,
  };
}

describe("applyActionFusionToEditor transform replay", () => {
  it("wraps execute from the current definition without double-wrap on replay", async () => {
    const baseExecute = vi.fn(async () => ({ content: "mutated" }));
    let stored = baseEditTool(baseExecute);

    const shellExecute = vi.fn(async () => ({ content: "shell", metadata: { exit: 0 } }));
    const editor = {
      get: (id: string) => {
        if (id === "shell") return { id: "shell", name: "shell", execute: shellExecute };
        if (id === "edit") return { ...stored, execute: stored.execute };
        return undefined;
      },
      update: (id: string, update: (tool: ToolInfo) => void) => {
        if (id !== "edit") return;
        const draft: ToolInfo = { ...stored, execute: stored.execute };
        update(draft);
        stored = { ...stored, ...draft, execute: draft.execute };
      },
      list: () => [stored],
      add: () => {},
      remove: () => {},
      namespace: () => {},
    };

    applyActionFusionToEditor(editor, { cwd: "/tmp/project", patchThenRunInSchema: true });
    await stored.execute({ path: "src/a.ts" }, mockContext);
    expect(baseExecute).toHaveBeenCalledTimes(1);

    stored = baseEditTool(baseExecute);
    applyActionFusionToEditor(editor, { cwd: "/tmp/project", patchThenRunInSchema: true });
    await stored.execute({ path: "src/a.ts" }, mockContext);
    expect(baseExecute).toHaveBeenCalledTimes(2);
  });

  it("replaces input schema without mutating the original nested object", () => {
    const nested = {
      path: { type: "string" as const },
    };
    const input = {
      type: "object" as const,
      properties: nested,
    };
    const execute = vi.fn(async () => ({ content: "ok" }));
    let stored = { ...baseEditTool(execute), input };

    const editor = {
      get: (id: string) => {
        if (id === "shell") {
          return { id: "shell", name: "shell", execute: vi.fn(async () => ({ content: "ok" })) };
        }
        if (id === "edit") return { ...stored };
        return undefined;
      },
      update: (id: string, update: (tool: ToolInfo) => void) => {
        const draft: ToolInfo = { ...stored };
        update(draft);
        stored = { ...stored, ...draft };
      },
      list: () => [stored],
      add: () => {},
      remove: () => {},
      namespace: () => {},
    };

    applyActionFusionToEditor(editor, { cwd: "/tmp/project", patchThenRunInSchema: true });
    expect(stored.input).toHaveProperty("properties.then_run");
    expect(nested).not.toHaveProperty("then_run");
  });
});
