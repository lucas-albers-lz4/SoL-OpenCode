# SoL-OpenCode

Unofficial OpenCode V2 port of **two** [SoL-Pi](https://github.com/NVlabs/SoL-Pi) harness mechanisms:

- **Action Fusion** — optional `then_run` on `edit`, `write`, and (when path enumeration is reliable) `patch`
- **Observation Pack** — pack host-visible tool text **> 10 KiB**; project on `session.hook("http.request")`; `obs_recall` pages the archive

This project is **not** NVIDIA, **not** NVlabs, and **not** the full four-mechanism SoL-Pi stack.

## From source

Requires Node.js **22+**. Pinned host is OpenCode **2.0.27** (see [docs/pin.md](docs/pin.md)).

```bash
git clone https://github.com/lucas-albers-lz4/SoL-OpenCode.git
cd SoL-OpenCode
npm ci
npm test
npm run build
```

Load the built package in an OpenCode 2.0.27 project:

```jsonc
{
  "plugins": [
    {
      "package": "/absolute/path/to/SoL-OpenCode",
      "options": { "actionFusion": true, "observationPack": true }
    }
  ]
}
```

Register per [V2 plugin docs](https://dev.opencode.ai/v2/docs/build/plugins). This is not yet published to npm.

## Plugin id

`sol.opencode`

## Options

| Option | Default | Description |
|--------|---------|-------------|
| `actionFusion` | `true` | Wrap mutation tools with optional `then_run` |
| `observationPack` | `true` | Archive large tool results and project placeholders on later provider requests |

Invalid option values log a warning and disable that mechanism only; `setup` does not throw.

## Provenance

Portable algorithms are copied from SoL-Pi (MIT, NVIDIA copyright). Reference commit: `e1a586af0ad8956f42ae5b26bba20e48fbf30e00`.

Pinned runtime: see [docs/pin.md](./docs/pin.md).

## License

MIT — see [LICENSE](./LICENSE).
