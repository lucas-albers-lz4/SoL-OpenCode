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
}

/**
 * Rewrite an outgoing provider HTTP body without touching stored session messages.
 * Increments send counts only when the archived text is present in the body.
 */
/** JSON-string contents of `value` (no surrounding quotes), for matching inside HTTP JSON bodies. */
export function jsonStringContents(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

export function projectArchivedTextsInHttpBody(
  body: string,
  entries: readonly HttpProjectionEntry[],
): { readonly body: string; readonly httpSendCounts: readonly number[] } {
  const httpSendCounts: number[] = [];
  let nextBody = body;

  for (const entry of entries) {
    let sendCount = entry.httpSendCount;
    const jsonText = jsonStringContents(entry.text);
    const inRaw = nextBody.includes(entry.text);
    const inJson = !inRaw && jsonText.length > 0 && nextBody.includes(jsonText);
    if (!inRaw && !inJson) {
      httpSendCounts.push(sendCount);
      continue;
    }

    sendCount += 1;
    if (sendCount > FULL_SENDS) {
      if (inRaw) {
        nextBody = nextBody.replaceAll(entry.text, entry.placeholder);
      } else {
        nextBody = nextBody.replaceAll(jsonText, jsonStringContents(entry.placeholder));
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
