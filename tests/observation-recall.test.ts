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

  it("snaps forward across a four-byte character", async () => {
    // "a😀b\n": byte 0 is "a", bytes 1-4 are the astral character, byte 5 is "b". Offset 1
    // is its lead byte, so only the continuation bytes 2-4 may move the start forward.
    const path = await fixture("a😀b\n");

    const atLeadByte = await readRecallChunk(path, 1, { maxBytes: 4096, maxLines: 10 });
    expect(atLeadByte.startOffset).toBe(1);
    expect(atLeadByte.text).toBe("😀b\n");

    for (const offset of [2, 3, 4]) {
      const chunk = await readRecallChunk(path, offset, { maxBytes: 4096, maxLines: 10 });

      expect(chunk.startOffset).toBe(5);
      expect(chunk.text).toBe("b\n");
      expect(chunk.text).not.toContain("\uFFFD");
    }
  });

  it("trims the tail instead of splitting a character when maxBytes binds", async () => {
    // 3-byte characters and a byte budget that cannot land on a boundary: 33 fit, the 34th
    // is cut in half and must be dropped rather than decoded as mojibake.
    const content = "€".repeat(4000);
    const path = await fixture(content);

    const chunk = await readRecallChunk(path, 0, { maxBytes: 100, maxLines: 1000 });

    expect(chunk.text).not.toContain("\uFFFD");
    expect(content.startsWith(chunk.text)).toBe(true);
    expect(chunk.text.length % 3).toBe(0);

    const next = await readRecallChunk(path, chunk.nextOffset, { maxBytes: 100, maxLines: 1000 });
    expect(content.startsWith(chunk.text + next.text)).toBe(true);
  });

  it("walks a byte-bounded multibyte fixture without emitting a replacement character", async () => {
    const line = `${"é".repeat(39)}\n`; // 79 bytes: an odd budget cuts inside the next line
    const content = line.repeat(200);
    const path = await fixture(content);

    const { text, chunks } = await walk(path, { maxBytes: 100, maxLines: 7 });

    expect(text).toBe(content);
    expect(chunks).toBeGreaterThan(10);
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

  it("returns an empty page when the cap cannot hold the character at the offset", async () => {
    // Paging is by bytes, as upstream SoL-Pi pages. A cap smaller than the character at the
    // offset cannot hold a page, so the page is empty and the cursor does not advance. The
    // shipped caller passes 15,872 bytes, which makes this unreachable in normal use: the
    // test pins it so that a change to it is a decision, and the interface comment names it
    // as the shape a caller must not loop on.
    const path = await fixture("😀😀😀");

    const chunk = await readRecallChunk(path, 0, { maxBytes: 3, maxLines: 10 });

    expect(chunk).toMatchObject({ text: "", bytes: 0, startOffset: 0, nextOffset: 0, eof: false });
  });

  it("decodes a damaged tail with a replacement character", async () => {
    // An object truncated inside a character is damage, and its bytes still decode: the
    // page carries a replacement character, exactly as upstream decodes it. A stored
    // object is written from a JavaScript string, so this shape cannot come from the store.
    const dir = await mkdtemp(join(tmpdir(), "obs-recall-damaged-tail-"));
    const path = join(dir, "object.bin");
    await writeFile(path, Buffer.from([0x61, 0x62, 0xf0, 0x9f, 0x92]));

    const chunk = await readRecallChunk(path, 0, { maxBytes: 15872, maxLines: 398 });

    expect(chunk.text).toBe("ab\uFFFD");
    expect(chunk.bytes).toBe(5);
    expect(chunk.eof).toBe(true);
  });
});
