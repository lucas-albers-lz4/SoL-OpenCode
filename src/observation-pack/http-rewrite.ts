/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { FULL_SENDS } from "./observation.js";
import type { PackedToolResult } from "./session-index.js";

export interface HttpProjectionEntry {
  readonly text: string;
  readonly placeholder: string;
  readonly httpSendCount: number;
  readonly toolCallId: string;
}

function outputId(record: Record<string, unknown>): string | undefined {
  switch (record.type) {
    case "tool_result": {
      const id = record.tool_use_id ?? record.toolUseId;
      return typeof id === "string" ? id : undefined;
    }
    case "function_call_output": {
      const id = record.call_id ?? record.callId;
      return typeof id === "string" ? id : undefined;
    }
    default: {
      if (record.role !== "tool") return undefined;
      const id = record.tool_call_id ?? record.toolCallId;
      return typeof id === "string" ? id : undefined;
    }
  }
}

function outputField(record: Record<string, unknown>): "content" | "output" {
  return record.type === "function_call_output" ? "output" : "content";
}

function replaceOutputText(
  record: Record<string, unknown>,
  field: "content" | "output",
  text: string,
  placeholder: string,
): boolean {
  const value = record[field];
  if (typeof value === "string") {
    if (value !== text) return false;
    record[field] = placeholder;
    return true;
  }
  if (!Array.isArray(value)) return false;

  const textBlocks = value.filter(
    (block): block is Record<string, unknown> =>
      typeof block === "object" &&
      block !== null &&
      typeof (block as Record<string, unknown>).text === "string",
  );
  if (
    textBlocks.length === value.length &&
    textBlocks.map((block) => block.text as string).join("\n") === text
  ) {
    record[field] = [{ type: "text", text: placeholder }];
    return true;
  }

  let changed = false;
  for (const block of textBlocks) {
    if (block.text !== text) continue;
    block.text = placeholder;
    changed = true;
  }
  return changed;
}

function projectEntryInParsedJson(
  parsed: unknown,
  entry: HttpProjectionEntry,
): { readonly value: unknown; readonly changed: boolean } {
  if (typeof parsed !== "object" || parsed === null) {
    return { value: parsed, changed: false };
  }

  const clone = structuredClone(parsed);
  let changed = false;

  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (typeof value !== "object" || value === null) return;

    const record = value as Record<string, unknown>;
    if (outputId(record) === entry.toolCallId) {
      changed = replaceOutputText(record, outputField(record), entry.text, entry.placeholder) || changed;
    }
    for (const child of Object.values(record)) visit(child);
  };

  visit(clone);
  return changed ? { value: clone, changed: true } : { value: parsed, changed: false };
}

export function projectArchivedTextsInHttpBody(
  body: string,
  entries: readonly HttpProjectionEntry[],
): { readonly body: string; readonly httpSendCounts: readonly number[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return { body, httpSendCounts: entries.map((entry) => entry.httpSendCount) };
  }

  const httpSendCounts: number[] = [];
  let nextBody = body;
  let nextParsed = parsed;

  for (const entry of entries) {
    const projection = projectEntryInParsedJson(nextParsed, entry);
    if (!projection.changed) {
      httpSendCounts.push(entry.httpSendCount);
      continue;
    }

    const sendCount = entry.httpSendCount + 1;
    if (sendCount > FULL_SENDS) {
      nextParsed = projection.value;
      nextBody = JSON.stringify(nextParsed);
    }
    httpSendCounts.push(sendCount);
  }

  return { body: nextBody, httpSendCounts };
}

export function applyHttpProjectionToPackedEntries(
  entries: readonly PackedToolResult[],
  httpSendCounts: readonly number[],
): PackedToolResult[] {
  return entries.map((entry, index) => ({
    ...entry,
    httpSendCount: httpSendCounts[index] ?? entry.httpSendCount,
  }));
}
