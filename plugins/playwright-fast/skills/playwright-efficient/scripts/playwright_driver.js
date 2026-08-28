const readline = require("node:readline");
const { chromium } = require("playwright");

const startedAt = performance.now();
let browser;
let context;
let page;
let closing = false;
let consoleErrors = [];
let pageErrors = [];

const supportedEvidence = new Set(["ultra", "health", "visual", "diag"]);
const supportedSteps = new Set([
  "setContent",
  "click",
  "fill",
  "clear",
  "type",
  "press",
  "select",
  "check",
  "uncheck",
  "hover",
  "focus",
  "wait",
  "readText",
  "readAllText",
  "readAttribute",
  "readBoundingBox",
  "readComputedStyle",
]);

class ContractError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContractError";
  }
}

class AssertionError extends Error {
  constructor(message) {
    super(message);
    this.name = "AssertionError";
  }
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload)}\n`);
}

function assertContract(condition, message) {
  if (!condition) throw new ContractError(message);
}

function assertExpected(condition, message) {
  if (!condition) throw new AssertionError(message);
}

function safeId(value) {
  return String(value || "flow").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 80);
}

function validateTarget(target, label) {
  assertContract(target && typeof target === "object" && !Array.isArray(target), `${label} target is required`);
  const selectors = ["role", "text", "label", "placeholder", "testId", "css"].filter(
    (key) => target[key] !== undefined,
  );
  assertContract(selectors.length === 1, `${label} target must define exactly one selector`);
  if (target.within !== undefined) validateTarget(target.within, `${label}.within`);
  assertContract(!(target.first && Number.isInteger(target.nth)), `${label} target cannot use both first and nth`);
}

function validateExpectation(expectation, label) {
  assertContract(
    expectation && typeof expectation === "object" && !Array.isArray(expectation),
    `${label} must be an object`,
  );
  const pageExpectation = ["url", "urlIncludes", "title", "titleIncludes"].some(
    (key) => expectation[key] !== undefined,
  );
  if (!pageExpectation) validateTarget(expectation.target, label);
  if (expectation.attribute !== undefined) {
    assertContract(
      expectation.attribute &&
        typeof expectation.attribute === "object" &&
        typeof expectation.attribute.name === "string",
      `${label}.attribute must contain a string name`,
    );
  }
  if (expectation.computedStyle !== undefined) {
    assertContract(
      expectation.computedStyle &&
        typeof expectation.computedStyle === "object" &&
        !Array.isArray(expectation.computedStyle),
      `${label}.computedStyle must be an object`,
    );
  }
  if (expectation.box !== undefined) {
    assertContract(
      expectation.box && typeof expectation.box === "object" && !Array.isArray(expectation.box),
      `${label}.box must be an object`,
    );
  }
}

function validateContract(contract) {
  assertContract(contract && typeof contract === "object" && !Array.isArray(contract), "Contract must be an object");
  assertContract(supportedEvidence.has(contract.evidence || "ultra"), "Unsupported evidence tier");
  if (contract.viewport !== undefined) {
    assertContract(
      Number.isInteger(contract.viewport.width) &&
        contract.viewport.width > 0 &&
        Number.isInteger(contract.viewport.height) &&
        contract.viewport.height > 0,
      "viewport requires positive integer width and height",
    );
  }
  if (contract.cookies !== undefined) {
    assertContract(Array.isArray(contract.cookies), "cookies must be an array");
  }
  if (contract.localStorage !== undefined) {
    assertContract(Array.isArray(contract.localStorage), "localStorage must be an array");
    contract.localStorage.forEach((entry, index) => {
      assertContract(entry && typeof entry === "object", `localStorage[${index}] must be an object`);
      assertContract(typeof entry.origin === "string" && entry.origin.length > 0, `localStorage[${index}].origin is required`);
      assertContract(typeof entry.name === "string" && entry.name.length > 0, `localStorage[${index}].name is required`);
      assertContract(typeof entry.value === "string", `localStorage[${index}].value must be a string`);
    });
  }
  if (contract.blockResourceTypes !== undefined) {
    assertContract(
      Array.isArray(contract.blockResourceTypes) &&
        contract.blockResourceTypes.every((type) => typeof type === "string"),
      "blockResourceTypes must be a string array",
    );
  }
  if (contract.routes !== undefined) {
    assertContract(Array.isArray(contract.routes), "routes must be an array");
    contract.routes.forEach((route, index) => {
      assertContract(route && typeof route === "object", `routes[${index}] must be an object`);
      assertContract(typeof route.url === "string" && route.url.length > 0, `routes[${index}].url is required`);
      const actions = ["json", "body", "abort"].filter((key) => route[key] !== undefined);
      assertContract(actions.length === 1, `routes[${index}] must define exactly one of json, body, or abort`);
      if (route.method !== undefined) {
        assertContract(typeof route.method === "string" && route.method.length > 0, `routes[${index}].method must be a string`);
      }
      if (route.requestBody !== undefined) {
        assertContract(route.requestBody && typeof route.requestBody === "object", `routes[${index}].requestBody must be an object`);
      }
      if (route.requestBodyIncludes !== undefined) {
        assertContract(typeof route.requestBodyIncludes === "string", `routes[${index}].requestBodyIncludes must be a string`);
      }
      if (route.cors !== undefined) {
        assertContract(typeof route.cors === "boolean", `routes[${index}].cors must be a boolean`);
      }
    });
  }
  assertContract(contract.steps === undefined || Array.isArray(contract.steps), "steps must be an array");
  (contract.steps || []).forEach((step, index) => {
    const label = `steps[${index}]`;
    assertContract(step && typeof step === "object", `${label} must be an object`);
    assertContract(supportedSteps.has(step.op), `${label} has unsupported operation: ${step.op}`);
    if (step.op === "setContent") {
      assertContract(typeof step.html === "string", `${label}.html must be a string`);
      return;
    }
    if (step.op === "wait" && step.ms !== undefined) {
      assertContract(Number.isInteger(step.ms) && step.ms >= 0, `${label}.ms must be a non-negative integer`);
      assertContract(step.target === undefined, `${label} cannot define both ms and target`);
      return;
    }
    validateTarget(step.target, label);
    if (step.timeoutMs !== undefined) {
      assertContract(Number.isInteger(step.timeoutMs) && step.timeoutMs > 0, `${label}.timeoutMs must be a positive integer`);
    }
    if (step.op === "readAttribute") {
      assertContract(
        typeof step.attribute === "string" && step.attribute.length > 0,
        `${label}.attribute must be a non-empty string`,
      );
    }
    if (step.op === "readComputedStyle") {
      assertContract(
        Array.isArray(step.properties) &&
          step.properties.length > 0 &&
          step.properties.every((property) => typeof property === "string" && property.length > 0),
        `${label}.properties must be a non-empty string array`,
      );
    }
  });
  if (contract.ready !== undefined) validateExpectation(contract.ready, "ready");
  assertContract(contract.expect === undefined || Array.isArray(contract.expect), "expect must be an array");
  (contract.expect || []).forEach((expectation, index) =>
    validateExpectation(expectation, `expect[${index}]`),
  );
}

function partialJsonMatch(actual, expected) {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected)) {
    return Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => partialJsonMatch(actual[index], value));
  }
  return actual && typeof actual === "object" && Object.entries(expected).every(([key, value]) => partialJsonMatch(actual[key], value));
}

function requestMatchesBody(request, rule) {
  const body = request.postData() || "";
  if (rule.requestBodyIncludes !== undefined && !body.includes(rule.requestBodyIncludes)) return false;
  if (rule.requestBody === undefined) return true;
  try {
    return partialJsonMatch(JSON.parse(body), rule.requestBody);
  } catch {
    return false;
  }
}

function corsHeaders(request, rule) {
  if (!rule.cors) return rule.headers;
  const requestHeaders = request.headers();
  return {
    "access-control-allow-origin": requestHeaders.origin || "*",
    "access-control-allow-headers": requestHeaders["access-control-request-headers"] || "Content-Type, Authorization",
    "access-control-allow-methods": `${rule.method || request.method()}, OPTIONS`,
    ...rule.headers,
  };
}

function globToRegExp(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") {
      expression += "[^/]*";
    } else if (character === "?") {
      expression += ".";
    } else {
      expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${expression}$`);
}

