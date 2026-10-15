/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { readFileSync } from "node:fs";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { extendToolInputWithThenRun } from "../src/action-fusion/then-run-schema.js";
import { THEN_RUN_DESCRIPTION } from "../src/action-fusion/wrap-tools.js";

/**
 * The model reads every `then_run` description on every provider request, so each added byte is
 * paid on every round-trip (see docs/quality-guard.md, issue #44).
 *
 * The descriptions come from the shipped wrapper, and each schema family is measured through the
 * serialization the host uses for that family. The last case ties these numbers to the table in the
 * document: move a number and the document must move with it.
 */
const CEILING_BYTES = 700;

/**
 * Byte cost of one shipped description, per schema family. The JSON family uses an empty object
 * base. The Effect family uses a one-field struct base, because an empty struct base adds 38 bytes
 * of object boilerplate per tool that no real request pays for the description: an empty struct
 * serializes to `{"not":{"type":"null"}}`, while the extended document carries the full object
 * skeleton. The delta is stable across the non-empty bases measured here — one field and three
 * fields both read 534 / 536 / 570.
 */
const EXPECTED_ADDED_BYTES = {
  json: { edit: 480, write: 482, patch: 516 },
  effect: { edit: 534, write: 536, patch: 570 },
} satisfies Record<string, Record<keyof typeof THEN_RUN_DESCRIPTION, number>>;

type Family = keyof typeof EXPECTED_ADDED_BYTES;
type ToolId = keyof typeof THEN_RUN_DESCRIPTION;

/**
 * The serialization the host applies to a tool definition for which it has parameters:
 * `@opencode/ai` calls `emptyInputJsonSchema(parameters) ?? toJsonSchema(parameters)`, and
 * `toJsonSchema` runs `Schema.toJsonSchemaDocument` with `onExcessProperty: "error"` and merges
 * `$defs` when the document has definitions. A non-empty base takes that branch, which is why the
 * effect fixtures use one.
 */
function serializeEffect(schema: unknown): string {
  const document = Schema.toJsonSchemaDocument(schema as never, { onExcessProperty: "error" });
  return JSON.stringify(
    Object.keys(document.definitions).length === 0
      ? document.schema
      : { ...document.schema, $defs: document.definitions },
  );
}

const FAMILY_BASE: Record<Family, unknown> = {
  json: { type: "object", properties: {} },
  effect: Schema.Struct({ path: Schema.String }),
};

const FAMILY_SERIALIZER: Record<Family, (value: unknown) => string> = {
  json: (value) => JSON.stringify(value),
  effect: serializeEffect,
};

/** Extend one family's empty base with a shipped description. */
function extend(family: Family, description: string): unknown {
  return extendToolInputWithThenRun(FAMILY_BASE[family] as never, description);
}

function addedBytes(family: Family, description: string): number {
  const base = FAMILY_BASE[family];
  const extended = extend(family, description);
  const serialize = FAMILY_SERIALIZER[family];
  return Buffer.byteLength(serialize(extended)) - Buffer.byteLength(serialize(base));
}

describe("model-visible schema cost", () => {
  for (const family of Object.keys(EXPECTED_ADDED_BYTES) as Family[]) {
    for (const [tool, description] of Object.entries(THEN_RUN_DESCRIPTION)) {
      it(`keeps ${tool}.then_run inside its byte budget on the ${family} family`, () => {
        const cost = addedBytes(family, description);

        // Fails when the shipped description, the keywords, or the pattern grows: update this
        // table and docs/quality-guard.md together, or the model pays bytes nobody chose.
        expect(cost).toBe(EXPECTED_ADDED_BYTES[family][tool as ToolId]);
        expect(cost).toBeLessThanOrEqual(CEILING_BYTES);
      });
    }
  }

  it("declares then_run on both schema families", () => {
    for (const description of Object.values(THEN_RUN_DESCRIPTION)) {
      const json = extend("json", description) as { properties?: Record<string, unknown> };
      const effect = extend("effect", description) as { fields?: Record<string, unknown> };

      expect(json.properties).toHaveProperty("then_run");
      expect(effect.fields).toHaveProperty("then_run");
    }
  });

  it("keeps the byte table in docs/quality-guard.md equal to the shipped cost", () => {
    // The page and this file hold the same numbers. This assertion is the link: a change that
    // updates one and not the other fails here instead of drifting into a stale table.
    const page = readFileSync(new URL("../docs/quality-guard.md", import.meta.url), "utf8");

    for (const tool of Object.keys(THEN_RUN_DESCRIPTION) as ToolId[]) {
      const row = `| \`${tool}\` | ${String(EXPECTED_ADDED_BYTES.json[tool])} | ${String(EXPECTED_ADDED_BYTES.effect[tool])} |`;
      expect(page).toContain(row);
    }
  });
});
