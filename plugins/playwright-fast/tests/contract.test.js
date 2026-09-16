const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");
const { after, before, test } = require("node:test");
const {
  DEFAULT_VIEWPORT,
  FlowRuntime,
  MAX_CONTRACT_BUDGET_MS,
  MAX_OPERATION_TIMEOUT_MS,
  contractSchema,
  resolveViewport,
  screenshotTimeoutMs,
  validateContract,
} = require("../shared/contract");

const pluginDir = path.resolve(__dirname, "..");
const runtimeSpec = JSON.parse(fs.readFileSync(path.join(pluginDir, "runtime.json"), "utf8"));
const credentialedMockUrl = "http://127.0.0.1:1/api/credentialed";
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
        <input id="seed-value" value="seed">
        <input placeholder="Repeated field" hidden>
        <input id="visible-repeated" placeholder="Repeated field">
        <input id="upload" type="file" multiple hidden>
        <div id="custom-select" class="el-select" style="position:relative;width:180px;height:32px" onclick="this.dataset.clicks = String(Number(this.dataset.clicks || 0) + 1)">
          <input id="custom-combobox" readonly role="combobox" style="width:180px;height:32px">
          <span style="position:absolute;inset:0">Choose stage</span>
        </div>
        <uni-button id="custom-save"><uni-view class="wd-button__text">保存</uni-view></uni-button>
        <div id="custom-cancel" class="uni-modal__btn uni-modal__btn_default"><span class="uni-modal__btn-text">取消</span></div>
        <div id="custom-ai" class="ai-btn"><span>AI 生成</span></div>
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
              fetch('/api/mocked').then(response => response.json()),
              fetch('${credentialedMockUrl}', {
                credentials: 'include',
                headers: { 'x-playwright-fixture': 'credentialed' }
              }).then(response => response.json())
            ])
              .then(() => document.querySelector('#load').dataset.done = 'true');
          };
          document.querySelector('#custom-save').onclick = (event) => event.currentTarget.dataset.clicked = 'true';
          document.querySelector('#custom-cancel').onclick = (event) => event.currentTarget.dataset.clicked = 'true';
          document.querySelector('#custom-ai').onclick = (event) => event.currentTarget.dataset.clicked = 'true';
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
    if (url.pathname === "/spa") {
      send(response, 200, "text/html; charset=utf-8", `<!doctype html><main id="route"></main><script>
        const render = () => {
          const route = document.querySelector('#route');
          route.dataset.hash = location.hash;
          route.textContent = location.hash;
          if (location.hash !== '#/one') {
            route.dataset.requested = 'true';
            fetch('/api/hash?value=' + encodeURIComponent(location.hash))
              .then(response => response.json().then(() => response))
              .then(response => {
                route.dataset.completed = 'true';
                route.dataset.responseUrl = response.url;
                route.dataset.status = String(response.status);
              })
              .catch(error => { route.dataset.error = error.message; });
          }
        };
        addEventListener('hashchange', render);
        render();
      </script>`);
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
    if (url.pathname === "/api/hash") {
      send(response, 200, "application/json", JSON.stringify({ value: url.searchParams.get("value") }));
      return;
    }
    if (url.pathname === "/binary") {
      send(response, 200, "image/png", Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      return;
    }
    if (url.pathname === "/empty") {
      response.writeHead(204, { "cache-control": "no-store" });
      response.end();
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
    routes: [
      { url: "**/api/mocked", method: "GET", json: { mocked: true } },
      { url: credentialedMockUrl, method: "GET", cors: true, json: { credentialed: true } },
    ],
    captureRouteCalls: true,
    steps: [
      { op: "click", target: { role: "button", name: "Load data" } },
      { op: "wait", target: { css: "#load[data-done=true]" } },
      { op: "readValue", target: { css: "#seed-value" }, as: "seedValue" },
      { op: "click", target: { text: "保存" }, timeoutMs: 500 },
      { op: "click", target: { role: "button", name: "取消" }, timeoutMs: 500 },
      { op: "click", target: { role: "button", name: "AI 生成" }, timeoutMs: 500 },
      { op: "readAttribute", target: { css: "#custom-save" }, attribute: "data-clicked", as: "customSaveClicked", timeoutMs: 500 },
      { op: "readAttribute", target: { css: "#custom-cancel" }, attribute: "data-clicked", as: "customCancelClicked", timeoutMs: 500 },
      { op: "readAttribute", target: { css: "#custom-ai" }, attribute: "data-clicked", as: "customAiClicked", timeoutMs: 500 },
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
        expression: "arg => ({ heading: document.querySelector('h2').textContent, seed: arg.seed })",
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
  assert.equal(result.outputs.seedValue, "seed");
  assert.equal(result.outputs.customSaveClicked, "true");
  assert.equal(result.outputs.customCancelClicked, "true");
  assert.equal(result.outputs.customAiClicked, "true");
  assert.deepEqual(result.locatorFallbacks, [
    { index: 3, strategy: "text-interactive-ancestor" },
    { index: 4, strategy: "button-name-interactive-ancestor" },
    { index: 5, strategy: "button-name-interactive-ancestor" },
  ]);
  assert.equal(result.outputs.frameHeading, "Frame details");
  assert.deepEqual(result.outputs.frameEvaluation, { heading: "Frame details", seed: 7 });
  assert.equal(result.outputs.popupText, "Target account");
  assert.deepEqual(result.outputs.pageEvaluation, { title: "Next page", seed: "ok" });
  assert.deepEqual(result.outputs.data.body, { ok: true, source: "fixture" });
  assert.deepEqual(result.outputs.many.map((entry) => entry.body.id).sort(), [1, 2]);
  assert.equal(result.outputs.binary, null);
  assert(result.routeCalls.some((call) => call.url.endsWith("/api/mocked") && call.action === "fulfill" && call.status === 200));
  assert(result.routeCalls.some((call) => call.url === credentialedMockUrl && call.action === "fulfill" && call.status === 200));
}

function assertErgonomicResult(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.outputs.repeated, "filled");
  assert.equal(result.outputs.clicks, "2");
  assert.deepEqual(result.outputs.uploadedFiles, ["runtime.json"]);
  assert.equal(result.outputs.boundedText.length, 32);
  assert.match(result.outputs.boundedText, /\.\.\.\[truncated\]$/);
  assert.deepEqual(result.locatorFallbacks, [
    { index: 0, strategy: "unique-visible-match" },
    { index: 1, strategy: "unique-visible-match" },
    { index: 2, strategy: "placeholder-text" },
    { index: 3, strategy: "readonly-control-ancestor" },
  ]);
}

function assertHashNavigationResult(result) {
  assert.equal(result.ok, true, JSON.stringify(result));
  assert.equal(result.outputs.route, "#/two");
  assert.deepEqual(result.outputs.hashes.map((entry) => entry.body.value), ["#/middle", "#/two"]);
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

function requestFailureContract(id) {
  return {
    id,
    timeoutMs: 200,
    steps: [
      {
        op: "setContent",
        html: "<!doctype html><main>Network probe</main><script>fetch('http://127.0.0.1:1/unhandled?token=secret').then(() => document.body.dataset.done = 'true').catch(() => {})<\/script>",
      },
      { op: "readText", target: { css: "main" }, as: "probe" },
      { op: "wait", target: { css: "body[data-done=true]" } },
    ],
  };
}

function viewportContract(id, viewport) {
  return {
    id,
    ...(viewport ? { viewport } : {}),
    steps: [
      { op: "setContent", html: "<!doctype html><main>Viewport probe</main>" },
      { op: "evaluate", expression: "({ width: innerWidth, height: innerHeight })", as: "viewport" },
    ],
  };
}

function ergonomicContract(id) {
  return {
    id,
    url: `${fixtureOrigin}/start`,
    steps: [
      { op: "fill", target: { placeholder: "Repeated field" }, text: "filled" },
      { op: "readValue", target: { placeholder: "Repeated field" }, as: "repeated" },
      { op: "click", target: { placeholder: "Choose stage" } },
      { op: "click", target: { css: "#custom-combobox" } },
      { op: "readAttribute", target: { css: "#custom-select" }, attribute: "data-clicks", as: "clicks" },
      { op: "setInputFiles", target: { css: "#upload" }, files: [path.resolve(pluginDir, "runtime.json")] },
      { op: "evaluate", expression: "Array.from(document.querySelector('#upload').files, file => file.name)", as: "uploadedFiles" },
      { op: "readText", target: { css: "body" }, maxChars: 32, as: "boundedText" },
      { op: "waitForTimeout", timeoutMs: 5 },
      { op: "reload" },
      { op: "wait", target: { css: "#custom-select" } },
    ],
  };
}

function hashNavigationContract(id) {
  return {
    id,
    url: `${fixtureOrigin}/spa#/one`,
    captureResponses: [
      { url: "**/api/hash*", method: "GET", body: "json", as: "hashes", count: 2, timeoutMs: 2000 },
    ],
    steps: [
      { op: "goto", url: `${fixtureOrigin}/spa#/middle` },
      { op: "goto", url: `${fixtureOrigin}/spa#/two` },
      { op: "readText", target: { css: "#route" }, as: "route" },
    ],
  };
}

function assertRequestFailureEvidence(result) {
  assert.equal(result.ok, false);
  assert.equal(result.failureKind, "locator");
  assert.equal(result.outputs.probe, "Network probe");
  assert(result.requestFailures.some((failure) => failure.resourceType === "fetch" && failure.url.endsWith("/unhandled")));
  assert(!JSON.stringify(result.requestFailures).includes("secret"));
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

test("bundles the MCP and JSONL entrypoints used by the Playwright skill", () => {
  const skillsDir = path.join(pluginDir, "skills");
  const skillDir = path.join(skillsDir, "playwright");
  const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, ".codex-plugin", "plugin.json"), "utf8"));

  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(fs.existsSync(path.join(skillDir, "SKILL.md")), true);
  assert.equal(fs.existsSync(path.join(skillDir, "references", "fallbacks.md")), true);
  assert.equal(fs.existsSync(path.join(skillDir, "scripts", "playwright_driver.sh")), true);
});

test("schema exposes scoped targets and validates new operations", () => {
  assert.equal(contractSchema.$defs.target.properties.within.$ref, "#/$defs/target");
  assert.equal(contractSchema.$defs.target.properties.frame.$ref, "#/$defs/frame");
  assert.equal(contractSchema.$defs.target.properties.hasText.oneOf.length, 2);
  assert.equal(contractSchema.properties.steps.items.type, "object");
  assert.equal(contractSchema.properties.steps.items.properties.target.type, "object");
  assert.equal(contractSchema.properties.routes.items.type, "object");
  assert.equal(contractSchema.properties.expect.items.type, "object");
  assert.equal(contractSchema.properties.ready.type, "object");
  assert.equal(contractSchema.properties.routes.items.additionalProperties, false);
  assert.equal(contractSchema.$defs.target.properties.name.type, "string");
  assert.equal(contractSchema.properties.steps.items.properties.timeoutMs.maximum, MAX_OPERATION_TIMEOUT_MS);
  assert(contractSchema.properties.steps.items.properties.popup.enum.includes("switch"));
  assert(contractSchema.properties.steps.items.properties.op.enum.includes("goto"));
  assert(contractSchema.properties.steps.items.properties.op.enum.includes("reload"));
  assert(contractSchema.properties.steps.items.properties.op.enum.includes("waitForTimeout"));
  assert(contractSchema.properties.steps.items.properties.op.enum.includes("setInputFiles"));
  assert(contractSchema.properties.steps.items.properties.op.enum.includes("evaluate"));
  assert(contractSchema.properties.steps.items.properties.op.enum.includes("readValue"));
  assert.equal(contractSchema.properties.steps.items.properties.text.type, "string");
  assert.equal(contractSchema.properties.steps.items.properties.maxChars.type, "integer");
  assert.equal(contractSchema.properties.steps.items.properties.ms.maximum, MAX_OPERATION_TIMEOUT_MS);
  assert.match(contractSchema.properties.ready.description, /nest the locator under target/);
  assert.match(contractSchema.properties.routes.description, /scoped to this run/);
  validateContract(flowContract("validation"));
  validateContract(ergonomicContract("ergonomic-validation"));
  validateContract({ ready: { target: { text: "Ready" }, state: "visible" } });
  validateContract({ steps: [{ op: "fill", target: { css: "input" }, text: "value", first: true }] });
  validateContract({ steps: [{ op: "reload", waitUntil: "load" }] });
  validateContract({ steps: [{ op: "waitForTimeout", timeoutMs: 10 }] });
  validateContract({ steps: [{ op: "setInputFiles", target: { css: "input[type=file]" }, paths: ["/tmp/example.txt"] }] });
  validateContract({ timeoutMs: 20000, steps: [{ op: "readAllText", target: { css: "body" }, timeoutMs: 15000 }] });
  validateContract({
    url: "http://127.0.0.1:3000/app#/one",
    timeoutMs: 30000,
    navigationTimeoutMs: 15000,
    steps: [
      { op: "waitForTimeout", ms: 1000 },
      { op: "goto", url: "http://127.0.0.1:3000/app#/two", timeoutMs: 30000 },
      { op: "waitForTimeout", ms: 1500 },
      { op: "readAllText" },
    ],
  });
  validateContract({ steps: [{ op: "readAllText", as: "pageText", maxChars: 1000 }] });
  validateContract({ steps: [{ op: "evaluate", target: { css: "select" }, expression: "element => element.value" }] });
  validateContract({ expect: [{ title: "human label", target: { css: "main" }, state: "visible" }] });
  validateContract({
    steps: [
      { op: "click", target: { css: "button" } },
      { op: "goto", url: "http://app.test/one" },
      { op: "wait", target: { css: "body" }, timeoutMs: 5000 },
      { op: "goto", url: "http://app.test/two" },
      { op: "wait", target: { css: "main" }, timeoutMs: 10000 },
      { op: "evaluate", expression: "document.title" },
    ],
    captureResponses: [
      { url: "**/save", as: "saved", timeoutMs: 10000 },
      { url: "**/restore", as: "restored", timeoutMs: 10000 },
    ],
  });
  assert.throws(
    () => validateContract({ ready: { text: "Ready", state: "visible" } }),
    /ready target is required/,
  );
  assert.throws(
    () => validateContract({ steps: [{ op: "fill", target: { css: "input" }, popup: "switch" }] }),
    /popup is only supported for click/,
  );
  assert.throws(
    () => validateContract({ steps: [{ op: "fill", target: { css: "input" } }] }),
    /value or steps\[0\]\.text must be a string for fill/,
  );
  assert.throws(
    () => validateContract({ steps: [{ op: "type", target: { css: "input" } }] }),
    /value or steps\[0\]\.text must be a string for type/,
  );
  assert.throws(
    () => validateContract({ steps: [{ op: "setInputFiles", target: { css: "input[type=file]" }, files: [] }] }),
    /files must be a non-empty string array/,
  );
  assert.throws(
    () => validateContract({ steps: [{ op: "press", target: { css: "input" } }] }),
    /key must be a non-empty string/,
  );
  assert.throws(
    () => validateContract({ steps: [{ op: "select", target: { css: "select" } }] }),
    /value is required for select/,
  );
  assert.throws(
    () => validateContract({ steps: [{ op: "click", target: { role: "button", name: false } }] }),
    /name must be a non-empty string/,
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
  assert.throws(
    () => validateContract({ steps: [{ op: "wait", ms: MAX_OPERATION_TIMEOUT_MS + 1 }] }),
    /must not exceed/,
  );
  assert.throws(
    () => validateContract({ steps: Array.from({ length: 5 }, () => ({ op: "wait", ms: MAX_OPERATION_TIMEOUT_MS })) }),
    new RegExp(`exceeds ${MAX_CONTRACT_BUDGET_MS}ms`),
  );
  validateContract({ steps: [{ op: "readAllText", target: { css: "li" }, timeoutMs: 10 }] });
  assert.throws(
    () => validateContract({ routes: [{ url: "**/api", json: {}, body: "duplicate" }] }),
    /exactly one of json, body, or abort/,
  );
  assert.throws(
    () => validateContract({ routes: [{ url: "**/api", body: { ok: true } }] }),
    /use routes\[0\]\.json for objects or arrays/,
  );
});

test("read operations pass supported per-step timeouts to Playwright", async () => {
  const calls = [];
  const locator = {
    count: async () => 1,
    textContent: async (options) => { calls.push(["textContent", options]); return "text"; },
    getAttribute: async (name, options) => { calls.push(["getAttribute", name, options]); return "value"; },
    inputValue: async (options) => { calls.push(["inputValue", options]); return "input"; },
    boundingBox: async (options) => { calls.push(["boundingBox", options]); return { x: 0, y: 0, width: 1, height: 1 }; },
    evaluate: async (_callback, properties, options) => { calls.push(["evaluate", properties, options]); return { color: "red" }; },
  };
  const flow = new FlowRuntime({ context: {}, page: { locator: () => locator } });
  const outputs = {};

  await flow.runStep({ op: "readText", target: { css: "main" }, timeoutMs: 75 }, outputs);
  await flow.runStep({ op: "readAttribute", target: { css: "main" }, attribute: "data-id", timeoutMs: 80 }, outputs);
  await flow.runStep({ op: "readValue", target: { css: "input" }, timeoutMs: 82, as: "input" }, outputs);
  await flow.runStep({ op: "readBoundingBox", target: { css: "main" }, timeoutMs: 85 }, outputs);
  await flow.runStep({ op: "readComputedStyle", target: { css: "main" }, properties: ["color"], timeoutMs: 90 }, outputs);

  assert.deepEqual(calls, [
    ["textContent", { timeout: 75 }],
    ["getAttribute", "data-id", { timeout: 80 }],
    ["inputValue", { timeout: 82 }],
    ["boundingBox", { timeout: 85 }],
    ["evaluate", ["color"], { timeout: 90 }],
  ]);
  assert.equal(outputs.input, "input");
});

test("response capture timeouts share one run-relative deadline", async () => {
  const context = new EventEmitter();
  const flow = new FlowRuntime({ context, page: {} });
  const capture = flow.installResponseCaptures({
    captureResponses: [
      { url: "**/first", as: "first", timeoutMs: 60 },
      { url: "**/second", as: "second", timeoutMs: 60 },
    ],
  }, {}, 2000);
  const started = performance.now();
  await assert.rejects(capture.wait(), /Timed out after 60ms/);
  const elapsedMs = performance.now() - started;
  capture.dispose();
  assert(elapsedMs < 105, `response waits took ${elapsedMs}ms and appear serial`);
});

test("empty response bodies are captured without a protocol-body failure", async () => {
  const listeners = new Map();
  const context = {
    on: (name, handler) => listeners.set(name, handler),
    off: (name) => listeners.delete(name),
  };
  const flow = new FlowRuntime({ context, page: {} });
  const outputs = {};
  const capture = flow.installResponseCaptures({
    captureResponses: [{ url: "**/empty", body: "text", as: "empty" }],
  }, outputs, 100);
  listeners.get("response")({
    url: () => "http://app.test/empty",
    status: () => 204,
    headers: () => ({}),
    headerValue: async () => null,
    body: async () => { throw new Error("body should not be read for 204"); },
    request: () => ({ method: () => "GET" }),
  });
  await capture.wait();
  capture.dispose();
  assert.deepEqual(outputs.empty, { url: "http://app.test/empty", method: "GET", status: 204, body: "" });
});

test("continuations preserve viewport and screenshots use the navigation timeout floor", () => {
  const mobile = { width: 375, height: 813 };
  assert.deepEqual(resolveViewport({ steps: [{ op: "click" }] }, mobile), mobile);
  assert.deepEqual(resolveViewport({ url: "http://app.test" }, mobile), DEFAULT_VIEWPORT);
  assert.deepEqual(resolveViewport({ steps: [{ op: "goto" }] }, mobile), DEFAULT_VIEWPORT);
  assert.deepEqual(resolveViewport({ steps: [{ op: "setContent" }] }, mobile), DEFAULT_VIEWPORT);
  assert.equal(screenshotTimeoutMs(2000, 5000), 5000);
  assert.equal(screenshotTimeoutMs(8000, 5000), 8000);
});

test("MCP host timeout leaves margin above the bounded contract budget", () => {
  const config = JSON.parse(fs.readFileSync(path.join(pluginDir, ".mcp.json"), "utf8"));
  assert(config.mcpServers["playwright-fast"].tool_timeout_sec * 1000 > MAX_CONTRACT_BUDGET_MS);
});

test("route glob makes query requirements explicit", async () => {
  let handler;
  const context = {
    route: async (_pattern, nextHandler) => { handler = nextHandler; },
  };
  const flow = new FlowRuntime({ context, page: {} });
  const dispatch = async (url) => {
    let action;
    await handler({
      request: () => ({
        method: () => "GET",
        url: () => url,
        resourceType: () => "fetch",
        headers: () => ({}),
        postData: () => null,
      }),
      continue: async () => { action = "continue"; },
      fulfill: async () => { action = "fulfill"; },
    });
    return action;
  };

  await flow.installNetworkRules({
    routes: [{ url: "**/toc/orders?*", method: "GET", json: {} }],
  }, []);
  assert.equal(await dispatch("http://api.test/toc/orders"), "continue");
  assert.equal(await dispatch("http://api.test/toc/orders?page=1"), "fulfill");

  await flow.installNetworkRules({
    routes: [{ url: "**/toc/orders*", method: "GET", json: {} }],
  }, []);
  assert.equal(await dispatch("http://api.test/toc/orders"), "fulfill");
  assert.equal(await dispatch("http://api.test/toc/orders?page=1"), "fulfill");
});

test("credentialed preflight selects the matching method rule and records status", async () => {
  let handler;
  const context = {
    route: async (_pattern, nextHandler) => { handler = nextHandler; },
  };
  const flow = new FlowRuntime({ context, page: {} });
  const routeCalls = [];
  await flow.installNetworkRules({
    captureRouteCalls: true,
    routes: [
      { url: "**/api/profile", method: "GET", cors: true, headers: { "x-selected-rule": "get" }, json: {} },
      { url: "**/api/profile", method: "POST", cors: true, headers: { "x-selected-rule": "post" }, json: {} },
    ],
  }, routeCalls);

  let fulfillment;
  await handler({
    request: () => ({
      method: () => "OPTIONS",
      url: () => "http://api.test/api/profile",
      resourceType: () => "fetch",
      headers: () => ({
        origin: "http://app.test",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, x-client",
      }),
    }),
    fulfill: async (options) => { fulfillment = options; },
  });

  assert.equal(fulfillment.status, 204);
  assert.equal(fulfillment.headers["access-control-allow-origin"], "http://app.test");
  assert.equal(fulfillment.headers["access-control-allow-credentials"], "true");
  assert.equal(fulfillment.headers["access-control-allow-methods"], "POST, OPTIONS");
  assert.equal(fulfillment.headers["x-selected-rule"], "post");
  assert.deepEqual(routeCalls, [{
    method: "OPTIONS",
    url: "http://api.test/api/profile",
    action: "cors-preflight",
    status: 204,
  }]);

  let wildcardHandler;
  const wildcardFlow = new FlowRuntime({
    context: { route: async (_pattern, nextHandler) => { wildcardHandler = nextHandler; } },
    page: {},
  });
  await wildcardFlow.installNetworkRules({
    routes: [{ url: "**/api/wildcard", cors: true, json: {} }],
  }, []);
  let wildcardFulfillment;
  await wildcardHandler({
    request: () => ({
      method: () => "OPTIONS",
      url: () => "http://api.test/api/wildcard",
      resourceType: () => "fetch",
      headers: () => ({
        origin: "http://app.test",
        "access-control-request-method": "POST",
      }),
    }),
    fulfill: async (options) => { wildcardFulfillment = options; },
  });
  assert.equal(wildcardFulfillment.headers["access-control-allow-methods"], "POST, OPTIONS");
});

test("MCP entrypoint runs scoped popup, response, frame, goto, and evaluate flow", { timeout: 20_000 }, async () => {
  const client = lineClient("bash", ["scripts/start.sh"], pluginDir);
  try {
    client.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    const initialized = await client.waitFor((message) => message.id === 1);
    const manifest = JSON.parse(fs.readFileSync(path.join(pluginDir, ".codex-plugin", "plugin.json"), "utf8"));
    assert.equal(initialized.result.serverInfo.version, manifest.version);
    client.write({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
    const listed = await client.waitFor((message) => message.id === 2);
    const runTool = listed.result.tools.find((tool) => tool.name === "run");
    assert.equal(runTool.inputSchema.$defs.target.properties.within.$ref, "#/$defs/target");
    assert.equal(runTool.inputSchema.properties.steps.items.type, "object");
    assert.equal(runTool.inputSchema.properties.steps.items.properties.target.type, "object");
    assert.equal(runTool.inputSchema.properties.routes.items.type, "object");
    client.write({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "run", arguments: flowContract("mcp") } });
    const reply = await client.waitFor((message) => message.id === 3);
    assert.equal(reply.result.isError, false, JSON.stringify(reply));
    assertFlowResult(JSON.parse(reply.result.content[0].text));
    client.write({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "run", arguments: viewportContract("mcp-mobile", { width: 375, height: 667 }) } });
    const mobile = JSON.parse((await client.waitFor((message) => message.id === 4)).result.content[0].text);
    assert.deepEqual(mobile.viewport, { width: 375, height: 667 });
    client.write({ jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "run", arguments: { id: "mcp-continuation", steps: [{ op: "evaluate", expression: "({ width: innerWidth, height: innerHeight })", as: "viewport" }] } } });
    const continuation = JSON.parse((await client.waitFor((message) => message.id === 5)).result.content[0].text);
    assert.deepEqual(continuation.viewport, { width: 375, height: 667 });
    assert.deepEqual(continuation.outputs.viewport, { width: 375, height: 667 });
    client.write({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "run", arguments: viewportContract("mcp-default") } });
    const desktop = JSON.parse((await client.waitFor((message) => message.id === 6)).result.content[0].text);
    assert.deepEqual(desktop.viewport, DEFAULT_VIEWPORT);
    assert.deepEqual(desktop.outputs.viewport, DEFAULT_VIEWPORT);
    client.write({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "status", arguments: {} } });
    const status = JSON.parse((await client.waitFor((message) => message.id === 7)).result.content[0].text);
    assert.equal(status.version, manifest.version);
    assert.equal(status.playwrightVersion, runtimeSpec.playwrightVersion);
    assert.equal(status.chromiumRevision, runtimeSpec.chromiumRevision);
    assert.equal(status.chromiumVersion, runtimeSpec.chromiumVersion);
    assert.equal(status.browserSource, "playwright-managed");
    assert.equal(fs.existsSync(status.browserExecutablePath), true);
    assert.deepEqual(status.viewport, DEFAULT_VIEWPORT);
    client.write({ jsonrpc: "2.0", id: 8, method: "tools/call", params: { name: "run", arguments: ergonomicContract("mcp-ergonomic") } });
    const ergonomic = JSON.parse((await client.waitFor((message) => message.id === 8)).result.content[0].text);
    assertErgonomicResult(ergonomic);
    client.write({ jsonrpc: "2.0", id: 9, method: "tools/call", params: { name: "run", arguments: hashNavigationContract("mcp-hash") } });
    const hashNavigation = JSON.parse((await client.waitFor((message) => message.id === 9)).result.content[0].text);
    assertHashNavigationResult(hashNavigation);
    client.write({
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: {
        name: "run",
        arguments: {
          id: "mcp-label-fallback",
          steps: [
            { op: "setContent", html: "<label>订单状态 <select><option>待付款</option><option>已付款</option></select></label><button onclick='this.dataset.clicked=\"yes\"'>选择学段</button><table><tbody><tr><td>已付款</td></tr></tbody></table><div id='count'>1</div>" },
            { op: "select", target: { label: "订单状态" }, value: "待付款" },
            { op: "click", target: { label: "订单状态" } },
            { op: "click", target: { text: "已付款" } },
            { op: "readValue", target: { label: "订单状态" }, as: "status" },
            { op: "readAllText", as: "pageText", timeoutMs: 1000 },
            { op: "evaluate", target: { label: "订单状态" }, expression: "element => Array.from(element.options, option => option.text)", as: "options" },
            { op: "click", target: { text: "学段" } },
            { op: "readValue", target: { css: "#count" }, as: "count" },
          ],
          expect: [{ title: "selected status", target: { label: "订单状态" }, value: "已付款" }],
        },
      },
    });
    const labelFallback = JSON.parse((await client.waitFor((message) => message.id === 10)).result.content[0].text);
    assert.equal(labelFallback.ok, true, JSON.stringify(labelFallback));
    assert.equal(labelFallback.outputs.status, "已付款");
    assert(labelFallback.outputs.pageText[0].includes("已付款"));
    assert.deepEqual(labelFallback.outputs.options, ["待付款", "已付款"]);
    assert.equal(labelFallback.outputs.count, "1");
    assert.equal(labelFallback.observations[0].label, "selected status");
    assert.deepEqual(labelFallback.locatorFallbacks, [
      { index: 1, strategy: "label-substring" },
      { index: 2, strategy: "label-substring" },
      { index: 3, strategy: "option-click-select" },
      { index: 4, strategy: "label-substring" },
      { index: 7, strategy: "text-substring" },
      { index: 8, strategy: "read-value-text-content" },
    ]);
  } finally {
    await client.stop();
  }
});

