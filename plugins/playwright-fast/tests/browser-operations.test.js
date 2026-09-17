const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { test } = require('node:test');

// Real Chromium through the published MCP entrypoint, against a local textarea
// fixture. This does not claim coverage of a production Monaco integration.
test('MCP observes, edits, saves and reloads a pipeline without evaluate steps', { timeout: 20000 }, async t => {
  let stored = 'pipeline {\n  stage("build") { echo "old" }\n}\n';
  const original = stored;
  let writes = 0;
  const server = http.createServer((req, res) => {
    res.setHeader('cache-control', 'no-store');
    if (req.method === 'POST' && req.url === '/save') {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => { stored = body; writes++; res.end('saved'); });
      return;
    }
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(`<!doctype html><title>Pipeline fixture</title>
      <h1>Pipeline</h1><label for="pipeline">Pipeline source</label>
      <textarea id="pipeline" rows="6" cols="70"></textarea>
      <textarea id="duplicate" aria-label="Repeated source">same same</textarea>
      <textarea id="readonly" aria-label="Read only source" readonly>locked</textarea>
      <dialog open aria-label="Editor help">Edit then save</dialog>
      <button id="save">Save pipeline</button><p role="status" id="status"></p>
      <script>
      document.querySelector('#pipeline').value = ${JSON.stringify(stored).replace(/</g, '\\u003c')};
      document.querySelector('#save').onclick = async () => {
        await fetch('/save', { method: 'POST', body: document.querySelector('#pipeline').value });
        document.querySelector('#status').textContent = 'Saved';
      };
      </script>`);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const child = spawn('bash', ['scripts/start.sh'], {
    cwd: path.resolve(__dirname, '..'), stdio: ['pipe', 'pipe', 'pipe'], env: process.env,
  });
  const pending = new Map();
  let sequence = 0, stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  readline.createInterface({ input: child.stdout }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    pending.get(message.id)?.(message);
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error(`MCP timeout: ${stderr}`)); }, 15000);
    pending.set(id, message => { clearTimeout(timer); pending.delete(id); resolve(message); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const timings = [];
  const run = async args => {
    assert(!args.steps.some(step => step.op === 'evaluate'));
    const start = performance.now();
    const message = await request('tools/call', { name: 'run', arguments: args });
    timings.push({ id: args.id, wallMs: Math.round(performance.now() - start) });
    assert(message.result, JSON.stringify(message));
    return JSON.parse(message.result.content[0].text);
  };
  const target = { css: '#pipeline' };
  try {
    await request('initialize', { protocolVersion: '2025-06-18' });
    const first = await run({ id: 'discover-read', url: `http://127.0.0.1:${server.address().port}/`, steps: [
      { op: 'observe', as: 'page' }, { op: 'editorRead', target, as: 'source' },
    ] });
    assert.equal(first.ok, true, JSON.stringify(first));
    assert.equal(first.outputs.source.text, original);
    assert.equal(first.outputs.source.adapter, 'textarea');
    assert.match(first.outputs.source.hash, /^[a-f0-9]{64}$/);
    assert.match(first.outputs.page.ariaSnapshot, /Save pipeline/);
    assert(first.outputs.page.editors.some(editor => editor.id === 'pipeline'));
    assert(first.outputs.page.dialogs.length > 0);
    const second = await run({ id: 'patch-save-reload-verify', steps: [
      { op: 'editorPatch', target, oldText: 'echo "old"', newText: 'echo "new"', expectedHash: first.outputs.source.hash, as: 'patch' },
      { op: 'click', target: { role: 'button', name: 'Save pipeline' } },
      { op: 'wait', target: { css: '#status', hasText: 'Saved' } },
      { op: 'reload' }, { op: 'editorRead', target, as: 'source' },
    ] });
    assert.equal(second.ok, true, JSON.stringify(second));
    assert.equal(second.outputs.patch.verified, true);
    assert.equal(second.outputs.source.text, original.replace('echo "old"', 'echo "new"'));
    assert.equal(second.outputs.source.hash, second.outputs.patch.afterHash);
    assert.equal(stored, second.outputs.source.text);
    assert.equal(writes, 1);
    t.diagnostic(`Successful editing flow: 2 run calls; ${JSON.stringify(timings)}. No model latency is simulated.`);

    for (const [id, css, oldText, expectedHash, error] of [
      ['stale', '#pipeline', 'echo "new"', first.outputs.source.hash, /expectedHash/],
      ['ambiguous', '#duplicate', 'same', undefined, /not unique/],
      ['readonly', '#readonly', 'locked', undefined, /read-only/],
    ]) {
      const failed = await run({ id, steps: [{ op: 'editorPatch', target: { css }, oldText, newText: 'WRONG', ...(expectedHash ? { expectedHash } : {}) }] });
      assert.equal(failed.ok, false, JSON.stringify(failed));
      assert.match(failed.error, error);
    }
    const unchanged = await run({ id: 'verify-rejections', steps: [
      { op: 'editorRead', target, as: 'source' },
      { op: 'editorRead', target: { css: '#duplicate' }, as: 'duplicate' },
      { op: 'editorRead', target: { css: '#readonly' }, as: 'readonly' },
    ] });
    assert.equal(unchanged.ok, true, JSON.stringify(unchanged));
    assert.equal(unchanged.outputs.source.text, stored);
    assert.equal(unchanged.outputs.duplicate.text, 'same same');
    assert.equal(unchanged.outputs.readonly.text, 'locked');
    assert.equal(writes, 1);
    const missing = await run({ id: 'missing-control', steps: [
      { op: 'click', target: { role: 'button', name: 'Not present' }, timeoutMs: 100 },
    ] });
    assert.equal(missing.ok, false);
    assert.equal(missing.failureKind, 'locator');
    assert.match(missing.failureObservation.ariaSnapshot, /Save pipeline/);
    assert.equal(writes, 1);
  } finally {
    child.stdin.end();
    await new Promise(resolve => child.exitCode !== null ? resolve() : child.once('exit', resolve));
    await new Promise(resolve => server.close(resolve));
  }
});
