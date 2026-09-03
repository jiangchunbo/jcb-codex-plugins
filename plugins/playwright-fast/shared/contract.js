const supportedEvidence = new Set(["ultra", "health", "visual", "diag"]);
const supportedWaitUntil = new Set(["commit", "domcontentloaded", "load", "networkidle"]);
const diagnosticRequestTypes = new Set(["document", "xhr", "fetch", "eventsource"]);
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 5000;
const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const MAX_OPERATION_TIMEOUT_MS = 10_000;
const MAX_CONTRACT_BUDGET_MS = 45_000;
const supportedSteps = new Set([
  "setContent", "goto", "click", "fill", "clear", "type", "press", "select", "check",
  "uncheck", "hover", "focus", "wait", "readText", "readAllText", "readAttribute",
  "readValue", "readBoundingBox", "readComputedStyle", "evaluate",
]);
const selectorKeys = ["role", "text", "label", "placeholder", "testId", "css"];

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

class PopupError extends Error {
  constructor(message) {
    super(message);
    this.name = "PopupError";
  }
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

function assertBoundedTimeout(value, label, { allowZero = false } = {}) {
  const minimum = allowZero ? 0 : 1;
  assertContract(Number.isInteger(value) && value >= minimum, `${label} must be ${allowZero ? "a non-negative" : "a positive"} integer`);
  assertContract(value <= MAX_OPERATION_TIMEOUT_MS, `${label} must not exceed ${MAX_OPERATION_TIMEOUT_MS}ms`);
}

function validateFrame(frame, label) {
  assertContract(frame && typeof frame === "object" && !Array.isArray(frame), `${label} must be an object`);
  const selectors = ["name", "urlIncludes", "css"].filter((key) => frame[key] !== undefined);
  assertContract(selectors.length === 1, `${label} must define exactly one of name, urlIncludes, or css`);
  assertContract(typeof frame[selectors[0]] === "string" && frame[selectors[0]].length > 0, `${label}.${selectors[0]} must be a non-empty string`);
}

function validateTarget(target, label) {
  assertContract(target && typeof target === "object" && !Array.isArray(target), `${label} target is required`);
  const selectors = selectorKeys.filter((key) => target[key] !== undefined);
  assertContract(selectors.length === 1, `${label} target must define exactly one selector`);
  const selector = selectors[0];
  assertContract(typeof target[selector] === "string" && target[selector].length > 0, `${label}.${selector} must be a non-empty string`);
  if (target.name !== undefined) {
    assertContract(target.role !== undefined, `${label}.name requires a role selector`);
    assertContract(typeof target.name === "string" && target.name.length > 0, `${label}.name must be a non-empty string`);
  }
  if (target.within !== undefined) validateTarget(target.within, `${label}.within`);
  if (target.frame !== undefined) validateFrame(target.frame, `${label}.frame`);
  if (target.hasText !== undefined) {
    const values = Array.isArray(target.hasText) ? target.hasText : [target.hasText];
    assertContract(
      values.length > 0 && values.every((value) => typeof value === "string" && value.length > 0),
      `${label}.hasText must be a non-empty string or string array`,
    );
  }
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

function expectationBudgetMs(expectation, defaultTimeoutMs) {
  if (["url", "urlIncludes"].some((key) => expectation[key] !== undefined)) return 0;
  if (["title", "titleIncludes"].some((key) => expectation[key] !== undefined)) return defaultTimeoutMs;
  const checks = ["state", "text", "contains", "value", "count", "attribute", "computedStyle", "box"]
    .filter((key) => expectation[key] !== undefined).length;
  return Math.max(1, checks) * defaultTimeoutMs;
}

function estimateContractBudgetMs(contract) {
  const defaultTimeoutMs = contract.timeoutMs || DEFAULT_TIMEOUT_MS;
  const navigationTimeoutMs = contract.navigationTimeoutMs || DEFAULT_NAVIGATION_TIMEOUT_MS;
  let budgetMs = contract.url ? navigationTimeoutMs : 0;
  if (contract.ready) budgetMs += expectationBudgetMs(contract.ready, defaultTimeoutMs);
  for (const step of contract.steps || []) {
    if (step.op === "wait" && step.ms !== undefined) {
      budgetMs += step.ms;
    } else if (step.op === "goto" || step.op === "setContent") {
      budgetMs += step.timeoutMs || navigationTimeoutMs;
    } else if (step.op === "click" && step.popup === "switch") {
      budgetMs += step.timeoutMs ? 3 * step.timeoutMs : 2 * defaultTimeoutMs + navigationTimeoutMs;
    } else {
      budgetMs += step.timeoutMs || defaultTimeoutMs;
    }
  }
  for (const expectation of contract.expect || []) {
    budgetMs += expectationBudgetMs(expectation, defaultTimeoutMs);
  }
  for (const capture of contract.captureResponses || []) {
    if (capture.required !== false) budgetMs += capture.timeoutMs || defaultTimeoutMs;
  }
  return budgetMs;
}

function resolveViewport(contract, currentViewport) {
  if (contract.viewport) return contract.viewport;
  const startsDocument = Boolean(contract.url) || (contract.steps || []).some(
    (step) => step.op === "goto" || step.op === "setContent",
  );
  return startsDocument ? DEFAULT_VIEWPORT : currentViewport || DEFAULT_VIEWPORT;
}

function screenshotTimeoutMs(defaultTimeoutMs, navigationTimeoutMs) {
  return Math.max(defaultTimeoutMs || DEFAULT_TIMEOUT_MS, navigationTimeoutMs || DEFAULT_NAVIGATION_TIMEOUT_MS);
}

function validateContract(contract) {
  assertContract(contract && typeof contract === "object" && !Array.isArray(contract), "Contract must be an object");
  assertContract(supportedEvidence.has(contract.evidence || "ultra"), "Unsupported evidence tier");
  if (contract.url !== undefined) assertContract(typeof contract.url === "string" && contract.url.length > 0, "url must be a non-empty string");
  if (contract.waitUntil !== undefined) assertContract(supportedWaitUntil.has(contract.waitUntil), "Unsupported waitUntil value");
  for (const key of ["timeoutMs", "navigationTimeoutMs"]) {
    if (contract[key] !== undefined) assertBoundedTimeout(contract[key], key);
  }
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
      if (route.requestBody !== undefined) assertContract(route.requestBody && typeof route.requestBody === "object", `routes[${index}].requestBody must be an object or array`);
      if (route.requestBodyIncludes !== undefined) assertContract(typeof route.requestBodyIncludes === "string", `routes[${index}].requestBodyIncludes must be a string`);
      if (route.cors !== undefined) assertContract(typeof route.cors === "boolean", `routes[${index}].cors must be a boolean`);
      if (route.body !== undefined) assertContract(typeof route.body === "string", `routes[${index}].body must be a string`);
      if (route.abort !== undefined) assertContract(route.abort === true || (typeof route.abort === "string" && route.abort.length > 0), `routes[${index}].abort must be true or a non-empty error code`);
      if (route.status !== undefined) assertContract(Number.isInteger(route.status) && route.status >= 100 && route.status <= 599, `routes[${index}].status must be an HTTP status code`);
      if (route.headers !== undefined) {
        assertContract(route.headers && typeof route.headers === "object" && !Array.isArray(route.headers), `routes[${index}].headers must be an object`);
        assertContract(Object.values(route.headers).every((value) => typeof value === "string"), `routes[${index}].headers values must be strings`);
      }
      if (route.contentType !== undefined) assertContract(typeof route.contentType === "string" && route.contentType.length > 0, `routes[${index}].contentType must be a non-empty string`);
    });
  }
  if (contract.captureResponses !== undefined) {
    assertContract(Array.isArray(contract.captureResponses), "captureResponses must be an array");
    const aliases = new Set();
    contract.captureResponses.forEach((capture, index) => {
      const label = `captureResponses[${index}]`;
      assertContract(capture && typeof capture === "object" && !Array.isArray(capture), `${label} must be an object`);
      assertContract(typeof capture.url === "string" && capture.url.length > 0, `${label}.url is required`);
      assertContract(typeof capture.as === "string" && capture.as.length > 0, `${label}.as is required`);
      assertContract(!aliases.has(capture.as), `${label}.as must be unique`);
      aliases.add(capture.as);
      if (capture.method !== undefined) assertContract(typeof capture.method === "string" && capture.method.length > 0, `${label}.method must be a string`);
      if (capture.body !== undefined) assertContract(capture.body === "json" || capture.body === "text", `${label}.body must be json or text`);
      for (const key of ["count", "maxBodyBytes", "timeoutMs"]) {
        if (capture[key] !== undefined) assertContract(Number.isInteger(capture[key]) && capture[key] > 0, `${label}.${key} must be a positive integer`);
      }
      if (capture.timeoutMs !== undefined) assertBoundedTimeout(capture.timeoutMs, `${label}.timeoutMs`);
      if (capture.required !== undefined) assertContract(typeof capture.required === "boolean", `${label}.required must be a boolean`);
    });
  }

  assertContract(contract.steps === undefined || Array.isArray(contract.steps), "steps must be an array");
  (contract.steps || []).forEach((step, index) => {
    const label = `steps[${index}]`;
    assertContract(step && typeof step === "object", `${label} must be an object`);
    assertContract(supportedSteps.has(step.op), `${label} has unsupported operation: ${step.op}`);
    if (step.timeoutMs !== undefined) assertBoundedTimeout(step.timeoutMs, `${label}.timeoutMs`);
    if (step.waitUntil !== undefined) assertContract(supportedWaitUntil.has(step.waitUntil), `${label}.waitUntil is unsupported`);
    if (step.popup !== undefined) {
      assertContract(step.op === "click", `${label}.popup is only supported for click`);
      assertContract(step.popup === "switch", `${label}.popup must be switch`);
    }
    if (step.waitUntil !== undefined) {
      const supportsWaitUntil = step.op === "setContent" || step.op === "goto" || (step.op === "click" && step.popup === "switch");
      assertContract(supportsWaitUntil, `${label}.waitUntil requires setContent, goto, or a popup click`);
    }
    if (step.frame !== undefined) assertContract(step.op === "evaluate", `${label}.frame is only supported directly on evaluate; other steps use target.frame`);
    if (step.as !== undefined) assertContract(typeof step.as === "string" && step.as.length > 0, `${label}.as must be a non-empty string`);
    if (step.delay !== undefined) assertContract(typeof step.delay === "number" && Number.isFinite(step.delay) && step.delay >= 0, `${label}.delay must be a non-negative number`);
    if (step.state !== undefined) assertContract(["attached", "detached", "visible", "hidden"].includes(step.state), `${label}.state is unsupported`);
    if (step.op === "setContent") {
      assertContract(typeof step.html === "string", `${label}.html must be a string`);
      return;
    }
    if (step.op === "goto") {
      assertContract(typeof step.url === "string" && step.url.length > 0, `${label}.url is required`);
      return;
    }
    if (step.op === "evaluate") {
      assertContract(typeof step.expression === "string" && step.expression.length > 0, `${label}.expression is required`);
      if (step.frame !== undefined) validateFrame(step.frame, `${label}.frame`);
      return;
    }
    if (step.op === "wait" && step.ms !== undefined) {
      assertBoundedTimeout(step.ms, `${label}.ms`, { allowZero: true });
      assertContract(step.target === undefined, `${label} cannot define both ms and target`);
      return;
    }
    validateTarget(step.target, label);
    if (step.op === "fill" || step.op === "type") assertContract(typeof step.value === "string", `${label}.value must be a string for ${step.op}`);
    if (step.op === "press") assertContract(typeof step.key === "string" && step.key.length > 0, `${label}.key must be a non-empty string`);
    if (step.op === "select") assertContract(step.value !== undefined, `${label}.value is required for select`);
    if (step.op === "readAllText" && step.timeoutMs !== undefined) assertContract(false, `${label}.timeoutMs is not supported for readAllText because it does not wait for a locator`);
    if (step.op === "readAttribute") assertContract(typeof step.attribute === "string" && step.attribute.length > 0, `${label}.attribute must be a non-empty string`);
    if (step.op === "readComputedStyle") assertContract(Array.isArray(step.properties) && step.properties.length > 0 && step.properties.every((property) => typeof property === "string" && property.length > 0), `${label}.properties must be a non-empty string array`);
  });
  if (contract.ready !== undefined) validateExpectation(contract.ready, "ready");
  assertContract(contract.expect === undefined || Array.isArray(contract.expect), "expect must be an array");
  (contract.expect || []).forEach((expectation, index) => validateExpectation(expectation, `expect[${index}]`));
  const budgetMs = estimateContractBudgetMs(contract);
  assertContract(budgetMs <= MAX_CONTRACT_BUDGET_MS, `Estimated contract budget ${budgetMs}ms exceeds ${MAX_CONTRACT_BUDGET_MS}ms; split the flow or lower explicit waits/timeouts`);
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
  const origin = requestHeaders.origin;
  const allowedMethod = String(rule.method || requestHeaders["access-control-request-method"] || request.method()).toUpperCase();
  return {
    "access-control-allow-origin": origin || "*",
    "access-control-allow-headers": requestHeaders["access-control-request-headers"] || "Content-Type, Authorization",
    "access-control-allow-methods": `${allowedMethod}, OPTIONS`,
    ...(origin ? {
      "access-control-allow-credentials": "true",
      vary: "Origin",
    } : {}),
    ...rule.headers,
  };
}

