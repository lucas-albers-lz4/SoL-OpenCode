/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { THEN_RUN_DESCRIPTION } from "../src/action-fusion/wrap-tools.js";
import { extendToolInputWithThenRun } from "../src/action-fusion/then-run-schema.js";

/**
 * The model reads every `then_run` description on every provider request, so each
 * added byte is paid on every round-trip (see docs/quality-guard.md, issue #44).
 *
 * The descriptions come from the shipped wrapper, so a wording or keyword change
 * fails here rather than in review. When a number moves, update this table and the
 * document in the same change. The ceiling is a separate guard on the request cost.
 */
const CEILING_BYTES = 600;

/** Byte cost of the shipped description for each tool, measured with `extend` below. */
const EXPECTED_ADDED_BYTES: Record<keyof typeof THEN_RUN_DESCRIPTION, number> = {
  edit: 480,
  write: 482,
  patch: 516,
};

function extend(description: string): {
  readonly schema: Record<string, unknown>;
  readonly addedBytes: number;
} {
  const base = { type: "object", properties: {} };
  const schema = extendToolInputWithThenRun(base, description) as unknown as Record<string, unknown>;
  return {
    schema,
    addedBytes: Buffer.byteLength(JSON.stringify(schema)) - Buffer.byteLength(JSON.stringify(base)),
  };
}

describe("model-visible schema cost", () => {
  for (const [tool, description] of Object.entries(THEN_RUN_DESCRIPTION)) {
    it(`declares ${tool}.then_run and keeps it inside its byte budget`, () => {
      const { schema, addedBytes } = extend(description);

      expect(schema.properties).toHaveProperty("then_run");
      // Fails when the shipped description, the keywords, or the pattern grows: update
      // this table and docs/quality-guard.md together, or the model pays bytes nobody chose.
      expect(addedBytes).toBe(EXPECTED_ADDED_BYTES[tool as keyof typeof THEN_RUN_DESCRIPTION]);
      expect(addedBytes).toBeLessThanOrEqual(CEILING_BYTES);
    });
  }
});
