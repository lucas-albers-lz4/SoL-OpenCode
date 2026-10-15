/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, lstat, mkdir, open } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Tool } from "@opencode/schema/tool";

/** Only tool results larger than this participate. */
export const THRESHOLD_BYTES = 10 * 1024;
/** Provider requests that still carry the full payload before the placeholder takes over. */
export const FULL_SENDS = 2;
/** Placeholder excerpt budget, split evenly between head and tail, whole lines only. */
export const PLACEHOLDER_EXCERPT_BYTES = 1024;

const CHARS_PER_TOKEN = 4;
const OBSERVATION_ID_PATTERN = /^obs_[a-f0-9]{24}$/u;
const READ_OBJECT_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW;
const CREATE_OBJECT_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW;

export interface Observation {
  readonly id: string;
  readonly contentHash: string;
  readonly filePath: string;
  readonly toolName: string;
  readonly toolCallId: string;
  readonly text: string;
  readonly bytes: number;
  readonly lines: number;
  readonly tokens: number;
}

export function hash(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = text.endsWith("\n") ? 0 : 1;
  for (const character of text) {
    if (character === "\n") lines += 1;
  }
  return lines;
}

function countBufferLines(buffer: Buffer): number {
  if (buffer.length === 0) return 0;
  let lines = buffer[buffer.length - 1] === 0x0a ? 0 : 1;
  for (const byte of buffer) {
    if (byte === 0x0a) lines += 1;
  }
  return lines;
}

export function isPureTextToolResult(result: Tool.Result): boolean {
  if (result.content === undefined) return false;
  if (typeof result.content === "string") {
    return result.content.length > 0;
  }
  if (!Array.isArray(result.content) || result.content.length === 0) return false;
  return result.content.every((block) => block.type === "text");
}

export function textFromToolResult(result: Tool.Result): string {
  if (typeof result.content === "string") return result.content;
  if (Array.isArray(result.content)) {
    return result.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n");
  }
  return "";
}

export function utf8ByteLength(text: string): number {
  return new TextEncoder().encode(text).length;
}

export function isObservationId(id: string): boolean {
  return OBSERVATION_ID_PATTERN.test(id);
}

export function createObservation(
  text: string,
  toolName: string,
  toolCallId: string,
  objectsRoot: string,
): Observation | undefined {
  const bytes = utf8ByteLength(text);
  if (bytes <= THRESHOLD_BYTES) return undefined;

  const contentHash = hash(text);
  const id = `obs_${hash(`${toolName}\0${toolCallId}\0${contentHash}`).slice(0, 24)}`;
  return {
    id,
    contentHash,
    filePath: join(objectsRoot, `${id}.txt`),
    toolName,
    toolCallId,
    text,
    bytes,
    lines: countLines(text),
    tokens: estimateTokens(text),
  };
}

export async function ensureStored(observation: Observation): Promise<void> {
  const directoryPath = dirname(observation.filePath);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(directoryPath);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(`Observation directory is not a regular directory for ${observation.id}`);
  }

  let handle: FileHandle | undefined;
  try {
    handle = await open(observation.filePath, CREATE_OBJECT_FLAGS, 0o600);
    await handle.writeFile(observation.text, { encoding: "utf8" });
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
    const existingHandle = await open(observation.filePath, READ_OBJECT_FLAGS);
    try {
      const existing = await existingHandle.stat();
      if (!existing.isFile()) {
        throw new Error(`Content-addressed observation is not a regular file for ${observation.id}`);
      }
      if (existing.size !== observation.bytes) {
        throw new Error(`Content-addressed observation size mismatch for ${observation.id}`);
      }
      const existingContent = await existingHandle.readFile();
      if (hash(existingContent) !== observation.contentHash) {
        throw new Error(`Content-addressed observation hash mismatch for ${observation.id}`);
      }
    } finally {
      await existingHandle.close();
    }
  } finally {
    await handle?.close();
  }
}

export async function readStoredObservation(path: string): Promise<string> {
  const handle = await open(path, READ_OBJECT_FLAGS);
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) throw new Error("Stored observation is not a regular file");
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

function completeLineExcerpt(text: string, budgetBytes: number, fromEnd: boolean): string {
  const lines = text.split(/(?<=\n)/);
  const selected: string[] = [];
  let selectedBytes = 0;
  let index = fromEnd ? lines.length - 1 : 0;

  while (index >= 0 && index < lines.length) {
    const line = lines[index];
    if (line === undefined) break;
    const lineBytes = utf8ByteLength(line);
    if (selectedBytes + lineBytes > budgetBytes) break;
    if (fromEnd) selected.unshift(line);
    else selected.push(line);
    selectedBytes += lineBytes;
    index += fromEnd ? -1 : 1;
  }

  return selected.join("");
}

