/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import type { Info as ToolInfo, ToolContext, ToolEditor } from "../deps/opencode-plugin-types.js";
import type { Types } from "effect";
import { resolveMutationPath } from "./file-queue.js";
import { enumeratePatchWrittenPaths } from "./patch-paths.js";
import {
  appendThenRunSkipNotice,
  executeMutationThenRunPatch,
  executeMutationThenRunSinglePath,
  type ShellExecute,
} from "./then-run.js";
import { extendToolInputWithThenRun, stripThenRun } from "./then-run-schema.js";

const MUTATION_TOOL_IDS = ["edit", "write", "patch"] as const;

const EDIT_THEN_RUN_DESCRIPTION =
  "Command to run next on this file after the edit succeeds; optional timeout in seconds. Skipped if the edit fails.";
const WRITE_THEN_RUN_DESCRIPTION =
  "Command to run next on this file after the write succeeds; optional timeout in seconds. Skipped if the write fails.";
const PATCH_THEN_RUN_DESCRIPTION =
  "Command to run after the patch succeeds on all written paths; optional timeout in seconds. Omitted from schema when patch paths cannot be enumerated.";

/**
 * The `then_run` property description for each mutation tool. Model-visible on every
 * provider request: `tests/schema-cost.test.ts` measures the shipped text and pins the
 * resulting byte cost, so a change here is a decision recorded in docs/quality-guard.md.
 */
export const THEN_RUN_DESCRIPTION: Record<(typeof MUTATION_TOOL_IDS)[number], string> = {
  edit: EDIT_THEN_RUN_DESCRIPTION,
  write: WRITE_THEN_RUN_DESCRIPTION,
  patch: PATCH_THEN_RUN_DESCRIPTION,
};

export interface ActionFusionWrapConfig {
  readonly cwd: string;
  /** When false, `patch` keeps its host schema (no `then_run` property). */
  readonly patchThenRunInSchema: boolean;
  /** Captured from `editor.get("shell").execute` in the same transform pass; hides `then_run` when absent. */
  readonly shellExecute?: ShellExecute;
}

export function patchSupportsThenRunInSchema(): boolean {
  return enumeratePatchWrittenPaths("*** Begin Patch\n*** End Patch\n") !== undefined;
}

function inputWithOptionalThenRun(
  toolId: (typeof MUTATION_TOOL_IDS)[number],
  input: ToolInfo["input"],
  config: ActionFusionWrapConfig,
): ToolInfo["input"] {
  if (!config.shellExecute) {
    return input;
  }
  if (toolId === "patch" && !config.patchThenRunInSchema) {
    return input;
  }
  return extendToolInputWithThenRun(input, THEN_RUN_DESCRIPTION[toolId]);
}

function wrapToolExecute(
  toolId: (typeof MUTATION_TOOL_IDS)[number],
  tool: Types.Mutable<ToolInfo>,
  config: ActionFusionWrapConfig,
): void {
  const currentExecute = tool.execute;

  tool.input = inputWithOptionalThenRun(toolId, tool.input, config);

  tool.execute = async (input: unknown, context: ToolContext) => {
    const { mutationInput, thenRun, skipReason } = stripThenRun(
      typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {},
    );

    if (toolId === "patch") {
      const patchText =
        typeof mutationInput === "object" &&
        mutationInput !== null &&
        "patchText" in mutationInput &&
        typeof (mutationInput as { patchText?: unknown }).patchText === "string"
          ? (mutationInput as { patchText: string }).patchText
          : "";

      const writtenPaths = enumeratePatchWrittenPaths(patchText);

      // A parsed patch that touches no path cannot queue or guard a follow-up, so
      // report the skip instead of returning plain success.
      if (writtenPaths !== undefined && writtenPaths.length === 0) {
        const mutationResult = await currentExecute(mutationInput, context);
        const reason = skipReason ?? "the patch touches no file path; the command was not run.";
        return thenRun === undefined && skipReason === undefined
          ? mutationResult
          : appendThenRunSkipNotice(mutationResult, reason);
      }

      const patchResult = await executeMutationThenRunPatch({
        cwd: config.cwd,
        relativePaths: writtenPaths ?? [],
        // An unparseable patch keeps the historical silent omission: its touched
        // paths are unknowable, so the follow-up is neither queued nor run.
        thenRun: writtenPaths === undefined ? undefined : thenRun,
        skipReason,
        context,
        shellExecute: config.shellExecute,
        mutate: () => currentExecute(mutationInput, context),
      });

      // A malformed `then_run` applies the mutation but must not report plain success.
      return skipReason === undefined
        ? patchResult
        : appendThenRunSkipNotice(patchResult, skipReason);
    }

    const pathValue =
      typeof mutationInput === "object" &&
      mutationInput !== null &&
      "path" in mutationInput &&
      typeof (mutationInput as { path?: unknown }).path === "string"
        ? (mutationInput as { path: string }).path
        : "";

    const singlePathResult = await executeMutationThenRunSinglePath({
      cwd: config.cwd,
      absolutePath: resolveMutationPath(config.cwd, pathValue),
      thenRun,
      skipReason,
      context,
      shellExecute: config.shellExecute,
      mutate: () => currentExecute(mutationInput, context),
    });

    return skipReason === undefined
      ? singlePathResult
      : appendThenRunSkipNotice(singlePathResult, skipReason);
  };
}

/**
 * Wrap the current tool definitions on this editor pass. Call from `ctx.tool.transform`
 * only; always read `editor.get(id)` / `tool.execute` inside `update`, never close over
 * a previous transform's wrapped execute.
 */
export function applyActionFusionToEditor(editor: ToolEditor, config: ActionFusionWrapConfig): void {
  const shellExecute = editor.get("shell")?.execute as ActionFusionWrapConfig["shellExecute"];
  const effectiveConfig: ActionFusionWrapConfig = { ...config, shellExecute };
  const patchThenRunInSchema =
    effectiveConfig.patchThenRunInSchema && patchSupportsThenRunInSchema();

  for (const toolId of MUTATION_TOOL_IDS) {
    const existing = editor.get(toolId);
    if (!existing) continue;

    editor.update(toolId, (tool) => {
      wrapToolExecute(toolId, tool, { ...effectiveConfig, patchThenRunInSchema });
    });
  }
}
