/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Tool } from "@opencode/schema/tool";
import { describe, expect, it, vi } from "vitest";
import type { ToolContext } from "../src/deps/opencode-plugin-types.js";
import { applyActionFusionToEditor } from "../src/action-fusion/wrap-tools.js";
import {
  executeMutationThenRunSinglePath,
  executeThenRun,
  THEN_RUN_FAILED,
  type ShellExecute,
} from "../src/action-fusion/then-run.js";
import { thenRunTimeoutMs } from "../src/action-fusion/then-run-schema.js";

const mockContext = {
  sessionID: "ses_test",
  agent: "agent_test",
  messageID: "msg_test",
  id: "call_test",
  signal: new AbortController().signal,
  progress: async () => {},
} satisfies ToolContext;

describe("executeThenRun", () => {
  it("converts timeout seconds to milliseconds for shell.execute", async () => {
    const shellExecute = vi.fn(async () => ({ content: "ok", metadata: { exit: 0 } })) as ShellExecute;
    await executeThenRun({ command: "echo hi", timeout: 12 }, mockContext, shellExecute);
    expect(shellExecute).toHaveBeenCalledWith({ command: "echo hi", timeout: 12_000 }, mockContext);
    expect(thenRunTimeoutMs({ command: "x", timeout: 12 })).toBe(12_000);
  });

  it("THEN_RUN_FAILED includes mutation output when shell.execute throws", async () => {
    const shellExecute = vi.fn(async () => {
      throw new Error("");
    }) as ShellExecute;

    const dir = await mkdtemp(join(tmpdir(), "then-run-fail-"));
    const filePath = join(dir, "target.txt");
    await writeFile(filePath, "mutated bytes\n", "utf8");

    await expect(
      executeMutationThenRunSinglePath({
        cwd: dir,
        absolutePath: filePath,
        thenRun: { command: "echo nope" },
        context: mockContext,
        shellExecute,
        mutate: async () => ({ content: "mutation-visible-to-model" }),
      }),
    ).rejects.toThrow(/mutation-visible-to-model[\s\S]*\[then_run:failed\]/);
  });
});

describe("patch then_run fusion guard", () => {
  it("skips then_run when patch paths cannot be enumerated", async () => {
    const shellExecute = vi.fn(async () => ({
      content: "shell",
      metadata: { exit: 0 },
    })) as ShellExecute;
    const baseExecute = vi.fn(async () => ({ content: "patched" }));

    let stored = {
      id: "patch",
      name: "patch",
      description: "patch",
      input: { type: "object" as const, properties: { patchText: { type: "string" } } },
      execute: baseExecute,
    };

    const editor = {
      get: (id: string) => {
        if (id === "shell") return { ...stored, execute: shellExecute };
        if (id === "patch") return { ...stored, execute: stored.execute };
        return undefined;
      },
      update: (id: string, update: (tool: typeof stored) => void) => {
        if (id !== "patch") return;
        const draft = { ...stored, execute: stored.execute };
        update(draft);
        stored = { ...stored, ...draft, execute: draft.execute };
      },
      list: () => [stored],
      add: () => {},
      remove: () => {},
      namespace: () => {},
    };

    applyActionFusionToEditor(editor, { cwd: "/tmp/project", patchThenRunInSchema: true });

    await stored.execute(
      { patchText: "not a patch", then_run: { command: "echo skipped" } },
      mockContext,
    );

    expect(baseExecute).toHaveBeenCalled();
    expect(shellExecute).not.toHaveBeenCalled();
  });
});
