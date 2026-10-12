/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors.
 * SPDX-License-Identifier: MIT
 */

// OpenCode V2 loads a plugin given as a local directory by resolving
// `<dir>/index.ts` or `<dir>/index.js` directly; it does NOT consult the
// package.json "exports" map for this channel (name/file: specifiers DO use
// it and load dist/ via the exports map). This file is the local-directory
// entrypoint; `exports` remains the npm-publish entrypoint. Both paths land
// on the same implementation in src/index.ts.
export { default } from "./src/index.js";
