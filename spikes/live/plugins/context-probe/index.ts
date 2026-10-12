/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

/* Directory entrypoint for OpenCode V2's local-plugin loader.
 * V2 2.0.27 loads a plugin given as a directory via <dir>/index.ts and
 * rejects direct .ts file paths ("configured plugin path must be a directory"),
 * so the probe itself stays in spikes/context-probe.ts and is re-exported here. */
export { default } from "../../../context-probe.ts";
