/*
 * SPDX-FileCopyrightText: Copyright (c) 2026 SoL-OpenCode contributors
 * SPDX-License-Identifier: MIT
 */

const sessionChains = new Map<string, Promise<unknown>>();

/** Serialize session-index load/modify/save for one session (archive + HTTP send counts). */
export function withSessionIndexLock<T>(sessionID: string, work: () => Promise<T>): Promise<T> {
  const prior = sessionChains.get(sessionID) ?? Promise.resolve();
  const run = prior.catch(() => undefined).then(work);
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  sessionChains.set(sessionID, tail);
  void tail.then(() => {
    // A later call may already have queued its own tail for this session. Only the
    // current owner may remove the entry when its work settles.
    if (sessionChains.get(sessionID) === tail) sessionChains.delete(sessionID);
  });
  return run;
}

/** @internal Vitest only — avoids leaked chains between cases. */
export function resetSessionIndexLocksForTests(): void {
  sessionChains.clear();
}
