/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { readRecallChunk } from "../src/observation-pack/observation.js";

const CHUNK_CAP = 400;

async function fixture(content: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "obs-recall-"));
  const path = join(dir, "object.txt");
  await writeFile(path, content, "utf8");
  return path;
}

async function walk(
  path: string,
  limits: { readonly maxBytes: number; readonly maxLines: number },
): Promise<{ readonly text: string; readonly chunks: number }> {
  let offset = 0;
  let text = "";
  let chunks = 0;
  for (;;) {
    const chunk = await readRecallChunk(path, offset, limits);
    expect(chunk.startOffset).toBe(offset);
    expect(chunk.text).not.toContain("\uFFFD");
    text += chunk.text;
    chunks += 1;
    expect(chunks).toBeLessThan(CHUNK_CAP);
    if (chunk.eof) break;
    expect(chunk.nextOffset).toBeGreaterThan(offset);
    offset = chunk.nextOffset;
  }
  return { text, chunks };
}

describe("readRecallChunk offsets", () => {
  it("rejects a negative, fractional or NaN offset with a clean error", async () => {
    const path = await fixture("héllo\n");

    for (const offset of [-5, -1, 1.5, Number.NaN]) {
      await expect(readRecallChunk(path, offset, { maxBytes: 4096, maxLines: 10 })).rejects.toThrow(
        /must be an integer >= 0/u,
      );
      await expect(
        readRecallChunk(path, offset, { maxBytes: 4096, maxLines: 10 }),
      ).rejects.not.toThrow(/ERR_OUT_OF_RANGE/u);
    }
  });

  it("never starts a chunk inside a multi-byte character", async () => {
    // "é" is two bytes, so offset 1 lands on its continuation byte.
    const path = await fixture("éclair\nplain\n");

    const chunk = await readRecallChunk(path, 1, { maxBytes: 4096, maxLines: 10 });

    expect(chunk.startOffset).toBe(2);
    expect(chunk.text).not.toContain("\uFFFD");
    expect(chunk.text.startsWith("clair")).toBe(true);
  });

  it("returns an empty chunk instead of mojibake for a trailing partial sequence", async () => {
    // A lone continuation byte as the whole tail: snapping forward has nowhere to go.
    const dir = await mkdtemp(join(tmpdir(), "obs-recall-partial-"));
    const path = join(dir, "object.bin");
    await writeFile(path, Buffer.from([0x61, 0x0a, 0xa9, 0xa9]), "utf8");

    const chunk = await readRecallChunk(path, 2, { maxBytes: 4096, maxLines: 10 });

    expect(chunk.text).toBe("");
    expect(chunk.nextOffset).toBe(4);
    expect(chunk.eof).toBe(true);
  });

  it("walks a line-bounded fixture so the concatenated chunks are byte-identical", async () => {
    const content = "line one\nline two\nline three\nline four\n";
    const path = await fixture(content);

    const { text, chunks } = await walk(path, { maxBytes: 10, maxLines: 2 });

    expect(text).toBe(content);
    expect(chunks).toBeGreaterThan(1);
  });

  it("walks a multi-byte fixture byte-identically across many chunks", async () => {
    const line = `${"é".repeat(40)}\n`; // 81 bytes per line
    const content = line.repeat(1200); // ~97 KiB of two-byte characters
    const path = await fixture(content);

    const { text, chunks } = await walk(path, { maxBytes: 4096, maxLines: 7 });

    expect(text).toBe(content);
    expect(chunks).toBeGreaterThan(10);
  });
});
