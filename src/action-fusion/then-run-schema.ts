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

function isEffectStruct(input: unknown): input is Schema.Struct<Schema.Struct.Fields> {
  if (!Schema.isSchema(input)) return false;
  return (
    "fields" in input &&
    typeof (input as { mapFields?: unknown }).mapFields === "function"
  );
}

function thenRunProperty(description: string): Record<string, unknown> {
  return {
    type: "object",
    description,
    properties: {
      command: {
        type: "string",
        description: "Shell command to run after the mutation succeeds",
      },
      timeout: {
        type: "number",
        description: "Timeout in seconds (optional; converted to milliseconds for shell)",
      },
    },
    required: ["command"],
    additionalProperties: false,
  };
}

function thenRunEffectField(description: string) {
  const thenRun = Schema.Struct({
    command: Schema.String.pipe(
      Schema.annotateKey({
        description: "Shell command to run after the mutation succeeds",
      }),
    ),
    timeout: Schema.optionalKey(
      Schema.Number.pipe(
        Schema.annotateKey({
          description: "Timeout in seconds (optional; converted to milliseconds for shell)",
        }),
      ),
    ),
  });
  return Schema.optionalKey(thenRun).pipe(Schema.annotateKey({ description }));
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
    if ("then_run" in input.fields) return input;
    return input.mapFields((fields) => ({
      ...fields,
      then_run: thenRunEffectField(description),
    }));
  }

  if (!isJsonObjectSchema(input)) {
    return input;
  }

  if (input.properties !== undefined && "then_run" in input.properties) {
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

export function stripThenRun<T extends Record<string, unknown>>(input: T): {
  readonly mutationInput: Omit<T, "then_run">;
  readonly thenRun: ThenRunInput | undefined;
} {
  const { then_run: thenRunRaw, ...mutationInput } = input;
  if (thenRunRaw === undefined) {
    return { mutationInput, thenRun: undefined };
  }
  if (
    typeof thenRunRaw === "object" &&
    thenRunRaw !== null &&
    "command" in thenRunRaw &&
    typeof (thenRunRaw as ThenRunInput).command === "string"
  ) {
    const candidate = thenRunRaw as ThenRunInput;
    const timeout =
      candidate.timeout === undefined
        ? undefined
        : typeof candidate.timeout === "number"
          ? candidate.timeout
          : undefined;
    return {
      mutationInput,
      thenRun: { command: candidate.command, timeout },
    };
  }
  return { mutationInput, thenRun: undefined };
}

/** OpenCode shell timeout is milliseconds; schema exposes seconds (SoL-Pi wording). */
export function thenRunTimeoutMs(thenRun: ThenRunInput | undefined): number | undefined {
  if (thenRun?.timeout === undefined) return undefined;
  return thenRun.timeout * 1000;
}
