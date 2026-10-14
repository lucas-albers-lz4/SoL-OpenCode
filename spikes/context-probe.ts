/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 *
 * Throwaway live probe for session.hook("context") persistence on OpenCode 2.0.27.
 * Do not ship. V2 2.0.27 will not load a direct .ts plugin path at all — an
 * absolute one is rejected with "configured plugin path must be a directory" and a
 * relative one fails silently. Load the directory form:
 *   { "plugins": ["./spikes/live/plugins/context-probe"] }
 *
 * Ask the model to call `sol_context_blob` (or any tool whose result includes BLOB below).
 * Mode via plugin options: { "mutate": "replace" | "inplace" }
 * Default replace: new object for the first message containing the blob; other messages keep refs.
 * inplace: overwrite text on the existing part (reproduces #43731).
 *
 * Logs one JSON line per hook fire to stderr (OpenCode plugin log).
 */

import { appendFileSync } from "node:fs";
import { Plugin } from "@opencode/plugin";

const MARKER = "SOL_OPENCODE_BLOB ";
/** Host-visible UTF-8 strictly greater than 10 KiB (marker + 10241 bytes). */
export const BLOB = MARKER + "A".repeat(10241);
const PLACEHOLDER = "[sol.opencode:packed]";
const FULL_SENDS = 2;
const MIN_BYTES = 10 * 1024;

function utf8ByteLength(value: string): number {
  return new TextEncoder().encode(value).length;
}

function logLine(logFile: string | undefined, record: Record<string, unknown>): void {
  const line = JSON.stringify(record);
  console.error(line);
  if (logFile) appendFileSync(logFile, `${line}\n`);
}

function findBlobText(value: unknown): string | undefined {
  if (typeof value === "string") {
    const index = value.indexOf(MARKER);
    return index === -1 ? undefined : value.slice(index);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findBlobText(item);
      if (found !== undefined) return found;
    }
  }
  if (typeof value === "object" && value !== null) {
    for (const nested of Object.values(value)) {
      const found = findBlobText(nested);
      if (found !== undefined) return found;
    }
  }
  return undefined;
}

function messageContainsBlob(value: unknown, blob: string): boolean {
  const found = findBlobText(value);
  return found !== undefined && found === blob;
}

function replaceBlobInClone(value: unknown, blob: string, placeholder: string): unknown {
  const cloned = structuredClone(value);
  overwriteFirstBlobInPlace(cloned, blob, placeholder);
  return cloned;
}

function replaceFirstBlobMessage(
  messages: Array<unknown>,
  blob: string,
  placeholder: string,
): Array<unknown> {
  let replaced = false;
  return messages.map((message) => {
    if (!replaced && messageContainsBlob(message, blob)) {
      replaced = true;
      return replaceBlobInClone(message, blob, placeholder);
    }
    return message;
  });
}

export default Plugin.define({
  id: "sol.opencode.context-probe",
  async setup(ctx) {
    const options =
      ctx.options && typeof ctx.options === "object" ? (ctx.options as Record<string, unknown>) : {};
    const mutate = options.mutate === "inplace" ? "inplace" : "replace";
    const logFile =
      typeof options.logFile === "string" ? options.logFile : process.env.SOL_PROBE_LOG;

    const seen = new Map<string, number>();
    let httpMarkerSends = 0;

    await ctx.tool.hook("execute.after", (event) => {
      if (event.status !== "completed") return;
      const text = findBlobText(event.result.content);
      if (text === undefined) return;
      const bytes = utf8ByteLength(text);
      logLine(logFile, {
        probe: "sol.opencode.context-probe",
        hook: "tool.execute.after",
        toolCallID: event.id,
        blobBytes: bytes,
        meetsGate: bytes > MIN_BYTES,
      });
    });

    await ctx.session.hook("http.request", async (event) => {
      try {
        let body = await event.request.clone().text();
        if (body.includes(MARKER)) httpMarkerSends += 1;
        const projectHttp = httpMarkerSends > FULL_SENDS && body.includes(MARKER);
        if (projectHttp) {
          const rewritten = body.replaceAll(BLOB, PLACEHOLDER).replaceAll(
            findBlobText(body) ?? MARKER,
            PLACEHOLDER,
          );
          event.request = new Request(event.request, { body: rewritten });
          body = rewritten;
        }
        logLine(logFile, {
          probe: "sol.opencode.context-probe",
          hook: "session.http.request",
          sessionID: event.sessionID,
          kind: event.kind,
          hasMarker: body.includes(MARKER),
          hasPlaceholder: body.includes(PLACEHOLDER),
          bodyBytes: utf8ByteLength(body),
          httpMarkerSends,
          projectHttp,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        logLine(logFile, {
          probe: "sol.opencode.context-probe",
          hook: "session.http.request",
          error: message,
        });
      }
    });

    await ctx.session.hook("context", (event) => {
      const blob = findBlobText(event.messages);
      const count = blob ? (seen.get(blob) ?? 0) + 1 : 0;
      if (blob) seen.set(blob, count);

      const project = count > FULL_SENDS;
      if (project && blob) {
        if (mutate === "inplace") {
          overwriteFirstBlobInPlace(event.messages, blob, PLACEHOLDER);
        } else {
          event.messages = replaceFirstBlobMessage(
            event.messages as Array<unknown>,
            blob,
            PLACEHOLDER,
          ) as typeof event.messages;
        }
      }

      logLine(logFile, {
        probe: "sol.opencode.context-probe",
        hook: "session.context",
        mutate,
        sessionID: event.sessionID,
        hadBlob: blob !== undefined,
        send: count || null,
        projected: project,
      });
    });

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "sol_context_blob",
        options: { codemode: false },
        description:
          "Return a host-visible UTF-8 blob (>10 KiB) for the context-hook persistence probe.",
        input: { type: "object", properties: {}, additionalProperties: false },
        async execute() {
          return { content: BLOB };
        },
      });
    });
  },
});

function overwriteFirstBlobInPlace(messages: unknown, blob: string, placeholder: string): void {
  const visit = (value: unknown): boolean => {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (visit(item)) return true;
      }
      return false;
    }
    if (typeof value === "object" && value !== null) {
      const record = value as Record<string, unknown>;
      if (typeof record.text === "string" && record.text.includes(blob)) {
        record.text = record.text.replace(blob, placeholder);
        return true;
      }
      for (const nested of Object.values(record)) {
        if (visit(nested)) return true;
      }
    }
    return false;
  };
  visit(messages);
}
