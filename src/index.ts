/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { Plugin } from "@opencode/plugin";
import { registerActionFusion } from "./action-fusion/index.js";
import { registerObservationPack } from "./observation-pack/index.js";
import { resolveMechanismOptions } from "./options.js";

interface Registration {
  dispose: () => Promise<void>;
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default Plugin.define({
  id: "sol.opencode",
  async setup(ctx) {
    const mechanisms = resolveMechanismOptions(ctx.options);
    const disposers: Registration[] = [];
    const failures: string[] = [];

    // Register each mechanism independently: one mechanism failing to register must not
    // take the other down with it. A mechanism that fails unwinds its own partial work
    // before it rethrows, so nothing is left registered that the host cannot dispose.
    const register = async (name: string, start: () => Promise<Registration>): Promise<void> => {
      try {
        disposers.push(await start());
      } catch (error) {
        failures.push(`${name} could not register: ${describeError(error)}`);
      }
    };

    if (mechanisms.actionFusion) {
      await register("Action Fusion", () => registerActionFusion(ctx));
    }
    if (mechanisms.observationPack) {
      await register("Observation Pack", () => registerObservationPack(ctx));
    }

    if (failures.length > 0) {
      console.warn(`sol.opencode: ${failures.join("; ")}`);
    }

    if (disposers.length === 0 && failures.length > 0) {
      // Nothing registered and something was asked for: tell the host rather than hand it
      // a plugin that silently does nothing.
      throw new Error(`sol.opencode: no mechanism could register (${failures.join("; ")})`);
    }

    return async () => {
      // Reverse registration order: the last thing registered is the first to go.
      for (const registration of [...disposers].reverse()) {
        await registration.dispose();
      }
    };
  },
});