function recordRequestFailure(requestFailures, request) {
  const resourceType = request.resourceType();
  if (!diagnosticRequestTypes.has(resourceType)) return;
  const rawUrl = request.url();
  let url;
  try {
    const parsedUrl = new URL(rawUrl);
    parsedUrl.username = "";
    parsedUrl.password = "";
    parsedUrl.search = "";
    parsedUrl.hash = "";
    url = parsedUrl.toString();
  } catch {
    [url] = rawUrl.split(/[?#]/, 1);
  }
  requestFailures.push({
    method: request.method(),
    url,
    resourceType,
    errorText: request.failure()?.errorText || "Request failed",
  });
  if (requestFailures.length > 10) requestFailures.shift();
}

function readStyles(locator, properties, options) {
  return locator.evaluate((element, names) => {
    const style = getComputedStyle(element);
    return Object.fromEntries(names.map((name) => [name, style.getPropertyValue(name) || style[name] || ""]));
  }, properties, options);
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
  if (error instanceof PopupError) return "page";
  if (phase === "navigation" || phase.includes(":goto")) return "navigation";
  if (phase === "responses") return "network";
  if (phase.includes(":evaluate")) return "runtime";
  if (phase === "ready" || phase.startsWith("step:") || phase.startsWith("expect:")) return "locator";
  return "runtime";
}

function frameFromNameOrUrl(page, spec) {
  const matches = page.frames().filter((frame) =>
    spec.name !== undefined ? frame.name() === spec.name : frame.url().includes(spec.urlIncludes),
  );
  if (matches.length !== 1) throw new Error(`Frame target matched ${matches.length} frames`);
  return matches[0];
}

class FlowRuntime {
  constructor({ context, page, onPage, defaultTimeoutMs = DEFAULT_TIMEOUT_MS }) {
    this.context = context;
    this.page = page;
    this.onPage = onPage;
    this.defaultTimeoutMs = defaultTimeoutMs;
  }

  async switchToPage(page) {
    this.page = page;
    if (this.onPage) await this.onPage(page);
  }

  locatorRoot(frame) {
    if (!frame) return this.page;
    if (frame.css !== undefined) return this.page.frameLocator(frame.css);
    return frameFromNameOrUrl(this.page, frame);
  }

  locate(target, root) {
    assertContract(target && typeof target === "object", "A locator target is required");
    if (!root) root = this.locatorRoot(target.frame);
    else if (target.frame) root = this.locatorRoot(target.frame);
    if (target.within) root = this.locate(target.within, root);

    let locator;
    if (target.role) {
      const options = {};
      if (target.name !== undefined) {
        options.name = target.name;
        options.exact = target.exact !== false;
      }
      locator = root.getByRole(target.role, options);
    } else if (target.text !== undefined) locator = root.getByText(target.text, { exact: target.exact !== false });
    else if (target.label !== undefined) locator = root.getByLabel(target.label, { exact: target.exact !== false });
    else if (target.placeholder !== undefined) locator = root.getByPlaceholder(target.placeholder, { exact: target.exact !== false });
    else if (target.testId !== undefined) locator = root.getByTestId(target.testId);
    else if (target.css !== undefined) locator = root.locator(target.css);
    else throw new ContractError("Unsupported locator target");

    const textFilters = Array.isArray(target.hasText) ? target.hasText : [target.hasText];
    for (const hasText of textFilters) {
      if (hasText !== undefined) locator = locator.filter({ hasText });
    }
    if (target.first) locator = locator.first();
    if (Number.isInteger(target.nth)) locator = locator.nth(target.nth);
    return locator;
  }

  async resolveEvaluationTarget(frame) {
    if (!frame) return this.page;
    if (frame.css === undefined) return frameFromNameOrUrl(this.page, frame);
    const locator = this.page.locator(frame.css);
    const count = await locator.count();
    if (count !== 1) throw new Error(`Frame target matched ${count} elements`);
    const handle = await locator.elementHandle();
    const contentFrame = await handle?.contentFrame();
    await handle?.dispose();
    if (!contentFrame) throw new Error("Frame target has no attached content frame");
    return contentFrame;
  }

  async runStep(step, outputs) {
    if (step.op === "setContent") {
      await this.page.setContent(step.html, { waitUntil: step.waitUntil || "domcontentloaded", ...(step.timeoutMs ? { timeout: step.timeoutMs } : {}) });
      return;
    }
    if (step.op === "goto") {
      await this.page.goto(step.url, { waitUntil: step.waitUntil || "domcontentloaded", ...(step.timeoutMs ? { timeout: step.timeoutMs } : {}) });
      return;
    }
    if (step.op === "evaluate") {
      const target = await this.resolveEvaluationTarget(step.frame);
      const timeoutMs = step.timeoutMs || this.defaultTimeoutMs;
      const value = await target.evaluate(
        ({ expression, arg, timeoutMs: evaluationTimeoutMs }) => {
          const evaluated = eval(expression);
          const result = typeof evaluated === "function" ? evaluated(arg) : evaluated;
          if (!result || typeof result.then !== "function") return result;
          return Promise.race([
            result,
            new Promise((_, reject) => setTimeout(() => reject(new Error(`Evaluation timed out after ${evaluationTimeoutMs}ms`)), evaluationTimeoutMs)),
          ]);
        },
        { expression: step.expression, arg: step.arg, timeoutMs },
      );
      outputs[step.as || "evaluation"] = value;
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
        if (step.popup === "switch") {
          let popupWaitError;
          const popupPromise = this.context.waitForEvent("page", {
            timeout: step.timeoutMs || this.defaultTimeoutMs,
          }).catch((error) => {
            popupWaitError = error;
            return null;
          });
          await locator.click(actionOptions);
          const popup = await popupPromise;
          if (!popup) throw new PopupError(compactError(popupWaitError));
          await this.switchToPage(popup);
          await popup.waitForLoadState(step.waitUntil || "domcontentloaded", actionOptions);
        } else await locator.click(actionOptions);
        break;
      case "fill": await locator.fill(step.value, actionOptions); break;
      case "clear": await locator.clear(actionOptions); break;
      case "type": await locator.pressSequentially(step.value, { delay: step.delay || 0, ...actionOptions }); break;
      case "press": await locator.press(step.key, actionOptions); break;
      case "select": await locator.selectOption(step.value, actionOptions); break;
      case "check": await locator.check(actionOptions); break;
      case "uncheck": await locator.uncheck(actionOptions); break;
      case "hover": await locator.hover(actionOptions); break;
      case "focus": await locator.focus(actionOptions); break;
      case "wait": await locator.waitFor({ state: step.state || "visible", ...actionOptions }); break;
      case "readText": outputs[step.as || "text"] = await locator.textContent(actionOptions); break;
      case "readAllText": outputs[step.as || "texts"] = await locator.allTextContents(); break;
      case "readAttribute": outputs[step.as || step.attribute] = await locator.getAttribute(step.attribute, actionOptions); break;
      case "readValue": outputs[step.as || "value"] = await locator.inputValue(actionOptions); break;
      case "readBoundingBox": {
        const box = await locator.boundingBox(actionOptions);
        assertExpected(box, "Target has no visible bounding box");
        outputs[step.as || "box"] = withBoxEdges(box);
        break;
      }
      case "readComputedStyle": outputs[step.as || "computedStyle"] = await readStyles(locator, step.properties, actionOptions); break;
      default: throw new ContractError(`Unsupported step operation: ${step.op}`);
    }
  }

  async checkExpectation(expectation) {
    const observed = {};
    if (expectation.url !== undefined || expectation.urlIncludes !== undefined) {
      const actual = this.page.url();
      observed.url = actual;
      if (expectation.url !== undefined) assertExpected(actual === expectation.url, `Expected URL ${expectation.url}, received ${actual}`);
      if (expectation.urlIncludes !== undefined) assertExpected(actual.includes(expectation.urlIncludes), `Expected URL containing ${expectation.urlIncludes}, received ${actual}`);
      return observed;
    }
    if (expectation.title !== undefined || expectation.titleIncludes !== undefined) {
      const actual = await this.page.title();
      observed.title = actual;
      if (expectation.title !== undefined) assertExpected(actual === expectation.title, `Expected title ${expectation.title}, received ${actual}`);
      if (expectation.titleIncludes !== undefined) assertExpected(actual.includes(expectation.titleIncludes), `Expected title containing ${expectation.titleIncludes}, received ${actual}`);
      return observed;
    }

    const locator = this.locate(expectation.target);
    const hasCondition = ["state", "text", "contains", "value", "count", "attribute", "computedStyle", "box"].some((key) => expectation[key] !== undefined);
    if (!hasCondition || expectation.state !== undefined) {
      const state = expectation.state || "visible";
      await locator.waitFor({ state });
      observed.state = state;
    }
    if (expectation.text !== undefined || expectation.contains !== undefined) {
      const actual = await locator.textContent();
      observed.text = actual;
      if (expectation.text !== undefined) assertExpected(actual === expectation.text, `Expected text ${expectation.text}, received ${actual}`);
      if (expectation.contains !== undefined) assertExpected(String(actual).includes(expectation.contains), `Expected text containing ${expectation.contains}, received ${actual}`);
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
      assertExpected(actual === expectation.attribute.value, `Expected ${expectation.attribute.name}=${expectation.attribute.value}, received ${actual}`);
    }
    if (expectation.computedStyle !== undefined) {
      const properties = Object.keys(expectation.computedStyle);
      const actual = await readStyles(locator, properties);
      observed.computedStyle = actual;
      for (const property of properties) assertExpected(actual[property] === String(expectation.computedStyle[property]), `Expected computed style ${property}=${expectation.computedStyle[property]}, received ${actual[property]}`);
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
      const requestedMethod = String(request.headers()["access-control-request-method"] || "").toUpperCase();
      const isPreflight = requestMethod === "OPTIONS" && requestedMethod.length > 0;
      const rule = rules.find((candidate) => {
        if (!candidate.matcher.test(request.url())) return false;
        if (isPreflight) {
          return candidate.cors && (candidate.method === undefined || candidate.method === requestedMethod);
        }
        if (candidate.cors && requestMethod === "OPTIONS") return true;
        return (candidate.method === undefined || candidate.method === requestMethod) && requestMatchesBody(request, candidate);
      });
      if (!rule) {
        await route.continue();
        return;
      }
      if (rule.cors && requestMethod === "OPTIONS") {
        await route.fulfill({ status: 204, headers: corsHeaders(request, rule), body: "" });
        if (contract.captureRouteCalls) routeCalls.push({ method: request.method(), url: request.url(), action: "cors-preflight", status: 204 });
        return;
      }
      if (rule.abort !== undefined) {
        if (contract.captureRouteCalls) routeCalls.push({ method: request.method(), url: request.url(), action: "abort" });
        await route.abort(rule.abort === true ? "failed" : rule.abort);
        return;
      }
      const isJson = Object.prototype.hasOwnProperty.call(rule, "json");
      const body = isJson ? JSON.stringify(rule.json) : String(rule.body);
      const status = rule.status ?? 200;
      await route.fulfill({
        status,
        headers: corsHeaders(request, rule),
        contentType: rule.contentType || (isJson ? "application/json" : undefined),
        body,
      });
      if (contract.captureRouteCalls) routeCalls.push({ method: request.method(), url: request.url(), action: "fulfill", status });
    };
    await this.context.route("**/*", handler);
    return handler;
  }

  installResponseCaptures(contract, outputs, defaultTimeoutMs) {
    const states = (contract.captureResponses || []).map((rule) => {
      let notify;
      return {
        rule: {
          body: "json",
          count: 1,
          maxBodyBytes: 1_000_000,
          required: true,
          ...rule,
          method: rule.method ? rule.method.toUpperCase() : undefined,
          matcher: globToRegExp(rule.url),
        },
        results: [],
        inFlight: 0,
        error: null,
        changed: new Promise((resolve) => { notify = resolve; }),
        notify,
      };
    });
    if (states.length === 0) return undefined;
    const pending = new Set();
    const signal = (state) => {
      state.notify();
      state.changed = new Promise((resolve) => { state.notify = resolve; });
    };
    const captureBody = async (response, state) => {
      const contentLength = Number(await response.headerValue("content-length"));
      if (Number.isFinite(contentLength) && contentLength > state.rule.maxBodyBytes) {
        throw new Error(`Response body exceeds maxBodyBytes (${state.rule.maxBodyBytes}) for ${state.rule.as}`);
      }
      const contentType = String(await response.headerValue("content-type") || "").toLowerCase();
      if (state.rule.body === "text" && contentType && !/^(text\/)|json|javascript|xml|x-www-form-urlencoded/.test(contentType)) {
        throw new Error(`Response content type ${contentType} is not textual for ${state.rule.as}`);
      }
      const buffer = await response.body();
      if (buffer.length > state.rule.maxBodyBytes) throw new Error(`Response body exceeds maxBodyBytes (${state.rule.maxBodyBytes}) for ${state.rule.as}`);
      const text = buffer.toString("utf8");
      return state.rule.body === "json" ? JSON.parse(text) : text;
    };
    const hasTextualBody = (response) => {
      const contentType = String(response.headers()["content-type"] || "").toLowerCase();
      return !contentType || /^(text\/)|json|javascript|xml|x-www-form-urlencoded/.test(contentType);
    };
    const handler = (response) => {
      const request = response.request();
      const method = request.method().toUpperCase();
      for (const state of states) {
        const matches =
          state.rule.matcher.test(response.url()) &&
          (state.rule.method === undefined || state.rule.method === method) &&
          state.results.length + state.inFlight < state.rule.count &&
          hasTextualBody(response);
        if (!matches) continue;
        state.inFlight += 1;
        const capture = captureBody(response, state)
          .then((body) => {
            state.results.push({ url: response.url(), method, status: response.status(), body });
          })
          .catch((error) => { state.error = error; })
          .finally(() => {
            state.inFlight -= 1;
            signal(state);
            pending.delete(capture);
          });
        pending.add(capture);
      }
    };
    this.context.on("response", handler);

    return {
      wait: async () => {
        for (const state of states) {
          const timeoutMs = state.rule.timeoutMs || defaultTimeoutMs;
          const deadline = Date.now() + timeoutMs;
          while (state.rule.required && state.results.length < state.rule.count && !state.error) {
            const remaining = deadline - Date.now();
            if (remaining <= 0) throw new Error(`Timed out waiting for ${state.rule.count} response(s) as ${state.rule.as}`);
            await new Promise((resolve, reject) => {
              const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${state.rule.count} response(s) as ${state.rule.as}`)), remaining);
              state.changed.then(() => {
                clearTimeout(timer);
                resolve();
              });
            });
          }
          if (state.error) throw state.error;
        }
        await Promise.all(pending);
        for (const state of states) {
          if (state.error) throw state.error;
          outputs[state.rule.as] = state.rule.count === 1 ? state.results[0] ?? null : state.results;
        }
      },
      dispose: () => this.context.off("response", handler),
    };
  }
}

const frameSchema = {
  type: "object",
  description: "Select one iframe by exact name, partial URL, or iframe CSS locator.",
  properties: {
    name: { type: "string", minLength: 1 },
    urlIncludes: { type: "string", minLength: 1 },
    css: { type: "string", minLength: 1 },
  },
  oneOf: ["name", "urlIncludes", "css"].map((key) => ({ required: [key] })),
  additionalProperties: false,
};

const targetSchema = {
  type: "object",
  description: "One semantic/CSS locator, optionally scoped to an ancestor with within and/or to an iframe with frame.",
  properties: {
    role: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    text: { type: "string", minLength: 1 },
    label: { type: "string", minLength: 1 },
    placeholder: { type: "string", minLength: 1 },
    testId: { type: "string", minLength: 1 },
    css: { type: "string", minLength: 1 },
    exact: { type: "boolean" },
    first: { type: "boolean" },
    nth: { type: "integer", minimum: 0 },
    hasText: {
      description: "Filter the selected elements by one or more contained text fragments.",
      oneOf: [
        { type: "string", minLength: 1 },
        { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
      ],
    },
    within: { $ref: "#/$defs/target" },
    frame: { $ref: "#/$defs/frame" },
  },
  oneOf: selectorKeys.map((key) => ({ required: [key] })),
  additionalProperties: false,
};

const basicLocatorStepOps = [
  "click", "clear", "check", "uncheck", "hover", "focus",
  "readText", "readAllText", "readValue", "readBoundingBox",
];

const stepSchema = {
  type: "object",
  description: "A navigation, interaction, read, or evaluate operation. goto/setContent/evaluate do not use target.",
  properties: {
    op: { type: "string", enum: [...supportedSteps] },
    target: { $ref: "#/$defs/target" },
    url: { type: "string", minLength: 1, description: "Destination for goto." },
    html: { type: "string", description: "HTML for setContent." },
    value: {},
    key: { type: "string", minLength: 1 },
    delay: { type: "number", minimum: 0 },
    state: { type: "string", enum: ["attached", "detached", "visible", "hidden"] },
    ms: { type: "integer", minimum: 0 },
    attribute: { type: "string", minLength: 1 },
    properties: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    as: { type: "string", minLength: 1, description: "Output key for reads/evaluate." },
    timeoutMs: { type: "integer", minimum: 1, maximum: MAX_OPERATION_TIMEOUT_MS },
    waitUntil: { type: "string", enum: [...supportedWaitUntil] },
    popup: { type: "string", enum: ["switch"], description: "On click, atomically wait for and switch to the new page." },
    expression: { type: "string", minLength: 1, description: "Page expression or function expression for evaluate; optional arg is available and passed to functions." },
    arg: {},
    frame: { $ref: "#/$defs/frame" },
  },
  required: ["op"],
  oneOf: [
    { properties: { op: { const: "setContent" } }, required: ["html"] },
    { properties: { op: { const: "goto" } }, required: ["url"] },
    { properties: { op: { const: "evaluate" } }, required: ["expression"] },
    {
      properties: { op: { const: "wait" } },
      oneOf: [
        { required: ["target"], not: { required: ["ms"] } },
        { required: ["ms"], not: { required: ["target"] } },
      ],
    },
    { properties: { op: { const: "readAttribute" } }, required: ["target", "attribute"] },
    { properties: { op: { const: "readComputedStyle" } }, required: ["target", "properties"] },
    { properties: { op: { const: "press" } }, required: ["target", "key"] },
    { properties: { op: { const: "select" } }, required: ["target", "value"] },
    { properties: { op: { enum: ["fill", "type"] }, value: { type: "string" } }, required: ["target", "value"] },
    { properties: { op: { enum: basicLocatorStepOps } }, required: ["target"] },
  ],
  allOf: [
    {
      if: { required: ["popup"] },
      then: { properties: { op: { const: "click" } } },
    },
    {
      if: { required: ["frame"] },
      then: { properties: { op: { const: "evaluate" } } },
    },
    {
      if: { required: ["waitUntil"] },
      then: {
        anyOf: [
          { properties: { op: { enum: ["setContent", "goto"] } } },
          { properties: { op: { const: "click" } }, required: ["popup"] },
        ],
      },
    },
    {
      if: { properties: { op: { const: "readAllText" } }, required: ["op"] },
      then: { not: { required: ["timeoutMs"] } },
    },
  ],
  additionalProperties: false,
};

const routeSchema = {
  type: "object",
  description: "One first-match request rule. Define exactly one response action: json, body, or abort.",
  properties: {
    url: { type: "string", minLength: 1, description: "URL glob." },
    method: { type: "string", minLength: 1 },
    requestBody: { type: ["object", "array"], description: "Partial JSON body that must match." },
    requestBodyIncludes: { type: "string", description: "Raw request-body fragment that must match." },
    cors: { type: "boolean", description: "Fulfill credential-compatible CORS headers and OPTIONS preflight." },
    json: { description: "JSON response body." },
    body: { type: "string", description: "Text response body." },
    abort: {
      oneOf: [{ const: true }, { type: "string", minLength: 1 }],
      description: "Abort with failed when true, or with the supplied Playwright error code.",
    },
    status: { type: "integer", minimum: 100, maximum: 599 },
    headers: { type: "object", additionalProperties: { type: "string" } },
    contentType: { type: "string", minLength: 1 },
  },
  required: ["url"],
  oneOf: ["json", "body", "abort"].map((key) => ({ required: [key] })),
  additionalProperties: false,
};

const expectationSchema = {
  type: "object",
  properties: {
    target: { $ref: "#/$defs/target" },
    state: { type: "string", enum: ["attached", "detached", "visible", "hidden"] },
    text: {}, contains: {}, value: {}, count: { type: "integer", minimum: 0 },
    attribute: { type: "object", properties: { name: { type: "string" }, value: {} }, required: ["name", "value"], additionalProperties: false },
    computedStyle: { type: "object", additionalProperties: true },
    box: { type: "object", additionalProperties: true },
    url: { type: "string" }, urlIncludes: { type: "string" },
    title: { type: "string" }, titleIncludes: { type: "string" },
  },
  oneOf: ["target", "url", "urlIncludes", "title", "titleIncludes"].map((key) => ({ required: [key] })),
  additionalProperties: false,
};

const contractSchema = {
  type: "object",
  description: `One bounded browser flow. Explicit operation timeouts are capped at ${MAX_OPERATION_TIMEOUT_MS}ms and the estimated combined budget at ${MAX_CONTRACT_BUDGET_MS}ms.`,
  $defs: { frame: frameSchema, target: targetSchema, route: routeSchema, step: stepSchema, expectation: expectationSchema },
  properties: {
    id: { type: "string", description: "Short flow identifier." },
    url: { type: "string", minLength: 1, description: "Optional entry URL." },
    viewport: {
      type: "object",
      description: "Viewport for this run. When omitted, new-document flows use 1440x900 and continuation flows preserve the current viewport.",
      properties: { width: { type: "integer" }, height: { type: "integer" } },
      required: ["width", "height"],
      additionalProperties: false,
    },
    steps: { type: "array", items: { $ref: "#/$defs/step" } },
    expect: { type: "array", items: { $ref: "#/$defs/expectation" } },
    ready: {
      description: "Expectation checked after top-level navigation. Locator readiness must nest the locator under target, for example { target: { text: 'Ready' }, state: 'visible' }.",
      allOf: [{ $ref: "#/$defs/expectation" }],
    },
    evidence: { type: "string", enum: [...supportedEvidence] },
    timeoutMs: { type: "integer", minimum: 1, maximum: MAX_OPERATION_TIMEOUT_MS },
    navigationTimeoutMs: { type: "integer", minimum: 1, maximum: MAX_OPERATION_TIMEOUT_MS },
    waitUntil: { type: "string", enum: [...supportedWaitUntil] },
    cookies: { type: "array", items: { type: "object", additionalProperties: true } },
    localStorage: {
      type: "array",
      description: "Origin-scoped localStorage entries installed before navigation and retained until reset.",
      items: { type: "object", properties: { origin: { type: "string", minLength: 1 }, name: { type: "string", minLength: 1 }, value: { type: "string" } }, required: ["origin", "name", "value"], additionalProperties: false },
    },
    routes: {
      type: "array",
      description: "First-match request mocks scoped to this run and removed before it returns. In URL globs, ? matches exactly one character; use a trailing * when a query string is optional.",
      items: { $ref: "#/$defs/route" },
    },
    captureResponses: {
      type: "array",
      description: "Capture and await matching real responses. One result is returned directly; count > 1 returns an array.",
      items: {
        type: "object",
        properties: {
          url: { type: "string", minLength: 1, description: "URL glob." }, method: { type: "string", minLength: 1 },
          body: { type: "string", enum: ["json", "text"], default: "json" }, as: { type: "string", minLength: 1 },
          count: { type: "integer", minimum: 1, default: 1 }, maxBodyBytes: { type: "integer", minimum: 1, default: 1000000 },
          timeoutMs: { type: "integer", minimum: 1, maximum: MAX_OPERATION_TIMEOUT_MS }, required: { type: "boolean", default: true },
        },
        required: ["url", "as"],
        additionalProperties: false,
      },
    },
    captureRouteCalls: { type: "boolean" },
    blockResourceTypes: {
      type: "array",
      description: "Resource types blocked only for this run.",
      items: { type: "string" },
    },
    reset: { type: "boolean", description: "Discard browser, context, page, cookies, and storage before this run. Route changes do not require reset." },
    screenshot: { type: "object", properties: { fullPage: { type: "boolean" }, path: { type: "string" } }, additionalProperties: false },
  },
  additionalProperties: false,
};

module.exports = {
  AssertionError,
  ContractError,
  DEFAULT_NAVIGATION_TIMEOUT_MS,
  DEFAULT_TIMEOUT_MS,
  DEFAULT_VIEWPORT,
  FlowRuntime,
  MAX_CONTRACT_BUDGET_MS,
  MAX_OPERATION_TIMEOUT_MS,
  PopupError,
  classifyFailure,
  compactError,
  contractSchema,
  recordRequestFailure,
  resolveViewport,
  screenshotTimeoutMs,
  validateContract,
};
