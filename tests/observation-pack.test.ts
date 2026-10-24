/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { isArchivableCompletedToolResult } from "../src/observation-pack/archive-gate.js";
import { projectArchivedTextsInHttpBody } from "../src/observation-pack/http-rewrite.js";
import {
  countLines,
  createObservation,
  FULL_SENDS,
  placeholderFor,
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

    const toolCallId = "call-basic";
    let body = JSON.stringify({
      messages: [{ role: "tool", tool_call_id: toolCallId, content: blob }],
    });
    let sendCount = 0;

    for (let request = 1; request <= FULL_SENDS + 1; request += 1) {
      const { body: nextBody, httpSendCounts } = projectArchivedTextsInHttpBody(body, [
        { text: blob, placeholder: PLACEHOLDER, httpSendCount: sendCount, toolCallId },
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
    const toolCallId = "call-newline";
    let body = JSON.stringify({
      messages: [{ role: "tool", tool_call_id: toolCallId, content: blob }],
    });
    let sendCount = 0;

    for (let request = 1; request <= FULL_SENDS + 1; request += 1) {
      const projected = projectArchivedTextsInHttpBody(body, [
        { text: blob, placeholder, httpSendCount: sendCount, toolCallId },
      ]);
      sendCount = projected.httpSendCounts[0] ?? sendCount;
      body = projected.body;
    }

    expect(JSON.parse(body).messages[0].content).toBe(placeholder);
  });

  it("projects a single-line blob using the real multiline placeholder without breaking JSON", () => {
    const blob = "A".repeat(10241);
    const toolCallId = "call-single-line";
    const observation = createObservation(blob, "bash", toolCallId, "/tmp/objects")!;
    const placeholder = placeholderFor(observation);
    expect(placeholder).toContain("\n");
    expect(placeholder).toContain('"');

    let body = JSON.stringify({
      messages: [{ role: "tool", tool_call_id: toolCallId, content: blob }],
    });
    let sendCount = 0;

    for (let request = 1; request <= FULL_SENDS + 1; request += 1) {
      const projected = projectArchivedTextsInHttpBody(body, [
        { text: blob, placeholder, httpSendCount: sendCount, toolCallId },
      ]);
      sendCount = projected.httpSendCounts[0] ?? sendCount;
      body = projected.body;
    }

    const parsed = JSON.parse(body) as { messages: Array<{ content: string }> };
    expect(parsed.messages[0]?.content).toBe(placeholder);
    expect(body).not.toContain(blob);
  });

  it("uses neutral availability wording in the placeholder (issue #26; measured in #27)", () => {
    const blob = "A".repeat(10241);
    const observation = createObservation(blob, "bash", "call-wording", "/tmp/objects")!;
    const placeholder = placeholderFor(observation);
    // Neutral, non-imperative availability line — an instruction to call
    // obs_recall measurably inflates agent round-trips (B1: +128%; nemotron
    // 3-arm docs: +22% rt / worse totals than the neutral arm).
    expect(placeholder).toContain('archived: full text is retrievable from the local observation store (id "');
    expect(placeholder).not.toMatch(/call obs_recall/i);
    // The quote guardrail (single-line JSON safety) depends on quoted values here.
    expect(placeholder).toContain('id "');
  });

  it("rewrites only the tool message when user and tool share the same archived text", () => {
    const blob = "A".repeat(10241);
    const toolCallId = "call-shared-text";
    const observation = createObservation(blob, "bash", toolCallId, "/tmp/objects")!;
    const placeholder = placeholderFor(observation);

    let body = JSON.stringify({
      messages: [
        { role: "user", content: blob },
        { role: "tool", tool_call_id: toolCallId, content: blob },
      ],
    });

    const projected = projectArchivedTextsInHttpBody(body, [
      { text: blob, placeholder, httpSendCount: FULL_SENDS, toolCallId },
    ]);

    const parsed = JSON.parse(projected.body) as {
      messages: Array<{ role: string; content: string }>;
    };
    expect(parsed.messages[0]?.content).toBe(blob);
    expect(parsed.messages[1]?.content).toBe(placeholder);
  });

  it("leaves non-JSON bodies unchanged and does not count them as provider sends", () => {
    const blob = MARKER + "D".repeat(10241);
    const placeholder = PLACEHOLDER;
    const original = `not-json prefix ${blob} suffix`;

    const projected = projectArchivedTextsInHttpBody(original, [
      { text: blob, placeholder, httpSendCount: FULL_SENDS },
    ]);

    expect(projected.body).toBe(original);
    expect(projected.httpSendCounts[0]).toBe(FULL_SENDS);
  });

  it("projects an Anthropic tool_result nested in a user message", () => {
    const blob = "C".repeat(10241);
    const toolCallId = "toolu-anthropic";
    const observation = createObservation(blob, "bash", toolCallId, "/tmp/objects")!;
    const placeholder = placeholderFor(observation);
    let body = JSON.stringify({
      messages: [
        {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: toolCallId, content: blob }],
        },
      ],
    });

    for (let request = 1; request <= FULL_SENDS + 1; request += 1) {
      const projected = projectArchivedTextsInHttpBody(body, [
        { text: blob, placeholder, httpSendCount: request - 1, toolCallId },
      ]);
      body = projected.body;
    }

    const parsed = JSON.parse(body) as {
      messages: Array<{ content: Array<{ type: string; content: string }> }>;
    };
    expect(parsed.messages[0]?.content[0]?.content).toBe(placeholder);
    expect(body).not.toContain(blob);
  });

  it("does not count matching user text when the archived tool result is absent", () => {
    const blob = "U".repeat(10241);
    const body = JSON.stringify({ messages: [{ role: "user", content: blob }] });

    const projected = projectArchivedTextsInHttpBody(body, [
      {
        text: blob,
        placeholder: PLACEHOLDER,
        httpSendCount: 1,
        toolCallId: "call-not-in-this-request",
      },
    ]);

    expect(projected.body).toBe(body);
    expect(projected.httpSendCounts[0]).toBe(1);
  });
});

