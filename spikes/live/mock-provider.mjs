#!/usr/bin/env node
/**
 * OpenAI-compatible mock for live SoL-OpenCode gates.
 * PROBE_MODE=permission|context  MOCK_PORT=18765
 * Logs every request body to MOCK_LOG (JSONL).
 */
import { createServer } from "node:http";
import { appendFileSync } from "node:fs";

const port = Number(process.env.MOCK_PORT ?? 18765);
const mode = process.env.PROBE_MODE === "context" ? "context" : "permission";
const logFile = process.env.MOCK_LOG;

function log(record) {
  const line = JSON.stringify({ t: Date.now(), ...record });
  if (logFile) appendFileSync(logFile, `${line}\n`);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function hasToolResult(messages) {
  return (messages ?? []).some((m) => {
    if (!m || typeof m !== "object") return false;
    if (m.role === "tool") return true;
    if (m.type === "function_call_output" || m.type === "tool_result") return true;
    return false;
  });
}

function permissionCall() {
  return {
    id: "chatcmpl-sol-permission",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "gate",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_sol_permission",
              type: "function",
              function: { name: "sol_permission_probe", arguments: "{}" },
            },
          ],
        },
      },
    ],
  };
}

function contextCall() {
  return {
    id: "chatcmpl-sol-context",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "gate",
    choices: [
      {
        index: 0,
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              id: "call_sol_context",
              type: "function",
              function: { name: "sol_context_blob", arguments: "{}" },
            },
          ],
        },
      },
    ],
  };
}

function textDone(text) {
  return {
    id: "chatcmpl-sol-done",
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: "gate",
    choices: [
      {
        index: 0,
        finish_reason: "stop",
        message: { role: "assistant", content: text },
      },
    ],
  };
}

function sendJson(res, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(200, { "content-type": "application/json", "content-length": Buffer.byteLength(body) });
  res.end(body);
}

const server = createServer(async (req, res) => {
  if (req.method === "GET" && (req.url === "/health" || req.url === "/v1/health")) {
    sendJson(res, { ok: true, mode });
    return;
  }

  const raw = await readBody(req);
  let parsed = {};
  try {
    parsed = raw ? JSON.parse(raw) : {};
  } catch {
    parsed = { parseError: true, raw };
  }
  log({ method: req.method, url: req.url, body: parsed });

  const messages = parsed.messages ?? parsed.input ?? [];
  const done = hasToolResult(messages);
  let payload;
  if (!done && mode === "permission") payload = permissionCall();
  else if (!done && mode === "context") payload = contextCall();
  else payload = textDone("sol-opencode-mock-done");

  if (parsed.stream === true) {
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = payload.choices[0].message;
    res.write(
      `data: ${JSON.stringify({
        id: payload.id,
        object: "chat.completion.chunk",
        choices: [{ index: 0, delta, finish_reason: payload.choices[0].finish_reason }],
      })}\n\n`,
    );
    res.write("data: [DONE]\n\n");
    res.end();
    return;
  }

  sendJson(res, payload);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`mock-provider ${mode} http://127.0.0.1:${port}\n`);
});
