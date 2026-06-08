const http = require("http");
const fs = require("fs");
const path = require("path");
const { spawn } = require("child_process");
const { URL } = require("url");

const PORT = Number(process.env.PORT || 3000);
const MAX_QUESTION_LENGTH = 8000;
const INDEX_FILE = path.join(__dirname, "index.html");

const MODELS = {
  chatgpt: {
    id: "chatgpt",
    name: "ChatGPT",
    args: (prompt, isNew = true, conversation = "") => {
      const arr = ["chatgpt", "ask", prompt, "--timeout", "120", "-f", "json"];
      if (conversation) {
        arr.push("--conversation", conversation);
      } else if (isNew) {
        arr.push("--new", "true");
      }
      return arr;
    },
    readArgs: () => ["chatgpt", "read", "--markdown", "true", "-f", "json"],
    statusArgs: () => ["chatgpt", "status", "-f", "plain"],
  },
  gemini: {
    id: "gemini",
    name: "Gemini",
    args: (prompt, isNew = true, conversation = "") => {
      const arr = ["gemini", "ask", prompt, "--timeout", "120", "-f", "json"];
      if (isNew) arr.push("--new", "true");
      return arr;
    },
    readArgs: () => ["gemini", "read", "-f", "json"],
    statusArgs: () => ["gemini", "new", "-f", "plain"],
    statusNote: "OpenCLI 1.8.0 does not expose `gemini status`; using `gemini new` as the Gemini availability/login check.",
  },
  grok: {
    id: "grok",
    name: "Grok",
    args: (prompt, isNew = true, conversation = "") => {
      const arr = ["grok", "ask", prompt, "--timeout", "120", "-f", "json"];
      if (isNew) arr.push("--new", "true");
      return arr;
    },
    readArgs: () => ["grok", "read", "--markdown", "true", "-f", "json"],
    statusArgs: () => ["grok", "status", "-f", "plain"],
  },
  deepseek: {
    id: "deepseek",
    name: "DeepSeek",
    args: (prompt, isNew = true, conversation = "") => {
      const arr = ["deepseek", "ask", prompt, "--timeout", "120", "-f", "json"];
      if (isNew) arr.push("--new", "true");
      return arr;
    },
    readArgs: () => ["deepseek", "read", "-f", "json"],
    statusArgs: () => ["deepseek", "status", "-f", "plain"],
  },
};

const activeRequests = new Map();
let upgradeInProgress = false;

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
  });
  res.end(body);
}

function runCommand(command, args, options = {}) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    const { timeoutMs = 120000, ...spawnOptions } = options;
    const child = spawn(command, args, {
      windowsHide: true,
      env: process.env,
      ...spawnOptions,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
    }, timeoutMs);

    function settle(result) {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolve({
        ...result,
        stdout,
        stderr,
        durationMs: Date.now() - startedAt,
      });
    }

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      settle({ ok: false, exitCode: null, signal: null, error: error.message });
    });

    child.on("close", (exitCode, signal) => {
      settle({
        ok: exitCode === 0,
        exitCode,
        signal,
        error: signal ? `Process ended with signal ${signal}` : "",
      });
    });
  });
}

function parseVersion(raw) {
  const match = String(raw).match(/\d+\.\d+\.\d+(?:[-+][\w.-]+)?/);
  return match ? match[0] : "";
}

function compareSemver(a, b) {
  const left = parseVersion(a).split(".").map((part) => Number.parseInt(part, 10) || 0);
  const right = parseVersion(b).split(".").map((part) => Number.parseInt(part, 10) || 0);

  for (let index = 0; index < 3; index += 1) {
    if (left[index] > right[index]) return 1;
    if (left[index] < right[index]) return -1;
  }

  return 0;
}

function getUpgradeCommand(opencliPath) {
  if (opencliPath.includes("/pnpm/")) {
    return { command: "pnpm", args: ["add", "-g", "@jackwener/opencli"], manager: "pnpm" };
  }

  return { command: "npm", args: ["install", "-g", "@jackwener/opencli"], manager: "npm" };
}

