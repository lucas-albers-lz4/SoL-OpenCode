/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import type { Context, ToolContext } from "../deps/opencode-plugin-types.js";
import { isArchivableCompletedToolResult, OBS_RECALL_TOOL } from "./archive-gate.js";
import {
  applyHttpProjectionToPackedEntries,
  projectArchivedTextsInHttpBody,
} from "./http-rewrite.js";
import {
  countLines,
  createObservation,
  ensureStored,
  estimateTokens,
  isObservationId,
  placeholderFor,
  readRecallChunk,
  readStoredObservation,
  textFromToolResult,
  utf8ByteLength,
} from "./observation.js";
import { observationObjectPath, observationPackObjectsRoot } from "./runtime-path.js";
import {
  loadSessionIndex,
  saveSessionIndex,
  type PackedToolResult,
} from "./session-index.js";
import { withSessionIndexLock } from "./session-index-mutex.js";

const RECALL_MAX_BYTES = 16 * 1024;
const RECALL_MAX_LINES = 400;
const RECALL_HEADER_RESERVE_BYTES = 512;
const RECALL_HEADER_LINES = 2;

const RECALL_LIMITS = {
  maxBytes: RECALL_MAX_BYTES - RECALL_HEADER_RESERVE_BYTES,
  maxLines: RECALL_MAX_LINES - RECALL_HEADER_LINES,
};

let cachedObjectsRoot: string | undefined;

async function objectsRoot(): Promise<string> {
  if (cachedObjectsRoot === undefined) {
    cachedObjectsRoot = await observationPackObjectsRoot();
  }
  return cachedObjectsRoot;
}

