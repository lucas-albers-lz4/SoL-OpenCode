#!/usr/bin/env node
/**
 * Isolated OpenCode 2.0.27 live gate runner. Does not touch the user shared service.
 *
 *   node spikes/live/run-live.mjs permission
 *   node spikes/live/run-live.mjs context
 */
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const mode = process.argv[2] === "context" ? "context" : "permission";
const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../..");
const oc = join(repo, "node_modules/@opencode/cli/bin/opencode.exe");
const serverPassword = randomBytes(18).toString("base64url");
const basic = Buffer.from(`opencode:${serverPassword}`).toString("base64");
const work = join(here, "work");
const xdg = join(here, ".xdg");
const out = join(here, "out");
const mockPort = 18765;
const servePort = 18766;
const base = `http://127.0.0.1:${servePort}`;

mkdirSync(work, { recursive: true });
mkdirSync(out, { recursive: true });
for (const name of ["config", "data", "state", "cache"]) {
  mkdirSync(join(xdg, name), { recursive: true });
}

const pluginLog = join(out, `${mode}-plugin.jsonl`);
const mockLog = join(out, `${mode}-mock.jsonl`);
const eventsLog = join(out, `${mode}-events.jsonl`);
if (existsSync(pluginLog)) rmSync(pluginLog);
if (existsSync(mockLog)) rmSync(mockLog);
if (existsSync(eventsLog)) rmSync(eventsLog);

writeFileSync(
  join(work, "opencode.json"),
  JSON.stringify(
    {
      $schema: "https://opencode.ai/config.json",
      model: "solprobe/gate",
      update: "disable",
      permissions: [
        { action: "*", resource: "*", effect: "allow" },
        { action: "shell", resource: "*", effect: "ask" },
      ],
      providers: {
        solprobe: {
          name: "SoL probe",
          env: ["SOL_PROBE_API_KEY"],
          package: "@opencode/ai/providers/openai-compatible",
          settings: { baseURL: `http://127.0.0.1:${mockPort}/v1` },
          models: { gate: { name: "gate" } },
        },
      },
      plugins: [
        join(repo, "spikes/live/plugins/permission-probe"),
        join(repo, "spikes/live/plugins/context-probe"),
      ],
    },
    null,
    2,
  ),
);
writeFileSync(join(work, "README.md"), "sol-opencode live fixture\n");

const env = {
  ...process.env,
  XDG_CONFIG_HOME: join(xdg, "config"),
  XDG_DATA_HOME: join(xdg, "data"),
  XDG_STATE_HOME: join(xdg, "state"),
  XDG_CACHE_HOME: join(xdg, "cache"),
  SOL_PROBE_API_KEY: "probe",
  SOL_PROBE_LOG: pluginLog,
  OPENCODE_SERVER_PASSWORD: serverPassword,
  OPENCODE_SERVER_USERNAME: "opencode",
  PROBE_MODE: mode,
  MOCK_PORT: String(mockPort),
  MOCK_LOG: mockLog,
};

function redact(text) {
  return String(text).replace(/server password \S+/gi, "server password [redacted]");
}

let printedPassword;

function spawnLogged(cmd, args, extra = {}) {
  const child = spawn(cmd, args, {
    cwd: work,
    env,
    stdio: ["ignore", "pipe", "pipe"],
    ...extra,
  });
  const tag = cmd.split("/").pop();
  const handle = (d, stream) => {
    const text = String(d);
    const match = text.match(/server password (\S+)/i);
    if (match) printedPassword = match[1];
    stream.write(`[${tag}] ${redact(text)}`);
  };
  child.stdout.on("data", (d) => handle(d, process.stdout));
  child.stderr.on("data", (d) => handle(d, process.stderr));
  return child;
}

async function waitHttp(url, timeoutMs, headers = {}) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { headers });
      if (res.ok || res.status === 404 || res.status === 401) return;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`timeout waiting for ${url}`);
}

function authHeader() {
  const password = printedPassword ?? serverPassword;
  return `Basic ${Buffer.from(`opencode:${password}`).toString("base64")}`;
}