function readStyles(locator, properties) {
  return locator.evaluate((element, names) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(
      names.map((name) => [name, style.getPropertyValue(name) || style[name] || ""]),
    );
  }, properties);
}

function withBoxEdges(box) {
  return { ...box, right: box.x + box.width, bottom: box.y + box.height };
}

function checkNumber(actual, expected, label) {
  if (typeof expected === "number") {
    assertExpected(Math.abs(actual - expected) <= 0.5, `Expected ${label} approximately ${expected}, received ${actual}`);
    return;
  }
  assertContract(expected && typeof expected === "object", `${label} constraint must be a number or object`);
  if (expected.min !== undefined) assertExpected(actual >= expected.min, `Expected ${label} >= ${expected.min}, received ${actual}`);
  if (expected.max !== undefined) assertExpected(actual <= expected.max, `Expected ${label} <= ${expected.max}, received ${actual}`);
  if (expected.approx !== undefined) {
    const tolerance = expected.tolerance ?? 0.5;
    assertExpected(
      Math.abs(actual - expected.approx) <= tolerance,
      `Expected ${label} approximately ${expected.approx} +/- ${tolerance}, received ${actual}`,
    );
  }
}

function classifyFailure(error, phase) {
  if (error instanceof ContractError) return "contract";
  if (error instanceof AssertionError) return "assertion";
  if (phase === "navigation") return "navigation";
  if (phase === "ready" || phase.startsWith("step:") || phase.startsWith("expect:")) return "locator";
  return "runtime";
}

