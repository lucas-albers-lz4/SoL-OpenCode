/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import type { Tool } from "@opencode/schema/tool";

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
    "type" in input &&
    (input as JsonObjectSchema).type === "object"
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

/** Replace tool `input` with a clone that adds optional `then_run`; never mutates nested schema in place. */
export function extendToolInputWithThenRun(
  input: Tool.ValueSchema,
  description: string,
): Tool.ValueSchema {
  if (!isJsonObjectSchema(input)) {
    return input;
  }

  const clone = structuredClone(input) as JsonObjectSchema;
  const properties = { ...(clone.properties ?? {}), then_run: thenRunProperty(description) };
  return {
    ...clone,
    properties,
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