async function getOpenCliUpdateInfo() {
  const [pathResult, currentResult, latestResult] = await Promise.all([
    runCommand("which", ["opencli"], { timeoutMs: 10000 }),
    runCommand("opencli", ["--version"], { timeoutMs: 10000 }),
    runCommand("npm", ["view", "@jackwener/opencli", "version"], { timeoutMs: 30000 }),
  ]);

  const opencliPath = pathResult.stdout.trim();
  const currentVersion = parseVersion(currentResult.stdout || currentResult.stderr);
  const latestVersion = parseVersion(latestResult.stdout || latestResult.stderr);
  const canCompare = Boolean(currentVersion && latestVersion);
  const updateAvailable = canCompare && compareSemver(currentVersion, latestVersion) < 0;
  const upgrade = getUpgradeCommand(opencliPath);

  return {
    ok: pathResult.ok && currentResult.ok && latestResult.ok && canCompare,
    opencliPath,
    currentVersion,
    latestVersion,
    updateAvailable,
    upgradeManager: upgrade.manager,
    upgradeCommand: [upgrade.command, ...upgrade.args].join(" "),
    diagnostics: {
      path: pathResult,
      current: currentResult,
      latest: latestResult,
    },
  };
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function tryParseJson(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function normalizeRole(value) {
  return String(value || "").trim().toLowerCase();
}

function extractResponse(raw) {
  const text = String(raw || "").trim();
  const parsed = tryParseJson(text);
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row && typeof row === "object" && typeof row.response === "string") {
      return row.response;
    }
  }

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || typeof row !== "object") continue;
    const role = normalizeRole(row.Role || row.role);
    const body = row.Text || row.text || row.Response || row.response;
    if (role === "assistant" && typeof body === "string") {
      return body;
    }
  }

  return text;
}

function extractConversationId(raw) {
  const text = String(raw || "").trim();
  const parsed = tryParseJson(text);
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (row && typeof row === "object" && typeof row.conversationId === "string") {
      return row.conversationId;
    }
  }
  return "";
}

function extractLatestAssistant(raw) {
  const parsed = tryParseJson(String(raw || "").trim());
  const rows = Array.isArray(parsed) ? parsed : parsed ? [parsed] : [];

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row || typeof row !== "object") continue;
    const role = normalizeRole(row.Role || row.role);
    const body = row.Text || row.text || row.Response || row.response;
    if (role === "assistant" && typeof body === "string") {
      return body;
    }
  }

  return "";
}

function parseSelectedModels(rawModels) {
  if (!rawModels) return [];

  const ids = rawModels
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);

  return [...new Set(ids)];
}

function validateAskRequest(question, modelIds) {
  if (!question || !question.trim()) {
    return "Question cannot be empty.";
  }

  if (question.length > MAX_QUESTION_LENGTH) {
    return `Question cannot exceed ${MAX_QUESTION_LENGTH} characters.`;
  }

  if (modelIds.length === 0) {
    return "Select at least one model.";
  }

  const invalidModel = modelIds.find((id) => !MODELS[id]);
  if (invalidModel) {
    return `Unknown model: ${invalidModel}`;
  }

  return null;
}

function killRequest(requestId) {
  const request = activeRequests.get(requestId);
  if (!request) return false;

  request.cancelled = true;
  for (const child of request.children.values()) {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  }

  return true;
}

function isLoginCheckOk(exitCode, stdout) {
  if (exitCode !== 0) return false;
  return !/^\s*Login:\s*No\s*$/im.test(stdout);
}