describe("placeholder excerpts", () => {
  it("excerpts a payload whose only line is longer than the excerpt budget", () => {
    // One line: minified JSON, `jq -c` output, a curl body. Splitting on
    // complete lines used to keep nothing, so the placeholder showed two empty
    // excerpts and the model lost both ends of the payload.
    const body = `HEAD-MARKER${"-pad".repeat(5_000)}TAIL-MARKER`;
    const observation = createObservation(body, "bash", "call-one-line", "/tmp/objects")!;
    const lines = placeholderFor(observation).split("\n");

    expect(lines[9]).toBe("[no complete line fits; first 512 bytes]");
    expect(lines[10]).toContain("HEAD-MARKER");
    expect(Buffer.byteLength(lines[10] ?? "", "utf8")).toBe(512);
    expect(lines[11]).toBe("[middle omitted; no complete line fits; last 512 bytes]");
    expect(lines[12]).toContain("TAIL-MARKER");
    expect(Buffer.byteLength(lines[12] ?? "", "utf8")).toBe(512);
  });

  it("cuts a line-less excerpt on a UTF-8 boundary", () => {
    const body = "☾".repeat(20_000);
    const observation = createObservation(body, "bash", "call-clef", "/tmp/objects")!;
    const lines = placeholderFor(observation).split("\n");

    for (const excerpt of [lines[10] ?? "", lines[12] ?? ""]) {
      expect(excerpt.length).toBeGreaterThan(0);
      expect(excerpt).not.toContain("�");
      expect(Buffer.byteLength(excerpt, "utf8")).toBeLessThanOrEqual(512);
      expect(excerpt).toBe("☾".repeat(excerpt.length));
    }
  });

  it("keeps whole lines and byte-identical output for a multi-line payload", () => {
    const text = `line-1\nline-2\nline-3\n${"x".repeat(10_240)}\nlast-1\nlast-2\n`;
    const observation = createObservation(text, "bash", "call-multi", "/tmp/objects")!;
    const placeholder = placeholderFor(observation);

    const headLabel = "[first complete lines, up to 512 bytes]\n";
    const tailLabel = "[middle omitted; last complete lines, up to 512 bytes]\n";
    const headStart = placeholder.indexOf(headLabel) + headLabel.length;
    const headEnd = placeholder.indexOf(`\n${tailLabel}`);
    const head = placeholder.slice(headStart, headEnd);
    const tailStart = placeholder.indexOf(tailLabel) + tailLabel.length;
    const tailEnd = placeholder.indexOf("\n[", tailStart);
    const tail = placeholder.slice(tailStart, tailEnd);

    expect(head).toBe("line-1\nline-2\nline-3\n");
    expect(tail).toBe("last-1\nlast-2\n");
    expect(placeholder).toContain(`original_lines: ${countLines(text)}`);
  });

  it("counts astral characters and newlines the same way as a code-point scan", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\n")).toBe(1);
    expect(countLines("a\nb")).toBe(2);
    expect(countLines("𝄞\n𝄞\n")).toBe(2);
    expect(countLines("𝄞".repeat(100))).toBe(1);
  });
});
