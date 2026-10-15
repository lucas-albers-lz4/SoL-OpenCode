/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { Schema } from "effect";
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

  it("adds then_run to Effect Schema.Struct host inputs", () => {
    const execute = vi.fn(async () => ({ content: "ok" }));
    const input = Schema.Struct({
      path: Schema.String,
      oldText: Schema.String,
      newText: Schema.String,
    });
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
    expect(Schema.isSchema(stored.input)).toBe(true);
    expect((stored.input as Schema.Struct<Schema.Struct.Fields>).fields).toHaveProperty("then_run");
    expect(input.fields).not.toHaveProperty("then_run");
  });

  it("defers to a host tool that declares its own then_run", async () => {
    // A host tool whose schema declares `then_run` owns that property: its value is
    // advertised to the model, so the executor must receive it unchanged (issue #48).
    const baseExecute = vi.fn(async (input: unknown) => ({
      content: `host executed ${JSON.stringify(input)}`,
    }));
    const shellExecute = vi.fn(async () => ({ content: "shell", metadata: { exit: 0 } }));
    let stored = {
      ...baseEditTool(baseExecute),
      input: {
        type: "object" as const,
        properties: {
          path: { type: "string" as const },
          then_run: { type: "string" as const },
        },
        required: ["path"],
      },
    };

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

    // The schema keeps the host's own property instead of the fusion one.
    expect(stored.input).toHaveProperty("properties.then_run.type", "string");

    const declared = await stored.execute({ path: "src/a.ts", then_run: "host words" }, mockContext);
    expect(baseExecute).toHaveBeenCalledWith({ path: "src/a.ts", then_run: "host words" }, mockContext);
    expect(shellExecute).not.toHaveBeenCalled();
    // No fabricated skip notice on the host tool's own success result.
    expect(JSON.stringify(declared)).not.toContain("then_run:skipped");

    // A value shaped like fusion input is still the host's value, not a command to run.
    await stored.execute({ path: "src/a.ts", then_run: { command: "echo host-shaped" } }, mockContext);
    expect(shellExecute).not.toHaveBeenCalled();
    expect(baseExecute).toHaveBeenCalledTimes(2);
  });
});
