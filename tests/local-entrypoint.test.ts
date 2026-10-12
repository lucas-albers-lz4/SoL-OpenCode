/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { expect, it } from "vitest";
import plugin from "../index.js";

it("exposes the plugin through the local-directory entrypoint", () => {
  expect(plugin.id).toBe("sol.opencode");
  expect(typeof plugin.setup).toBe("function");
});
