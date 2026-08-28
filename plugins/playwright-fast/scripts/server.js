const readline = require("node:readline");

const SERVER_NAME = "playwright-fast";
const SERVER_VERSION = "0.1.0";
const DEFAULT_TTL_MS = 30 * 60 * 1000;
const DEFAULT_VIEWPORT = { width: 1440, height: 900 };
let chromium;
const supportedEvidence = new Set(["ultra", "health", "visual", "diag"]);
const supportedSteps = new Set([
  "setContent", "click", "fill", "clear", "type", "press", "select", "check", "uncheck",
  "hover", "focus", "wait", "readText", "readAllText", "readAttribute", "readBoundingBox",
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

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function assertContract(condition, message) {
  if (!condition) throw new ContractError(message);
}

function assertExpected(condition, message) {
  if (!condition) throw new AssertionError(message);
}

function compactError(error) {
  return error instanceof Error ? error.message : String(error);
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
  assertContract(expectation && typeof expectation === "object" && !Array.isArray(expectation), `${label} must be an object`);
  const pageExpectation = ["url", "urlIncludes", "title", "titleIncludes"].some(
    (key) => expectation[key] !== undefined,
  );
  if (!pageExpectation) validateTarget(expectation.target, label);
  if (expectation.attribute !== undefined) {
    assertContract(expectation.attribute && typeof expectation.attribute.name === "string", `${label}.attribute must contain a string name`);
  }
  if (expectation.computedStyle !== undefined) {
    assertContract(expectation.computedStyle && typeof expectation.computedStyle === "object" && !Array.isArray(expectation.computedStyle), `${label}.computedStyle must be an object`);
  }
  if (expectation.box !== undefined) {
    assertContract(expectation.box && typeof expectation.box === "object" && !Array.isArray(expectation.box), `${label}.box must be an object`);
  }
}

function validateContract(contract) {
  assertContract(contract && typeof contract === "object" && !Array.isArray(contract), "Contract must be an object");
  assertContract(supportedEvidence.has(contract.evidence || "ultra"), "Unsupported evidence tier");
  if (contract.viewport !== undefined) {
    assertContract(Number.isInteger(contract.viewport.width) && contract.viewport.width > 0 && Number.isInteger(contract.viewport.height) && contract.viewport.height > 0, "viewport requires positive integer width and height");
  }
  if (contract.cookies !== undefined) assertContract(Array.isArray(contract.cookies), "cookies must be an array");
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
    assertContract(Array.isArray(contract.blockResourceTypes) && contract.blockResourceTypes.every((type) => typeof type === "string"), "blockResourceTypes must be a string array");
  }
  if (contract.routes !== undefined) {
    assertContract(Array.isArray(contract.routes), "routes must be an array");
    contract.routes.forEach((route, index) => {
      assertContract(route && typeof route === "object", `routes[${index}] must be an object`);
      assertContract(typeof route.url === "string" && route.url.length > 0, `routes[${index}].url is required`);
      const actions = ["json", "body", "abort"].filter((key) => route[key] !== undefined);
      assertContract(actions.length === 1, `routes[${index}] must define exactly one of json, body, or abort`);
      if (route.method !== undefined) assertContract(typeof route.method === "string" && route.method.length > 0, `routes[${index}].method must be a string`);
      if (route.requestBody !== undefined) assertContract(route.requestBody && typeof route.requestBody === "object", `routes[${index}].requestBody must be an object`);
      if (route.requestBodyIncludes !== undefined) assertContract(typeof route.requestBodyIncludes === "string", `routes[${index}].requestBodyIncludes must be a string`);
      if (route.cors !== undefined) assertContract(typeof route.cors === "boolean", `routes[${index}].cors must be a boolean`);
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
    if (step.timeoutMs !== undefined) assertContract(Number.isInteger(step.timeoutMs) && step.timeoutMs > 0, `${label}.timeoutMs must be a positive integer`);
    if (step.op === "readAttribute") assertContract(typeof step.attribute === "string" && step.attribute.length > 0, `${label}.attribute must be a non-empty string`);
    if (step.op === "readComputedStyle") assertContract(Array.isArray(step.properties) && step.properties.length > 0 && step.properties.every((property) => typeof property === "string" && property.length > 0), `${label}.properties must be a non-empty string array`);
  });
  if (contract.ready !== undefined) validateExpectation(contract.ready, "ready");
  assertContract(contract.expect === undefined || Array.isArray(contract.expect), "expect must be an array");
  (contract.expect || []).forEach((expectation, index) => validateExpectation(expectation, `expect[${index}]`));
}

function globToRegExp(pattern) {
  let expression = "^";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index];
    if (character === "*" && pattern[index + 1] === "*") {
      expression += ".*";
      index += 1;
    } else if (character === "*") expression += "[^/]*";
    else if (character === "?") expression += ".";
    else expression += character.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`${expression}$`);
}

