/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import type { StorageDomain } from "../deps/opencode-plugin-types.js";

/** Ledger pointers only; observation bytes live in the object file. */
export interface PackedToolResult {
  readonly toolCallId: string;
  readonly obsId: string;
  readonly toolName: string;
  readonly contentHash: string;
  readonly bytes: number;
  readonly httpSendCount: number;
}

export const SESSION_INDEX_KEY_PREFIX = "sol.opencode/observation-pack/v1/";

export function sessionIndexKey(sessionID: string): string {
  return `${SESSION_INDEX_KEY_PREFIX}${sessionID}`;
}

function isPackedEntry(value: unknown): value is PackedToolResult {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.toolCallId === "string" &&
    typeof record.obsId === "string" &&
    typeof record.toolName === "string" &&
    typeof record.contentHash === "string" &&
    typeof record.bytes === "number" &&
    typeof record.httpSendCount === "number"
  );
}

export async function loadSessionIndex(
  storage: StorageDomain,
  sessionID: string,
): Promise<PackedToolResult[]> {
  const raw = await storage.get(sessionIndexKey(sessionID));
  if (!Array.isArray(raw)) return [];
  return raw.filter(isPackedEntry);
}

export async function saveSessionIndex(
  storage: StorageDomain,
  sessionID: string,
  entries: readonly PackedToolResult[],
): Promise<void> {
  await storage.set(sessionIndexKey(sessionID), entries as unknown as Parameters<StorageDomain["set"]>[1]);
}
