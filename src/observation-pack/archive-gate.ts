/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import type { Tool } from "@opencode/schema/tool";
import {
  isPureTextToolResult,
  textFromToolResult,
  THRESHOLD_BYTES,
  utf8ByteLength,
} from "./observation.js";

export const OBS_RECALL_TOOL = "obs_recall";

export type ArchivableExecuteAfter = {
  readonly tool: string;
  readonly status: "completed";
  readonly id: string;
  readonly result: Tool.Result;
};

export function isArchivableCompletedToolResult(event: {
  readonly tool: string;
  readonly status: string;
  readonly id?: string;
  readonly result?: Tool.Result;
}): event is ArchivableExecuteAfter {
  if (event.status !== "completed") return false;
  if (event.tool === OBS_RECALL_TOOL) return false;
  if (!event.id) return false;
  if (event.result === undefined || !isPureTextToolResult(event.result)) return false;
  return utf8ByteLength(textFromToolResult(event.result)) > THRESHOLD_BYTES;
}
