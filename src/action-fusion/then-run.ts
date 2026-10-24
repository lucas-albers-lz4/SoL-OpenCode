/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import type { Tool } from "@opencode/schema/tool";
import type { ToolContext } from "../deps/opencode-plugin-types.js";
import { resolveMutationPath, withFusedFileQueue, withFusedFileQueues } from "./file-queue.js";
import { type ThenRunInput, thenRunTimeoutMs } from "./then-run-schema.js";

export const THEN_RUN_SUCCEEDED = "[then_run:succeeded]";
export const THEN_RUN_FAILED = "[then_run:failed]";
export const THEN_RUN_SKIPPED = "[then_run:skipped]";

export type ShellExecute = (
  input: { readonly command: string; readonly timeout?: number },
  context: ToolContext,
) => Promise<Tool.Result>;

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function resultText(result: Tool.Result): string {
  if (typeof result.content === "string") {
    return result.content;
  }
  if (Array.isArray(result.content)) {
    return result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

async function fileSha256(path: string): Promise<string> {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}

/** State of a path that a fused mutation may have removed. */
const MISSING_FILE_STATE = "<missing>";

async function fileState(path: string): Promise<string> {
  try {
    return await fileSha256(path);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    // Mirrors `isMissingPathError` in file-queue.ts: ENOENT and ENOTDIR both mean
    // "no file here", neither is interference.
    if (code === "ENOENT" || code === "ENOTDIR") {
      return MISSING_FILE_STATE;
    }
    throw error;
  }
}

export async function assertUnchangedBeforeCommand(
  path: string,
  yieldForInterference: () => Promise<void> = () => new Promise<void>((resolve) => setImmediate(resolve)),
): Promise<void> {
  try {
    // Existence-aware: a delete target or a rename source is absent both before and
    // after the command slot, which is not interference — only a state change is.
    const mutationState = await fileState(path);
    await yieldForInterference();
    const commandState = await fileState(path);
    if (mutationState !== commandState) {
      throw new Error("target content changed after the fused mutation");
    }
  } catch (error) {
    throw new Error(`${THEN_RUN_SKIPPED} ${errorText(error)}; the command was not run.`);
  }
}

export async function assertAllUnchangedBeforeCommand(
  absolutePaths: readonly string[],
): Promise<void> {
  for (const path of absolutePaths) {
    await assertUnchangedBeforeCommand(path);
  }
}

function mapShellResultToObservation(result: Tool.Result): string {
  const metadata = result.metadata;
  // A signal kill has no exit code: the host leaves `exit` undefined and reports
  // `signal` instead, so the default below would turn a killed command into a
  // success marker. Treat any signal as a failure.
  const signal = typeof metadata?.signal === "string" ? metadata.signal : undefined;
  const exit = typeof metadata?.exit === "number" ? metadata.exit : 0;
  const timedOut = metadata?.timeout === true;
  const output = resultText(result);

  if (timedOut || signal !== undefined || exit !== 0) {
    return [THEN_RUN_FAILED, output].filter(Boolean).join("\n");
  }
  return output ? `${THEN_RUN_SUCCEEDED}\n${output}` : THEN_RUN_SUCCEEDED;
}

/** Invoke captured built-in `shell.execute` (permission.assert runs inside the host). */
export async function executeThenRun(
  thenRun: ThenRunInput,
  context: ToolContext,
  shellExecute: ShellExecute,
): Promise<string> {
  if (thenRun.command.trim() === "") {
    // `thenRunFailedError` prepends the marker for this path; do not duplicate it.
    throw new Error("empty command");
  }

  const timeoutMs = thenRunTimeoutMs(thenRun);
  const shellInput =
    timeoutMs === undefined
      ? { command: thenRun.command }
      : { command: thenRun.command, timeout: timeoutMs };

  const result = await shellExecute(shellInput, context);
  return mapShellResultToObservation(result);
}

function appendResultText(result: Tool.Result, text: string): Tool.Result {
  if (typeof result.content === "string") {
    const merged = result.content.length > 0 ? `${result.content}\n${text}` : text;
    return { ...result, content: merged };
  }
  if (Array.isArray(result.content)) {
    return {
      ...result,
      content: [...result.content, { type: "text" as const, text }],
    };
  }
  return { ...result, content: [{ type: "text" as const, text }] };
}

/** Attach an explicit skip marker to a mutation result whose follow-up never ran. */
export function appendThenRunSkipNotice(result: Tool.Result, reason: string): Tool.Result {
  return appendResultText(result, `${THEN_RUN_SKIPPED} ${reason}`);
}

function thenRunFailedError(mutationResult: Tool.Result, error: unknown): Error {
  const mutationOutput = resultText(mutationResult);
  return new Error(
    [mutationOutput, THEN_RUN_FAILED, errorText(error)].filter(Boolean).join("\n\n"),
  );
}

export async function executeMutationThenRunSinglePath({
  cwd,
  absolutePath,
  thenRun,
  skipReason,
  mutate,
  context,
  shellExecute,
}: {
  readonly cwd: string;
  readonly absolutePath: string;
  readonly thenRun: ThenRunInput | undefined;
  /** Set when `then_run` was present but unusable; carried so the reason survives a throw. */
  readonly skipReason?: string;
  readonly mutate: () => Promise<Tool.Result>;
  readonly context: ToolContext;
  readonly shellExecute: ShellExecute | undefined;
}): Promise<Tool.Result> {
  return withFusedFileQueue(absolutePath, async () => {
    let mutationResult: Tool.Result;
    try {
      mutationResult = await mutate();
    } catch (error) {
      if (thenRun === undefined && skipReason === undefined) {
        throw error;
      }
      // A malformed `then_run` normalises to `thenRun: undefined`, so its reason has to be
      // carried separately or the caller's mistake disappears on this path.
      const reason = skipReason ?? "The file mutation did not complete successfully";
      throw new Error(`${errorText(error)}\n\n${THEN_RUN_SKIPPED} ${reason}; the command was not run.`);
    }

    if (thenRun === undefined) {
      return mutationResult;
    }

    if (!shellExecute) {
      throw new Error(`${THEN_RUN_SKIPPED} shell tool is unavailable; the command was not run.`);
    }

    await assertUnchangedBeforeCommand(absolutePath);
    try {
      const output = await executeThenRun(thenRun, context, shellExecute);
      return appendResultText(mutationResult, output);
    } catch (error) {
      throw thenRunFailedError(mutationResult, error);
    }
  });
}

export async function executeMutationThenRunPatch({
  cwd,
  relativePaths,
  thenRun,
  skipReason,
  mutate,
  context,
  shellExecute,
}: {
  readonly cwd: string;
  readonly relativePaths: readonly string[];
  readonly thenRun: ThenRunInput | undefined;
  /** Set when `then_run` was present but unusable; carried so the reason survives a throw. */
  readonly skipReason?: string;
  readonly mutate: () => Promise<Tool.Result>;
  readonly context: ToolContext;
  readonly shellExecute: ShellExecute | undefined;
}): Promise<Tool.Result> {
  const absolutePaths = relativePaths.map((path) => resolveMutationPath(cwd, path));

  return withFusedFileQueues(absolutePaths, async () => {
    let mutationResult: Tool.Result;
    try {
      mutationResult = await mutate();
    } catch (error) {
      if (thenRun === undefined && skipReason === undefined) {
        throw error;
      }
      const reason = skipReason ?? "The patch did not complete successfully";
      throw new Error(`${errorText(error)}\n\n${THEN_RUN_SKIPPED} ${reason}; the command was not run.`);
    }

    if (thenRun === undefined) {
      return mutationResult;
    }

    if (!shellExecute) {
      throw new Error(`${THEN_RUN_SKIPPED} shell tool is unavailable; the command was not run.`);
    }

    await assertAllUnchangedBeforeCommand(absolutePaths);
    try {
      const output = await executeThenRun(thenRun, context, shellExecute);
      return appendResultText(mutationResult, output);
    } catch (error) {
      throw thenRunFailedError(mutationResult, error);
    }
  });
}
