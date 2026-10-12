/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { isArchivableCompletedToolResult } from "../src/observation-pack/archive-gate.js";
import { projectArchivedTextsInHttpBody } from "../src/observation-pack/http-rewrite.js";
import {
  createObservation,
  FULL_SENDS,
  THRESHOLD_BYTES,
  utf8ByteLength,
} from "../src/observation-pack/observation.js";

const MARKER = "SOL_OPENCODE_PACK_MARKER ";
const PLACEHOLDER = "[sol.opencode:packed placeholder]";

function repeatToBytes(targetBytes: number, unit: string): string {
  let text = unit;
  while (utf8ByteLength(text) <= targetBytes) {
    text += unit;
  }
  return text.slice(0, targetBytes);
}

describe("observation pack thresholds", () => {
  it("does not pack at exactly 10 KiB and packs at 10 KiB + 1", () => {
    const exact = repeatToBytes(THRESHOLD_BYTES, "a");
    expect(utf8ByteLength(exact)).toBe(THRESHOLD_BYTES);
    expect(createObservation(exact, "bash", "call-1", "/tmp/objects")).toBeUndefined();

    const over = repeatToBytes(THRESHOLD_BYTES + 1, "b");
    expect(utf8ByteLength(over)).toBe(THRESHOLD_BYTES + 1);
    expect(createObservation(over, "bash", "call-1", "/tmp/objects")).toBeDefined();
  });

  it("does not re-pack obs_recall output larger than 10 KiB", () => {
    const large = repeatToBytes(THRESHOLD_BYTES + 500, "recall-line\n");
    const result = { content: large };
    expect(
      isArchivableCompletedToolResult({
        tool: "obs_recall",
        status: "completed",
        id: "call-recall",
        result,
      }),
    ).toBe(false);
    expect(
      isArchivableCompletedToolResult({
        tool: "bash",
        status: "completed",
        id: "call-bash",
        result,
      }),
    ).toBe(true);
  });
});

describe("projectArchivedTextsInHttpBody", () => {
  it("keeps marker through FULL_SENDS then swaps placeholder without mutating stored messages", () => {
    const blob = MARKER + "A".repeat(10241);
    const storedMessages = [{ role: "tool", content: [{ type: "text", text: blob }] }];
    const cloneBefore = structuredClone(storedMessages);

    let body = JSON.stringify({ messages: [{ content: blob }] });
    let sendCount = 0;

    for (let request = 1; request <= FULL_SENDS + 1; request += 1) {
      const { body: nextBody, httpSendCounts } = projectArchivedTextsInHttpBody(body, [
        { text: blob, placeholder: PLACEHOLDER, httpSendCount: sendCount },
      ]);
      sendCount = httpSendCounts[0] ?? sendCount;
      body = nextBody;
      if (request <= FULL_SENDS) {
        expect(body).toContain(MARKER);
        expect(body).not.toContain(PLACEHOLDER);
      }
    }

    expect(body).not.toContain(MARKER);
    expect(body).toContain(PLACEHOLDER);
    expect(storedMessages).toEqual(cloneBefore);
  });

  it("matches JSON-escaped newlines in the provider body", () => {
    const blob = `${MARKER}\n${"B".repeat(10241)}`;
    const placeholder = "[packed-with-newline]";
    let body = JSON.stringify({ messages: [{ content: blob }] });
    let sendCount = 0;

    for (let request = 1; request <= FULL_SENDS + 1; request += 1) {
      const projected = projectArchivedTextsInHttpBody(body, [
        { text: blob, placeholder, httpSendCount: sendCount },
      ]);
      sendCount = projected.httpSendCounts[0] ?? sendCount;
      body = projected.body;
    }

    expect(JSON.parse(body).messages[0].content).toBe(placeholder);
  });
});
