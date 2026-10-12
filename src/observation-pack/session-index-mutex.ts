/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

const sessionChains = new Map<string, Promise<unknown>>();

/** Serialize session-index load/modify/save for one session (archive + HTTP send counts). */
export function withSessionIndexLock<T>(sessionID: string, work: () => Promise<T>): Promise<T> {
  const prior = sessionChains.get(sessionID) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(work);
  sessionChains.set(
    sessionID,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}

/** @internal Vitest only — avoids leaked chains between cases. */
export function resetSessionIndexLocksForTests(): void {
  sessionChains.clear();
}