function partialJsonMatch(actual, expected) {
  if (expected === null || typeof expected !== "object") return Object.is(actual, expected);
  if (Array.isArray(expected)) return Array.isArray(actual) && expected.length === actual.length && expected.every((value, index) => partialJsonMatch(actual[index], value));
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

function readStyles(locator, properties) {
  return locator.evaluate((element, names) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name) || style[name] || ""]));
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
    assertExpected(Math.abs(actual - expected.approx) <= tolerance, `Expected ${label} approximately ${expected.approx} +/- ${tolerance}, received ${actual}`);
  }
}

function classifyFailure(error, phase) {
  if (error instanceof ContractError) return "contract";
  if (error instanceof AssertionError) return "assertion";
  if (phase === "navigation") return "navigation";
  if (phase === "ready" || phase.startsWith("step:") || phase.startsWith("expect:")) return "locator";
  return "runtime";
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
  }

  isWarm() {
    return Boolean(
      this.browser?.isConnected() && this.context && this.page && !this.page.isClosed(),
    );
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

  async createPage() {
    this.context = await this.browser.newContext({
      viewport: DEFAULT_VIEWPORT,
      reducedMotion: "reduce",
      serviceWorkers: "block",
    });
    this.page = await this.context.newPage();
    this.page.setDefaultTimeout(2000);
    this.page.setDefaultNavigationTimeout(5000);
    this.page.on("console", (message) => {
      if (message.type() === "error") this.consoleErrors.push(message.text());
    });
    this.page.on("pageerror", (error) => this.pageErrors.push(error.message));
  }

  async launch() {
    await this.dispose();
    if (!chromium) ({ chromium } = require("playwright"));
    this.browser = await chromium.launch({ headless: true });
    await this.createPage();
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
      this.launchPromise = this.launch().finally(() => {
        this.launchPromise = null;
      });
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
      launches: this.launches,
      resets: this.resets,
      runs: this.runs,
    };
  }

  locate(target, root = this.page) {
    assert(target && typeof target === "object", "A locator target is required");
    if (target.within) root = this.locate(target.within, root);

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
      locator = root.getByPlaceholder(target.placeholder, { exact: target.exact !== false });
    } else if (target.testId !== undefined) {
      locator = root.getByTestId(target.testId);
    } else if (target.css !== undefined) {
      locator = root.locator(target.css);
    } else {
      throw new Error("Unsupported locator target");
    }

    if (target.first) locator = locator.first();
    if (Number.isInteger(target.nth)) locator = locator.nth(target.nth);
    return locator;
  }

  async runStep(step, outputs) {
    if (step.op === "setContent") {
      await this.page.setContent(step.html || "", {
        waitUntil: step.waitUntil || "domcontentloaded",
      });
      return;
    }

    if (step.op === "wait" && step.ms !== undefined) {
      await this.page.waitForTimeout(step.ms);
      return;
    }

    const locator = this.locate(step.target);
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

  async checkExpectation(expectation) {
    const observed = {};
    if (expectation.url !== undefined || expectation.urlIncludes !== undefined) {
      const actual = this.page.url();
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
      const actual = await this.page.title();
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

    const locator = this.locate(expectation.target);
    const hasCondition = ["state", "text", "contains", "value", "count", "attribute", "computedStyle", "box"].some(
      (key) => expectation[key] !== undefined,
    );
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
        assertExpected(actual[property] === String(expectation.computedStyle[property]), `Expected computed style ${property}=${expectation.computedStyle[property]}, received ${actual[property]}`);
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

  async installNetworkRules(contract, routeCalls) {
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
        if (contract.captureRouteCalls) routeCalls.push({ method: request.method(), url: request.url(), action: "abort-resource" });
        await route.abort();
        return;
      }
      const requestMethod = request.method().toUpperCase();
      const rule = rules.find((candidate) =>
        candidate.matcher.test(request.url()) &&
        ((candidate.cors && requestMethod === "OPTIONS") || candidate.method === undefined || candidate.method === requestMethod) &&
        (requestMethod === "OPTIONS" || requestMatchesBody(request, candidate)),
      );
      if (!rule) {
        await route.continue();
        return;
      }
      if (rule.cors && requestMethod === "OPTIONS") {
        if (contract.captureRouteCalls) routeCalls.push({ method: request.method(), url: request.url(), action: "cors-preflight" });
        await route.fulfill({ status: 204, headers: corsHeaders(request, rule), body: "" });
        return;
      }
      if (rule.abort !== undefined) {
        if (contract.captureRouteCalls) routeCalls.push({ method: request.method(), url: request.url(), action: "abort" });
        await route.abort(rule.abort === true ? "failed" : rule.abort);
        return;
      }
      const isJson = Object.prototype.hasOwnProperty.call(rule, "json");
      const body = isJson ? JSON.stringify(rule.json) : String(rule.body);
      if (contract.captureRouteCalls) routeCalls.push({ method: request.method(), url: request.url(), action: "fulfill" });
      await route.fulfill({
        status: rule.status ?? 200,
        headers: corsHeaders(request, rule),
        contentType: rule.contentType || (isJson ? "application/json" : undefined),
        body,
      });
    };
    await this.page.route("**/*", handler);
    return handler;
  }

  async run(contract) {
    const started = performance.now();
    const evidence = contract?.evidence || "ultra";
    const outputs = {};
    const observations = [];
    const routeCalls = [];
    let phase = "contract";
    let routeHandler;
    let image;
    let coldStarted = false;
    this.consoleErrors = [];
    this.pageErrors = [];

    try {
      validateContract(contract);
      coldStarted = contract.reset ? (await this.reset(true), true) : await this.ensure();
      this.page.setDefaultTimeout(positiveInteger(contract.timeoutMs, 2000));
      this.page.setDefaultNavigationTimeout(positiveInteger(contract.navigationTimeoutMs, 5000));

      if (contract.viewport) {
        phase = "viewport";
        await this.page.setViewportSize(contract.viewport);
      }
      if ((contract.routes || []).length > 0 || (contract.blockResourceTypes || []).length > 0) {
        phase = "routes";
        routeHandler = await this.installNetworkRules(contract, routeCalls);
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
        await this.page.goto(contract.url, {
          waitUntil: contract.waitUntil || "domcontentloaded",
        });
      }
      if (contract.ready) {
        phase = "ready";
        observations.push(await this.checkExpectation(contract.ready));
      }
      for (const [index, step] of (contract.steps || []).entries()) {
        phase = `step:${index}:${step.op}`;
        await this.runStep(step, outputs);
      }
      for (const [index, expectation] of (contract.expect || []).entries()) {
        phase = `expect:${index}`;
        observations.push(await this.checkExpectation(expectation));
      }
      if (evidence === "visual" || evidence === "diag") {
        phase = "screenshot";
        image = await this.page.screenshot({ fullPage: Boolean(contract.screenshot?.fullPage) });
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
          outputs,
          observations,
          ...(healthFailure ? { failureKind: "page" } : {}),
          ...(evidence === "health" || evidence === "diag"
            ? { consoleErrors: this.consoleErrors, pageErrors: this.pageErrors }
            : {}),
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
          id: String(contract.id || "flow").slice(0, 80),
          runtime: coldStarted ? "cold" : "warm",
          phase,
          failureKind,
          elapsedMs: Math.round(performance.now() - started),
          url: this.page?.url() || null,
          error: compactError(error),
          ...(evidence === "health" || evidence === "diag"
            ? { consoleErrors: this.consoleErrors, pageErrors: this.pageErrors }
            : {}),
          ...(image ? { screenshotBytes: image.length } : {}),
          ...(contract?.captureRouteCalls ? { routeCalls } : {}),
        },
        image,
      };
    } finally {
      if (routeHandler && this.page && !this.page.isClosed()) {
        await this.page.unroute("**/*", routeHandler).catch(() => {});
      }
      if (this.isWarm()) this.touch();
    }
  }
}

