/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

import type { Tool } from "@opencode/schema/tool";
import { Schema } from "effect";

export interface ThenRunInput {
  readonly command: string;
  readonly timeout?: number;
}

/** Reasons a present-but-unusable `then_run` reports through `[then_run:skipped]`. */
export const THEN_RUN_INVALID_SHAPE = "then_run must be an object with a command.";
export const THEN_RUN_INVALID_COMMAND = "then_run.command must be a non-empty string.";
export const THEN_RUN_INVALID_TIMEOUT =
  "then_run.timeout must be a positive, finite number of seconds.";

/**
 * `setTimeout` clamps anything above 2**31-1 ms to 1 ms, so a bound far larger than a
 * caller's intent would run the command instantly. Reject it instead of inverting it.
 */
export const MAX_TIMEOUT_MILLISECONDS = 2_147_483_647;
export const MAX_TIMEOUT_SECONDS = MAX_TIMEOUT_MILLISECONDS / 1000;
export const THEN_RUN_TIMEOUT_TOO_LARGE =
  `then_run.timeout must be at most ${MAX_TIMEOUT_SECONDS} seconds (the largest timer Node accepts).`;

type JsonObjectSchema = {
  readonly type: "object";
  readonly properties?: Record<string, unknown>;
  readonly required?: readonly string[];
  readonly additionalProperties?: boolean | Record<string, unknown>;
  readonly [key: string]: unknown;
};

function isJsonObjectSchema(input: Tool.ValueSchema): input is JsonObjectSchema {
  return (
    typeof input === "object" &&
    input !== null &&
    !Schema.isSchema(input) &&
    "type" in input &&
    (input as JsonObjectSchema).type === "object"
  );
}

/** Short label for the schema family, so an "unavailable" warning names what it saw. */
function describeSchemaFamily(input: Tool.ValueSchema): string {
  // Effect structs are extended before this point, so "effect-struct" is unreachable here and
  // would read as a contradiction next to "unsupported schema family".
  if (Schema.isSchema(input)) return "effect-schema";
  if (input === null) return "null";
  if (typeof input === "object" && "~standard" in input) {
    return "standard-schema";
  }
  if (typeof input === "object" && input !== null && "type" in input) {
    return `json:${String((input as { type?: unknown }).type)}`;
  }
  return typeof input;
}

function isEffectStruct(input: unknown): input is Schema.Struct<Schema.Struct.Fields> {
  if (!Schema.isSchema(input)) return false;
  return (
    "fields" in input &&
    typeof (input as { mapFields?: unknown }).mapFields === "function"
  );
}

/**
 * `Schema.minLength` / `Schema.pattern` / `Schema.greaterThan` do not exist in effect
 * 4.0.1; the checks below are the supported spellings. `minLength`/`pattern` mirror the
 * JSON-Schema side, whose pattern is deliberately unanchored so any non-blank command
 * passes.
 */
function thenRunProperty(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: {
      command: {
        type: "string",
        minLength: 1,
        pattern: "\\S",
        description: "Shell command to run after the mutation succeeds",
      },
      timeout: {
        type: "number",
        exclusiveMinimum: 0,
        description: "Timeout in seconds (optional; converted to milliseconds for shell)",
      },
    },
    required: ["command"],
    additionalProperties: false,
  };
}

function thenRunEffectField(description: string) {
  const thenRun = Schema.Struct({
    command: Schema.String.check(Schema.isPattern(/\S/)).pipe(
      Schema.annotateKey({
        description: "Shell command to run after the mutation succeeds",
      }),
    ),
    timeout: Schema.optionalKey(
      Schema.Number.check(Schema.isGreaterThan(0)).pipe(
        Schema.annotateKey({
          description: "Timeout in seconds (optional; converted to milliseconds for shell)",
        }),
      ),
    ),
  });
  return Schema.optionalKey(thenRun).pipe(Schema.annotateKey({ description }));
}

/**
 * True when the plugin can read or add `then_run` on this schema family. A family it cannot
 * read is a family it never advertised `then_run` on, so any value in the input is the
 * host's own (see the deferral in `wrap-tools.ts`).
 */
export function supportsThenRunProperty(input: Tool.ValueSchema): boolean {
  return isEffectStruct(input) || isJsonObjectSchema(input);
}

/**
 * True when the tool's own input schema already declares `then_run`, in either schema
 * family. Such a tool owns that property: the schema transform leaves the declaration
 * alone, and the execute wrapper must not strip or reinterpret it (issue #48).
 */
export function declaresThenRunProperty(input: Tool.ValueSchema): boolean {
  if (isEffectStruct(input)) return "then_run" in input.fields;
  if (!isJsonObjectSchema(input)) return false;
  const declared = input.properties;
  return typeof declared === "object" && declared !== null && Object.hasOwn(declared, "then_run");
}

