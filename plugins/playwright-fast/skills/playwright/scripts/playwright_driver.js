const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const readline = require("node:readline");
const { chromium } = require("playwright");
const {
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VIEWPORT,
  FlowRuntime,
  classifyFailure,
  compactError,
  recordRequestFailure,
  resolveViewport,
  screenshotTimeoutMs,
  validateContract,
} = require("../../../shared/contract");

const startedAt = performance.now();
let browser;
let context;
let page;
let closing = false;
let consoleErrors = [];
let pageErrors = [];
let requestFailures = [];
let defaultTimeoutMs = DEFAULT_TIMEOUT_MS;
let defaultNavigationTimeoutMs = DEFAULT_NAVIGATION_TIMEOUT_MS;
let artifactDir;
let screenshotSequence = 0;
const attachedPages = new WeakSet();

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function safeId(value) {
  return String(value || "flow").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80);
}

function defaultScreenshotPath(id, suffix = "") {
  if (!artifactDir) artifactDir = fs.mkdtempSync(path.join(os.tmpdir(), "playwright-fast-"));
  screenshotSequence += 1;
  return path.join(artifactDir, `${String(screenshotSequence).padStart(4, "0")}-${id}${suffix}.png`);
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function attachPage(nextPage) {
  nextPage.setDefaultTimeout(defaultTimeoutMs);
  nextPage.setDefaultNavigationTimeout(defaultNavigationTimeoutMs);
  if (attachedPages.has(nextPage)) return;
  attachedPages.add(nextPage);
  nextPage.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  nextPage.on("pageerror", (error) => pageErrors.push(error.message));
  nextPage.on("requestfailed", (request) => recordRequestFailure(requestFailures, request));
}

function adoptPage(nextPage) {
  page = nextPage;
  attachPage(nextPage);
}

async function createRuntime() {
  context = await browser.newContext({
    viewport: DEFAULT_VIEWPORT,
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  adoptPage(await context.newPage());
}

async function resetRuntime() {
  if (context) await context.close();
  await createRuntime();
}

async function runContract(contract) {
  const id = safeId(contract?.id);
  const evidence = contract?.evidence || "ultra";
  const started = performance.now();
  const outputs = {};
  const observations = [];
  const routeCalls = [];
  const stepResults = [];
  let phase = "contract";
  let networkHandler;
  let responseCapture;
  let screenshotPath;

  consoleErrors = [];
  pageErrors = [];
  requestFailures = [];

  try {
    validateContract(contract);
    if (contract.reset) await resetRuntime();
    defaultTimeoutMs = positiveInteger(contract.timeoutMs, DEFAULT_TIMEOUT_MS);
    defaultNavigationTimeoutMs = positiveInteger(contract.navigationTimeoutMs, DEFAULT_NAVIGATION_TIMEOUT_MS);
    attachPage(page);
    const flow = new FlowRuntime({ context, page, onPage: adoptPage, defaultTimeoutMs });

    phase = "viewport";
    await page.setViewportSize(resolveViewport(contract, page.viewportSize()));
    if ((contract.routes || []).length > 0 || (contract.blockResourceTypes || []).length > 0) {
      phase = "routes";
      networkHandler = await flow.installNetworkRules(contract, routeCalls);
    }
    if ((contract.captureResponses || []).length > 0) {
      phase = "responses";
      responseCapture = flow.installResponseCaptures(contract, outputs, defaultTimeoutMs);
    }
    if ((contract.cookies || []).length > 0) {
      phase = "cookies";
      await context.addCookies(contract.cookies);
    }
    if ((contract.localStorage || []).length > 0) {
      phase = "localStorage";
      await context.addInitScript((storageEntries) => {
        for (const entry of storageEntries) {
          if (location.origin === entry.origin) localStorage.setItem(entry.name, entry.value);
        }
      }, contract.localStorage);
    }
    if (contract.url) {
      phase = "navigation";
      await page.goto(contract.url, { waitUntil: contract.waitUntil || "domcontentloaded" });
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
      screenshotPath = contract.screenshot?.path || defaultScreenshotPath(id);
      await page.screenshot({
        path: screenshotPath,
        fullPage: Boolean(contract.screenshot?.fullPage),
        timeout: screenshotTimeoutMs(defaultTimeoutMs, defaultNavigationTimeoutMs),
      });
    }

    const healthFailure =
      (evidence === "health" || evidence === "diag") &&
      (consoleErrors.length > 0 || pageErrors.length > 0);
    emit({
      type: "result",
      id,
      ok: !healthFailure,
      ...(healthFailure ? { failureKind: "page" } : {}),
      elapsedMs: Math.round(performance.now() - started),
      url: page.url(),
      viewport: page.viewportSize(),
      outputs,
      observations,
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
      ...(evidence === "health" || evidence === "diag" ? { consoleErrors, pageErrors } : {}),
      ...((evidence === "health" || evidence === "diag") && requestFailures.length > 0 ? { requestFailures } : {}),
      ...(contract.captureRouteCalls ? { routeCalls } : {}),
    });
  } catch (error) {
    const failureKind = classifyFailure(error, phase);
    if (failureKind !== "contract" && (evidence === "visual" || evidence === "diag") && !screenshotPath) {
      screenshotPath = contract?.screenshot?.path || defaultScreenshotPath(id, "-failure");
      try {
        await page.screenshot({
          path: screenshotPath,
          fullPage: false,
          timeout: screenshotTimeoutMs(defaultTimeoutMs, defaultNavigationTimeoutMs),
        });
      } catch {
        screenshotPath = undefined;
      }
    }
    emit({
      type: "result",
      id,
      ok: false,
      phase,
      failureKind,
      elapsedMs: Math.round(performance.now() - started),
      url: page?.url(),
      viewport: page?.viewportSize() || null,
      error: compactError(error),
      ...(stepResults.length > 0 ? { stepResults } : {}),
      ...(Object.keys(outputs).length > 0 ? { outputs } : {}),
      ...(observations.length > 0 ? { observations } : {}),
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
      ...(evidence === "health" || evidence === "diag" ? { consoleErrors, pageErrors } : {}),
      ...(requestFailures.length > 0 ? { requestFailures } : {}),
      ...(contract?.captureRouteCalls ? { routeCalls } : {}),
    });
  } finally {
    responseCapture?.dispose();
    if (networkHandler && context) await context.unroute("**/*", networkHandler).catch(() => {});
  }
}

async function close() {
  if (closing) return;
  closing = true;
  if (browser) await browser.close();
}

async function main() {
  browser = await chromium.launch({ headless: true });
  await createRuntime();
  emit({ type: "ready", startupMs: Math.round(performance.now() - startedAt) });

  const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
  for await (const line of input) {
    if (!line.trim()) continue;
    let command;
    try {
      command = JSON.parse(line);
    } catch (error) {
      emit({ type: "protocol-error", ok: false, error: compactError(error) });
      continue;
    }
    if (command.command === "close") {
      emit({ type: "closed" });
      break;
    }
    if (command.command === "ping") {
      emit({ type: "pong", connected: browser.isConnected() });
      continue;
    }
    await runContract(command);
  }

  input.close();
  await close();
}

process.once("SIGTERM", async () => {
  await close();
  process.exit(0);
});

main().catch((error) => {
  emit({ type: "fatal", ok: false, error: compactError(error) });
  process.exit(1);
});
