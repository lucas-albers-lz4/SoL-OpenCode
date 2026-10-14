/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { link, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
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

function patchToolHarness({
  cwd,
  shellExecute,
  mutate,
}: {
  cwd: string;
  shellExecute: ShellExecute;
  mutate: () => Promise<Tool.Result>;
}) {
  let stored: {
    id: string;
    name: string;
    description: string;
    input: unknown;
    execute: (...args: unknown[]) => Promise<Tool.Result>;
  } = {
    id: "patch",
    name: "patch",
    description: "patch",
    input: { type: "object" as const, properties: { patchText: { type: "string" } } },
    execute: mutate as (...args: unknown[]) => Promise<Tool.Result>,
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

  applyActionFusionToEditor(editor, { cwd, patchThenRunInSchema: true });

  return {
    mutate,
    execute: (args: Record<string, unknown>): Promise<Tool.Result> =>
      stored.execute(args, mockContext) as Promise<Tool.Result>,
  };
}

function textOf(result: Tool.Result): string {
  if (typeof result.content === "string") {
    return result.content;
  }
  if (Array.isArray(result.content)) {
    return result.content.map((block) => ("text" in block ? block.text : "")).join("\n");
  }
  return "";
}

describe("patch then_run fusion guard", () => {
  it("keeps the silent omission when patch paths cannot be enumerated", async () => {
    const shellExecute = vi.fn(async () => ({
      content: "shell",
      metadata: { exit: 0 },
    })) as ShellExecute;
    const mutate = vi.fn(async () => ({ content: "patched" }));
    const harness = patchToolHarness({ cwd: "/tmp/project", shellExecute, mutate });

    const result = await harness.execute({
      patchText: "not a patch",
      then_run: { command: "echo skipped" },
    });

    expect(mutate).toHaveBeenCalled();
    expect(shellExecute).not.toHaveBeenCalled();
    expect(textOf(result)).toBe("patched");
  });

  it("runs then_run for a delete-only patch even though the target is gone", async () => {
    const shellExecute = vi.fn(async () => ({
      content: "after-delete",
      metadata: { exit: 0 },
    })) as ShellExecute;
    const dir = await mkdtemp(join(tmpdir(), "then-run-delete-"));
    const target = join(dir, "gone.txt");
    await writeFile(target, "bye\n", "utf8");

    const mutate = vi.fn(async () => {
      await rm(target, { force: true });
      return { content: "deleted" };
    });
    const harness = patchToolHarness({ cwd: dir, shellExecute, mutate });

    const result = await harness.execute({
      patchText: "*** Begin Patch\n*** Delete File: gone.txt\n*** End Patch",
      then_run: { command: "echo after-delete" },
    });

    expect(mutate).toHaveBeenCalled();
    expect(shellExecute).toHaveBeenCalledWith({ command: "echo after-delete" }, mockContext);
    expect(textOf(result)).toContain("[then_run:succeeded]");
    expect(textOf(result)).not.toContain("[then_run:skipped]");
  });

  it("reports an explicit skip for a parsed patch that touches no path", async () => {
    const shellExecute = vi.fn(async () => ({
      content: "shell",
      metadata: { exit: 0 },
    })) as ShellExecute;
    const mutate = vi.fn(async () => ({ content: "patched" }));
    const harness = patchToolHarness({ cwd: "/tmp/project", shellExecute, mutate });

    const withThenRun = await harness.execute({
      patchText: "*** Begin Patch\n*** End Patch",
      then_run: { command: "echo zero" },
    });

    expect(mutate).toHaveBeenCalled();
    expect(shellExecute).not.toHaveBeenCalled();
    expect(textOf(withThenRun)).toContain("[then_run:skipped]");

    const withoutThenRun = await harness.execute({ patchText: "*** Begin Patch\n*** End Patch" });
    expect(textOf(withoutThenRun)).toBe("patched");
  });

  it("runs then_run for a rename patch, where a moving update removes its source", async () => {
    const shellExecute = vi.fn(async () => ({
      content: "after-rename",
      metadata: { exit: 0 },
    })) as ShellExecute;
    const dir = await mkdtemp(join(tmpdir(), "then-run-rename-"));
    const source = join(dir, "old.txt");
    const destination = join(dir, "new.txt");
    await writeFile(source, "old\n", "utf8");

    const mutate = vi.fn(async () => {
      await rename(source, destination);
      return { content: "renamed" };
    });
    const harness = patchToolHarness({ cwd: dir, shellExecute, mutate });

    const result = await harness.execute({
      patchText:
        "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n@@\n-old\n+new\n*** End Patch",
      then_run: { command: "echo after-rename" },
    });

    expect(mutate).toHaveBeenCalled();
    expect(shellExecute).toHaveBeenCalledWith({ command: "echo after-rename" }, mockContext);
    expect(textOf(result)).toContain("[then_run:succeeded]");
    expect(textOf(result)).not.toContain("[then_run:skipped]");
  });

  it("runs the command when the same bytes were changed through a hardlink alias", async () => {
    // #36's model-visible effect, at the marker level: two names for one inode must serialize,
    // or the fused section reads the other write as interference and skips the command.
    const dir = await mkdtemp(join(tmpdir(), "then-run-alias-"));
    const original = join(dir, "a.txt");
    const alias = join(dir, "b.txt");
    await writeFile(original, "base\n", "utf8");
    await link(original, alias);

    const shellExecute = vi.fn(async () => ({
      content: "shell",
      metadata: { exit: 0 },
    })) as ShellExecute;
    const mutateVia = (writePath: string) => async () => {
      await writeFile(writePath, "base\nchanged\n", "utf8");
      return { content: `wrote ${writePath}` };
    };

    const results = await Promise.all([
      executeMutationThenRunSinglePath({
        cwd: dir,
        absolutePath: original,
        thenRun: { command: "echo via-original" },
        context: mockContext,
        shellExecute,
        mutate: mutateVia(alias),
      }),
      executeMutationThenRunSinglePath({
        cwd: dir,
        absolutePath: alias,
        thenRun: { command: "echo via-alias" },
        context: mockContext,
        shellExecute,
        mutate: mutateVia(original),
      }),
    ]);

    const text = results.map((result) => textOf(result)).join("\n");
    expect(shellExecute).toHaveBeenCalledTimes(2);
    expect(text).not.toContain("[then_run:skipped]");
    expect(text).toContain("[then_run:succeeded]");
  });
});
