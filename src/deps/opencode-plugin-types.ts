/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 *
 * The host publishes a wildcard subpath map — `"./*"` with an `import` condition
 * of `./dist/*.js` and a `types` condition of `./dist/*.d.ts` — so these type
 * imports resolve through it without reaching into its node_modules tree. Keep
 * the specifiers extensionless: a ".js"-suffixed specifier expands through
 * `import` to `dist/promise/plugin.js.js` (no such file) and is looked up by
 * `types` as `dist/promise/plugin.js.d.ts` (also absent).
 */

export type { Context } from "@opencode/plugin/promise/plugin";
export type { Info, ToolContext, ToolEditor } from "@opencode/plugin/promise/tool";
export type { StorageDomain } from "@opencode/plugin/promise/storage";
