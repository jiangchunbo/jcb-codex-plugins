const readline = require("node:readline");
const {
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VIEWPORT,
  FlowRuntime,
  classifyFailure,
  compactError,
  contractSchema,
  recordRequestFailure,
  validateContract,
} = require("../shared/contract");

const SERVER_NAME = "playwright-fast";
const { version: SERVER_VERSION } = require("../.codex-plugin/plugin.json");
const DEFAULT_TTL_MS = 30 * 60 * 1000;
let chromium;

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

class PersistentRuntime {
  constructor() {
    this.ttlMs = positiveInteger(process.env.PLAYWRIGHT_FAST_TTL_MS, DEFAULT_TTL_MS);
    this.browser = null;
    this.context = null;
    this.page = null;
    this.launchPromise = null;
    this.expiryTimer = null;
    this.startedAt = null;
    this.lastUsedAt = null;
    this.launches = 0;
    this.resets = 0;
    this.runs = 0;
    this.consoleErrors = [];
    this.pageErrors = [];
    this.requestFailures = [];
    this.attachedPages = new WeakSet();
    this.defaultTimeoutMs = DEFAULT_TIMEOUT_MS;
    this.defaultNavigationTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS;
  }

  isWarm() {
    return Boolean(this.browser?.isConnected() && this.context && this.page && !this.page.isClosed());
  }

  touch() {
    this.lastUsedAt = Date.now();
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = setTimeout(() => {
      this.dispose().catch((error) => {
        process.stderr.write(`${SERVER_NAME}: idle disposal failed: ${compactError(error)}\n`);
      });
    }, this.ttlMs);
    this.expiryTimer.unref();
  }

  attachPage(page) {
    page.setDefaultTimeout(this.defaultTimeoutMs);
    page.setDefaultNavigationTimeout(this.defaultNavigationTimeoutMs);
    if (this.attachedPages.has(page)) return;
    this.attachedPages.add(page);
    page.on("console", (message) => {
      if (message.type() === "error") this.consoleErrors.push(message.text());
    });
    page.on("pageerror", (error) => this.pageErrors.push(error.message));
    page.on("requestfailed", (request) => recordRequestFailure(this.requestFailures, request));
  }

  adoptPage(page) {
    this.page = page;
    this.attachPage(page);
  }

