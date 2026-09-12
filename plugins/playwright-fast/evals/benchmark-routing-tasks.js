#!/usr/bin/env node
// Real Chromium task journeys with controlled local connection faults; no public sites/model API.
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { Router, keyOf } = require('../scripts/routing');
const { resolveRuntime } = require('../scripts/resolve-runtime');
const scenarios = {
  normal: { direct: 0, proxy: 0 },
  'direct-slow': { direct: 450, proxy: 10 },
  'proxy-slow': { direct: 10, proxy: 450 },
  'direct-refused': { direct: 10, proxy: 10, failed: 'direct' },
  'proxy-refused-warm': { direct: 10, proxy: 10, failed: 'proxy', warm: true },
  'direct-timeout': { direct: 3000, proxy: 10 },
};
const modes = ['direct', 'auto', 'race'];
const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const percentile = (values, fraction) => values.length ? [...values].sort((a, b) => a - b)[Math.ceil(values.length * fraction) - 1] : null;
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const cancel = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener('abort', cancel); resolve(); }, ms);
    signal.addEventListener('abort', cancel, { once: true }); if (signal.aborted) cancel();
  });
}
async function fixtures() {
  const sockets = new Set(); const sessions = new Map(); let port, originConnections = 0;
  const watch = s => { sockets.add(s); s.on('error', () => {}); s.on('close', () => sockets.delete(s)); return s; };
  const state = id => { if (!sessions.has(id)) sessions.set(id, { posts: 0, resources: 0 }); return sessions.get(id); };
  const origin = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture'); const id = url.searchParams.get('id');
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end(); }
    if (url.pathname === '/data') return res.end(JSON.stringify({ answer: 42 }));
    if (url.pathname === '/asset') { state(id).resources++; return res.end('resource'); }
    if (url.pathname === '/save') {
      req.resume(); req.on('end', () => { state(id).posts++; res.setHeader('set-cookie', 'session=ready; Path=/'); res.end('saved'); }); return;
    }
    res.setHeader('content-type', 'text/html');
    res.end(`<main><h1>Routing task</h1><button id="query">Query</button><output id="answer"></output>
      <input aria-label="Name"><button id="review">Review</button><section id="summary"></section>
      <button id="confirm" hidden>Confirm</button><output id="receipt"></output><output id="assets"></output><output id="socket"></output></main>
      <script>
      const id=${JSON.stringify(id)};
      document.querySelector('#query').onclick=async()=>{const r=await fetch('/data?id='+id); document.querySelector('#answer').textContent=(await r.json()).answer};
      document.querySelector('#review').onclick=()=>{document.querySelector('#summary').textContent=document.querySelector('input').value;document.querySelector('#confirm').hidden=false};
      document.querySelector('#confirm').onclick=async()=>{await fetch('/save?id='+id,{method:'POST',body:document.querySelector('input').value});localStorage.setItem('saved','yes');document.querySelector('#receipt').textContent='Saved'};
      Promise.all(Array.from({length:12},(_,i)=>fetch('/asset?id='+id+'&n='+i).then(r=>r.text()))).then(()=>document.querySelector('#assets').textContent='12 loaded');
      window.echo=()=>new Promise((resolve,reject)=>{const ws=new WebSocket('ws://'+location.host+'/echo');ws.onopen=()=>ws.send('ping');ws.onmessage=e=>{document.querySelector('#socket').textContent=e.data;ws.close();resolve(e.data)};ws.onerror=reject});
      </script>`);
  });
  origin.on('connection', socket => { originConnections++; watch(socket); });
  origin.on('upgrade', (req, socket) => {
    const accept = crypto.createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    // The fixture expects one short, masked browser text frame, followed by close.
    let buffered = Buffer.alloc(0);
    socket.on('data', chunk => {
      buffered = Buffer.concat([buffered, chunk]);
      if (buffered.length < 6) return;
      const opcode = buffered[0] & 15, size = buffered[1] & 127;
      if (opcode === 8) { socket.end(Buffer.from([0x88, 0])); return; }
      if (size > 125 || !(buffered[1] & 128)) { socket.destroy(); return; }
      if (buffered.length < 6 + size) return;
      const body = Buffer.from(buffered.subarray(6, 6 + size));
      for (let i = 0; i < size; i++) body[i] ^= buffered[2 + i % 4];
      buffered = buffered.subarray(6 + size); socket.write(Buffer.concat([Buffer.from([0x81, size]), body]));
    });
  });
  port = await listen(origin);
  const proxy = http.createServer(); proxy.on('connection', watch);
  proxy.on('connect', (req, client, head) => {
    const dest = watch(net.connect({ host: '127.0.0.1', port }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n'); if (head.length) dest.write(head);
      dest.pipe(client); client.pipe(dest);
    }));
    dest.on('error', () => client.destroy()); dest.on('close', () => client.destroy()); client.on('close', () => dest.destroy());
  });
  const proxyPort = await listen(proxy);
  return { port, proxyPort, state, connectionCount: () => originConnections, async close() { for (const s of sockets) s.destroy(); await Promise.all([origin, proxy].map(s => new Promise(resolve => s.close(resolve)))); } };
}
async function journey(launchBrowser, fixture, root, scenario, mode, repetition, proxyScope = 'http') {
  const id = `${scenario}-${mode}-${repetition}`; const spec = scenarios[scenario];
  const router = new Router({ env: { HTTP_PROXY: `http://127.0.0.1:${fixture.proxyPort}`, ...(proxyScope === 'both' ? { HTTPS_PROXY: `http://127.0.0.1:${fixture.proxyPort}` } : {}), PLAYWRIGHT_FAST_CONNECT_RACE: mode === 'race' ? 'on' : 'off' }, directory: path.join(root, id), bypassTarget: () => false });
  const target = { host: 'bench.test', port: fixture.port, secure: false }; const attempts = { direct: 0, proxy: 0 };
  const connect = router.connect.bind(router);
  router.connect = async (dest, route, signal, stages) => {
    if (dest.host !== 'bench.test' || dest.port !== fixture.port) throw Object.assign(new Error('Non-fixture connection blocked'), { code: 'ECONNREFUSED' });
    attempts[route]++;
    if (spec[route]) await delay(spec[route], signal);
    if (spec.failed === route) throw Object.assign(new Error('Controlled refusal'), { code: 'ECONNREFUSED' });
    return connect({ ...dest, host: '127.0.0.1' }, route, signal, stages);
  };
  await router.start();
  if (mode === 'direct') router.proxy = () => null; // Same relay/fault injector, direct-only policy.
  if (spec.warm && mode !== 'direct') {
    for (let i = 0; i < 3; i++) for (const route of ['direct', 'proxy']) router.store.add({ target: keyOf(target), route, kind: 'probe', ms: route === 'proxy' ? 10 : 450, ok: true, failure: null });
  }
  const taskBrowser = await launchBrowser(mode === 'native' ? [] : router.browserArgs());
  const context = await taskBrowser.newContext({ serviceWorkers: 'block' });
  const page = await context.newPage(); page.setDefaultTimeout(4000); page.setDefaultNavigationTimeout(5000);
  page.on('request', req => router.noteBrowserRequest(req)); page.on('requestfailed', req => router.noteBrowserFailure(req));
  const phases = {}; let ok = true, error = null, failedPhase = null;
  const step = async (name, fn) => { failedPhase = name; const start = performance.now(); try { await fn(); } finally { phases[name] = performance.now() - start; } };
  const began = performance.now(); const originBefore = fixture.connectionCount();
  try {
    await step('navigation', () => page.goto(`http://${mode === 'native' ? '127.0.0.1' : 'bench.test'}:${fixture.port}/?id=${id}`, { waitUntil: 'domcontentloaded' }));
    await step('query', async () => { await page.locator('#query').click(); await page.locator('#answer').filter({ hasText: '42' }).waitFor(); });
    await step('resources', () => page.locator('#assets').filter({ hasText: '12 loaded' }).waitFor());
    await step('form', async () => {
      await page.getByLabel('Name').fill('Alice'); await page.locator('#review').click(); assert.equal(await page.locator('#summary').innerText(), 'Alice');
      await page.locator('#confirm').click(); await page.locator('#receipt').filter({ hasText: 'Saved' }).waitFor(); assert.equal(fixture.state(id).posts, 1);
    });
    await step('websocket', async () => assert.equal(await page.evaluate(() => Promise.race([window.echo(), new Promise((_, reject) => setTimeout(() => reject(new Error('WS deadline')), 4000))])), 'ping'));
    await step('persistence', async () => {
      await page.reload({ waitUntil: 'domcontentloaded' });
      assert.equal(await page.evaluate(() => localStorage.getItem('saved')), 'yes');
      assert((await context.cookies()).some(c => c.name === 'session' && c.value === 'ready'));
      assert.equal(fixture.state(id).posts, 1);
    });
    failedPhase = null;
  } catch (err) { ok = false; error = err.message.split('\n')[0]; }
  const elapsedMs = performance.now() - began;
  // Task timing excludes cancellation/flush; connection counts include live background probes.
  await context.close(); await taskBrowser.close(); await router.close();
  return { scenario, mode, repetition, proxyScope, ok, error, failedPhase, elapsedMs, phases, attempts: mode === 'native' ? null : attempts, originConnections: fixture.connectionCount() - originBefore,
    posts: fixture.state(id).posts, resources: fixture.state(id).resources, race: router.status().race,
    fallbacks: router.fallbacks, probeAttempts: router.metrics.filter(m => m.kind === 'probe' && [keyOf(target), keyOf({ ...target, secure: true })].includes(m.target)).length,
    cancelled: router.metrics.filter(m => m.outcome === 'cancelled' && [keyOf(target), keyOf({ ...target, secure: true })].includes(m.target)).length };
}
function summarize(rows) {
  const result = [];
  for (const scenario of Object.keys(scenarios)) for (const mode of [...modes, ...(scenario === 'normal' ? ['native'] : [])]) {
    const group = rows.filter(r => r.scenario === scenario && r.mode === mode); if (!group.length) continue; const successes = group.filter(r => r.ok);
    result.push({ scenario, mode, runs: group.length, successes: successes.length,
      successP50Ms: percentile(successes.map(r => r.elapsedMs), .5), successP95Ms: percentile(successes.map(r => r.elapsedMs), .95),
      attemptP95Ms: percentile(group.map(r => r.elapsedMs), .95),
      meanConnectionAttempts: mode === 'native' ? null : group.reduce((a, r) => a + r.attempts.direct + r.attempts.proxy, 0) / group.length,
      meanOriginConnections: group.reduce((a, r) => a + r.originConnections, 0) / group.length,
      meanProbes: group.reduce((a, r) => a + r.probeAttempts, 0) / group.length,
      duplicatePosts: group.filter(r => r.posts > 1).length });
  }
  return result;
}
async function main() {
  const repetitions = Number(process.argv.find(a => a.startsWith('--repetitions='))?.split('=')[1] || 5);
  if (!Number.isInteger(repetitions) || repetitions < 1 || repetitions > 30) throw new Error('repetitions must be 1..30');
  const proxyScope = process.argv.find(a => a.startsWith('--proxy-scope='))?.split('=')[1] || 'http';
  if (!['http', 'both'].includes(proxyScope)) throw new Error('proxy-scope must be http or both');
  const selectedScenarios = process.argv.find(a => a.startsWith('--scenarios='))?.split('=')[1].split(',') || Object.keys(scenarios);
  const selectedModes = process.argv.find(a => a.startsWith('--modes='))?.split('=')[1].split(',') || modes;
  if (selectedScenarios.some(s => !scenarios[s]) || selectedModes.some(m => !modes.includes(m))) throw new Error('Invalid scenarios/modes');
  const total = repetitions * (selectedScenarios.length * selectedModes.length + Number(selectedScenarios.includes('normal')));
  const output = process.argv.find(a => a.startsWith('--output='))?.slice(9);
  const runtime = resolveRuntime({ root: path.resolve(__dirname, '..') }); const { chromium } = require(path.join(runtime.nodeModules, 'playwright'));
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'routing-task-eval-')); const fixture = await fixtures();
  const rows = [];
  const launchBrowser = args => chromium.launch({ headless: true, executablePath: runtime.browserExecutablePath, args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE 127.0.0.1', ...args] });
  try {
    // Rotate mode order each repetition to reduce systematic warmup/time-order bias.
    for (let repeat = 0; repeat < repetitions; repeat++) for (const scenario of selectedScenarios) {
      for (let i = 0; i < selectedModes.length; i++) {
        const mode = selectedModes[(i + repeat) % selectedModes.length]; rows.push(await journey(launchBrowser, fixture, root, scenario, mode, repeat, proxyScope));
      }
      if (scenario === 'normal') rows.push(await journey(launchBrowser, fixture, root, scenario, 'native', repeat, proxyScope));
      process.stderr.write(`completed ${rows.length}/${total}: ${scenario}\n`);
    }
    const result = { measuredAt: new Date().toISOString(), repetitions, proxyScope, runtime, scenarios,
      scope: 'Local HTTP and WebSocket Chromium journeys; controlled connection delays before real TCP/CONNECT. Direct uses the same relay; not a native-direct overhead comparison. Fresh browser/PAC, context, and cache per run except explicitly seeded warm statistics; browser launch excluded. No model API or public network.',
      summary: summarize(rows), taskFailures: rows.filter(r => !r.ok).length, duplicatePostTasks: rows.filter(r => r.posts > 1).length, rows };
    if (output) await fs.writeFile(output, JSON.stringify(result, null, 2) + '\n');
    console.log(JSON.stringify(result.summary, null, 2));
    const knownFailure = r => ['direct-refused', 'direct-timeout'].includes(r.scenario) && r.mode === 'direct' && r.failedPhase === 'navigation';
    if (rows.some(r => r.posts > 1 || (!r.ok && (!knownFailure(r) || (process.argv.includes('--enforce') && r.mode !== 'direct'))))) process.exitCode = 1;
  } finally { await fixture.close(); await fs.rm(root, { recursive: true, force: true }); }
}
if (require.main === module) main().catch(error => { console.error(error); process.exitCode = 1; });
module.exports = { summarize, scenarios };
