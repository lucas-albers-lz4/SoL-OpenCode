/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 *
 * CPU micro-benchmark for the placeholder path. It reports the cost of counting
 * lines and rendering a placeholder from a built payload; it says nothing about
 * provider context or round-trips, which the A/B protocol measures.
 *
 * Usage: npm run build && node benchmarks/placeholder-bench.mjs
 */

import { performance } from "node:perf_hooks";

const observation = await import("../dist/observation-pack/observation.js");

const MIB = 1024 * 1024;
const lines = [];
for (let index = 0; index < 90_000; index += 1) {
  lines.push(
    `2026-10-24T00:00:00Z INFO worker=${index % 17} step=${index} message=some-service-log-line-${index}`,
  );
}
let multiline = lines.join("\n");
while (Buffer.byteLength(multiline, "utf8") < 7 * MIB) multiline += `\n${lines[0]}`;
const singleLine = "A".repeat(7 * MIB);

function sample(text) {
  return {
    id: "obs_0123456789abcdef01234567",
    contentHash: "benchmark",
    filePath: "/tmp/object.txt",
    toolName: "bash",
    toolCallId: "call-bench",
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    lines: 1,
    tokens: Math.ceil(text.length / 4),
  };
}

function time(label, run, iterations) {
  for (let index = 0; index < 3; index += 1) run();
  const started = performance.now();
  for (let index = 0; index < iterations; index += 1) run();
  const perCall = (performance.now() - started) / iterations;
  console.log(`${label}\t${perCall.toFixed(3)} ms/call\t${iterations} iterations`);
}

console.log("== countLines, 7 MiB multi-line ==");
time("countLines", () => observation.countLines(multiline), 20);

console.log("== placeholderFor, prebuilt observations ==");
const multilineObservation = sample(multiline);
const singleLineObservation = sample(singleLine);
time("multi-line", () => observation.placeholderFor(multilineObservation), 20);
time("single-line", () => observation.placeholderFor(singleLineObservation), 10);

console.log("== placeholder output ==");
const rendered = observation.placeholderFor(multilineObservation);
console.log(`multi_line_lines\t${rendered.split("\n").length}`);
const singleRendered = observation.placeholderFor(singleLineObservation);
console.log(`single_line_head_bytes\t${Buffer.byteLength(singleRendered.split("\n")[10] ?? "", "utf8")}`);
console.log(`single_line_tail_bytes\t${Buffer.byteLength(singleRendered.split("\n")[12] ?? "", "utf8")}`);