export function placeholderFor(observation: Observation): string {
  const headBudget = Math.floor(PLACEHOLDER_EXCERPT_BYTES / 2);
  const tailBudget = PLACEHOLDER_EXCERPT_BYTES - headBudget;
  const head = completeLineExcerpt(observation.text, headBudget, false);
  const tail = completeLineExcerpt(observation.text, tailBudget, true);
  return [
    `[large tool result replaced after its first ${FULL_SENDS} provider requests]`,
    `id: ${observation.id}`,
    `tool_call_id: ${observation.toolCallId}`,
    `tool: ${observation.toolName}`,
    `original_bytes: ${observation.bytes}`,
    `original_lines: ${observation.lines}`,
    `estimated_tokens: ${observation.tokens}`,
    `archived: full text is retrievable from the local observation store (id "${observation.id}")`,
    `tool_call_id for recall context: ${observation.toolCallId}`,
    `[first complete lines, up to ${headBudget} bytes]`,
    head,
    `[middle omitted; last complete lines, up to ${tailBudget} bytes]`,
    tail,
    `[${observation.bytes} original bytes omitted]`,
  ].join("\n");
}

/**
 * One page of a stored observation.
 *
 * Offsets are bytes and `maxBytes` bounds a page. `startOffset` is snapped forward to the
 * first byte that can begin a character, and the page ends at the last character boundary
 * inside the window, so a page never splits a character that is complete in the file.
 *
 * Two shapes follow from paging by bytes:
 * - When no character fits the window, `text` is empty, `nextOffset` equals `startOffset`, and
 *   `eof` stays false. **Do not loop on `nextOffset` in that shape** — it does not advance. Raise
 *   `maxBytes` instead. A character wider than `maxBytes` produces this shape, and so does a run of
 *   `maxBytes` or more continuation bytes at the offset. The shipped caller passes 15,872 bytes
 *   (`RECALL_LIMITS`), so well-formed UTF-8 cannot reach it.
 * - Bytes that are not valid UTF-8 decode with replacement characters (U+FFFD). An object truncated
 *   inside a character ends that way, and the call still returns the page. A stored object is
 *   written from a JavaScript string, so this shape means the object is damaged.
 *
 * Upstream SoL-Pi pages by byte offset the same way, with the same end trim, and promises nothing
 * further about either shape.
 */
export interface RecallChunk {
  readonly text: string;
  readonly bytes: number;
  readonly lines: number;
  /** Byte offset this chunk actually starts at — always a character boundary. */
  readonly startOffset: number;
  readonly nextOffset: number;
  readonly eof: boolean;
}

function trimUtf8End(buffer: Buffer, limit: number): number {
  let end = limit;
  while (end > 0 && end < buffer.length && ((buffer[end] ?? 0) & 0xc0) === 0x80) end -= 1;
  return end;
}

/**
 * Snap a requested offset forward to the next UTF-8 lead byte (or ASCII byte), so a page does not
 * begin inside a multi-byte character: a page that starts inside one decodes as U+FFFD.
 *
 * This function reads only the bytes around the start. It does not validate the rest of the page,
 * so a damaged object can still carry a replacement character later in its text.
 *
 * Returns `size` when nothing but continuation bytes remain, which yields an empty page rather
 * than a partial character.
 */
async function utf8AlignedOffset(
  handle: FileHandle,
  offset: number,
  size: number,
): Promise<number> {
  if (offset === 0 || offset >= size) return offset;

  // A UTF-8 sequence is at most 4 bytes, so a lead byte is never further than 3
  // bytes ahead of a mid-character offset.
  const probeLength = Math.min(4, size - offset);
  const probe = Buffer.alloc(probeLength);
  await handle.read(probe, 0, probeLength, offset);
  for (let index = 0; index < probeLength; index += 1) {
    if (((probe[index] ?? 0) & 0xc0) !== 0x80) return offset + index;
  }
  return size;
}

export async function readRecallChunk(
  path: string,
  offset: number,
  limits: { readonly maxBytes: number; readonly maxLines: number },
): Promise<RecallChunk> {
  // The tool schema promises `integer, minimum 0`; enforce it here so an invented
  // offset (negative, fractional, NaN) fails as this clean error instead of leaking a
  // raw ERR_OUT_OF_RANGE from FileHandle.read.
  if (!Number.isInteger(offset) || offset < 0) {
    throw new Error(`Offset ${offset} must be an integer >= 0`);
  }

  const handle = await open(path, READ_OBJECT_FLAGS);
  try {
    const fileStats = await handle.stat();
    if (!fileStats.isFile()) throw new Error("Stored observation is not a regular file");
    if (offset > fileStats.size) throw new Error(`Offset ${offset} exceeds observation size ${fileStats.size}`);

    const start = await utf8AlignedOffset(handle, offset, fileStats.size);
    const available = Math.max(0, fileStats.size - start);
    const buffer = Buffer.alloc(Math.min(available, limits.maxBytes + 4));
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let end = Math.min(bytesRead, limits.maxBytes);
    let newlineCount = 0;

    for (let index = 0; index < end; index += 1) {
      if (buffer[index] !== 0x0a) continue;
      newlineCount += 1;
      if (newlineCount === limits.maxLines) {
        end = index + 1;
        break;
      }
    }

    end = trimUtf8End(buffer, end);
    const chunk = buffer.subarray(0, end);
    const nextOffset = start + chunk.length;
    return {
      text: chunk.toString("utf8"),
      bytes: chunk.length,
      lines: countBufferLines(chunk),
      startOffset: start,
      nextOffset,
      eof: nextOffset >= fileStats.size,
    };
  } finally {
    await handle.close();
  }
}