async function createRuntime() {
  context = await browser.newContext({
    reducedMotion: "reduce",
    serviceWorkers: "block",
  });
  page = await context.newPage();
  page.setDefaultTimeout(2000);
  page.setDefaultNavigationTimeout(5000);
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => pageErrors.push(error.message));
}

async function resetRuntime() {
  if (context) await context.close();
  await createRuntime();
}

function locate(target, root = page) {
  assertContract(target && typeof target === "object", "A locator target is required");

  if (target.within) root = locate(target.within, root);

  let locator;
  if (target.role) {
    const options = {};
    if (target.name !== undefined) {
      options.name = target.name;
      options.exact = target.exact !== false;
    }
    locator = root.getByRole(target.role, options);
  } else if (target.text !== undefined) {
    locator = root.getByText(target.text, { exact: target.exact !== false });
  } else if (target.label !== undefined) {
    locator = root.getByLabel(target.label, { exact: target.exact !== false });
  } else if (target.placeholder !== undefined) {
    locator = root.getByPlaceholder(target.placeholder, {
      exact: target.exact !== false,
    });
  } else if (target.testId !== undefined) {
    locator = root.getByTestId(target.testId);
  } else if (target.css !== undefined) {
    locator = root.locator(target.css);
  } else {
    throw new ContractError("Unsupported locator target");
  }

  if (target.first) locator = locator.first();
  if (Number.isInteger(target.nth)) locator = locator.nth(target.nth);
  return locator;
}

async function runStep(step, outputs) {
  if (step.op === "setContent") {
    await page.setContent(step.html || "", {
      waitUntil: step.waitUntil || "domcontentloaded",
    });
    return;
  }

  if (step.op === "wait" && step.ms !== undefined) {
    await page.waitForTimeout(step.ms);
    return;
  }

  const locator = locate(step.target);
  const actionOptions = step.timeoutMs ? { timeout: step.timeoutMs } : undefined;
  switch (step.op) {
    case "click":
      await locator.click(actionOptions);
      break;
    case "fill":
      await locator.fill(step.value ?? "", actionOptions);
      break;
    case "clear":
      await locator.clear(actionOptions);
      break;
    case "type":
      await locator.pressSequentially(step.value ?? "", { delay: step.delay || 0, ...actionOptions });
      break;
    case "press":
      await locator.press(step.key, actionOptions);
      break;
    case "select":
      await locator.selectOption(step.value, actionOptions);
      break;
    case "check":
      await locator.check(actionOptions);
      break;
    case "uncheck":
      await locator.uncheck(actionOptions);
      break;
    case "hover":
      await locator.hover(actionOptions);
      break;
    case "focus":
      await locator.focus(actionOptions);
      break;
    case "wait":
      await locator.waitFor({ state: step.state || "visible", ...actionOptions });
      break;
    case "readText":
      outputs[step.as || "text"] = await locator.textContent();
      break;
    case "readAllText":
      outputs[step.as || "texts"] = await locator.allTextContents();
      break;
    case "readAttribute":
      outputs[step.as || step.attribute] = await locator.getAttribute(step.attribute);
      break;
    case "readBoundingBox": {
      const box = await locator.boundingBox();
      assertExpected(box, "Target has no visible bounding box");
      outputs[step.as || "box"] = withBoxEdges(box);
      break;
    }
    case "readComputedStyle":
      outputs[step.as || "computedStyle"] = await readStyles(locator, step.properties);
      break;
    default:
      throw new ContractError(`Unsupported step operation: ${step.op}`);
  }
}

