const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");
const { compactOutputs, OUTPUT_LIMIT, PREVIEW_LIMIT, cleanupExpiredOutputs } = require("../scripts/output");

async function fixture(t) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pw-output-test-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

test("small output preserves result identity and creates no file", async () => {
  const result = { ok: true, outputs: { count: 2, text: "small", rows: [] } };
  assert.equal(await compactOutputs(result, { io: { mkdtemp() { throw new Error("must not touch disk"); } } }), result);
  assert.equal(await compactOutputs({ ok: false }).then(r => r.ok), false);
  const boundary = { outputs: { text: "x".repeat(OUTPUT_LIMIT - 11) } };
  assert.equal(JSON.stringify(boundary.outputs).length, OUTPUT_LIMIT);
  assert.equal(await compactOutputs(boundary), boundary);
});

test("large single-line and escaped multi-line output has bounded preview and exact private artifact", async t => {
  const tempDir = await fixture(t);
  for (const text of ["x".repeat(500000), '\n\t"\\中文😀'.repeat(30000)]) {
    const outputs = { terminal: text, label: "tail field" };
    const result = await compactOutputs({ ok: true, outputs }, { tempDir });
    assert.equal(typeof result.outputs.terminal, "string");
    assert.match(result.outputs.terminal, /truncated/);
    assert.equal(result.outputs.label, "tail field");
    assert(JSON.stringify(result.outputs).length <= PREVIEW_LIMIT);
    assert.equal(result.outputArtifact.truncated, true);
    assert.equal(result.outputArtifact.originalChars, JSON.stringify(outputs).length);
    assert.deepEqual(JSON.parse(await fs.readFile(result.outputArtifact.path, "utf8")), outputs);
    assert.equal((await fs.stat(result.outputArtifact.path)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(result.outputArtifact.path))).mode & 0o777, 0o700);
  }
});

test("nested arrays and objects retain shapes without losing failure evidence", async t => {
  const tempDir = await fixture(t);
  const outputs = { rows: Array.from({ length: 3000 }, (_, id) => ({ id, payload: "x".repeat(200) })), meta: { total: 3000 } };
  const original = { ok: false, outputs, error: "Failed after extraction", observations: [{ ok: false }], stepResults: [{ index: 1, ok: false }] };
  const result = await compactOutputs(original, { tempDir });
  assert.equal(result.ok, false);
  assert.equal(result.error, original.error);
  assert.equal(result.observations, original.observations);
  assert.equal(result.stepResults, original.stepResults);
  assert(Array.isArray(result.outputs.rows));
  assert(result.outputs.rows.length > 0 && result.outputs.rows.length < outputs.rows.length);
  assert.equal(typeof result.outputs.rows[0], "object");
  assert.equal(result.outputs.meta.total, 3000);
  assert(JSON.stringify(result.outputs).length <= PREVIEW_LIMIT);
  assert.deepEqual(JSON.parse(await fs.readFile(result.outputArtifact.path, "utf8")), outputs);
});

test("artifact write failure preserves complete original outputs and business status", async t => {
  const tempDir = await fixture(t);
  const original = { ok: true, outputs: { text: "x".repeat(30000) } };
  const io = { ...fs, writeFile: async () => { throw Object.assign(new Error("private detail"), { code: "ENOSPC" }); } };
  const result = await compactOutputs(original, { io, tempDir });
  assert.equal(result.ok, true);
  assert.equal(result.outputs, original.outputs);
  assert.equal(result.outputArtifact, undefined);
  assert.match(result.outputWarning, /ENOSPC/);
  assert.doesNotMatch(result.outputWarning, /private detail/);
  assert.deepEqual(await fs.readdir(tempDir), []);
});

test("large keys and deep data cannot escape the preview size budget", async t => {
  const tempDir = await fixture(t);
  let deep = { text: "x".repeat(30000) };
  for (let i = 0; i < 30; i++) deep = { deep };
  for (const outputs of [{ ["key".repeat(10000)]: 1 }, deep]) {
    const result = await compactOutputs({ outputs }, { tempDir });
    assert(JSON.stringify(result.outputs).length <= PREVIEW_LIMIT);
    assert(result.outputArtifact.truncated);
    assert.deepEqual(JSON.parse(await fs.readFile(result.outputArtifact.path, "utf8")), outputs);
  }
});


test("cleanup removes only expired private output artifacts and preserves other paths", async t => {
  const tempDir = await fixture(t);
  const old = new Date(Date.now() - 25 * 60 * 60 * 1000);
  async function create(name, extra = false) {
    const dir = path.join(tempDir, name);
    await fs.mkdir(dir, { mode: 0o700 });
    await fs.writeFile(path.join(dir, "outputs.json"), "{}", { mode: 0o600 });
    await fs.utimes(path.join(dir, "outputs.json"), old, old);
    if (extra) await fs.writeFile(path.join(dir, "keep.txt"), "keep");
    await fs.utimes(dir, old, old);
    return dir;
  }
  const expired = await create("playwright-fast-outputs-Ab1234");
  const unknown = await create("another-plugin-outputs-Ab1234");
  const extra = await create("playwright-fast-outputs-Cd1234", true);
  const recent = await create("playwright-fast-outputs-Ef1234");
  await fs.utimes(recent, new Date(), new Date());
  const linked = path.join(tempDir, "playwright-fast-outputs-Gh1234");
  await fs.symlink(unknown, linked);
  await cleanupExpiredOutputs(tempDir);
  await assert.rejects(fs.stat(expired), { code: "ENOENT" });
  for (const preserved of [unknown, extra, recent, linked]) assert(await fs.lstat(preserved));
});


test("MCP run returns compact text and original error classification through server integration", async t => {
  const tempDir = await fixture(t);
  const vm = require("node:vm");
  const { createRequire } = require("node:module");
  const filename = path.resolve(__dirname, "../scripts/server.js");
  const nativeRequire = createRequire(filename);
  const source = (await fs.readFile(filename, "utf8")).split("const input = readline.createInterface")[0];
  const original = { ok: false, failureKind: "page", error: "visible failure", outputs: { log: "line\n".repeat(30000) }, stepResults: [{ index: 1, ok: false }] };
  const sandbox = {
    require: name => name === "./output" ? { compactOutputs: result => compactOutputs(result, { tempDir }) } : nativeRequire(name),
    process, performance, setTimeout, clearTimeout, original,
  };
  const callTool = vm.runInNewContext(`${source}; runtime.run = async () => ({ result: original }); callTool`, sandbox, { filename });
  const reply = await callTool("run", {});
  assert.equal(reply.isError, false);
  const result = JSON.parse(reply.content[0].text);
  assert.equal(result.error, original.error);
  assert.deepEqual(result.stepResults, original.stepResults);
  assert(JSON.stringify(result.outputs).length <= PREVIEW_LIMIT);
  assert.equal((await fs.readFile(result.outputArtifact.path, "utf8")), JSON.stringify(original.outputs));
  original.failureKind = "runtime";
  assert.equal((await callTool("run", {})).isError, true);
});