test("JSONL fallback starts, runs a compact flow, and keeps artifact paths unique", { timeout: 20_000 }, async () => {
  const script = "skills/playwright/scripts/playwright_driver.sh";
  const client = lineClient("bash", [script], pluginDir);
  const screenshotPaths = [];
  try {
    await client.waitFor((message) => message.type === "ready");
    client.write({ id: "jsonl-smoke", steps: [{ op: "setContent", html: "<main>JSONL ready</main>" }, { op: "readText", target: { css: "main" }, as: "text" }] });
    const result = await client.waitFor((message) => message.type === "result" && message.id === "jsonl-smoke");
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.outputs.text, "JSONL ready");
    client.write({ id: "repeat-shot", steps: [{ op: "setContent", html: "<main>one</main>" }], evidence: "visual" });
    const firstShot = await client.waitFor((message) => message.type === "result" && message.id === "repeat-shot" && message.screenshot);
    screenshotPaths.push(firstShot.screenshot);
    client.write({ id: "repeat-shot", steps: [{ op: "setContent", html: "<main>two</main>" }], evidence: "visual" });
    const secondShot = await client.waitFor((message) => message.type === "result" && message.id === "repeat-shot" && message.screenshot && message.screenshot !== firstShot.screenshot, 5000);
    screenshotPaths.push(secondShot.screenshot);
    assert.notEqual(firstShot.screenshot, secondShot.screenshot);
    assert(screenshotPaths.every((screenshotPath) => fs.existsSync(screenshotPath)));
    client.write({ command: "close" });
    await client.waitFor((message) => message.type === "closed");
  } finally {
    await client.stop();
    for (const screenshotPath of screenshotPaths) fs.rmSync(screenshotPath, { force: true });
    const artifactDirs = [...new Set(screenshotPaths.map((screenshotPath) => path.dirname(screenshotPath)))];
    for (const artifactDir of artifactDirs) fs.rmdirSync(artifactDir);
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
      params: { name: "run", arguments: { steps: [{ op: "unsupported" }] } },
    });
    const contractReply = await client.waitFor((message) => message.id === 2);
    assert.equal(contractReply.result.isError, true);
    const contractResult = JSON.parse(contractReply.result.content[0].text);
    assert.equal(contractResult.failureKind, "contract");
    assert.equal(contractResult.runtime, "idle");
    assert(contractResult.contractErrors.some(issue => issue.path === "steps[0].op"));
    client.write({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: {
        name: "run",
        arguments: { ...missingPopupContract("missing-popup"), evidence: "visual" },
      },
    });
    const reply = await client.waitFor((message) => message.id === 3);
    assert.equal(reply.result.isError, false);
    assert(reply.result.content.some((item) => item.type === "image"));
    const result = JSON.parse(reply.result.content[0].text);
    assertMissingPopupResult(result);
    assert.match(result.nextAction, /without repeating the failed expectation/);
    client.write({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "run", arguments: requestFailureContract("mcp-network-failure") },
    });
    const networkReply = await client.waitFor((message) => message.id === 4);
    assert.equal(networkReply.result.isError, false);
    assertRequestFailureEvidence(JSON.parse(networkReply.result.content[0].text));
  } finally {
    await client.stop();
  }
});
