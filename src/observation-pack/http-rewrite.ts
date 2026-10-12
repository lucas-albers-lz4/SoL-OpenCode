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
  readonly toolCallId?: string;
}

/**
 * Rewrite an outgoing provider HTTP body without touching stored session messages.
 * Increments send counts only when the archived text is present in the body.
 */
/** JSON-string contents of `value` (no surrounding quotes), for matching inside HTTP JSON bodies. */
export function jsonStringContents(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function archivedTextPresentInBody(body: string, text: string): boolean {
  if (body.includes(text)) return true;
  const jsonText = jsonStringContents(text);
  return jsonText.length > 0 && body.includes(jsonText);
}

function messageToolCallId(record: Record<string, unknown>): string | undefined {
  const id = record.tool_call_id ?? record.toolCallId;
  return typeof id === "string" ? id : undefined;
}

function replaceTextInMessageRecord(
  record: Record<string, unknown>,
  text: string,
  placeholder: string,
): boolean {
  let changed = false;

  if (typeof record.content === "string" && record.content === text) {
    record.content = placeholder;
    changed = true;
  } else if (Array.isArray(record.content)) {
    for (const block of record.content) {
      if (typeof block !== "object" || block === null) continue;
      const part = block as Record<string, unknown>;
      if (part.type === "text" && part.text === text) {
        part.text = placeholder;
        changed = true;
      }
    }
  }

  return changed;
}

function shouldRewriteMessage(record: Record<string, unknown>, entry: HttpProjectionEntry): boolean {
  if (entry.toolCallId !== undefined) {
    return messageToolCallId(record) === entry.toolCallId;
  }
  const role = record.role;
  if (role !== undefined && role !== "tool") return false;
  return true;
}

function projectEntryInParsedJson(
  parsed: unknown,
  entry: HttpProjectionEntry,
): { readonly value: unknown; readonly changed: boolean } {
  if (typeof parsed !== "object" || parsed === null) {
    return { value: parsed, changed: false };
  }

  const root = parsed as Record<string, unknown>;
  const messages = root.messages;
  if (!Array.isArray(messages)) {
    return { value: parsed, changed: false };
  }

  const clone = structuredClone(parsed) as Record<string, unknown>;
  const clonedMessages = clone.messages;
  if (!Array.isArray(clonedMessages)) {
    return { value: parsed, changed: false };
  }

  let changed = false;
  for (const message of clonedMessages) {
    if (typeof message !== "object" || message === null) continue;
    const record = message as Record<string, unknown>;
    if (!shouldRewriteMessage(record, entry)) continue;
    if (replaceTextInMessageRecord(record, entry.text, entry.placeholder)) {
      changed = true;
    }
  }

  return changed ? { value: clone, changed: true } : { value: parsed, changed: false };
}

export function projectArchivedTextsInHttpBody(
  body: string,
  entries: readonly HttpProjectionEntry[],
): { readonly body: string; readonly httpSendCounts: readonly number[] } {
  let parsed: unknown;
  let isJson = true;
  try {
    parsed = JSON.parse(body);
  } catch {
    isJson = false;
  }

  const httpSendCounts: number[] = [];
  let nextBody = body;
  let nextParsed = parsed;

  for (const entry of entries) {
    let sendCount = entry.httpSendCount;
    const present = archivedTextPresentInBody(nextBody, entry.text);

    if (!present) {
      httpSendCounts.push(sendCount);
      continue;
    }

    sendCount += 1;
    if (sendCount > FULL_SENDS) {
      if (isJson) {
        const projected = projectEntryInParsedJson(nextParsed, entry);
        if (projected.changed) {
          nextParsed = projected.value;
          nextBody = JSON.stringify(nextParsed);
        }
      }
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