async function checkExpectation(expectation) {
  const observed = {};

  if (expectation.url !== undefined || expectation.urlIncludes !== undefined) {
    const actual = page.url();
    observed.url = actual;
    if (expectation.url !== undefined) {
      assertExpected(actual === expectation.url, `Expected URL ${expectation.url}, received ${actual}`);
    }
    if (expectation.urlIncludes !== undefined) {
      assertExpected(
        actual.includes(expectation.urlIncludes),
        `Expected URL containing ${expectation.urlIncludes}, received ${actual}`,
      );
    }
    return observed;
  }

  if (expectation.title !== undefined || expectation.titleIncludes !== undefined) {
    const actual = await page.title();
    observed.title = actual;
    if (expectation.title !== undefined) {
      assertExpected(actual === expectation.title, `Expected title ${expectation.title}, received ${actual}`);
    }
    if (expectation.titleIncludes !== undefined) {
      assertExpected(
        actual.includes(expectation.titleIncludes),
        `Expected title containing ${expectation.titleIncludes}, received ${actual}`,
      );
    }
    return observed;
  }

  const locator = locate(expectation.target);
  const hasCondition = [
    "state",
    "text",
    "contains",
    "value",
    "count",
    "attribute",
    "computedStyle",
    "box",
  ].some((key) => expectation[key] !== undefined);

  if (!hasCondition || expectation.state !== undefined) {
    const state = expectation.state || "visible";
    await locator.waitFor({ state });
    observed.state = state;
  }

  if (expectation.text !== undefined || expectation.contains !== undefined) {
    const actual = await locator.textContent();
    observed.text = actual;
    if (expectation.text !== undefined) {
      assertExpected(actual === expectation.text, `Expected text ${expectation.text}, received ${actual}`);
    }
    if (expectation.contains !== undefined) {
      assertExpected(
        String(actual).includes(expectation.contains),
        `Expected text containing ${expectation.contains}, received ${actual}`,
      );
    }
  }

  if (expectation.value !== undefined) {
    const actual = await locator.inputValue();
    observed.value = actual;
    assertExpected(actual === expectation.value, `Expected value ${expectation.value}, received ${actual}`);
  }

  if (expectation.count !== undefined) {
    const actual = await locator.count();
    observed.count = actual;
    assertExpected(actual === expectation.count, `Expected count ${expectation.count}, received ${actual}`);
  }

  if (expectation.attribute !== undefined) {
    const actual = await locator.getAttribute(expectation.attribute.name);
    observed.attribute = { name: expectation.attribute.name, value: actual };
    assertExpected(
      actual === expectation.attribute.value,
      `Expected ${expectation.attribute.name}=${expectation.attribute.value}, received ${actual}`,
    );
  }

  if (expectation.computedStyle !== undefined) {
    const properties = Object.keys(expectation.computedStyle);
    const actual = await readStyles(locator, properties);
    observed.computedStyle = actual;
    for (const property of properties) {
      assertExpected(
        actual[property] === String(expectation.computedStyle[property]),
        `Expected computed style ${property}=${expectation.computedStyle[property]}, received ${actual[property]}`,
      );
    }
  }

  if (expectation.box !== undefined) {
    const rawBox = await locator.boundingBox();
    assertExpected(rawBox, "Target has no visible bounding box");
    const actual = withBoxEdges(rawBox);
    observed.box = actual;
    for (const [property, constraint] of Object.entries(expectation.box)) {
      assertContract(property in actual, `Unsupported box property: ${property}`);
      checkNumber(actual[property], constraint, `box.${property}`);
    }
  }

  return observed;
}

