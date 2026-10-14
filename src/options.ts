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

const KNOWN_OPTION_KEYS: readonly string[] = ["actionFusion", "observationPack"];

/**
 * Options must be a plain object: `typeof [] === "object"` used to let `options: []`
 * through, where reading the two known keys off an array silently resolved to both
 * mechanisms enabled with no diagnostic.
 */
function isPlainOptionsObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value) as unknown;
  return prototype === Object.prototype || prototype === null;
}

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
  if (raw !== undefined && !isPlainOptionsObject(raw)) {
    log("sol.opencode: plugin options must be a plain object; disabling Action Fusion and Observation Pack");
    return { actionFusion: false, observationPack: false };
  }

  const options = isPlainOptionsObject(raw) ? raw : {};

  // A near-miss key ("actionfusion", "observation_pack") must not fail open: the mechanism
  // it was meant to switch off would stay enabled, with no diagnostic at all.
  for (const key of Object.keys(options)) {
    if (!KNOWN_OPTION_KEYS.includes(key)) {
      log(
        `sol.opencode: unrecognized option "${key}" (expected ${KNOWN_OPTION_KEYS.join(" or ")}); ignoring it`,
      );
    }
  }

  return {
    actionFusion: readBooleanOption(options, "actionFusion", log),
    observationPack: readBooleanOption(options, "observationPack", log),
  };
}
