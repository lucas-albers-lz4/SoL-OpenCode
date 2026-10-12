# Live-gate plugin directories

OpenCode V2 2.0.27 loads plugins given as **directories** (`<dir>/index.ts`) and
rejects direct `.ts` file paths with `configured plugin path must be a directory`
(the probes silently never loaded, making `run-live.mjs` report `no-ask-once`).
Each directory here is a one-line entrypoint re-exporting the probe in `spikes/`.