async function installNetworkRules(contract, routeCalls) {
  const blocked = new Set(contract.blockResourceTypes || []);
  const rules = (contract.routes || []).map((rule) => ({
    ...rule,
    method: rule.method ? String(rule.method).toUpperCase() : undefined,
    matcher: globToRegExp(rule.url),
  }));
  if (blocked.size === 0 && rules.length === 0) return undefined;

  const handler = async (route) => {
    const request = route.request();
    if (blocked.has(request.resourceType())) {
      if (contract.captureRouteCalls) {
        routeCalls.push({ method: request.method(), url: request.url(), action: "abort-resource" });
      }
      await route.abort();
      return;
    }

    const rule = rules.find(
      (candidate) =>
        candidate.matcher.test(request.url()) &&
        ((candidate.cors && request.method().toUpperCase() === "OPTIONS") ||
          candidate.method === undefined ||
          candidate.method === request.method().toUpperCase()) &&
        (request.method().toUpperCase() === "OPTIONS" || requestMatchesBody(request, candidate)),
    );
    if (!rule) {
      await route.continue();
      return;
    }

    if (rule.cors && request.method().toUpperCase() === "OPTIONS") {
      if (contract.captureRouteCalls) {
        routeCalls.push({ method: request.method(), url: request.url(), action: "cors-preflight" });
      }
      await route.fulfill({ status: 204, headers: corsHeaders(request, rule), body: "" });
      return;
    }

    if (rule.abort !== undefined) {
      if (contract.captureRouteCalls) {
        routeCalls.push({ method: request.method(), url: request.url(), action: "abort" });
      }
      await route.abort(rule.abort === true ? "failed" : rule.abort);
      return;
    }

    const isJson = Object.prototype.hasOwnProperty.call(rule, "json");
    const body = isJson ? JSON.stringify(rule.json) : String(rule.body);
    if (contract.captureRouteCalls) {
      routeCalls.push({ method: request.method(), url: request.url(), action: "fulfill" });
    }
    await route.fulfill({
      status: rule.status ?? 200,
      headers: corsHeaders(request, rule),
      contentType: rule.contentType || (isJson ? "application/json" : undefined),
      body,
    });
  };

  await page.route("**/*", handler);
  return handler;
}

async function runContract(contract) {
  const id = safeId(contract?.id);
  const evidence = contract?.evidence || "ultra";
  const started = performance.now();
  const outputs = {};
  const observations = [];
  const routeCalls = [];
  let phase = "contract";
  let networkHandler;
  let screenshotPath;

  consoleErrors = [];
  pageErrors = [];

  try {
    validateContract(contract);
    if (contract.reset) await resetRuntime();

    page.setDefaultTimeout(contract.timeoutMs || 2000);
    page.setDefaultNavigationTimeout(contract.navigationTimeoutMs || 5000);

    if (contract.viewport) {
      phase = "viewport";
      await page.setViewportSize(contract.viewport);
    }

    if ((contract.routes || []).length > 0 || (contract.blockResourceTypes || []).length > 0) {
      phase = "routes";
      networkHandler = await installNetworkRules(contract, routeCalls);
    }

    if ((contract.cookies || []).length > 0) {
      phase = "cookies";
      await context.addCookies(contract.cookies);
    }

    if ((contract.localStorage || []).length > 0) {
      phase = "localStorage";
      const entries = contract.localStorage;
      await context.addInitScript((storageEntries) => {
        for (const entry of storageEntries) {
          if (location.origin === entry.origin) localStorage.setItem(entry.name, entry.value);
        }
      }, entries);
    }

    if (contract.url) {
      phase = "navigation";
      await page.goto(contract.url, { waitUntil: contract.waitUntil || "domcontentloaded" });
    }

    if (contract.ready) {
      phase = "ready";
      observations.push(await checkExpectation(contract.ready));
    }

    for (const [index, step] of (contract.steps || []).entries()) {
      phase = `step:${index}:${step.op}`;
      await runStep(step, outputs);
    }

    for (const [index, expectation] of (contract.expect || []).entries()) {
      phase = `expect:${index}`;
      observations.push(await checkExpectation(expectation));
    }

    if (evidence === "visual" || evidence === "diag") {
      phase = "screenshot";
      screenshotPath = contract.screenshot?.path || `/tmp/playwright-efficient-${id}.png`;
      await page.screenshot({
        path: screenshotPath,
        fullPage: Boolean(contract.screenshot?.fullPage),
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
      outputs,
      observations,
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
      ...(evidence === "health" || evidence === "diag"
        ? { consoleErrors, pageErrors }
        : {}),
      ...(contract.captureRouteCalls ? { routeCalls } : {}),
    });
  } catch (error) {
    const failureKind = classifyFailure(error, phase);
    if (
      failureKind !== "contract" &&
      (evidence === "visual" || evidence === "diag") &&
      !screenshotPath
    ) {
      screenshotPath = contract.screenshot?.path || `/tmp/playwright-efficient-${id}-failure.png`;
      try {
        await page.screenshot({ path: screenshotPath, fullPage: false });
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
      error: error.message,
      ...(screenshotPath ? { screenshot: screenshotPath } : {}),
      ...(evidence === "health" || evidence === "diag"
        ? { consoleErrors, pageErrors }
        : {}),
      ...(contract?.captureRouteCalls ? { routeCalls } : {}),
    });
  } finally {
    if (networkHandler) await page.unroute("**/*", networkHandler);
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
      emit({ type: "protocol-error", ok: false, error: error.message });
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
  emit({ type: "fatal", ok: false, error: error.message });
  process.exit(1);
});