const contractSchema = {
  type: "object",
  properties: {
    id: { type: "string", description: "Short flow identifier." },
    url: { type: "string", description: "Optional entry URL." },
    viewport: {
      type: "object",
      properties: { width: { type: "integer" }, height: { type: "integer" } },
      required: ["width", "height"],
      additionalProperties: false,
    },
    steps: { type: "array", items: { type: "object", additionalProperties: true } },
    expect: { type: "array", items: { type: "object", additionalProperties: true } },
    ready: { type: "object", additionalProperties: true },
    evidence: { type: "string", enum: ["ultra", "health", "visual", "diag"] },
    timeoutMs: { type: "integer" },
    navigationTimeoutMs: { type: "integer" },
    waitUntil: { type: "string", enum: ["commit", "domcontentloaded", "load", "networkidle"] },
    cookies: { type: "array", items: { type: "object", additionalProperties: true } },
    localStorage: {
      type: "array",
      description: "Origin-scoped localStorage entries installed before navigation and retained until reset.",
      items: {
        type: "object",
        properties: {
          origin: { type: "string" },
          name: { type: "string" },
          value: { type: "string" },
        },
        required: ["origin", "name", "value"],
        additionalProperties: false,
      },
    },
    routes: {
      type: "array",
      description: "First-match request mocks; supports requestBody/requestBodyIncludes and cors preflight handling.",
      items: { type: "object", additionalProperties: true },
    },
    captureRouteCalls: { type: "boolean" },
    blockResourceTypes: { type: "array", items: { type: "string" } },
    reset: { type: "boolean" },
    screenshot: { type: "object", properties: { fullPage: { type: "boolean" } } },
  },
  additionalProperties: false,
};

const tools = [
  {
    name: "run",
    description:
      "Run one batched Playwright contract on the persistent page. Defaults: 1440x900, 2s locator, 5s navigation, ultra evidence.",
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
  if (name === "status") {
    return { content: [{ type: "text", text: JSON.stringify(await runtime.status()) }] };
  }
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
  if (method === "notifications/initialized") {
    return;
  }
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
      respond(id, {
        content: [{ type: "text", text: JSON.stringify({ ok: false, error: compactError(error) }) }],
        isError: true,
      });
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