async function api(method, path, body) {
  const headers = { authorization: authHeader() };
  if (body) headers["content-type"] = "application/json";
  const res = await fetch(`${base}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (!res.ok) {
    throw new Error(`${method} ${path} ${res.status}: ${text.slice(0, 800)}`);
  }
  return json;
}

const mock = spawnLogged(process.execPath, [join(here, "mock-provider.mjs")]);
const serve = spawnLogged(oc, [
  "serve",
  "--hostname",
  "127.0.0.1",
  "--port",
  String(servePort),
]);

let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  serve.kill("SIGTERM");
  mock.kill("SIGTERM");
  setTimeout(() => process.exit(code), 300);
}
process.on("SIGINT", () => stop(130));
serve.on("exit", (c) => {
  if (!stopping) {
    console.error(`opencode serve exited ${c}`);
    stop(c ?? 1);
  }
});

async function main() {
  await waitHttp(`http://127.0.0.1:${mockPort}/health`, 5000);
  const start = Date.now();
  while (Date.now() - start < 20000) {
    try {
      const res = await fetch(`${base}/api/info`, { headers: { authorization: authHeader() } });
      if (res.ok) break;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const info = await api("GET", "/api/info");
  console.log("server", JSON.stringify({ version: info.version, pid: info.pid }));

  const plugins = await api("GET", "/api/plugin");
  console.log("plugins", JSON.stringify(plugins, null, 2).slice(0, 4000));

  async function createAndPrompt(title) {
    const session = await api("POST", "/api/session", {
      title,
      model: { providerID: "solprobe", id: "gate" },
    });
    const sessionID = session.id ?? session.sessionID ?? session.data?.id;
    await api("POST", `/api/session/${sessionID}/prompt`, { text: `run the ${mode} probe` });
    return sessionID;
  }

  async function waitAsked(sessionID, ms = 20000) {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const pending = await api("GET", `/api/session/${sessionID}/permission`).catch(() => []);
      const list = Array.isArray(pending) ? pending : pending?.data ?? [];
      if (list.length) return list;
      await new Promise((r) => setTimeout(r, 300));
    }
    return [];
  }

  async function replyPermission(sessionID, requestID, decision) {
    await api("POST", `/api/session/${sessionID}/permission/${requestID}/reply`, { decision }).catch(
      async () => {
        await api("POST", `/api/session/${sessionID}/permission/${requestID}/reply`, { reply: decision });
      },
    );
  }

  if (mode === "permission") {
    const sessionOnce = await createAndPrompt("sol-live-permission-once");
    const askedOnce = await waitAsked(sessionOnce);
    console.log("permission.once", JSON.stringify(askedOnce, null, 2));
    if (!askedOnce.length) {
      writeFileSync(join(out, `${mode}-result.json`), JSON.stringify({ go: false, reason: "no-ask-once" }, null, 2));
      stop(2);
      return;
    }
    await replyPermission(sessionOnce, askedOnce[0].id, "once");
    await new Promise((r) => setTimeout(r, 1500));

    const sessionReject = await createAndPrompt("sol-live-permission-reject");
    const askedReject = await waitAsked(sessionReject);
    console.log("permission.reject", JSON.stringify(askedReject, null, 2));
    if (askedReject.length) {
      await replyPermission(sessionReject, askedReject[0].id, "reject");
      await new Promise((r) => setTimeout(r, 1500));
    }

    writeFileSync(
      join(out, `${mode}-result.json`),
      JSON.stringify(
        {
          allowOnce: askedOnce[0],
          reject: askedReject[0] ?? null,
          nestedBeforeDeltaWant: 0,
          pluginLog,
        },
        null,
        2,
      ),
    );
  } else {
    const sessionID = await createAndPrompt("sol-live-context");
    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setTimeout(r, 1500));
      await api("POST", `/api/session/${sessionID}/prompt`, { text: `continue ${i}` }).catch(() => {});
    }
    await new Promise((r) => setTimeout(r, 2500));
    const stored = await api("GET", `/api/session/${sessionID}/context`).catch(() => null);
    const storedText = JSON.stringify(stored ?? "");
    writeFileSync(
      join(out, `${mode}-result.json`),
      JSON.stringify(
        {
          storedHasMarker: storedText.includes("SOL_OPENCODE_BLOB"),
          storedHasPlaceholder: storedText.includes("[sol.opencode:packed]"),
          pluginLog,
        },
        null,
        2,
      ),
    );
  }

  console.log("wrote", join(out, `${mode}-result.json`));
  stop(0);
}

main().catch((error) => {
  console.error(error);
  writeFileSync(join(out, `${mode}-result.json`), JSON.stringify({ error: String(error) }, null, 2));
  stop(1);
});
