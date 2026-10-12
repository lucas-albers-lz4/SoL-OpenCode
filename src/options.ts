/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

export interface SolOpenCodePluginOptions {
  readonly actionFusion?: boolean;
  readonly observationPack?: boolean;
}

export interface ResolvedMechanisms {
  readonly actionFusion: boolean;
  readonly observationPack: boolean;
}

export type LogFn = (message: string) => void;

function readBooleanOption(
  options: Record<string, unknown>,
  key: keyof SolOpenCodePluginOptions,
  log: LogFn,
): boolean {
  const raw = options[key];
  if (raw === undefined) return true;
  if (typeof raw === "boolean") return raw;
  log(`sol.opencode: invalid option "${String(key)}" (expected boolean); disabling that mechanism`);
  return false;
}

export function resolveMechanismOptions(
  raw: unknown,
  log: LogFn = (message) => console.warn(message),
): ResolvedMechanisms {
  const options =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : {};

  if (raw !== undefined && (typeof raw !== "object" || raw === null)) {
    log("sol.opencode: plugin options must be an object; disabling Action Fusion and Observation Pack");
    return { actionFusion: false, observationPack: false };
  }

  return {
    actionFusion: readBooleanOption(options, "actionFusion", log),
    observationPack: readBooleanOption(options, "observationPack", log),
  };
}