/**
 * Replace tool `input` with a shallow copy that adds optional `then_run`; never
 * mutates the caller's schema. Returns `input` unchanged when the schema already
 * declares `then_run` (mirrors the Effect-struct branch) and uses a shallow copy
 * rather than a deep clone, which throws on in-process schemas that carry
 * functions.
 */
export function extendToolInputWithThenRun(
  input: Tool.ValueSchema,
  description: string,
): Tool.ValueSchema {
  if (isEffectStruct(input)) {
    if (declaresThenRunProperty(input)) return input;
    return input.mapFields((fields) => ({
      ...fields,
      then_run: thenRunEffectField(description),
    }));
  }

  if (!isJsonObjectSchema(input)) {
    // The tool still registers, it simply has no then_run. Say so rather than returning the
    // same object silently, which made an unsupported schema family invisible (issue #41).
    console.warn(
      `sol.opencode: then_run unavailable for a tool input of an unsupported schema family (${describeSchemaFamily(input)}); registering the tool without it`,
    );
    return input;
  }

  if (declaresThenRunProperty(input)) {
    return input;
  }

  return {
    ...input,
    properties: {
      ...(input.properties ?? {}),
      then_run: thenRunProperty(description),
    },
  };
}

/**
 * Only a plain object is a `then_run`: a `Date`, `Map` or class instance is not a record
 * carrying a `command`, and blaming its missing command would hide the real problem.
 */
function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

/**
 * A numeric string naming a positive, finite number of seconds is coerced; a number
 * must already be positive and finite. Everything else is rejected, because a bound
 * the caller asked for must never be silently dropped (the command would run
 * unbounded). The schema checks alone cannot do this: `isGreaterThan(0)` still
 * accepts `Infinity`, so this finite check is load-bearing.
 */
function coerceTimeoutSeconds(value: unknown): number | undefined {
  const parsed = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  if (typeof parsed !== "number" || !Number.isFinite(parsed) || parsed <= 0) {
    return undefined;
  }
  return parsed;
}

/**
 * Validate one `then_run` value. A malformed value is reported, never dropped: the
 * caller applies the mutation and surfaces the reason as `[then_run:skipped]`.
 */
function parseThenRun(
  value: unknown,
): { readonly thenRun: ThenRunInput } | { readonly skipReason: string } {
  if (!isPlainRecord(value)) {
    return { skipReason: THEN_RUN_INVALID_SHAPE };
  }
  const command = value.command;
  if (typeof command !== "string" || command.trim() === "") {
    return { skipReason: THEN_RUN_INVALID_COMMAND };
  }
  if (value.timeout === undefined) {
    return { thenRun: { command } };
  }
  const seconds = coerceTimeoutSeconds(value.timeout);
  if (seconds === undefined) {
    return { skipReason: THEN_RUN_INVALID_TIMEOUT };
  }
  if (seconds * 1000 > MAX_TIMEOUT_MILLISECONDS) {
    return { skipReason: THEN_RUN_TIMEOUT_TOO_LARGE };
  }
  return { thenRun: { command, timeout: seconds } };
}

export function stripThenRun<T extends Record<string, unknown>>(input: T): {
  readonly mutationInput: Omit<T, "then_run">;
  readonly thenRun: ThenRunInput | undefined;
  /** Set when `then_run` was present but unusable; undefined when absent or usable. */
  readonly skipReason: string | undefined;
} {
  const { then_run: thenRunRaw, ...mutationInput } = input;
  if (thenRunRaw === undefined) {
    return { mutationInput, thenRun: undefined, skipReason: undefined };
  }
  const parsed = parseThenRun(thenRunRaw);
  if ("thenRun" in parsed) {
    return { mutationInput, thenRun: parsed.thenRun, skipReason: undefined };
  }
  return { mutationInput, thenRun: undefined, skipReason: parsed.skipReason };
}

/** OpenCode shell timeout is milliseconds; schema exposes seconds (SoL-Pi wording). */
export function thenRunTimeoutMs(thenRun: ThenRunInput | undefined): number | undefined {
  const seconds = thenRun?.timeout;
  if (seconds === undefined) return undefined;
  // Second line of defence for direct callers — the fused path validated this already.
  // A bound that cannot be honoured must not degrade into an unbounded run, so fail loudly
  // instead of dropping the timeout key.
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`${THEN_RUN_INVALID_TIMEOUT} (received ${String(seconds)})`);
  }
  const milliseconds = seconds * 1000;
  if (milliseconds > MAX_TIMEOUT_MILLISECONDS) {
    throw new Error(`${THEN_RUN_TIMEOUT_TOO_LARGE} (received ${String(seconds)})`);
  }
  return milliseconds;
}
