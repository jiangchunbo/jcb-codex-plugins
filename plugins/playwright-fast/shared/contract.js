const supportedEvidence = new Set(["ultra", "health", "visual", "diag"]);
const supportedWaitUntil = new Set(["commit", "domcontentloaded", "load", "networkidle"]);
const diagnosticRequestTypes = new Set(["document", "xhr", "fetch", "eventsource"]);
const DEFAULT_TIMEOUT_MS = 2000;
const DEFAULT_NAVIGATION_TIMEOUT_MS = 5000;
const DEFAULT_VIEWPORT = Object.freeze({ width: 1440, height: 900 });
const MAX_OPERATION_TIMEOUT_MS = 30_000;
const MAX_FLOW_TIMEOUT_MS = 30_000;
const MAX_CONTRACT_BUDGET_MS = 50_000;
const supportedSteps = new Set([
  "setContent", "goto", "reload", "click", "fill", "clear", "type", "press", "select", "setInputFiles", "check",
  "uncheck", "hover", "focus", "wait", "readText", "readAllText", "readAttribute",
  "readValue", "readBoundingBox", "readComputedStyle", "evaluate", "waitForTimeout",
]);
const selectorKeys = ["role", "text", "label", "placeholder", "testId", "css"];

class ContractError extends Error {
  constructor(message, issues) {
    super(message);
    this.name = "ContractError";
    if (issues) this.issues = issues;
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

function effectiveStepTarget(step) {
  if (step?.op === "readAllText" && step.target === undefined) return { css: "body" };
  if (!step?.target || (step.first === undefined && step.nth === undefined)) return step?.target;
  return {
    ...step.target,
    ...(step.target.first === undefined && step.first !== undefined ? { first: step.first } : {}),
    ...(step.target.nth === undefined && step.nth !== undefined ? { nth: step.nth } : {}),
  };
}

function truncateText(value, maxChars) {
  if (typeof value !== "string" || maxChars === undefined || value.length <= maxChars) return value;
  const suffix = "...[truncated]";
  if (maxChars <= suffix.length) return suffix.slice(0, maxChars);
  return `${value.slice(0, maxChars - suffix.length)}${suffix}`;
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
  const pageExpectation = expectation.url !== undefined || expectation.urlIncludes !== undefined ||
    (expectation.target === undefined && (expectation.title !== undefined || expectation.titleIncludes !== undefined));
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
  return defaultTimeoutMs;
}

function estimateContractBudgetMs(contract) {
  const defaultTimeoutMs = contract.timeoutMs || DEFAULT_TIMEOUT_MS;
  const navigationTimeoutMs = contract.navigationTimeoutMs || DEFAULT_NAVIGATION_TIMEOUT_MS;
  let serialBudgetMs = contract.url ? navigationTimeoutMs : 0;
  let currentDocumentUrl = contract.url;
  let largestLocatorBudgetMs = contract.ready ? expectationBudgetMs(contract.ready, defaultTimeoutMs) : 0;
  for (const step of contract.steps || []) {
    if (step.op === "wait" && step.ms !== undefined) {
      serialBudgetMs += step.ms;
    } else if (step.op === "waitForTimeout") {
      serialBudgetMs += step.ms ?? step.timeoutMs ?? defaultTimeoutMs;
    } else if (step.op === "goto") {
      const sameDocument = currentDocumentUrl && String(currentDocumentUrl).split("#", 1)[0] === String(step.url).split("#", 1)[0];
      if (!sameDocument) serialBudgetMs += step.timeoutMs || navigationTimeoutMs;
      currentDocumentUrl = step.url;
    } else if (step.op === "reload" || step.op === "setContent") {
      serialBudgetMs += step.timeoutMs || navigationTimeoutMs;
      if (step.op === "setContent") currentDocumentUrl = undefined;
    } else if (step.op === "click" && step.popup === "switch") {
      serialBudgetMs += step.timeoutMs ? 3 * step.timeoutMs : 2 * defaultTimeoutMs + navigationTimeoutMs;
    } else {
      largestLocatorBudgetMs = Math.max(largestLocatorBudgetMs, step.timeoutMs || defaultTimeoutMs);
    }
  }
  for (const expectation of contract.expect || []) {
    largestLocatorBudgetMs = Math.max(largestLocatorBudgetMs, expectationBudgetMs(expectation, defaultTimeoutMs));
  }
  const responseBudgetMs = Math.max(0, ...(contract.captureResponses || [])
    .filter((capture) => capture.required !== false)
    .map((capture) => capture.timeoutMs || defaultTimeoutMs));
  // A locator failure stops the flow. Adding every locator timeout rejects compact flows even
  // though only one failure ceiling can be consumed; navigation and explicit sleeps stay serial.
  return Math.max(serialBudgetMs + largestLocatorBudgetMs, responseBudgetMs);
}

function suggestedNextAction(failureKind) {
  if (failureKind === "contract") return "Correct all reported contract fields together and rerun the same compact flow.";
  return "Preserve the current page and run one targeted diag contract without repeating the failed expectation; omit top-level url unless diagnosis navigates.";
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

// Validate the keywords used by our published schema, including nested targets.
// Semantic constraints (operation-specific fields, selector exclusivity, budgets)
// remain in validateContractSemantics below.
function schemaIssues(value, schema, path = "", issues = []) {
  if (schema.$ref) schema = contractSchema.$defs[schema.$ref.split("/").pop()];
  const label = path || "contract";
  const add = (message) => issues.push({ path: label, message });
  if (schema.oneOf) {
    if (schema.oneOf.filter((branch) => schemaIssues(value, branch, path, []).length === 0).length !== 1) {
      add(`${label} must match exactly one supported shape`);
    }
    return issues;
  }
  if (Object.prototype.hasOwnProperty.call(schema, "const") && value !== schema.const) add(`${label} must be ${JSON.stringify(schema.const)}`);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some((type) => type === "array" ? Array.isArray(value)
      : type === "object" ? value !== null && typeof value === "object" && !Array.isArray(value)
      : type === "integer" ? Number.isInteger(value)
      : type === "number" ? typeof value === "number" && Number.isFinite(value)
      : typeof value === type);
    if (!matches) { add(`${label} must be ${types.join(" or ")}`); return issues; }
  }
  if (schema.enum && !schema.enum.includes(value)) add(`${label} must be one of ${schema.enum.join(", ")}`);
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) add(`${label} must be at least ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) add(`${label} must not exceed ${schema.maximum}`);
  }
  if (typeof value === "string" && schema.minLength !== undefined && value.length < schema.minLength) add(`${label} must be a non-empty string`);
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) add(`${label} must contain at least ${schema.minItems} item(s)`);
    if (schema.items) value.forEach((item, index) => schemaIssues(item, schema.items, `${path}[${index}]`, issues));
  } else if (value && typeof value === "object") {
    const childPath = (key) => path ? `${path}.${key}` : key;
    for (const key of schema.required || []) {
      if (value[key] === undefined) issues.push({ path: childPath(key), message: `${childPath(key)} is required` });
    }
    for (const [key, item] of Object.entries(value)) {
      const childSchema = Object.hasOwn(schema.properties || {}, key) ? schema.properties[key] : undefined;
      if (childSchema) schemaIssues(item, childSchema, childPath(key), issues);
      else if (schema.additionalProperties === false) issues.push({ path: childPath(key), message: `${childPath(key)} is not supported` });
      else if (schema.additionalProperties && typeof schema.additionalProperties === "object") schemaIssues(item, schema.additionalProperties, childPath(key), issues);
    }
  }
  return issues;
}

function validateContract(contract) {
  const issues = schemaIssues(contract, contractSchema);
  let semanticError;
  try { validateContractSemantics(contract); } catch (error) { semanticError = error; }
  if (semanticError instanceof ContractError) {
    const matching = issues.findIndex((issue) => semanticError.message.startsWith(`${issue.path} `) || semanticError.message === issue.message);
    if (matching >= 0) issues[matching].message = semanticError.message;
    else issues.unshift({ path: "contract", message: semanticError.message });
  } else if (semanticError && !(semanticError instanceof ContractError) && issues.length === 0) {
    throw semanticError;
  }
  if (issues.length) throw new ContractError(issues.map((issue) => issue.message).join("; "), issues);
}

function validateContractSemantics(contract) {
  assertContract(contract && typeof contract === "object" && !Array.isArray(contract), "Contract must be an object");
  assertContract(supportedEvidence.has(contract.evidence || "ultra"), "Unsupported evidence tier");
  if (contract.url !== undefined) assertContract(typeof contract.url === "string" && contract.url.length > 0, "url must be a non-empty string");
  if (contract.waitUntil !== undefined) assertContract(supportedWaitUntil.has(contract.waitUntil), "Unsupported waitUntil value");
  if (contract.timeoutMs !== undefined) {
    assertContract(Number.isInteger(contract.timeoutMs) && contract.timeoutMs > 0, "timeoutMs must be a positive integer");
    assertContract(contract.timeoutMs <= MAX_FLOW_TIMEOUT_MS, `timeoutMs must not exceed ${MAX_FLOW_TIMEOUT_MS}ms`);
  }
  if (contract.navigationTimeoutMs !== undefined) assertBoundedTimeout(contract.navigationTimeoutMs, "navigationTimeoutMs");
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
      if (route.body !== undefined) {
        assertContract(
          typeof route.body === "string",
          `routes[${index}].body must be a string; use routes[${index}].json for objects or arrays`,
        );
      }
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
    if (step.ms !== undefined) assertBoundedTimeout(step.ms, `${label}.ms`, { allowZero: true });
    if (step.maxChars !== undefined) {
      assertContract(Number.isInteger(step.maxChars) && step.maxChars > 0, `${label}.maxChars must be a positive integer`);
    }
    if (step.first !== undefined) assertContract(typeof step.first === "boolean", `${label}.first must be a boolean`);
    if (step.nth !== undefined) assertContract(Number.isInteger(step.nth) && step.nth >= 0, `${label}.nth must be a non-negative integer`);
    if (step.waitUntil !== undefined) assertContract(supportedWaitUntil.has(step.waitUntil), `${label}.waitUntil is unsupported`);
    if (step.popup !== undefined) {
      assertContract(step.op === "click", `${label}.popup is only supported for click`);
      assertContract(step.popup === "switch", `${label}.popup must be switch`);
    }
    if (step.waitUntil !== undefined) {
      const supportsWaitUntil = step.op === "setContent" || step.op === "goto" || step.op === "reload" || (step.op === "click" && step.popup === "switch");
      assertContract(supportsWaitUntil, `${label}.waitUntil requires setContent, goto, reload, or a popup click`);
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
    if (step.op === "reload") return;
    if (step.op === "evaluate") {
      assertContract(typeof step.expression === "string" && step.expression.length > 0, `${label}.expression is required`);
      if (step.frame !== undefined) validateFrame(step.frame, `${label}.frame`);
      if (step.target !== undefined) validateTarget(effectiveStepTarget(step), label);
      assertContract(!(step.frame && step.target), `${label} cannot define both frame and target`);
      return;
    }
    if (step.op === "waitForTimeout") {
      assertContract(step.ms !== undefined || step.timeoutMs !== undefined, `${label} requires ms or timeoutMs`);
      assertContract(step.target === undefined, `${label} does not use target`);
      return;
    }
    if (step.op === "wait" && step.ms !== undefined) {
      assertContract(step.target === undefined, `${label} cannot define both ms and target`);
      return;
    }
    validateTarget(effectiveStepTarget(step), label);
    if (step.op === "fill" || step.op === "type") {
      assertContract(typeof (step.value ?? step.text) === "string", `${label}.value or ${label}.text must be a string for ${step.op}`);
    }
    if (step.op === "press") assertContract(typeof step.key === "string" && step.key.length > 0, `${label}.key must be a non-empty string`);
    if (step.op === "select") assertContract(step.value !== undefined, `${label}.value is required for select`);
    if (step.op === "setInputFiles") {
      const fileFields = ["files", "paths"].filter((key) => step[key] !== undefined);
      assertContract(fileFields.length === 1, `${label} must define exactly one of files or paths for setInputFiles`);
      const files = step[fileFields[0]];
      assertContract(
        Array.isArray(files) && files.length > 0 && files.every((file) => typeof file === "string" && file.length > 0),
        `${label}.${fileFields[0]} must be a non-empty string array`,
      );
    }
    if (step.maxChars !== undefined) assertContract(["readText", "readAllText"].includes(step.op), `${label}.maxChars is only supported for readText and readAllText`);
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

  async resolveUniqueVisibleLocator(locator) {
    const count = await locator.count();
    if (count <= 1) return { locator };
    const visibleIndexes = await locator.evaluateAll((elements) => elements.flatMap((element, index) => {
      const box = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none"
        ? [index]
        : [];
    }));
    if (visibleIndexes.length !== 1) return { locator };
    return { locator: locator.nth(visibleIndexes[0]), locatorFallback: "unique-visible-match" };
  }

  async resolveImplicitFuzzyLocator(target, locator) {
    const fuzzyKind = target.label !== undefined ? "label" : target.text !== undefined ? "text" : null;
    if (target.exact !== undefined || fuzzyKind === null || await locator.count() !== 0) return { locator };
    const fallback = this.locate({ ...target, exact: false });
    if (await fallback.count() === 0) return { locator };
    return { locator: fallback, locatorFallback: `${fuzzyKind}-substring` };
  }

  async resolveClickLocator(target, locator, locatorFallback) {
    let candidate = locator;
    let strategy = locatorFallback;

    if (await candidate.count() === 0 && target.placeholder !== undefined) {
      candidate = this.locate({
        text: target.placeholder,
        exact: target.exact,
        first: target.first,
        nth: target.nth,
        hasText: target.hasText,
        within: target.within,
        frame: target.frame,
      });
      const visible = await this.resolveUniqueVisibleLocator(candidate);
      candidate = visible.locator;
      strategy = "placeholder-text";
    }

    if (await candidate.count() === 0 && target.role === "button") {
      candidate = this.locate({
        text: target.name,
        exact: target.exact,
        first: target.first,
        nth: target.nth,
        hasText: target.hasText,
        within: target.within,
        frame: target.frame,
      });
      strategy = "button-name-interactive-ancestor";
    }
    const visible = await this.resolveUniqueVisibleLocator(candidate);
    candidate = visible.locator;
    strategy = strategy || visible.locatorFallback;
    if (await candidate.count() !== 1) return { locator };

    if (target.text === undefined && !(target.role === "button" && target.name !== undefined)) {
      const ancestorDistance = await candidate.evaluate((element) => {
        const isReadonlyControl = element.matches("input") && element.readOnly;
        if (!isReadonlyControl) return -1;
        let current = element.parentElement;
        let distance = 1;
        while (current && distance <= 5) {
          const role = current.getAttribute("role");
          const className = String(current.getAttribute("class") || "");
          if (role === "combobox" || /(?:^|\s|[-_])(select|cascader|picker|combobox)(?:\s|[-_]|$)/i.test(className)) return distance;
          current = current.parentElement;
          distance += 1;
        }
        return -1;
      });
      if (ancestorDistance > 0) {
        return {
          locator: candidate.locator(`xpath=ancestor-or-self::*[${ancestorDistance + 1}]`),
          locatorFallback: "readonly-control-ancestor",
        };
      }
      return { locator: candidate, ...(strategy ? { locatorFallback: strategy } : {}) };
    }

    const ancestorDistance = await candidate.evaluate((element) => {
      const isInteractive = (node) => {
        const tag = node.tagName.toLowerCase();
        const inputType = node.getAttribute("type");
        const classTokens = String(node.getAttribute("class") || "").split(/\s+/);
        return tag === "button"
          || tag === "a"
          || tag === "summary"
          || tag === "uni-button"
          || node.getAttribute("role") === "button"
          || (tag === "input" && ["button", "submit", "reset"].includes(inputType))
          || classTokens.some((token) => /(?:^|[-_])btn(?:$|_[a-z0-9-]+$|--[a-z0-9-]+$)/i.test(token));
      };
      let current = element;
      let distance = 0;
      while (current) {
        if (isInteractive(current)) return distance;
        current = current.parentElement;
        distance += 1;
      }
      return -1;
    });
    if (ancestorDistance === 0) return { locator: candidate, ...(strategy ? { locatorFallback: strategy } : {}) };
    if (ancestorDistance < 0) return { locator: candidate, ...(strategy ? { locatorFallback: strategy } : {}) };

    const ancestor = candidate.locator(`xpath=ancestor-or-self::*[${ancestorDistance + 1}]`);
    if (await ancestor.count() !== 1) return { locator: candidate, ...(strategy ? { locatorFallback: strategy } : {}) };
    return {
      locator: ancestor,
      locatorFallback: strategy || "text-interactive-ancestor",
    };
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

  async navigate(url, { waitUntil = "domcontentloaded", timeoutMs } = {}) {
    const response = await this.page.goto(url, { waitUntil, ...(timeoutMs ? { timeout: timeoutMs } : {}) });
    if (response === null) {
      await this.page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    }
  }

  async runStep(step, outputs) {
    if (step.op === "setContent") {
      await this.page.setContent(step.html, { waitUntil: step.waitUntil || "domcontentloaded", ...(step.timeoutMs ? { timeout: step.timeoutMs } : {}) });
      return;
    }
    if (step.op === "goto") {
      await this.navigate(step.url, { waitUntil: step.waitUntil, timeoutMs: step.timeoutMs });
      return;
    }
    if (step.op === "reload") {
      await this.page.reload({ waitUntil: step.waitUntil || "domcontentloaded", ...(step.timeoutMs ? { timeout: step.timeoutMs } : {}) });
      return;
    }
    if (step.op === "evaluate") {
      const timeoutMs = step.timeoutMs || this.defaultTimeoutMs;
      let value;
      if (step.target) {
        const exactLocator = this.locate(effectiveStepTarget(step));
        const fuzzy = await this.resolveImplicitFuzzyLocator(effectiveStepTarget(step), exactLocator);
        const resolved = await this.resolveUniqueVisibleLocator(fuzzy.locator);
        value = await resolved.locator.evaluate(
          (element, { expression, arg }) => {
            const evaluated = eval(expression);
            return typeof evaluated === "function" ? evaluated(element, arg) : evaluated;
          },
          { expression: step.expression, arg: step.arg },
          { timeout: timeoutMs },
        );
      } else {
        const target = await this.resolveEvaluationTarget(step.frame);
        value = await target.evaluate(
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
      }
      outputs[step.as || "evaluation"] = value;
      return;
    }
    if ((step.op === "wait" && step.ms !== undefined) || step.op === "waitForTimeout") {
      await this.page.waitForTimeout(step.ms ?? step.timeoutMs);
      return;
    }

    const target = effectiveStepTarget(step);
    const locator = this.locate(target);
    const actionOptions = step.timeoutMs ? { timeout: step.timeoutMs } : undefined;
    const canPreferVisible = step.op !== "readAllText" && !(step.op === "wait" && ["hidden", "detached"].includes(step.state));
    const fuzzyResolved = await this.resolveImplicitFuzzyLocator(target, locator);
    const initiallyResolved = canPreferVisible
      ? await this.resolveUniqueVisibleLocator(fuzzyResolved.locator)
      : fuzzyResolved;
    const resolvedLocator = initiallyResolved.locator;
    let locatorFallback = fuzzyResolved.locatorFallback || initiallyResolved.locatorFallback;
    switch (step.op) {
      case "click": {
        const resolved = await this.resolveClickLocator(target, resolvedLocator, locatorFallback);
        locatorFallback = resolved.locatorFallback;
        const clickOrSelectOption = async () => {
          let optionLocator = resolved.locator;
          let optionValue = await resolved.locator.evaluate((element, requested) => {
            if (element.tagName.toLowerCase() === "option") return element.value;
            if (requested.text === undefined) return null;
            const select = element.tagName.toLowerCase() === "select" ? element : element.querySelector("select");
            if (!select) return null;
            const option = Array.from(select.options).find((candidate) => requested.exact === false
              ? candidate.text.includes(requested.text)
              : candidate.text === requested.text);
            return option?.value ?? null;
          }, { text: target.text, exact: target.exact });
          if (optionValue === null && target.text !== undefined) {
            const resolvedIsInteractive = await resolved.locator.evaluate((element) =>
              ["button", "a", "summary", "uni-button"].includes(element.tagName.toLowerCase()) ||
              element.getAttribute("role") === "button" ||
              (element.tagName.toLowerCase() === "input" && ["button", "submit", "reset"].includes(element.getAttribute("type"))),
            );
            if (!resolvedIsInteractive) {
              const optionCandidates = this.locate({ css: "option", within: target.within, frame: target.frame });
              const matchingIndexes = await optionCandidates.evaluateAll((options, requested) =>
                options.flatMap((option, index) => {
                  const matches = requested.exact === false
                    ? option.text.includes(requested.text)
                    : option.text === requested.text;
                  return matches ? [index] : [];
                }), { text: target.text, exact: target.exact });
              if (matchingIndexes.length === 1) {
                optionLocator = optionCandidates.nth(matchingIndexes[0]);
                optionValue = await optionLocator.evaluate((option) => option.value);
              }
            }
          }
          if (optionValue === null) {
            await resolved.locator.click(actionOptions);
            return;
          }
          const select = optionLocator.locator("xpath=ancestor-or-self::select[1] | descendant::select[1]");
          await select.selectOption(optionValue, actionOptions);
          locatorFallback = "option-click-select";
        };
        if (step.popup === "switch") {
          let popupWaitError;
          const popupPromise = this.context.waitForEvent("page", {
            timeout: step.timeoutMs || this.defaultTimeoutMs,
          }).catch((error) => {
            popupWaitError = error;
            return null;
          });
          await clickOrSelectOption();
          const popup = await popupPromise;
          if (!popup) throw new PopupError(compactError(popupWaitError));
          await this.switchToPage(popup);
          await popup.waitForLoadState(step.waitUntil || "domcontentloaded", actionOptions);
        } else await clickOrSelectOption();
        break;
      }
      case "fill": await resolvedLocator.fill(step.value ?? step.text, actionOptions); break;
      case "clear": await resolvedLocator.clear(actionOptions); break;
      case "type": await resolvedLocator.pressSequentially(step.value ?? step.text, { delay: step.delay || 0, ...actionOptions }); break;
      case "press": await resolvedLocator.press(step.key, actionOptions); break;
      case "select": await resolvedLocator.selectOption(step.value, actionOptions); break;
      case "setInputFiles": await resolvedLocator.setInputFiles(step.files ?? step.paths, actionOptions); break;
      case "check": await resolvedLocator.check(actionOptions); break;
      case "uncheck": await resolvedLocator.uncheck(actionOptions); break;
      case "hover": await resolvedLocator.hover(actionOptions); break;
      case "focus": await resolvedLocator.focus(actionOptions); break;
      case "wait": await resolvedLocator.waitFor({ state: step.state || "visible", ...actionOptions }); break;
      case "readText": {
        const value = await resolvedLocator.textContent(actionOptions);
        outputs[step.as || "text"] = truncateText(value, step.maxChars);
        break;
      }
      case "readAllText": {
        if (step.timeoutMs) await resolvedLocator.first().waitFor({ state: "attached", timeout: step.timeoutMs });
        const values = await resolvedLocator.allTextContents();
        outputs[step.as || "texts"] = values.map((value) => truncateText(value, step.maxChars));
        break;
      }
      case "readAttribute": outputs[step.as || step.attribute] = await resolvedLocator.getAttribute(step.attribute, actionOptions); break;
      case "readValue": {
        try {
          outputs[step.as || "value"] = await resolvedLocator.inputValue(actionOptions);
        } catch (error) {
          if (!/Node is not an <input>, <textarea> or <select> element/i.test(compactError(error))) throw error;
          outputs[step.as || "value"] = truncateText(await resolvedLocator.textContent(actionOptions), step.maxChars);
          locatorFallback = "read-value-text-content";
        }
        break;
      }
      case "readBoundingBox": {
        const box = await resolvedLocator.boundingBox(actionOptions);
        assertExpected(box, "Target has no visible bounding box");
        outputs[step.as || "box"] = withBoxEdges(box);
        break;
      }
      case "readComputedStyle": outputs[step.as || "computedStyle"] = await readStyles(resolvedLocator, step.properties, actionOptions); break;
      default: throw new ContractError(`Unsupported step operation: ${step.op}`);
    }
    return locatorFallback ? { locatorFallback } : undefined;
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
    if (expectation.target === undefined && (expectation.title !== undefined || expectation.titleIncludes !== undefined)) {
      const actual = await this.page.title();
      observed.title = actual;
      if (expectation.title !== undefined) assertExpected(actual === expectation.title, `Expected title ${expectation.title}, received ${actual}`);
      if (expectation.titleIncludes !== undefined) assertExpected(actual.includes(expectation.titleIncludes), `Expected title containing ${expectation.titleIncludes}, received ${actual}`);
      return observed;
    }

    const exactLocator = this.locate(expectation.target);
    const { locator } = await this.resolveImplicitFuzzyLocator(expectation.target, exactLocator);
    if (expectation.title !== undefined) observed.label = expectation.title;
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
    const installedAt = Date.now();
    const states = (contract.captureResponses || []).map((rule) => {
      let notify;
      const normalizedRule = {
        body: "json",
        count: 1,
        maxBodyBytes: 1_000_000,
        required: true,
        ...rule,
        method: rule.method ? rule.method.toUpperCase() : undefined,
        matcher: globToRegExp(rule.url),
      };
      return {
        rule: normalizedRule,
        deadline: installedAt + (normalizedRule.timeoutMs || defaultTimeoutMs),
        results: [],
        inFlight: 0,
        error: null,
        closed: false,
        changed: new Promise((resolve) => { notify = resolve; }),
        notify,
      };
    });
    if (states.length === 0) return undefined;
    const signal = (state) => {
      state.notify();
      state.changed = new Promise((resolve) => { state.notify = resolve; });
    };
    const captureBody = async (response, state) => {
      const contentLengthHeader = await response.headerValue("content-length");
      const contentLength = contentLengthHeader === null ? null : Number(contentLengthHeader);
      if (contentLength !== null && Number.isFinite(contentLength) && contentLength > state.rule.maxBodyBytes) {
        throw new Error(`Response body exceeds maxBodyBytes (${state.rule.maxBodyBytes}) for ${state.rule.as}`);
      }
      const contentType = String(await response.headerValue("content-type") || "").toLowerCase();
      if (state.rule.body === "text" && contentType && !/^(text\/)|json|javascript|xml|x-www-form-urlencoded/.test(contentType)) {
        throw new Error(`Response content type ${contentType} is not textual for ${state.rule.as}`);
      }
      if ([204, 205, 304].includes(response.status()) || contentLength === 0) return state.rule.body === "json" ? null : "";
      const buffer = await response.body();
      if (buffer.length > state.rule.maxBodyBytes) throw new Error(`Response body exceeds maxBodyBytes (${state.rule.maxBodyBytes}) for ${state.rule.as}`);
      const text = buffer.toString("utf8");
      if (state.rule.body === "json" && text.length === 0) return null;
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
          !state.closed && Date.now() < state.deadline &&
          state.rule.matcher.test(response.url()) &&
          (state.rule.method === undefined || state.rule.method === method) &&
          state.results.length + state.inFlight < state.rule.count &&
          hasTextualBody(response);
        if (!matches) continue;
        state.inFlight += 1;
        captureBody(response, state)
          .then((body) => {
            if (!state.closed && Date.now() < state.deadline) {
              state.results.push({ url: response.url(), method, status: response.status(), body });
            }
          })
          .catch((error) => { if (!state.closed && Date.now() < state.deadline) state.error = error; })
          .finally(() => {
            state.inFlight -= 1;
            signal(state);
          });
      }
    };
    this.context.on("response", handler);

    const dispose = () => {
      this.context.off("response", handler);
      for (const state of states) {
        state.closed = true;
        signal(state);
      }
    };
    return {
      wait: async () => {
        const waitForState = async (state) => {
          // Optional captures only wait for bodies already in progress, never for
          // missing responses. All rules share their original run-relative clock.
          while (!state.closed && !state.error &&
            (state.rule.required ? state.results.length < state.rule.count : state.inFlight > 0)) {
            const remaining = state.deadline - Date.now();
            if (remaining <= 0) {
              if (state.rule.required) {
                throw new Error(`Timed out after ${state.rule.timeoutMs || defaultTimeoutMs}ms waiting for ${state.rule.count} response(s) as ${state.rule.as} (received ${state.results.length})`);
              }
              break;
            }
            await new Promise((resolve) => {
              const timer = setTimeout(resolve, remaining);
              state.changed.then(() => {
                clearTimeout(timer);
                resolve();
              });
            });
          }
          state.closed = true;
          if (state.error) throw state.error;
        };
        try {
          await Promise.all(states.map(waitForState));
          for (const state of states) {
            outputs[state.rule.as] = state.rule.count === 1 ? state.results[0] ?? null : [...state.results];
          }
        } finally {
          // Late body completions/rejections remain handled but cannot change
          // the results returned by this call or retain the response listener.
          dispose();
        }
      },
      dispose,
    };
  }

}

const frameSchema = {
  type: "object",
  description: "Select one iframe by exactly one of name, urlIncludes, or css.",
  properties: {
    name: { type: "string", minLength: 1 },
    urlIncludes: { type: "string", minLength: 1 },
    css: { type: "string", minLength: 1 },
  },
  additionalProperties: false,
};

const targetSchema = {
  type: "object",
  description: "Define exactly one of role, text, label, placeholder, testId, or css; optionally scope with within/frame or disambiguate with first/nth.",
  properties: {
    role: { type: "string", minLength: 1 },
    name: { type: "string", minLength: 1 },
    text: { type: "string", minLength: 1 },
    label: { type: "string", minLength: 1 },
    placeholder: { type: "string", minLength: 1 },
    testId: { type: "string", minLength: 1 },
    css: { type: "string", minLength: 1 },
    exact: { type: "boolean", description: "Use exact matching. When omitted, text and label targets retry one substring match if exact matching finds nothing." },
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
  additionalProperties: false,
};

const stepSchema = {
  type: "object",
  description: "One operation. fill/type accept value or text; wait accepts target or ms; waitForTimeout accepts ms or timeoutMs; setInputFiles accepts files or paths; goto/reload/setContent/evaluate do not use target.",
  properties: {
    op: { type: "string", enum: [...supportedSteps] },
    target: targetSchema,
    url: { type: "string", minLength: 1, description: "Destination for goto." },
    html: { type: "string", description: "HTML for setContent." },
    value: {},
    text: { type: "string", description: "Alias for value on fill/type." },
    files: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, description: "Absolute file paths for setInputFiles." },
    paths: { type: "array", minItems: 1, items: { type: "string", minLength: 1 }, description: "Alias for files on setInputFiles." },
    key: { type: "string", minLength: 1 },
    delay: { type: "number", minimum: 0 },
    state: { type: "string", enum: ["attached", "detached", "visible", "hidden"] },
    ms: { type: "integer", minimum: 0, maximum: MAX_OPERATION_TIMEOUT_MS },
    first: { type: "boolean", description: "Shorthand for target.first." },
    nth: { type: "integer", minimum: 0, description: "Shorthand for target.nth." },
    maxChars: { type: "integer", minimum: 1, description: "Bound each readText/readAllText string and mark truncation." },
    attribute: { type: "string", minLength: 1 },
    properties: { type: "array", minItems: 1, items: { type: "string", minLength: 1 } },
    as: { type: "string", minLength: 1, description: "Output key for reads/evaluate." },
    timeoutMs: { type: "integer", minimum: 1, maximum: MAX_OPERATION_TIMEOUT_MS, description: "Per-operation timeout. For readAllText, waits for the first match to attach before reading all matches." },
    waitUntil: { type: "string", enum: [...supportedWaitUntil] },
    popup: { type: "string", enum: ["switch"], description: "On click, atomically wait for and switch to the new page." },
    expression: { type: "string", minLength: 1, description: "Page expression or function expression for evaluate; optional arg is available and passed to functions." },
    arg: {},
    frame: frameSchema,
  },
  required: ["op"],
  additionalProperties: false,
};

const routeSchema = {
  type: "object",
  description: "One first-match request rule. Define url and exactly one response action: json, body, or abort.",
  properties: {
    url: { type: "string", minLength: 1, description: "URL glob." },
    method: { type: "string", minLength: 1 },
    requestBody: { type: ["object", "array"], description: "Partial JSON body that must match." },
    requestBodyIncludes: { type: "string", description: "Raw request-body fragment that must match." },
    cors: { type: "boolean", description: "Fulfill credential-compatible CORS headers and OPTIONS preflight." },
    json: { description: "Structured JSON response body. Use this for objects and arrays." },
    body: { type: "string", description: "Plain text response body; use json for objects and arrays." },
    abort: {
      oneOf: [{ const: true }, { type: "string", minLength: 1 }],
      description: "Abort with failed when true, or with the supplied Playwright error code.",
    },
    status: { type: "integer", minimum: 100, maximum: 599 },
    headers: { type: "object", additionalProperties: { type: "string" } },
    contentType: { type: "string", minLength: 1 },
  },
  required: ["url"],
  additionalProperties: false,
};

const expectationSchema = {
  type: "object",
  properties: {
    target: targetSchema,
    state: { type: "string", enum: ["attached", "detached", "visible", "hidden"] },
    text: {}, contains: {}, value: {}, count: { type: "integer", minimum: 0 },
    attribute: { type: "object", properties: { name: { type: "string" }, value: {} }, required: ["name", "value"], additionalProperties: false },
    computedStyle: { type: "object", additionalProperties: true },
    box: { type: "object", additionalProperties: true },
    url: { type: "string" }, urlIncludes: { type: "string" },
    title: { type: "string" }, titleIncludes: { type: "string" },
  },
  description: "Define one page field (url/urlIncludes or title/titleIncludes without target), or one target plus its expected state/value. With target, title is an optional observation label.",
  additionalProperties: false,
};

const contractSchema = {
  type: "object",
  description: `One bounded browser flow. Explicit operation timeouts are capped at ${MAX_OPERATION_TIMEOUT_MS}ms and the estimated combined budget at ${MAX_CONTRACT_BUDGET_MS}ms.`,
  $defs: { frame: frameSchema, target: targetSchema },
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
    steps: { type: "array", items: stepSchema },
    expect: { type: "array", items: expectationSchema },
    ready: {
      ...expectationSchema,
      description: "Expectation checked after top-level navigation. Locator readiness must nest the locator under target, for example { target: { text: 'Ready' }, state: 'visible' }.",
    },
    evidence: { type: "string", enum: [...supportedEvidence] },
    timeoutMs: { type: "integer", minimum: 1, maximum: MAX_FLOW_TIMEOUT_MS, description: "Default locator timeout for this flow; usually omit it. This is not a whole-flow deadline." },
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
      items: routeSchema,
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
  suggestedNextAction,
  validateContract,
};
