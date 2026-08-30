const assert = require("node:assert/strict");
const http = require("node:http");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { after, before, test } = require("node:test");
const { contractSchema, validateContract } = require("../shared/contract");

const pluginDir = path.resolve(__dirname, "..");
let fixtureServer;
let fixtureOrigin;

function send(response, status, contentType, body) {
  response.writeHead(status, { "content-type": contentType, "cache-control": "no-store" });
  response.end(body);
}

before(async () => {
  fixtureServer = http.createServer((request, response) => {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/start") {
      send(response, 200, "text/html; charset=utf-8", `<!doctype html>
        <title>Start</title>
        <button id="load">Load data</button>
        <div class="account-row"><span>13900000000</span><span>Teacher</span><button onclick="window.open('/wrong')">模拟登录</button></div>
        <div class="account-row"><span>13900000000</span><span>Administrator</span><button onclick="window.open('/popup')">模拟登录</button></div>
        <button id="no-popup">No popup</button>
        <iframe id="details" name="details" src="/frame"></iframe>
        <img alt="" src="/binary">
        <script>
          document.querySelector('#load').onclick = () => {
            Promise.all([
              fetch('/api/data').then(response => response.json()),
              fetch('/api/many?i=1').then(response => response.json()),
              fetch('/api/many?i=2').then(response => response.json()),
              fetch('/api/mocked').then(response => response.json())
            ])
              .then(() => document.querySelector('#load').dataset.done = 'true');
          };
        </script>`);
      return;
    }
    if (url.pathname === "/frame") {
      send(response, 200, "text/html; charset=utf-8", "<!doctype html><h2>Frame details</h2><button>Frame action</button>");
      return;
    }
    if (url.pathname === "/popup") {
      send(response, 200, "text/html; charset=utf-8", "<!doctype html><title>Popup</title><main>Target account</main>");
      return;
    }
    if (url.pathname === "/wrong") {
      send(response, 200, "text/html; charset=utf-8", "<!doctype html><main>Wrong account</main>");
      return;
    }
    if (url.pathname === "/next") {
      send(response, 200, "text/html; charset=utf-8", "<!doctype html><title>Next page</title><main>Navigation complete</main>");
      return;
    }
    if (url.pathname === "/api/data") {
      send(response, 200, "application/json", JSON.stringify({ ok: true, source: "fixture" }));
      return;
    }
    if (url.pathname === "/api/many") {
      send(response, 200, "application/json", JSON.stringify({ id: Number(url.searchParams.get("i")) }));
      return;
    }
    if (url.pathname === "/binary") {
      send(response, 200, "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    send(response, 404, "text/plain", "not found");
  });
  await new Promise((resolve) => fixtureServer.listen(0, "127.0.0.1", resolve));
  fixtureOrigin = `http://127.0.0.1:${fixtureServer.address().port}`;
});

after(async () => {
  await new Promise((resolve) => fixtureServer.close(resolve));
});

function flowContract(id) {
  return {
    id,
    url: `${fixtureOrigin}/start`,
    captureResponses: [
      { url: "**/api/data", method: "GET", body: "json", as: "data" },
      { url: "**/api/many**", method: "GET", body: "json", as: "many", count: 2 },
      { url: "**/binary", body: "json", as: "binary", required: false },
    ],
    routes: [{ url: "**/api/mocked", method: "GET", json: { mocked: true } }],
    captureRouteCalls: true,
    steps: [
      { op: "click", target: { role: "button", name: "Load data" } },
      { op: "wait", target: { css: "#load[data-done=true]" } },
      {
        op: "readText",
        target: { text: "13900000000", within: { css: ".account-row", hasText: ["13900000000", "Administrator"] } },
        as: "phone",
      },
      {
        op: "readText",
        target: { role: "heading", name: "Frame details", frame: { css: "#details" } },
        as: "frameHeading",
      },
      {
        op: "evaluate",
        expression: "({ heading: document.querySelector('h2').textContent, seed: arg.seed })",
        arg: { seed: 7 },
        frame: { name: "details" },
        as: "frameEvaluation",
      },
      {
        op: "click",
        target: { role: "button", name: "模拟登录", within: { css: ".account-row", hasText: ["13900000000", "Administrator"] } },
        popup: "switch",
      },
      { op: "readText", target: { css: "main" }, as: "popupText" },
      { op: "goto", url: `${fixtureOrigin}/next` },
      { op: "evaluate", expression: "({ title: document.title, seed: arg })", arg: "ok", as: "pageEvaluation" },
    ],
    expect: [
      { url: `${fixtureOrigin}/next` },
      { target: { css: "main" }, text: "Navigation complete" },
    ],
    evidence: "ultra",
  };
}

function assertFlowResult(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.url, `${fixtureOrigin}/next`);
  assert.equal(result.outputs.phone, "13900000000");
  assert.equal(result.outputs.frameHeading, "Frame details");
  assert.deepEqual(result.outputs.frameEvaluation, { heading: "Frame details", seed: 7 });
  assert.equal(result.outputs.popupText, "Target account");
  assert.deepEqual(result.outputs.pageEvaluation, { title: "Next page", seed: "ok" });
  assert.deepEqual(result.outputs.data.body, { ok: true, source: "fixture" });
  assert.deepEqual(result.outputs.many.map((entry) => entry.body.id).sort(), [1, 2]);
  assert.equal(result.outputs.binary, null);
  assert(result.routeCalls.some((call) => call.url.endsWith("/api/mocked") && call.action === "fulfill"));
}

