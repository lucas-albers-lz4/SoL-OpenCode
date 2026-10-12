/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 *
 * Throwaway live probe for fused-shell permission on OpenCode 2.0.27.
 * Do not ship. Load beside sol.opencode:
 *   { "plugins": ["./spikes/permission-probe.ts"] }
 *
 * In a session, ask the model to call `sol_permission_probe`.
 * Expect a native shell permission prompt for:
 *   echo sol-opencode-permission-probe
 * Nested `tool.execute.before` for tool id `shell` must stay 0.
 */

import { appendFileSync } from "node:fs";
import { Plugin } from "@opencode/plugin";
import type { ToolContext } from "../src/deps/opencode-plugin-types.js";

const PROBE_COMMAND = "echo sol-opencode-permission-probe";

function logLine(logFile: string | undefined, record: Record<string, unknown>): void {
  const line = JSON.stringify({ probe: "sol.opencode.permission-probe", ...record });
  console.error(line);
  if (logFile) appendFileSync(logFile, `${line}\n`);
}

export default Plugin.define({
  id: "sol.opencode.permission-probe",
  async setup(ctx) {
    const logFile =
      (ctx.options &&
      typeof ctx.options === "object" &&
      "logFile" in ctx.options &&
      typeof (ctx.options as { logFile?: unknown }).logFile === "string"
        ? (ctx.options as { logFile: string }).logFile
        : undefined) ?? process.env.SOL_PROBE_LOG;

    logLine(logFile, { event: "setup", directory: ctx.location.directory });

    let nestedShellBefore = 0;

    await ctx.tool.hook("execute.before", (event) => {
      if (event.tool === "shell") {
        nestedShellBefore += 1;
        logLine(logFile, { hook: "tool.execute.before", tool: event.tool, id: event.id });
      }
    });

    await ctx.tool.transform((editor) => {
      const shell = editor.get("shell");
      const capturedExecute = shell?.execute;

      editor.add({
        name: "sol_permission_probe",
        options: { codemode: false },
        description:
          "Call captured built-in shell.execute with a no-op echo. Used to verify the native permission prompt.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute(_input: unknown, toolCtx: ToolContext) {
          if (!capturedExecute) {
            logLine(logFile, { event: "missing-shell" });
            return { content: "NO-GO: built-in shell tool missing when this transform ran" };
          }

          const before = nestedShellBefore;
          try {
            const result = await capturedExecute({ command: PROBE_COMMAND }, toolCtx);
            logLine(logFile, {
              event: "shell-returned",
              nestedBeforeDelta: nestedShellBefore - before,
              result,
            });
            return {
              content: [
                `nested tool.execute.before(shell) delta=${nestedShellBefore - before} (want 0)`,
                `command=${PROBE_COMMAND}`,
                JSON.stringify(result),
              ].join("\n"),
            };
          } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            logLine(logFile, {
              event: "shell-threw",
              nestedBeforeDelta: nestedShellBefore - before,
              error: message,
            });
            return {
              content: [
                `nested tool.execute.before(shell) delta=${nestedShellBefore - before} (want 0)`,
                `threw: ${message}`,
              ].join("\n"),
            };
          }
        },
      });
    });
  },
});
