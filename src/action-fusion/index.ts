/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { isAbsolute } from "node:path";
import type { Context, ToolEditor } from "../deps/opencode-plugin-types.js";
import { applyActionFusionToEditor } from "./wrap-tools.js";

export { applyActionFusionToEditor, patchSupportsThenRunInSchema } from "./wrap-tools.js";
export { enumeratePatchWrittenPaths } from "./patch-paths.js";
export {
  assertUnchangedBeforeCommand,
  executeThenRun,
  resultText,
  THEN_RUN_FAILED,
  THEN_RUN_SKIPPED,
  THEN_RUN_SUCCEEDED,
  type ShellExecute,
} from "./then-run.js";

export async function registerActionFusion(ctx: Pick<Context, "tool" | "location">) {
  // Read the working directory once, at registration: the transform callback runs later,
  // and a missing or relative directory would silently aim every fused command at the
  // wrong place. A named error here lets the host fall back to Observation Pack.
  const cwd = ctx.location?.directory;
  if (typeof cwd !== "string" || cwd.length === 0 || !isAbsolute(cwd)) {
    throw new Error(
      `Action Fusion needs an absolute ctx.location.directory (received ${JSON.stringify(cwd ?? null)})`,
    );
  }
  if (ctx.tool === undefined || typeof ctx.tool.transform !== "function") {
    throw new Error("Action Fusion needs the tool host domain (ctx.tool.transform)");
  }

  return ctx.tool.transform((editor: ToolEditor) => {
    applyActionFusionToEditor(editor, { cwd, patchThenRunInSchema: true });
  });
}
