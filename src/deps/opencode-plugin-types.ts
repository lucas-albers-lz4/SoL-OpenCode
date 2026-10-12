/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 *
 * @opencode/plugin exports only the package root; tool/editor types live under dist/promise/.
 */

export type { Context } from "../../node_modules/@opencode/plugin/dist/promise/plugin.js";
export type {
  Info,
  ToolContext,
  ToolEditor,
} from "../../node_modules/@opencode/plugin/dist/promise/tool.js";
export type { StorageDomain } from "../../node_modules/@opencode/plugin/dist/promise/storage.js";