function handleAsk(req, res, url) {
  const question = url.searchParams.get("question") || "";
  const modelIds = parseSelectedModels(url.searchParams.get("models") || "");
  const isNew = url.searchParams.get("new") !== "false";
  const conversation = url.searchParams.get("conversation") || "";
  const validationError = validateAskRequest(question, modelIds);

  if (validationError) {
    sendJson(res, 400, { error: validationError });
    return;
  }

  const requestId = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const requestState = {
    cancelled: false,
    children: new Map(),
    finishedModels: new Set(),
    latestResponses: new Map(),
    remaining: modelIds.length,
  };

  activeRequests.set(requestId, requestState);

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  sendSse(res, "request", { requestId, models: modelIds });

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);

  function finishModel(modelId) {
    if (requestState.finishedModels.has(modelId)) return;
    requestState.finishedModels.add(modelId);
    requestState.children.delete(modelId);
    requestState.remaining -= 1;

    if (requestState.remaining === 0) {
      clearInterval(heartbeat);
      activeRequests.delete(requestId);
      sendSse(res, "all_done", { requestId });
      res.end();
    }
  }

  res.on("close", () => {
    clearInterval(heartbeat);
    if (activeRequests.has(requestId)) {
      killRequest(requestId);
      activeRequests.delete(requestId);
    }
  });

  async function pollReadableAnswer(modelId, model) {
    if (!model.readArgs || requestState.cancelled) return;

    let lastText = "";
    let firstReadAt = 0;

    while (!requestState.cancelled && !requestState.finishedModels.has(modelId)) {
      await new Promise((resolve) => setTimeout(resolve, firstReadAt ? 1400 : 900));
      if (requestState.cancelled || requestState.finishedModels.has(modelId)) return;

      const readResult = await runCommand("opencli", model.readArgs(), { timeoutMs: 20000 });
      if (!readResult.ok) continue;

      const nextText = extractLatestAssistant(readResult.stdout);
      if (!nextText || nextText === lastText) continue;

      firstReadAt ||= Date.now();
      sendSse(res, "replace", {
        requestId,
        model: modelId,
        text: nextText,
      });
      requestState.latestResponses.set(modelId, nextText);
      lastText = nextText;
    }
  }

  for (const modelId of modelIds) {
    const model = MODELS[modelId];
    let stdout = "";
    let stderr = "";
    const child = spawn("opencli", model.args(question, isNew, conversation), {
      windowsHide: true,
      env: process.env,
    });

    requestState.children.set(modelId, child);
    sendSse(res, "start", { requestId, model: modelId, name: model.name });
    pollReadableAnswer(modelId, model);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      sendSse(res, "model_error", {
        requestId,
        model: modelId,
        message: error.message,
      });
      finishModel(modelId);
    });

    child.on("close", (exitCode, signal) => {
      if (requestState.cancelled) {
        sendSse(res, "model_error", {
          requestId,
          model: modelId,
          message: signal ? `Cancelled (${signal})` : "Cancelled",
        });
      } else if (exitCode && exitCode !== 0) {
        const stderrText = stderr.trim();
        sendSse(res, "model_error", {
          requestId,
          model: modelId,
          message: stderrText || `opencli exited with code ${exitCode}`,
        });
      } else if (stderr.trim()) {
        sendSse(res, "model_warning", {
          requestId,
          model: modelId,
          message: stderr.trim(),
        });
      }

      const responseText = extractResponse(stdout);
      const latestResponse = requestState.latestResponses.get(modelId) || "";
      if (responseText && (!latestResponse || responseText.length > latestResponse.length)) {
        sendSse(res, "replace", {
          requestId,
          model: modelId,
          text: responseText,
        });
        requestState.latestResponses.set(modelId, responseText);
      }

      const conversationId = extractConversationId(stdout);
      sendSse(res, "done", { requestId, model: modelId, exitCode, signal, conversationId });
      finishModel(modelId);
    });
  }
}

function handleCancel(res, url) {
  const requestId = url.searchParams.get("requestId") || "";
  if (!requestId) {
    sendJson(res, 400, { error: "requestId is required." });
    return;
  }

  const cancelled = killRequest(requestId);
  sendJson(res, cancelled ? 200 : 404, { requestId, cancelled });
}

