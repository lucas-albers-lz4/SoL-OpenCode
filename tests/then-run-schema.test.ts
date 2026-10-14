/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { Tool } from "@opencode/schema/tool";
import { extendToolInputWithThenRun } from "../src/action-fusion/then-run-schema.js";

describe("extendToolInputWithThenRun Effect schemas", () => {
  it("adds optional then_run to Schema.Struct without returning the same object", () => {
    const input = Schema.Struct({ path: Schema.String });
    const extended = extendToolInputWithThenRun(
      input,
      "Command to run next on this file after the write succeeds",
    );

    expect(extended).not.toBe(input);
    expect(Schema.isSchema(extended)).toBe(true);
    const struct = extended as Schema.Struct<Schema.Struct.Fields>;
    expect(struct.fields).toHaveProperty("then_run");
    expect(input.fields).not.toHaveProperty("then_run");

    const decode = Schema.decodeUnknownSync(struct);
    expect(decode({ path: "a.txt" })).toEqual({ path: "a.txt" });
    expect(decode({ path: "a.txt", then_run: { command: "echo hi", timeout: 12 } })).toEqual({
      path: "a.txt",
      then_run: { command: "echo hi", timeout: 12 },
    });
  });

  it("does not nest then_run when the struct is already extended", () => {
    const input = Schema.Struct({ path: Schema.String });
    const once = extendToolInputWithThenRun(input, "once");
    const twice = extendToolInputWithThenRun(once, "twice");
    expect(twice).toBe(once);
  });
});

describe("extendToolInputWithThenRun JSON Schema", () => {
  it("still copies object schemas and adds then_run", () => {
    const nested = { path: { type: "string" as const } };
    const input = { type: "object" as const, properties: nested };
    const extended = extendToolInputWithThenRun(input, "json path");
    expect(extended).not.toBe(input);
    expect(extended).toHaveProperty("properties.then_run");
    expect(nested).not.toHaveProperty("then_run");
  });

  it("does not throw on a schema carrying a function (shallow copy, issue #43)", () => {
    const validate = () => true;
    const input = {
      type: "object" as const,
      properties: {},
      validate,
    } as unknown as Tool.ValueSchema;

    const extended = extendToolInputWithThenRun(input, "json fn") as unknown as {
      validate?: () => boolean;
    };

    expect(extended).toHaveProperty("properties.then_run");
    expect(extended.validate).toBe(validate);
  });

  it("returns the input unchanged when the schema already declares then_run (issue #42)", () => {
    const declared = { type: "string" as const, description: "host-owned" };
    const input = {
      type: "object" as const,
      properties: { then_run: declared },
    } as unknown as Tool.ValueSchema;

    expect(extendToolInputWithThenRun(input, "fused")).toBe(input);
  });

  it("is idempotent for JSON object schemas", () => {
    const input = {
      type: "object" as const,
      properties: { path: { type: "string" as const } },
    } as unknown as Tool.ValueSchema;

    const once = extendToolInputWithThenRun(input, "once");
    expect(extendToolInputWithThenRun(once, "twice")).toBe(once);
  });

  it("tolerates a null or non-object properties value", () => {
    for (const properties of [null, "oops"]) {
      const input = { type: "object" as const, properties } as unknown as Tool.ValueSchema;
      const extended = extendToolInputWithThenRun(input, "fused") as unknown as {
        properties: Record<string, unknown>;
      };

      expect(extended).toHaveProperty("properties.then_run");
    }
  });

  it("logs why then_run is unavailable for an unsupported family (issue #41 item 7)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const union = Schema.Union([
        Schema.Struct({ a: Schema.String }),
        Schema.Struct({ b: Schema.String }),
      ]);
      const suspended = Schema.suspend(() => Schema.Struct({ c: Schema.String }));

      for (const schema of [union, suspended]) {
        expect(extendToolInputWithThenRun(schema, "fused")).toBe(schema);
      }

      const warnings = warn.mock.calls.flat().join(" ");
      expect(warnings).toContain("then_run unavailable");
      expect(warnings).toContain("effect-schema");
    } finally {
      // A failing assertion must not leave console.warn stubbed for the rest of the file.
      warn.mockRestore();
    }
  });

  it("names the standard-schema and primitive families as well (issue #41 item 7)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);

    try {
      const standardSchema = { "~standard": { version: 1, validate: () => ({ value: undefined }) } };
      const primitive = "just-a-string";

      expect(extendToolInputWithThenRun(standardSchema as never, "fused")).toBe(standardSchema);
      expect(extendToolInputWithThenRun(primitive as never, "fused")).toBe(primitive);
      expect(extendToolInputWithThenRun(null as never, "fused")).toBeNull();

      const warnings = warn.mock.calls.flat().join(" ");
      expect(warnings).toContain("standard-schema");
      expect(warnings).toContain("string");
      expect(warnings).toContain("family (null)");
      // A bare "object" label was the finding: it named neither family.
      expect(warnings).not.toContain("family (object)");
    } finally {
      warn.mockRestore();
    }
  });

  it("keys off an own then_run property, not an inherited one", () => {
    const inherited = Object.create({ then_run: { type: "string" } }) as Record<string, unknown>;
    inherited.path = { type: "string" };
    const input = {
      type: "object" as const,
      properties: inherited,
    } as unknown as Tool.ValueSchema;

    const extended = extendToolInputWithThenRun(input, "fused") as unknown as {
      properties: Record<string, unknown>;
    };

    expect(extended).not.toBe(input);
    expect(Object.hasOwn(extended.properties, "then_run")).toBe(true);
  });
});
