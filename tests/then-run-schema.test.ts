/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
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
  it("still clones object schemas and adds then_run", () => {
    const nested = { path: { type: "string" as const } };
    const input = { type: "object" as const, properties: nested };
    const extended = extendToolInputWithThenRun(input, "json path");
    expect(extended).not.toBe(input);
    expect(extended).toHaveProperty("properties.then_run");
    expect(nested).not.toHaveProperty("then_run");
  });
});
