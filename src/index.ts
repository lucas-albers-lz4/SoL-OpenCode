/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
 * SPDX-License-Identifier: MIT
 */

import { Plugin } from "@opencode/plugin";
import { registerActionFusion } from "./action-fusion/index.js";
import { registerObservationPack } from "./observation-pack/index.js";
import { resolveMechanismOptions } from "./options.js";

export default Plugin.define({
  id: "sol.opencode",
  async setup(ctx) {
    const mechanisms = resolveMechanismOptions(ctx.options);
    const disposers: Array<{ dispose: () => Promise<void> }> = [];

    if (mechanisms.actionFusion) {
      disposers.push(await registerActionFusion(ctx));
    }
    if (mechanisms.observationPack) {
      disposers.push(await registerObservationPack(ctx));
    }

    return async () => {
      for (const registration of disposers) {
        await registration.dispose();
      }
    };
  },
});
