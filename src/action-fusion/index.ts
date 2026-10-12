/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

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
  return ctx.tool.transform((editor: ToolEditor) => {
    applyActionFusionToEditor(editor, {
      cwd: ctx.location.directory,
      patchThenRunInSchema: true,
    });
  });
}
