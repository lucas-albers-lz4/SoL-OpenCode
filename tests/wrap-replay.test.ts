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

    applyActionFusionToEditor(editor, { cwd: "/tmp/project-replay-wrap", patchThenRunInSchema: true });
    await stored.execute({ path: "src/a.ts" }, mockContext);
    expect(baseExecute).toHaveBeenCalledTimes(1);

    stored = baseEditTool(baseExecute);
    applyActionFusionToEditor(editor, { cwd: "/tmp/project-replay-wrap", patchThenRunInSchema: true });
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

    applyActionFusionToEditor(editor, { cwd: "/tmp/project-schema-copy", patchThenRunInSchema: true });
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

    applyActionFusionToEditor(editor, { cwd: "/tmp/project-struct-extend", patchThenRunInSchema: true });
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

    applyActionFusionToEditor(editor, { cwd: "/tmp/project-declared-json", patchThenRunInSchema: true });

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

  it("defers for the Effect-struct family, where the shipped mutation tools live", async () => {
    // Issue #48 says the bug is shared with the Effect-struct branch, and OpenCode's own
    // edit/write/patch are Effect structs: a deferral that only covered the JSON family
    // would leave the one family the fix protects in practice untested.
    const baseExecute = vi.fn(async (input: unknown) => ({
      content: `host executed ${JSON.stringify(input)}`,
    }));
    const shellExecute = vi.fn(async () => ({ content: "shell", metadata: { exit: 0 } }));
    const declaredInput = Schema.Struct({ path: Schema.String, then_run: Schema.String });
    let stored = { ...baseEditTool(baseExecute), input: declaredInput as unknown as ToolInfo["input"] };

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

    applyActionFusionToEditor(editor, { cwd: "/tmp/project-declared-struct", patchThenRunInSchema: true });

    // The struct's own declaration stands, and its value reaches the executor.
    expect(stored.input).toBe(declaredInput);
    const result = await stored.execute({ path: "src/a.ts", then_run: "host words" }, mockContext);
    expect(baseExecute).toHaveBeenCalledWith({ path: "src/a.ts", then_run: "host words" }, mockContext);
    expect(shellExecute).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("then_run:skipped");

    await stored.execute({ path: "src/a.ts", then_run: { command: "echo host-shaped" } }, mockContext);
    expect(shellExecute).not.toHaveBeenCalled();
  });

  it("keeps fusion working when a replay pass meets the property this plugin added", async () => {
    // A host may replay the transform onto definitions it already wrapped. The second pass
    // then sees the `then_run` property this plugin added, so the wrapper defers and calls
    // the first pass's wrapper: fusion must still run once, and must not re-enter the
    // per-file queue (a second fusion wrapper deadlocks here from the second pass on).
    const baseExecute = vi.fn(async () => ({ content: "mutated" }));
    const shellExecute = vi.fn(async () => ({ content: "shell", metadata: { exit: 0 } }));
    let stored = baseEditTool(baseExecute);

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

    const config = { cwd: "/tmp/project-replay-accumulating", patchThenRunInSchema: true };
    applyActionFusionToEditor(editor, config);
    applyActionFusionToEditor(editor, config);

    const result = await stored.execute(
      { path: "src/a.ts", then_run: { command: "echo replay" } },
      mockContext,
    );

    expect(baseExecute).toHaveBeenCalledTimes(1);
    expect(shellExecute).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(result)).toContain("[then_run:succeeded]");
  });

  it("defers for a schema family the plugin cannot read", async () => {
    // For a family the plugin cannot inspect, `then_run` was never advertised, so a value
    // in the input is the host's: the wrapper must not strip it or run it as a command.
    const baseExecute = vi.fn(async (input: unknown) => ({
      content: `host executed ${JSON.stringify(input)}`,
    }));
    const shellExecute = vi.fn(async () => ({ content: "shell", metadata: { exit: 0 } }));
    const foreignInput = { "~standard": { version: 1 }, vendor: "zod-like" };
    let stored = { ...baseEditTool(baseExecute), input: foreignInput as unknown as ToolInfo["input"] };

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

    applyActionFusionToEditor(editor, { cwd: "/tmp/project-foreign-family", patchThenRunInSchema: true });

    const result = await stored.execute(
      { path: "src/a.ts", then_run: { command: "echo foreign" } },
      mockContext,
    );

    expect(baseExecute).toHaveBeenCalledTimes(1);
    // The value must reach the host executor intact. Without this assertion a refactor that strips
    // `then_run` here passes every test in this file — issue #48's failure mode, for a host tool
    // whose unreadable schema declares the property.
    expect(baseExecute).toHaveBeenCalledWith(
      { path: "src/a.ts", then_run: { command: "echo foreign" } },
      mockContext,
    );
    expect(shellExecute).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("[then_run:succeeded]");
  });
});