  async createContext() {
    this.context = await this.browser.newContext({
      viewport: DEFAULT_VIEWPORT,
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    this.adoptPage(await this.context.newPage());
  }

  async launch() {
    await this.dispose();
    if (!chromium) ({ chromium } = require("playwright"));
    this.browser = await chromium.launch({ headless: true });
    await this.createContext();
    this.startedAt = Date.now();
    this.launches += 1;
    this.touch();
  }

  async ensure() {
    if (this.isWarm()) {
      this.touch();
      return false;
    }
    if (!this.launchPromise) {
      this.launchPromise = this.launch().finally(() => { this.launchPromise = null; });
    }
    await this.launchPromise;
    return true;
  }

  async dispose() {
    if (this.expiryTimer) clearTimeout(this.expiryTimer);
    this.expiryTimer = null;
    const browser = this.browser;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.startedAt = null;
    this.lastUsedAt = null;
    if (browser) await browser.close().catch(() => {});
  }

  async reset(warm = true) {
    const started = performance.now();
    if (this.launchPromise) await this.launchPromise.catch(() => {});
    await this.dispose();
    this.resets += 1;
    if (warm) await this.ensure();
    return { ...(await this.status()), elapsedMs: Math.round(performance.now() - started) };
  }

  async status() {
    const warm = this.isWarm();
    const now = Date.now();
    return {
      warm,
      ttlMs: this.ttlMs,
      expiresInMs: warm ? Math.max(0, this.ttlMs - (now - this.lastUsedAt)) : 0,
      uptimeMs: warm ? now - this.startedAt : 0,
      url: warm ? this.page.url() : null,
      viewport: warm ? this.page.viewportSize() : null,
      version: SERVER_VERSION,
      launches: this.launches,
      resets: this.resets,
      runs: this.runs,
    };
  }

  async run(contract) {
    const started = performance.now();
    const evidence = contract?.evidence || "ultra";
    const outputs = {};
    const observations = [];
    const routeCalls = [];
    const stepResults = [];
    let phase = "contract";
    let routeHandler;
    let responseCapture;
    let flow;
    let image;
    let coldStarted = false;
    this.consoleErrors = [];
    this.pageErrors = [];
    this.requestFailures = [];

    try {
      validateContract(contract);
      coldStarted = contract.reset ? (await this.reset(true), true) : await this.ensure();
      this.defaultTimeoutMs = positiveInteger(contract.timeoutMs, DEFAULT_TIMEOUT_MS);
      this.defaultNavigationTimeoutMs = positiveInteger(contract.navigationTimeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS);
      this.attachPage(this.page);
      flow = new FlowRuntime({
        context: this.context,
        page: this.page,
        onPage: (page) => this.adoptPage(page),
        defaultTimeoutMs: this.defaultTimeoutMs,
      });

      phase = "viewport";
      await this.page.setViewportSize(contract.viewport || DEFAULT_VIEWPORT);
      if ((contract.routes || []).length > 0 || (contract.blockResourceTypes || []).length > 0) {
        phase = "routes";
        routeHandler = await flow.installNetworkRules(contract, routeCalls);
      }
      if ((contract.captureResponses || []).length > 0) {
        phase = "responses";
        responseCapture = flow.installResponseCaptures(contract, outputs, this.defaultTimeoutMs);
      }
      if ((contract.cookies || []).length > 0) {
        phase = "cookies";
        await this.context.addCookies(contract.cookies);
      }
      if ((contract.localStorage || []).length > 0) {
        phase = "localStorage";
        await this.context.addInitScript((storageEntries) => {
          for (const entry of storageEntries) {
            if (location.origin === entry.origin) localStorage.setItem(entry.name, entry.value);
          }
        }, contract.localStorage);
      }
      if (contract.url) {
        phase = "navigation";
        await this.page.goto(contract.url, { waitUntil: contract.waitUntil || "domcontentloaded" });
      }
      if (contract.ready) {
        phase = "ready";
        observations.push(await flow.checkExpectation(contract.ready));
      }
      for (const [index, step] of (contract.steps || []).entries()) {
        phase = `step:${index}:${step.op}`;
        const stepStarted = performance.now();
        try {
          await flow.runStep(step, outputs);
          stepResults.push({ index, op: step.op, ok: true, elapsedMs: Math.round(performance.now() - stepStarted) });
        } catch (error) {
          stepResults.push({ index, op: step.op, ok: false, elapsedMs: Math.round(performance.now() - stepStarted) });
          throw error;
        }
      }
      for (const [index, expectation] of (contract.expect || []).entries()) {
        phase = `expect:${index}`;
        observations.push(await flow.checkExpectation(expectation));
      }
      if (responseCapture) {
        phase = "responses";
        await responseCapture.wait();
      }
      if (evidence === "visual" || evidence === "diag") {
        phase = "screenshot";
        image = await this.page.screenshot({
          ...(contract.screenshot?.path ? { path: contract.screenshot.path } : {}),
          fullPage: Boolean(contract.screenshot?.fullPage),
        });
      }

      const healthFailure =
        (evidence === "health" || evidence === "diag") &&
        (this.consoleErrors.length > 0 || this.pageErrors.length > 0);
      this.runs += 1;
      return {
        result: {
          ok: !healthFailure,
          id: String(contract.id || "flow").slice(0, 80),
          runtime: coldStarted ? "cold" : "warm",
          elapsedMs: Math.round(performance.now() - started),
          url: this.page.url(),
          viewport: this.page.viewportSize(),
          outputs,
          observations,
          ...(healthFailure ? { failureKind: "page" } : {}),
          ...(evidence === "health" || evidence === "diag" ? { consoleErrors: this.consoleErrors, pageErrors: this.pageErrors } : {}),
          ...((evidence === "health" || evidence === "diag") && this.requestFailures.length > 0 ? { requestFailures: this.requestFailures } : {}),
          ...(image ? { screenshotBytes: image.length } : {}),
          ...(contract.captureRouteCalls ? { routeCalls } : {}),
        },
        image,
      };
    } catch (error) {
      const failureKind = classifyFailure(error, phase);
      if (evidence === "diag" && !image && this.page && !this.page.isClosed()) {
        try {
          image = await this.page.screenshot({ fullPage: false });
        } catch {}
      }
      this.runs += 1;
      return {
        result: {
          ok: false,
          id: String(contract?.id || "flow").slice(0, 80),
          runtime: coldStarted ? "cold" : "warm",
          phase,
          failureKind,
          elapsedMs: Math.round(performance.now() - started),
          url: this.page?.url() || null,
          viewport: this.page?.viewportSize() || null,
          error: compactError(error),
          ...(stepResults.length > 0 ? { stepResults } : {}),
          ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
          ...(observations.length > 0 ? { observations } : {}),
          ...(evidence === "health" || evidence === "diag" ? { consoleErrors: this.consoleErrors, pageErrors: this.pageErrors } : {}),
          ...(this.requestFailures.length > 0 ? { requestFailures: this.requestFailures } : {}),
          ...(image ? { screenshotBytes: image.length } : {}),
          ...(contract?.captureRouteCalls ? { routeCalls } : {}),
        },
        image,
      };
    } finally {
      responseCapture?.dispose();
      if (routeHandler && this.context) await this.context.unroute("**/*", routeHandler).catch(() => {});
      if (this.isWarm()) this.touch();
    }
  }
}

const tools = [
  {
    name: "run",
    description: "Run one batched Playwright contract on the persistent page. Browser and storage state can persist; request routes and resource blocking are scoped to this call.",
    inputSchema: contractSchema,
  },
  {
    name: "reset",
    description: "Discard browser state and optionally prewarm a fresh Chromium runtime.",
    inputSchema: {
      type: "object",
      properties: { warm: { type: "boolean", description: "Relaunch immediately; defaults true." } },
      additionalProperties: false,
    },
  },
  {
    name: "status",
    description: "Return compact runtime warmth, TTL, URL, and counters without extending the TTL.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  },
];

const runtime = new PersistentRuntime();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function respond(id, result) {
  send({ jsonrpc: "2.0", id, result });
}

function fail(id, code, message) {
  send({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });
}

async function callTool(name, args) {
  if (name === "run") {
    const { result, image } = await runtime.run(args || {});
    const content = [{ type: "text", text: JSON.stringify(result) }];
    if (image) content.push({ type: "image", data: image.toString("base64"), mimeType: "image/png" });
    return { content, isError: !result.ok };
  }
  if (name === "reset") {
    const result = await runtime.reset(args?.warm !== false);
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  }
  if (name === "status") return { content: [{ type: "text", text: JSON.stringify(await runtime.status()) }] };
  throw new Error(`Unknown tool: ${name}`);
}

async function handle(message) {
  const { id, method, params = {} } = message;
  if (method === "initialize") {
    respond(id, {
      protocolVersion: params.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    });
    return;
  }
  if (method === "notifications/initialized") return;
  if (method === "ping") {
    respond(id, {});
    return;
  }
  if (method === "tools/list") {
    respond(id, { tools });
    setImmediate(() => {
      runtime.ensure().catch((error) => {
        process.stderr.write(`${SERVER_NAME}: prewarm failed: ${compactError(error)}\n`);
      });
    });
    return;
  }
  if (method === "tools/call") {
    try {
      respond(id, await callTool(params.name, params.arguments || {}));
    } catch (error) {
      respond(id, { content: [{ type: "text", text: JSON.stringify({ ok: false, error: compactError(error) }) }], isError: true });
    }
    return;
  }
  if (method?.startsWith("notifications/")) return;
  fail(id, -32601, `Method not found: ${method}`);
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
let queue = Promise.resolve();
input.on("line", (line) => {
  if (!line.trim()) return;
  queue = queue.then(async () => {
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      fail(null, -32700, `Parse error: ${compactError(error)}`);
      return;
    }
    await handle(message);
  });
});

input.on("close", () => {
  queue.finally(() => runtime.dispose()).finally(() => process.exit(0));
});

async function shutdown() {
  await runtime.dispose();
  process.exit(0);
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