function missingPopupContract(id) {
  return {
    id,
    url: `${fixtureOrigin}/start`,
    timeoutMs: 100,
    steps: [
      { op: "readText", target: { css: "title" }, as: "title" },
      { op: "click", target: { css: "#no-popup" }, popup: "switch" },
    ],
  };
}

function assertMissingPopupResult(result) {
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "page");
  assert.deepEqual(result.stepResults.map(({ index, op, ok }) => ({ index, op, ok })), [
    { index: 0, op: "readText", ok: true },
    { index: 1, op: "click", ok: false },
  ]);
}

function lineClient(command, args, cwd) {
  const child = spawn(command, args, { cwd, env: process.env, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const waiters = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });
  const waitFor = (predicate, timeoutMs = 15_000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`Timed out waiting for child output. stderr: ${stderr}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  const write = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);
  const stop = async () => {
    child.stdin.end();
    await new Promise((resolve) => {
      if (child.exitCode !== null) resolve();
      else child.once("exit", resolve);
    });
  };
  return { child, waitFor, write, stop };
}

test("schema exposes scoped targets and validates new operations", () => {
  assert.equal(contractSchema.$defs.target.properties.within.$ref, "#/$defs/target");
  assert.equal(contractSchema.$defs.target.properties.frame.$ref, "#/$defs/frame");
  assert.equal(contractSchema.$defs.target.properties.hasText.oneOf.length, 2);
  assert.equal(contractSchema.$defs.target.oneOf.length, 6);
  assert.equal(contractSchema.$defs.frame.oneOf.length, 3);
  assert.equal(contractSchema.$defs.step.oneOf.length, 9);
  assert.equal(contractSchema.$defs.expectation.oneOf.length, 5);
  assert(contractSchema.$defs.step.properties.popup.enum.includes("switch"));
  assert(contractSchema.$defs.step.properties.op.enum.includes("goto"));
  assert(contractSchema.$defs.step.properties.op.enum.includes("evaluate"));
  validateContract(flowContract("validation"));
  assert.throws(
    () => validateContract({ steps: [{ op: "fill", target: { css: "input" }, popup: "switch" }] }),
    /popup is only supported for click/,
  );
  assert.throws(
    () => validateContract({ steps: [{ op: "evaluate", expression: "document.title", waitUntil: "load" }] }),
    /waitUntil requires/,
  );
  assert.throws(
    () => validateContract({ captureResponses: [{ url: "**/a", as: "same" }, { url: "**/b", as: "same" }] }),
    /as must be unique/,
  );
  assert.throws(
    () => validateContract({ steps: [{ op: "click", target: { css: "button", hasText: [] } }] }),
    /hasText must be a non-empty string or string array/,
  );
});

test("MCP entrypoint runs scoped popup, response, frame, goto, and evaluate flow", { timeout: 20_000 }, async () => {
  const client = lineClient("bash", ["scripts/start.sh"], pluginDir);
  try {
    client.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await client.waitFor((message) => message.id === 1);
    client.write({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await client.waitFor((message) => message.id === 2);
    const runTool = listed.result.tools.find((tool) => tool.name === "run");
    assert.equal(runTool.inputSchema.$defs.target.properties.within.$ref, "#/$defs/target");
    assert.equal(runTool.inputSchema.$defs.target.oneOf.length, 6);
    assert.equal(runTool.inputSchema.$defs.step.oneOf.length, 9);
    client.write({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run", arguments: flowContract("mcp") } });
    const reply = await client.waitFor((message) => message.id === 3);
    assert.equal(reply.result.isError, false, JSON.stringify(reply));
    assertFlowResult(JSON.parse(reply.result.content[0].text));
  } finally {
    await client.stop();
  }
});

test("JSONL entrypoint runs the same flow", { timeout: 20_000 }, async () => {
  const script = "skills/playwright-efficient/scripts/playwright_driver.sh";
  const client = lineClient("bash", [script], pluginDir);
  try {
    await client.waitFor((message) => message.type === "ready");
    client.write(flowContract("jsonl"));
    const result = await client.waitFor((message) => message.type === "result" && message.id === "jsonl");
    assertFlowResult(result);
    client.write(missingPopupContract("jsonl-missing-popup"));
    const failure = await client.waitFor((message) => message.type === "result" && message.id === "jsonl-missing-popup");
    assertMissingPopupResult(failure);
    client.write({ command: "close" });
    await client.waitFor((message) => message.type === "closed");
  } finally {
    await client.stop();
  }
});

test("MCP failure reports step progress and classifies a missing popup as page", { timeout: 20_000 }, async () => {
  const client = lineClient("bash", ["scripts/start.sh"], pluginDir);
  try {
    client.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await client.waitFor((message) => message.id === 1);
    client.write({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: {
        name: "run",
        arguments: missingPopupContract("missing-popup"),
      },
    });
    const reply = await client.waitFor((message) => message.id === 2);
    const result = JSON.parse(reply.result.content[0].text);
    assertMissingPopupResult(result);
  } finally {
    await client.stop();
  }
});