function failOpen(reason: string, error: unknown): void {
  const detail = error instanceof Error ? error.message : String(error);
  console.error(`[sol.opencode observation-pack] ${reason}: ${detail}`);
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function registerObservationPack(
  ctx: Pick<Context, "tool" | "session" | "storage">,
): Promise<{ dispose: () => Promise<void> }> {
  // Feature-check the domains this mechanism needs, so a host missing one fails with a
  // named reason instead of a bare TypeError at the first dereference.
  if (
    ctx.tool === undefined ||
    typeof ctx.tool.hook !== "function" ||
    typeof ctx.tool.transform !== "function"
  ) {
    throw new Error("Observation Pack needs the tool host domain (ctx.tool.hook, ctx.tool.transform)");
  }
  if (ctx.session === undefined || typeof ctx.session.hook !== "function") {
    throw new Error("Observation Pack needs the session host domain (ctx.session.hook)");
  }
  if (
    ctx.storage === undefined ||
    typeof ctx.storage.get !== "function" ||
    typeof ctx.storage.set !== "function"
  ) {
    throw new Error("Observation Pack needs the storage host domain (ctx.storage.get, ctx.storage.set)");
  }

  const disposers: Array<{ dispose: () => Promise<void> }> = [];

  /**
   * Register one part of the mechanism. A mechanism that fails half way through is work
   * the host can never clean up — it never received a disposer for what already took
   * effect — so unwind everything registered so far, in reverse order, then rethrow.
   */
  const addRegistration = async (
    start: () => Promise<{ dispose: () => Promise<void> }>,
  ): Promise<void> => {
    try {
      disposers.push(await start());
    } catch (error) {
      const unwindFailures: string[] = [];
      for (const registration of [...disposers].reverse()) {
        try {
          await registration.dispose();
        } catch (unwindError) {
          unwindFailures.push(describeError(unwindError));
        }
      }
      if (unwindFailures.length === 0) throw error;
      // The registration failure is the diagnosis; a failure while cleaning up must not take
      // its place in the only message the user sees.
      throw new Error(
        `${describeError(error)} (cleanup also failed: ${unwindFailures.join("; ")})`,
        { cause: error },
      );
    }
  };

  await addRegistration(
    () => ctx.tool.hook("execute.after", async (event) => {
      if (!isArchivableCompletedToolResult(event)) return;

      try {
        const text = textFromToolResult(event.result);

        const root = await objectsRoot();
        const observation = createObservation(text, event.tool, event.id, root);
        if (!observation) return;

        await ensureStored(observation);

        await withSessionIndexLock(event.sessionID, async () => {
          const entries = await loadSessionIndex(ctx.storage, event.sessionID);
          const joinKey = `${event.sessionID}\0${event.id}`;
          if (entries.some((entry) => `${event.sessionID}\0${entry.toolCallId}` === joinKey)) {
            return;
          }

          const packed: PackedToolResult = {
            toolCallId: event.id,
            obsId: observation.id,
            toolName: event.tool,
            contentHash: observation.contentHash,
            bytes: observation.bytes,
            httpSendCount: 0,
          };

          await saveSessionIndex(ctx.storage, event.sessionID, [...entries, packed]);
        });
      } catch (error) {
        failOpen("archive fail-open", error);
      }
    }),
  );

  await addRegistration(
    () => ctx.session.hook("http.request", async (event) => {
      try {
        await withSessionIndexLock(event.sessionID, async () => {
          const entries = await loadSessionIndex(ctx.storage, event.sessionID);
          if (entries.length === 0) return;

          const root = await objectsRoot();
          const liveEntries: PackedToolResult[] = [];
          const projectionEntries: Array<{
            text: string;
            placeholder: string;
            httpSendCount: number;
            toolCallId: string;
          }> = [];
          for (const entry of entries) {
            const objectPath = observationObjectPath(root, entry.obsId);
            try {
              const text = await readStoredObservation(objectPath);
              liveEntries.push(entry);
              projectionEntries.push({
                text,
                placeholder: placeholderFor({
                  id: entry.obsId,
                  contentHash: entry.contentHash,
                  filePath: objectPath,
                  toolName: entry.toolName,
                  toolCallId: entry.toolCallId,
                  text,
                  bytes: entry.bytes,
                  lines: countLines(text),
                  tokens: estimateTokens(text),
                }),
                httpSendCount: entry.httpSendCount,
                toolCallId: entry.toolCallId,
              });
            } catch {
              // Fork without copied artifacts: fail open for this entry.
            }
          }
          if (liveEntries.length === 0) return;

          const originalBody = await event.request.clone().text();
          const { body: projectedBody, httpSendCounts } = projectArchivedTextsInHttpBody(
            originalBody,
            projectionEntries,
          );
          if (projectedBody !== originalBody) {
            event.request = new Request(event.request, { body: projectedBody });
          }

          const updated = applyHttpProjectionToPackedEntries(liveEntries, httpSendCounts);
          const merged = entries.map((entry) => {
            const match = updated.find(
              (candidate) => candidate.toolCallId === entry.toolCallId && candidate.obsId === entry.obsId,
            );
            return match ?? entry;
          });
          const countsChanged = merged.some((entry, index) => {
            const prior = entries[index];
            return prior !== undefined && prior.httpSendCount !== entry.httpSendCount;
          });
          if (projectedBody !== originalBody || countsChanged) {
            await saveSessionIndex(ctx.storage, event.sessionID, merged);
          }
        });
      } catch (error) {
        failOpen("http.request projection fail-open", error);
      }
    }),
  );

  await addRegistration(
    () => ctx.tool.transform((editor) => {
      editor.add({
        name: OBS_RECALL_TOOL,
        options: { codemode: false },
        description: "Read a stored large tool result by observation id and byte offset.",
        input: {
          type: "object",
          properties: {
            id: { type: "string", description: "Observation id from a placeholder" },
            offset: { type: "integer", minimum: 0, description: "Byte offset, default 0" },
          },
          required: ["id"],
          additionalProperties: false,
        },
        async execute(input: unknown, context: ToolContext) {
          const params =
            typeof input === "object" && input !== null
              ? (input as { id?: unknown; offset?: unknown })
              : {};
          if (typeof params.id !== "string" || !isObservationId(params.id)) {
            throw new Error(`Unknown observation id: ${String(params.id)}`);
          }
          const offset = typeof params.offset === "number" ? params.offset : 0;

          const sessionEntries = await loadSessionIndex(ctx.storage, context.sessionID);
          if (!sessionEntries.some((entry) => entry.obsId === params.id)) {
            throw new Error(`Unknown observation id: ${params.id}`);
          }

          const root = await objectsRoot();
          const path = observationObjectPath(root, params.id);

          let chunk;
          try {
            chunk = await readRecallChunk(path, offset, RECALL_LIMITS);
          } catch (error) {
            if (error instanceof Error && "code" in error && error.code === "ENOENT") {
              throw new Error(`Unknown observation id: ${params.id}`);
            }
            throw error;
          }

          // Report the offset the chunk really starts at; a mid-character request is
          // snapped forward, so the model can page from a boundary again.
          const offsetLabel =
            chunk.startOffset === offset
              ? `offset=${offset}`
              : `offset=${chunk.startOffset} (requested ${offset}, snapped to a character boundary)`;
          const header = [
            `[obs_recall id=${params.id} ${offsetLabel} next_offset=${chunk.nextOffset} eof=${chunk.eof}]`,
            `[chunk_bytes=${chunk.bytes} chunk_lines=${chunk.lines}; use next_offset to continue]`,
          ].join("\n");
          const content = `${header}\n${chunk.text}`;
          if (utf8ByteLength(content) > RECALL_MAX_BYTES || countLines(content) > RECALL_MAX_LINES) {
            throw new Error("Recall output exceeded its hard limit");
          }

          return { content };
        },
      });
    }),
  );

  return {
    async dispose() {
      // Reverse registration order: the last thing registered is the first to go. Every
      // registration is attempted, so one throwing disposer cannot leave the rest live.
      const failures: string[] = [];
      for (const registration of [...disposers].reverse()) {
        try {
          await registration.dispose();
        } catch (error) {
          failures.push(describeError(error));
        }
      }
      if (failures.length > 0) {
        throw new Error(`Observation Pack disposal failed (${failures.join("; ")})`);
      }
    },
  };
}

export {
  createObservation,
  FULL_SENDS,
  placeholderFor,
  THRESHOLD_BYTES,
} from "./observation.js";
export { projectArchivedTextsInHttpBody } from "./http-rewrite.js";
