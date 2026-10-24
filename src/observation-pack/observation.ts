/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { createHash, randomUUID } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { type FileHandle, link, lstat, mkdir, open, unlink } from "node:fs/promises";
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
// `O_NOFOLLOW` is absent on Windows. Node ORs an undefined flag to 0, which
// silently drops the symlink guard, so name the fallback instead of hiding it.
const NO_FOLLOW_FLAG = typeof constants.O_NOFOLLOW === "number" ? constants.O_NOFOLLOW : 0;
const READ_OBJECT_FLAGS = constants.O_RDONLY | NO_FOLLOW_FLAG;
const CREATE_OBJECT_FLAGS = constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW_FLAG;

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
  // Indexed, not `for..of`: this walks whole payloads on every projection, and
  // the code-point iterator costs several times more for the same answer.
  for (let index = 0; index < text.length; index += 1) {
    if (text.charCodeAt(index) === 10) lines += 1;
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

/**
 * Confirm that the handle and the pathname name the same regular file.
 *
 * `O_NOFOLLOW` is not available on every platform, and it protects the final
 * component only. Comparing `dev`/`ino` after the open catches a pathname that
 * was swapped for a link (or another file) while the open was in flight.
 */
async function verifyOpenedObject(handle: FileHandle, path: string, label: string): Promise<Stats> {
  const handleStats = await handle.stat();
  if (!handleStats.isFile()) {
    throw new Error(`Content-addressed observation is not a regular file for ${label}`);
  }
  const pathStats = await lstat(path);
  if (pathStats.isSymbolicLink()) {
    throw new Error(`Observation path is a symbolic link for ${label}`);
  }
  if (pathStats.dev !== handleStats.dev || pathStats.ino !== handleStats.ino) {
    throw new Error(`Observation path changed while open for ${label}`);
  }
  return handleStats;
}

async function verifyExistingObservation(observation: Observation): Promise<void> {
  const existingHandle = await open(observation.filePath, READ_OBJECT_FLAGS);
  try {
    const existing = await verifyOpenedObject(existingHandle, observation.filePath, observation.id);
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
}

export async function ensureStored(observation: Observation): Promise<void> {
  const directoryPath = dirname(observation.filePath);
  await mkdir(directoryPath, { recursive: true, mode: 0o700 });
  const directoryStats = await lstat(directoryPath);
  if (!directoryStats.isDirectory() || directoryStats.isSymbolicLink()) {
    throw new Error(`Observation directory is not a regular directory for ${observation.id}`);
  }

  // Publish through a temporary file and a hard link. A direct write into the
  // content-addressed name leaves a truncated object behind when the write
  // fails, and every later read then serves or rejects that partial file.
  const temporaryPath = join(directoryPath, `.${observation.id}.${process.pid}.${randomUUID()}.tmp`);
  let published = false;
  try {
    const temporaryHandle = await open(temporaryPath, CREATE_OBJECT_FLAGS, 0o600);
    try {
      await temporaryHandle.writeFile(observation.text, { encoding: "utf8" });
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
    }
    await link(temporaryPath, observation.filePath);
    published = true;
  } catch (error) {
    if (!(error instanceof Error) || !("code" in error) || error.code !== "EEXIST") throw error;
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }

  if (!published) await verifyExistingObservation(observation);
}

export async function readStoredObservation(path: string, expectedBytes?: number): Promise<string> {
  const handle = await open(path, READ_OBJECT_FLAGS);
  try {
    const stats = await verifyOpenedObject(handle, path, path);
    if (expectedBytes !== undefined && stats.size !== expectedBytes) {
      throw new Error(`Stored observation size mismatch for ${path}`);
    }
    return await handle.readFile("utf8");
  } finally {
    await handle.close();
  }
}

/**
 * Whole lines from one end of the payload, within a byte budget.
 *
 * Walks line breaks from the chosen end instead of splitting the payload:
 * splitting allocates one string per line of a multi-megabyte observation on
 * every projection, to keep at most a few hundred bytes of it.
 */
function completeLineExcerpt(text: string, budgetBytes: number, fromEnd: boolean): string {
  let selectedBytes = 0;

  if (fromEnd) {
    let start = text.length;
    while (start > 0) {
      const previousBreak = start >= 2 ? text.lastIndexOf("\n", start - 2) : -1;
      const lineStart = previousBreak + 1;
      const lineBytes = Buffer.byteLength(text.slice(lineStart, start), "utf8");
      if (selectedBytes + lineBytes > budgetBytes) break;
      selectedBytes += lineBytes;
      start = lineStart;
    }
    return text.slice(start);
  }

  let end = 0;
  while (end < text.length) {
    const nextBreak = text.indexOf("\n", end);
    const lineEnd = nextBreak < 0 ? text.length : nextBreak + 1;
    const lineBytes = Buffer.byteLength(text.slice(end, lineEnd), "utf8");
    if (selectedBytes + lineBytes > budgetBytes) break;
    selectedBytes += lineBytes;
    end = lineEnd;
  }
  return text.slice(0, end);
}

/**
 * Take whole code points up to a byte budget, from either end.
 *
 * Used when the payload has no line short enough to excerpt: one long line of
 * minified JSON, a `jq -c` result, a `curl` body. Cutting on a UTF-8 boundary
 * keeps the excerpt from ending in a replacement character.
 */
function byteBoundedExcerpt(text: string, budgetBytes: number, fromEnd: boolean): string {
  // One code point is at least one byte, so this window is a superset of the
  // characters that can fit the budget.
  const characters = [...(fromEnd ? text.slice(-budgetBytes) : text.slice(0, budgetBytes))];
  const selected: string[] = [];
  let selectedBytes = 0;

  for (let index = 0; index < characters.length; index += 1) {
    const character = characters[fromEnd ? characters.length - 1 - index : index];
    if (character === undefined) break;
    const characterBytes = Buffer.byteLength(character, "utf8");
    if (selectedBytes + characterBytes > budgetBytes) break;
    if (fromEnd) selected.unshift(character);
    else selected.push(character);
    selectedBytes += characterBytes;
  }

  return selected.join("");
}

interface PlaceholderExcerpt {
  readonly text: string;
  readonly wholeLines: boolean;
}

function placeholderExcerpt(text: string, budgetBytes: number, fromEnd: boolean): PlaceholderExcerpt {
  const lines = completeLineExcerpt(text, budgetBytes, fromEnd);
  if (lines.length > 0) return { text: lines, wholeLines: true };
  return { text: byteBoundedExcerpt(text, budgetBytes, fromEnd), wholeLines: false };
}

export function placeholderFor(observation: Observation): string {
  const headBudget = Math.floor(PLACEHOLDER_EXCERPT_BYTES / 2);
  const tailBudget = PLACEHOLDER_EXCERPT_BYTES - headBudget;
  const head = placeholderExcerpt(observation.text, headBudget, false);
  const tail = placeholderExcerpt(observation.text, tailBudget, true);
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
    head.wholeLines
      ? `[first complete lines, up to ${headBudget} bytes]`
      : `[no complete line fits; first ${headBudget} bytes]`,
    head.text,
    tail.wholeLines
      ? `[middle omitted; last complete lines, up to ${tailBudget} bytes]`
      : `[middle omitted; no complete line fits; last ${tailBudget} bytes]`,
    tail.text,
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
 * - When no character fits the window, `text` is empty and `nextOffset` equals `startOffset`.
 *   **Do not loop on `nextOffset` in that shape** — it does not advance. Raise `maxBytes` instead.
 *   A character wider than `maxBytes` produces this shape, and so does a run of `maxBytes` or more
 *   continuation bytes at the offset. `eof` is false while bytes remain after the empty page, and
 *   true when the snap reached the end of the file. The shipped caller passes 15,872 bytes
 *   (`RECALL_LIMITS`), so well-formed UTF-8 cannot reach it.
 * - Bytes that are not valid UTF-8 decode with replacement characters (U+FFFD). An object truncated
 *   inside a character ends that way, and the call still returns the page. A stored object is
 *   written from a JavaScript string, so this shape means the object is damaged.
 *
 * Upstream SoL-Pi pages by byte offset the same way and trims the end with the same walk-back, and
 * it promises nothing further about either shape. The start snap is this port's own: upstream starts
 * at the offset it is given, and can therefore begin inside a character.
 */
export interface RecallChunk {
  readonly text: string;
  readonly bytes: number;
  readonly lines: number;
  /** Byte offset this page starts at: a character boundary for every object the store writes. */
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
