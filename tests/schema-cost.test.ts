/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { describe, expect, it } from "vitest";
import { extendToolInputWithThenRun } from "../src/action-fusion/then-run-schema.js";

/**
 * The model reads every `then_run` description on every provider request, so each
 * added byte is paid on every round-trip (see docs/quality-guard.md, issue #44).
 *
 * The expected byte counts keep that document honest: when a wording or keyword
 * change moves a number, update this table and the document in the same change.
 * The ceiling below is a separate guard on the request cost.
 */
const CEILING_BYTES = 600;

/** The shipped descriptions, copied from the tool wrapper so a change here fails loudly. */
const DESCRIPTION_BY_TOOL = {
  edit: {
    expectedAddedBytes: 480,
    description:
      "Command to run next on this file after the edit succeeds; optional timeout in seconds. Skipped if the edit fails.",
  },
  write: {
    expectedAddedBytes: 482,
    description:
      "Command to run next on this file after the write succeeds; optional timeout in seconds. Skipped if the write fails.",
  },
  patch: {
    expectedAddedBytes: 516,
    description:
      "Command to run after the patch succeeds on all written paths; optional timeout in seconds. Omitted from schema when patch paths cannot be enumerated.",
  },
} as const;

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
  for (const [tool, { description, expectedAddedBytes }] of Object.entries(DESCRIPTION_BY_TOOL)) {
    it(`declares ${tool}.then_run and keeps it inside its byte budget`, () => {
      const { schema, addedBytes } = extend(description);

      expect(schema.properties).toHaveProperty("then_run");
      // Fails when the description, the keywords, or the pattern grows: update this
      // table and docs/quality-guard.md together, or the model pays bytes nobody chose.
      expect(addedBytes).toBe(expectedAddedBytes);
      expect(addedBytes).toBeLessThanOrEqual(CEILING_BYTES);
    });
  }
});
