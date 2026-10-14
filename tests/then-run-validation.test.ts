/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  extendToolInputWithThenRun,
  MAX_TIMEOUT_SECONDS,
  stripThenRun,
  THEN_RUN_INVALID_TIMEOUT,
  THEN_RUN_TIMEOUT_TOO_LARGE,
  thenRunTimeoutMs,
} from "../src/action-fusion/then-run-schema.js";

describe("stripThenRun validation", () => {
  it("reports every malformed shape instead of dropping it silently", () => {
    const matrix: ReadonlyArray<readonly [unknown, string]> = [
      ["echo hi", "must be an object"],
      [null, "must be an object"],
      [[{ command: "echo hi" }], "must be an object"],
      [{}, "non-empty string"],
      [{ command: 123 }, "non-empty string"],
      [{ command: "   " }, "non-empty string"],
      [{ command: "echo hi", timeout: -5 }, "positive, finite"],
      [{ command: "echo hi", timeout: 0 }, "positive, finite"],
      [{ command: "echo hi", timeout: Number.NaN }, "positive, finite"],
      [{ command: "echo hi", timeout: Number.POSITIVE_INFINITY }, "positive, finite"],
      [{ command: "echo hi", timeout: "abc" }, "positive, finite"],
      [{ command: "echo hi", timeout: "0" }, "positive, finite"],
      [{ command: "echo hi", timeout: {} }, "positive, finite"],
    ];

    for (const [value, fragment] of matrix) {
      const label = JSON.stringify(value);
      const stripped = stripThenRun({ a: 1, then_run: value });
      expect(stripped.thenRun, label).toBeUndefined();
      expect(stripped.skipReason, label).toContain(fragment);
      expect(stripped.mutationInput).toEqual({ a: 1 });
    }
  });

  it("accepts a usable then_run and coerces a numeric-string timeout", () => {
    // `toStrictEqual`: `toEqual` cannot tell an absent key from `undefined`, so a variant
    // that emitted `timeout: undefined` would pass.
    expect(stripThenRun({ a: 1, then_run: { command: "echo hi" } })).toStrictEqual({
      mutationInput: { a: 1 },
      thenRun: { command: "echo hi" },
      skipReason: undefined,
    });
    expect(stripThenRun({ then_run: { command: "echo hi", timeout: "5" } }).thenRun).toStrictEqual({
      command: "echo hi",
      timeout: 5,
    });
    expect(stripThenRun({ then_run: { command: "echo hi", timeout: 5 } }).thenRun).toStrictEqual({
      command: "echo hi",
      timeout: 5,
    });
  });

  it("blames the container, not the command, for a non-plain object", () => {
    for (const value of [new Date(), new Map(), new (class { command = "echo hi"; })()]) {
      const stripped = stripThenRun({ then_run: value });
      expect(String(stripped.skipReason)).toContain("must be an object");
      expect(String(stripped.skipReason)).not.toContain("non-empty string");
    }
  });

  it("rejects a timeout above the largest timer Node accepts", () => {
    const tooLarge = stripThenRun({ then_run: { command: "echo hi", timeout: 3_000_000 } });
    expect(tooLarge.thenRun).toBeUndefined();
    expect(tooLarge.skipReason).toBe(THEN_RUN_TIMEOUT_TOO_LARGE);
    expect(stripThenRun({ then_run: { command: "echo hi", timeout: MAX_TIMEOUT_SECONDS } }).thenRun)
      .toStrictEqual({ command: "echo hi", timeout: MAX_TIMEOUT_SECONDS });
  });

  it("leaves an absent then_run unmarked", () => {
    const stripped = stripThenRun({ a: 1 });
    expect(stripped.thenRun).toBeUndefined();
    expect(stripped.skipReason).toBeUndefined();
  });
});

describe("then_run schema guards", () => {
  it("carries the command and timeout rules in the JSON schema", () => {
    const extended = extendToolInputWithThenRun(
      { type: "object" as const, properties: {} },
      "fused",
    ) as unknown as { properties: { then_run: { properties: Record<string, unknown> } } };

    expect(extended.properties.then_run.properties.command).toMatchObject({
      type: "string",
      minLength: 1,
      pattern: "\\S",
    });
    expect(extended.properties.then_run.properties.timeout).toMatchObject({
      type: "number",
      exclusiveMinimum: 0,
    });
  });

  it("rejects a blank command and a non-positive timeout in the Effect schema", () => {
    const struct = extendToolInputWithThenRun(
      Schema.Struct({ path: Schema.String }),
      "fused",
    ) as Schema.Struct<Schema.Struct.Fields>;
    const decode = (value: unknown) => Schema.decodeUnknownSync(struct)(value);

    expect(
      decode({ path: "a.txt", then_run: { command: "echo hi", timeout: 5 } }),
    ).toMatchObject({ then_run: { command: "echo hi", timeout: 5 } });
    expect(() => decode({ path: "a.txt", then_run: { command: "   " } })).toThrow();
    expect(() => decode({ path: "a.txt", then_run: { command: "echo hi", timeout: 0 } })).toThrow();
    expect(() => decode({ path: "a.txt", then_run: { command: "echo hi", timeout: -5 } })).toThrow();
  });

  it("shows that Infinity passes the schema guard, so the runtime check is load-bearing", () => {
    const struct = extendToolInputWithThenRun(
      Schema.Struct({ path: Schema.String }),
      "fused",
    ) as Schema.Struct<Schema.Struct.Fields>;
    const decode = (value: unknown) => Schema.decodeUnknownSync(struct)(value);

    expect(
      decode({ path: "a.txt", then_run: { command: "echo hi", timeout: Number.POSITIVE_INFINITY } }),
    ).toMatchObject({ then_run: { timeout: Number.POSITIVE_INFINITY } });
    expect(
      stripThenRun({ then_run: { command: "echo hi", timeout: Number.POSITIVE_INFINITY } })
        .skipReason,
    ).toContain("positive, finite");
  });

  it("keeps an unusable bound away from shell.execute", () => {
    expect(thenRunTimeoutMs({ command: "x", timeout: 12 })).toBe(12_000);
    expect(thenRunTimeoutMs({ command: "x" })).toBeUndefined();
    // A bound that cannot be honoured must not become an unbounded run for a direct caller.
    for (const unusable of [Number.POSITIVE_INFINITY, Number.NaN, -5, 0]) {
      expect(() => thenRunTimeoutMs({ command: "x", timeout: unusable })).toThrow(
        THEN_RUN_INVALID_TIMEOUT,
      );
    }
    expect(() => thenRunTimeoutMs({ command: "x", timeout: MAX_TIMEOUT_SECONDS + 1 })).toThrow(
      THEN_RUN_TIMEOUT_TOO_LARGE,
    );
  });
});
