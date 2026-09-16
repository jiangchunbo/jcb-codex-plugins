const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { createRequire } = require("node:module");
const test = require("node:test");
const { validateContract } = require("../shared/contract");

function loadRuntime() {
  const filename = path.resolve(__dirname, "../scripts/server.js");
  const source = fs.readFileSync(filename, "utf8").split("const runtime = new PersistentRuntime();")[0];
  const sandbox = { require: createRequire(filename), process, performance, setTimeout, clearTimeout };
  return vm.runInNewContext(`${source}; PersistentRuntime`, sandbox, { filename });
}

test("reports timeout and missing capture alias together before browser work", async () => {
  const Runtime = loadRuntime();
  const runtime = new Runtime();
  runtime.ensure = () => { throw new Error("browser must not launch"); };
  const { result } = await runtime.run({ timeoutMs: 45000, captureResponses: [{ url: "**/api/login" }] });
  assert.equal(result.failureKind, "contract");
  assert(result.contractErrors.some(issue => issue.path === "timeoutMs"));
  assert(result.contractErrors.some(issue => issue.path === "captureResponses[0].as"));
  assert.match(result.error, /timeoutMs/);
  assert.match(result.error, /captureResponses\[0\].as/);
});

test("invalid visual and diagnostic contracts never screenshot the existing page", async () => {
  const Runtime = loadRuntime();
  for (const evidence of ["visual", "diag"]) {
    const runtime = new Runtime();
    let screenshots = 0;
    runtime.page = {
      isClosed: () => false,
      url: () => "http://localhost/existing",
      viewportSize: () => ({ width: 375, height: 667 }),
      screenshot: async () => { screenshots++; throw new Error("must not screenshot"); },
    };
    runtime.browser = { isConnected: () => true };
    runtime.context = {};
    runtime.touch = () => {};
    const page = runtime.page;
    const { result, image } = await runtime.run({ timeoutMs: 45000, evidence });
    assert.equal(result.failureKind, "contract");
    assert.equal(screenshots, 0);
    assert.equal(image, undefined);
    assert.equal(runtime.page, page);
    assert.equal(result.url, "http://localhost/existing");
  }
});

test("rejects schema-invalid nested targets and unsupported fields", () => {
  for (const target of [
    { css: "#x", nth: -1 }, { css: "#x", first: "yes" },
    { css: "#x", exact: 1 }, { css: "#x", within: { css: "main", nth: -2 } },
  ]) assert.throws(() => validateContract({ steps: [{ op: "click", target }] }), /ContractError/);
  assert.throws(() => validateContract({ captureResponses: [{ url: "**/api", as: "data", jsonPaths: ["code"] }] }), /jsonPaths is not supported/);
  assert.throws(() => validateContract({ steps: [{ op: "click", target: { css: "button" }, invented: true }] }), /invented is not supported/);
  assert.throws(() => validateContract({ viewport: null }), /viewport must be object/);
  for (const key of ["constructor", "toString", "__proto__"]) {
    assert.throws(() => validateContract(JSON.parse(`{"${key}":true}`)), /is not supported/);
    assert.throws(() => validateContract({ steps: [{ op: "click", target: JSON.parse(`{"css":"button","${key}":true}`) }] }), /is not supported/);
  }
  validateContract({ steps: [{ op: "fill", target: { label: "Username", exact: false }, text: "demo" }], captureResponses: [{ url: "**/api", as: "data" }] });
});
