const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { test } = require('node:test');
const http = require('node:http');
const path = require('node:path');
const readline = require('node:readline');
const { spawn } = require('node:child_process');
const { FlowRuntime } = require('../shared/contract');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
function response(body, suffix = '') {
  return { request: () => ({ method: () => 'GET' }), url: () => `http://fixture/api${suffix}`,
    headers: () => ({ 'content-type': 'application/json' }), headerValue: async () => null,
    status: () => 200, body };
}
function captures(rules) {
  const context = new EventEmitter();
  const outputs = {};
  const capture = new FlowRuntime({ context, page: {} }).installResponseCaptures({ captureResponses: rules }, outputs, 100);
  return { context, outputs, capture };
}
test('optional captures do not wait for missing responses', async () => {
  const { context, outputs, capture } = captures([{ url: '**/api', as: 'optional', required: false, timeoutMs: 1000 }]);
  await Promise.race([capture.wait(), delay(100).then(() => { throw Error('optional capture waited for missing response'); })]);
  assert.equal(outputs.optional, null);
  assert.equal(context.listenerCount('response'), 0);
});
test('optional in-flight bodies have concurrent run-relative deadlines and immutable partial results', async () => {
  let finish, reject;
  const lateSuccess = new Promise(resolve => { finish = resolve; });
  const lateFailure = new Promise((_, fail) => { reject = fail; });
  const { context, outputs, capture } = captures([
    { url: '**/api*', as: 'partial', count: 3, required: false, timeoutMs: 100 },
    { url: '**/api*', as: 'second', count: 3, required: false, timeoutMs: 100 },
  ]);
  context.emit('response', response(async () => Buffer.from('{"done":true}'), '1'));
  context.emit('response', response(() => lateSuccess, '2'));
  context.emit('response', response(() => lateFailure, '3'));
  await delay(60);
  const started = performance.now();
  await capture.wait();
  assert(performance.now() - started < 95, 'must use original deadline and await rules concurrently');
  assert.equal(outputs.partial.length, 1);
  assert.equal(outputs.second.length, 1);
  const saved = JSON.stringify(outputs);
  finish(Buffer.from('{"late":true}'));
  reject(Error('late rejection'));
  await delay(10);
  assert.equal(JSON.stringify(outputs), saved);
  assert.equal(context.listenerCount('response'), 0);
});
test('required incomplete bodies still time out and dispose releases waiters', async () => {
  const { context, capture } = captures([{ url: '**/api', as: 'required', timeoutMs: 30 }]);
  context.emit('response', response(() => new Promise(() => {})));
  await assert.rejects(capture.wait(), /Timed out after 30ms.*required/);
  assert.equal(context.listenerCount('response'), 0);
  const next = captures([{ url: '**/api', as: 'optional', required: false, timeoutMs: 1000 }]);
  next.context.emit('response', response(() => new Promise(() => {})));
  const waiting = next.capture.wait();
  next.capture.dispose();
  await waiting;
  assert.equal(next.context.listenerCount('response'), 0);
});
test('MCP optional hanging HTTP body returns and subsequent status/run remain usable', { timeout: 15000 }, async () => {
  let headersSent = 0;
  const server = http.createServer((req, res) => {
    if (req.url === '/api') {
      headersSent++;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.flushHeaders();
      return; // Deliberately never end the body.
    }
    res.end('<title>Capture fixture</title>');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const child = spawn('bash', ['scripts/start.sh'], { cwd: path.resolve(__dirname, '..'), stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '', id = 0;
  child.stderr.on('data', chunk => { stderr += chunk; });
  const pending = new Map();
  readline.createInterface({ input: child.stdout }).on('line', line => {
    const message = JSON.parse(line);
    pending.get(message.id)?.(message);
  });
  const call = async (name, args = {}) => {
    const requestId = ++id;
    const result = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { pending.delete(requestId); reject(Error(`MCP timeout: ${stderr}`)); }, 5000);
      pending.set(requestId, message => { clearTimeout(timer); pending.delete(requestId); resolve(message); });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: requestId, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    });
    return JSON.parse(result.result.content[0].text);
  };
  try {
    assert.equal((await call('run', { url: origin })).ok, true);
    const result = await call('run', {
      captureResponses: [{ url: '**/api', as: 'optional', required: false, timeoutMs: 250 }],
      steps: [{ op: 'evaluate', expression: "async () => { await fetch('/api'); return 'headers received'; }", as: 'headers' }],
    });
    assert.equal(headersSent, 1);
    assert.equal(result.ok, true, JSON.stringify(result));
    assert.equal(result.outputs.headers, 'headers received');
    assert.equal(result.outputs.optional, null);
    assert(result.elapsedMs < 1500, JSON.stringify(result));
    assert.equal((await call('status')).warm, true);
    assert.equal((await call('run', { steps: [{ op: 'evaluate', expression: '42', as: 'answer' }] })).outputs.answer, 42);
  } finally {
    child.stdin.end();
    await new Promise(resolve => {
      if (child.exitCode !== null) return resolve();
      const timer = setTimeout(() => child.kill('SIGKILL'), 2000);
      child.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
});
