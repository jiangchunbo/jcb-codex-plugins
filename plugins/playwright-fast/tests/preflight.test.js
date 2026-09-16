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
  return vm.runInNewContext(`${source}; PersistentRuntime`, {
    require: createRequire(filename), process, performance, setTimeout, clearTimeout,
  }, { filename });
}

test("invalid evaluate syntax rejects the whole contract before earlier actions or reset", async () => {
  const Runtime = loadRuntime();
  const runtime = new Runtime();
  runtime.ensure = () => { throw new Error("must not launch or operate browser"); };
  runtime.close = () => { throw new Error("must not reset browser"); };
  const { result } = await runtime.run({ reset: true, steps: [
    { op: "click", target: { text: "Delete" } },
    { op: "evaluate", expression: "() => ({ items: [1, 2] " },
  ] });
  assert.equal(result.failureKind, "contract");
  assert.equal(result.phase, "contract");
  assert.equal(result.contractErrors[0].path, "steps[1].expression");
  assert.match(result.error, /invalid JavaScript syntax/);
});

test("evaluate preflight aggregates syntax errors and never executes valid code", () => {
  const key = "__playwrightFastPreflightExecuted";
  delete globalThis[key];
  validateContract({ steps: [
    { op: "evaluate", expression: `globalThis.${key} = true` },
    { op: "evaluate", expression: "async () => { const response = await fetch('/api'); return response.json(); }" },
    { op: "evaluate", expression: "({ count: document.querySelectorAll('button').length })" },
    { op: "evaluate", expression: "const value = arg; value" },
  ] });
  assert.equal(globalThis[key], undefined);
  assert.throws(() => validateContract({ timeoutMs: 35000, steps: [
    { op: "evaluate", expression: "() => [" },
    { op: "evaluate", expression: "() => ({" },
  ] }), error => {
    for (const field of ["timeoutMs", "steps[0].expression", "steps[1].expression"]) {
      assert(error.issues.some(issue => issue.path === field));
    }
    return true;
  });
});

test("budget explains observed sleep plus evaluation failure and preserves exact boundary", () => {
  const make = timeoutMs => ({ ...(timeoutMs === undefined ? {} : { timeoutMs }), steps: [
    { op: "wait", ms: 25000 }, { op: "evaluate", expression: "() => document.title" },
  ] });
  assert.throws(() => validateContract(make(30000)), error => {
    assert.match(error.message, /55000ms exceeds 50000ms/);
    assert.match(error.message, /steps\[0\].ms contributes 25000ms/);
    assert.match(error.message, /timeoutMs contributes 30000ms/);
    assert.match(error.message, /at least 5000ms/);
    assert.match(error.message, /not a whole-flow deadline/);
    return true;
  });
  assert.throws(() => validateContract(make(35000)), error => {
    assert(error.issues.some(issue => issue.path === "timeoutMs"));
    assert(error.issues.some(issue => /60000ms exceeds 50000ms/.test(issue.message)));
    return true;
  });
  validateContract(make(25000));
  validateContract(make(undefined));
});

test("budget attributes popup multipliers and navigation overrides without changing constraints", () => {
  assert.throws(() => validateContract({ url: "http://localhost/", navigationTimeoutMs: 15000, steps: [
    { op: "click", popup: "switch", timeoutMs: 15000, target: { text: "Open" } },
  ] }), /navigationTimeoutMs contributes 15000ms, steps\[0\].timeoutMs contributes 45000ms/);
  assert.throws(() => validateContract({ steps: [
    { op: "goto", url: "http://localhost/a", timeoutMs: 30000 },
    { op: "goto", url: "http://localhost/b", timeoutMs: 25000 },
  ] }), /steps\[0\].timeoutMs contributes 30000ms, steps\[1\].timeoutMs contributes 25000ms/);
  validateContract({ url: "http://localhost/#/a", navigationTimeoutMs: 30000, steps: [
    { op: "goto", url: "http://localhost/#/b", timeoutMs: 30000 },
    { op: "evaluate", expression: "1", timeoutMs: 20000 },
  ] });
});