function handleLoginCheck(req, res) {
  const requestId = `check-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const modelIds = Object.keys(MODELS);
  let remaining = modelIds.length;
  const children = new Map();

  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    "Connection": "keep-alive",
    "X-Accel-Buffering": "no",
  });

  sendSse(res, "check_request", { requestId, models: modelIds });

  const heartbeat = setInterval(() => {
    res.write(": heartbeat\n\n");
  }, 15000);

  function finishOne(modelId) {
    children.delete(modelId);
    remaining -= 1;

    if (remaining === 0) {
      clearInterval(heartbeat);
      sendSse(res, "check_all_done", { requestId });
      res.end();
    }
  }

  req.on("close", () => {
    clearInterval(heartbeat);
    for (const child of children.values()) {
      if (!child.killed) child.kill("SIGTERM");
    }
  });

  for (const modelId of modelIds) {
    const model = MODELS[modelId];
    const startedAt = Date.now();
    let stdout = "";
    let stderr = "";

    sendSse(res, "check_start", {
      requestId,
      model: modelId,
      name: model.name,
      command: ["opencli", ...model.statusArgs()].join(" "),
      note: model.statusNote || "",
    });

    const child = spawn("opencli", model.statusArgs(), {
      windowsHide: true,
      env: process.env,
    });

    children.set(modelId, child);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      sendSse(res, "check_result", {
        requestId,
        model: modelId,
        name: model.name,
        ok: false,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        error: error.message,
        note: model.statusNote || "",
      });
      finishOne(modelId);
    });

    child.on("close", (exitCode, signal) => {
      const ok = isLoginCheckOk(exitCode, stdout);

      sendSse(res, "check_result", {
        requestId,
        model: modelId,
        name: model.name,
        ok,
        exitCode,
        signal,
        durationMs: Date.now() - startedAt,
        stdout,
        stderr,
        error: "",
        note: model.statusNote || "",
      });
      finishOne(modelId);
    });
  }
}

async function handleOpenCliUpdateCheck(res) {
  try {
    const info = await getOpenCliUpdateInfo();
    sendJson(res, info.ok ? 200 : 500, info);
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  }
}

async function handleOpenCliUpgrade(res) {
  if (upgradeInProgress) {
    sendJson(res, 409, { ok: false, error: "OpenCLI upgrade is already running." });
    return;
  }

  upgradeInProgress = true;

  try {
    const before = await getOpenCliUpdateInfo();
    if (!before.ok) {
      sendJson(res, 500, { ok: false, error: "Could not check OpenCLI version.", before });
      return;
    }

    if (!before.updateAvailable) {
      sendJson(res, 200, { ok: true, changed: false, before, after: before, upgrade: null });
      return;
    }

    const upgrade = getUpgradeCommand(before.opencliPath);
    const upgradeResult = await runCommand(upgrade.command, upgrade.args, { timeoutMs: 180000 });
    const after = await getOpenCliUpdateInfo();
    const ok = upgradeResult.ok && after.ok;

    sendJson(res, ok ? 200 : 500, {
      ok,
      changed: before.currentVersion !== after.currentVersion,
      before,
      after,
      upgrade: {
        manager: upgrade.manager,
        command: [upgrade.command, ...upgrade.args].join(" "),
        result: upgradeResult,
      },
    });
  } catch (error) {
    sendJson(res, 500, { ok: false, error: error.message });
  } finally {
    upgradeInProgress = false;
  }
}

function handleModels(res) {
  sendJson(res, 200, {
    models: Object.values(MODELS).map((model) => ({
      id: model.id,
      name: model.name,
      selected: true,
    })),
  });
}

function handleStatic(res, url) {
  if (url.pathname !== "/" && url.pathname !== "/index.html") {
    sendJson(res, 404, { error: "Not found." });
    return;
  }

  fs.readFile(INDEX_FILE, (error, data) => {
    if (error) {
      sendJson(res, 500, { error: "Could not read index.html." });
      return;
    }

    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);

  if (req.method === "GET" && url.pathname === "/ask") {
    handleAsk(req, res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/check-logins") {
    handleLoginCheck(req, res);
    return;
  }

  if (req.method === "GET" && url.pathname === "/check-opencli-update") {
    handleOpenCliUpdateCheck(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/upgrade-opencli") {
    handleOpenCliUpgrade(res);
    return;
  }

  if (req.method === "POST" && url.pathname === "/cancel") {
    handleCancel(res, url);
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/models") {
    handleModels(res);
    return;
  }

  if (req.method === "GET") {
    handleStatic(res, url);
    return;
  }

  sendJson(res, 405, { error: "Method not allowed." });
});

server.listen(PORT, () => {
  console.log(`Ask All AI is running at http://localhost:${PORT}`);
});
