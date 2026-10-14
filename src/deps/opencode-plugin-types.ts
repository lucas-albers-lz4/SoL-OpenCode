/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 *
 * The host publishes a wildcard subpath map (`"./*": "./dist/*.js"`), so these
 * type imports resolve through it without reaching into its node_modules tree.
 * Keep the specifiers extensionless: with the wildcard, a ".js"-suffixed
 * specifier would expand to `dist/promise/plugin.js.js`.
 */

export type { Context } from "@opencode/plugin/promise/plugin";
export type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool";
export type { StorageDomain } from "@opencode/plugin/promise/storage";
