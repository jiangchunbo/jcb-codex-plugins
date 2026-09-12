const assert = require('node:assert/strict');
const { test } = require('node:test');
const http = require('node:http');
const https = require('node:https');
const net = require('node:net');
const tls = require('node:tls');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { Router, Samples, ProbeBudget, discover, bypass, fingerprint, keyOf } = require('../scripts/routing');

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
const close = server => new Promise(resolve => { server.closeAllConnections?.(); server.close(resolve); });
const temp = () => fs.mkdtemp(path.join(os.tmpdir(), 'pw-routing-'));
function request(port, url, method = 'GET', body = '', headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: url, method, headers }, res => {
      let data = ''; res.on('data', chunk => data += chunk); res.on('end', () => resolve({ status: res.statusCode, data, headers: res.headers }));
    }); req.on('error', reject); req.end(body);
  });
}
async function proxyServer({ reject = false, secureOptions, requiredAuth } = {}) {
  let tunnels = 0; const sockets = new Set();
  const proxy = secureOptions ? https.createServer(secureOptions) : http.createServer();
  proxy.on('connection', socket => { sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  proxy.on('connect', (req, client, head) => {
    tunnels++;
    if (requiredAuth && req.headers['proxy-authorization'] !== requiredAuth) return client.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    if (reject) return client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    const url = new URL(`http://${req.url}`);
    const dest = net.connect({ host: '127.0.0.1', port: Number(url.port) }, () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) dest.write(head); client.pipe(dest); dest.pipe(client);
    });
    sockets.add(dest); dest.on('close', () => { sockets.delete(dest); client.destroy(); }); dest.on('error', () => client.destroy()); client.on('close', () => dest.destroy());
  });
  const port = await listen(proxy);
  return { port, count: () => tunnels, close: async () => { for (const s of sockets) s.destroy(); await close(proxy); } };
}

test('inherited proxy precedence, scheme selection, absence and unsupported protocols', () => {
  assert.equal(discover({}).enabled, false);
  assert.equal(discover({ ALL_PROXY: 'socks5://127.0.0.1:1' }).enabled, false);
  assert.deepEqual(discover({ ALL_PROXY: 'socks5://127.0.0.1:1' }).warnings, ['unsupported-or-invalid-inherited-proxy']);
  const cfg = discover({ http_proxy: 'http://127.0.0.1:11', HTTP_PROXY: 'http://127.0.0.1:12', ALL_PROXY: 'https://proxy.example:13' });
  assert.equal(cfg.proxies.http.port, '11'); assert.equal(cfg.proxies.https.port, '13');
  assert.equal(discover({ http_proxy: '', HTTP_PROXY: 'http://ignored:1' }).enabled, false);
  assert.equal(discover({ HTTPS_PROXY: 'http://proxy:1', PLAYWRIGHT_FAST_ROUTING: 'off' }).enabled, false);
});

test('local networks, IPv6, NO_PROXY suffixes, ports, wildcard and CIDR bypass', () => {
  for (const host of ['localhost', 'api.localhost', '10.0.0.1', '172.31.2.1', '192.168.5.1', '127.0.0.1', '::1', 'fd00::1', '::ffff:7f00:1']) assert(bypass({ host, port: 443 }), host);
  assert(bypass({ host: 'api.example.com', port: 443 }, '.example.com'));
  assert(bypass({ host: 'example.com', port: 443 }, 'example.com:443'));
  assert(!bypass({ host: 'example.com', port: 80 }, 'example.com:443'));
  assert(!bypass({ host: 'notexample.com', port: 443 }, '.example.com'));
  assert(bypass({ host: '203.0.113.8', port: 80 }, '203.0.113.0/24'));
  assert(bypass({ host: 'api.example.com', port: 80 }, '*.example.com'));
});

test('no inherited proxy creates no listener, probes or cache directory', async () => {
  const root = await temp(); const directory = path.join(root, 'missing');
  const router = new Router({ env: {}, directory });
  assert.equal(await router.start(), null); assert.equal(router.activeProbes, 0);
  await assert.rejects(fs.stat(directory), { code: 'ENOENT' }); await router.close(); await fs.rm(root, { recursive: true });
});

test('private DNS answers stay direct and slow DNS never leaks a possible intranet name', async () => {
  const directory = await temp();
  const router = new Router({ env: { HTTPS_PROXY: 'http://proxy.example:1' }, directory,
    lookup: (_host, _options, callback) => callback(null, [{ address: '10.1.2.3', family: 4 }]) });
  assert.equal(await router.isBypassed({ host: 'internal.example.com', port: 443, secure: true }), true);
  router.lookup = () => {};
  assert.equal(await router.isBypassed({ host: 'slow.example.com', port: 443, secure: true }), true);
  assert.equal(router.resolvedPrivate.has('slow.example.com'), false);
  assert.equal(router.activeProbes, 0);
  await router.close(); await fs.rm(directory, { recursive: true });
});

test('selection weights failures, requires evidence and hysteresis, expires and recovers', async () => {
  const directory = await temp(); let now = Date.now(); const s = new Samples(directory, 'test', () => now); const target = 'https://example.com:443';
  const add = (route, ms, ok = true) => s.add({ target, route, kind: 'probe', ms, ok, failure: ok ? null : 'timeout' });
  add('direct', 500); add('proxy', 100); assert.equal(s.choose(target), 'direct');
  for (let i = 0; i < 2; i++) { now++; add('direct', 500); add('proxy', 100); }
  assert.equal(s.choose(target), 'proxy');
  s.add({ target, route: 'proxy', kind: 'selection', ms: 0, ok: true, failure: null });
  now++; add('proxy', 3000, false); now++; add('proxy', 3000, false);
  assert.equal(s.choose(target), 'direct'); assert(s.suspended(target, 'proxy'));
  now += 31000; assert(!s.suspended(target, 'proxy'));
  now += 31 * 60_000; assert.equal(s.stats(target, 'proxy').count, 0); assert.equal(s.choose(target), 'direct');
  await s.writes; await fs.rm(directory, { recursive: true });
});

test('sharded cache merges concurrent writers, excludes other networks and survives corruption', async () => {
  const directory = await temp(); const a = new Samples(directory, 'network'), b = new Samples(directory, 'network');
  const entry = { target: 'https://example.com:443', route: 'direct', kind: 'probe', ms: 100, ok: true, failure: null };
  a.add(entry); b.add({ ...entry, route: 'proxy' }); await Promise.all([a.writes, b.writes]);
  await fs.writeFile(path.join(directory, '1-deadbeef.json'), '{bad');
  const c = new Samples(directory, 'network'); await c.load(); assert.equal(c.samples.length, 2);
  const d = new Samples(directory, 'other'); await d.load(); assert.equal(d.samples.length, 0);
  const cfg = discover({ HTTPS_PROXY: 'http://127.0.0.1:1' });
  assert.notEqual(fingerprint(cfg, { interfaces: {}, dns: ['a'] }), fingerprint(cfg, { interfaces: {}, dns: ['b'] }));
  assert.notEqual(fingerprint(cfg, { interfaces: {}, dns: [] }), fingerprint(discover({ HTTPS_PROXY: 'http://127.0.0.1:2' }), { interfaces: {}, dns: [] }));
  await fs.rm(directory, { recursive: true });
});

test('HTTP forwards POST once through fallback and never replays a failed business request', async () => {
  const directory = await temp(); let posts = 0; let failResponse = false;
  const origin = http.createServer((req, res) => { let body = ''; req.on('data', b => body += b); req.on('end', () => {
    if (req.method === 'POST') posts++;
    if (failResponse) req.socket.destroy(); else { res.setHeader('set-cookie', 'session=ok'); res.end(body || 'hello'); }
  }); }); const port = await listen(origin); const proxy = await proxyServer();
  const router = new Router({ env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }, directory, bypassTarget: () => false });
  const original = router.connect.bind(router);
  router.connect = (target, route, signal) => route === 'direct' ? Promise.reject(Object.assign(new Error('refused'), { code: 'ECONNREFUSED' })) : original(target, route, signal);
  const endpoint = new URL(await router.start());
  try {
    const result = await request(Number(endpoint.port), `http://example.test:${port}/submit`, 'POST', 'payload');
    assert.equal(result.data, 'payload'); assert.equal(posts, 1); assert.equal(router.fallbacks, 1); assert.equal(router.pins.values().next().value, 'proxy');
    assert.deepEqual(result.headers['set-cookie'], ['session=ok']);
    failResponse = true;
    const failed = await request(Number(endpoint.port), `http://example.test:${port}/submit`, 'POST', 'next');
    assert.equal(failed.status, 502); assert.equal(posts, 2); assert.equal(router.fallbacks, 1);
  } finally { await router.close(); await proxy.close(); await close(origin); await fs.rm(directory, { recursive: true }); }
});

test('CONNECT is opaque and delivers bytes only once', async () => {
  const directory = await temp(); const origin = net.createServer(s => s.pipe(s)); const port = await listen(origin);
  const router = new Router({ env: { HTTPS_PROXY: 'http://127.0.0.1:1' }, directory }); const endpoint = new URL(await router.start());
  try {
    const data = await new Promise((resolve, reject) => {
      const client = net.connect(Number(endpoint.port), '127.0.0.1'); let header = true; let buffer = Buffer.alloc(0);
      client.on('error', reject); client.on('data', chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        if (header) { const end = buffer.indexOf('\r\n\r\n'); if (end < 0) return; assert.match(buffer.toString(), /^HTTP\/1.1 200/); buffer = buffer.subarray(end + 4); header = false; client.write(Buffer.from([0, 1, 2, 255])); }
        if (!header && buffer.length >= 4) { resolve(buffer); client.destroy(); }
      }); client.write(`CONNECT 127.0.0.1:${port} HTTP/1.1\r\nHost: localhost\r\n\r\n`);
    }); assert.deepEqual(data, Buffer.from([0, 1, 2, 255])); assert.equal(router.pins.size, 0);
  } finally { await router.close(); await close(origin); await fs.rm(directory, { recursive: true }); }
});

test('websocket upgrade preserves the handshake and bidirectional stream', async () => {
  const directory = await temp(); const origin = http.createServer();
  origin.on('upgrade', (req, socket, head) => { socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n'); if (head.length) socket.write(head); socket.pipe(socket); });
  const port = await listen(origin); const router = new Router({ env: { HTTP_PROXY: 'http://127.0.0.1:1' }, directory }); const endpoint = new URL(await router.start());
  try {
    await new Promise((resolve, reject) => {
      const client = net.connect(Number(endpoint.port), '127.0.0.1'); let upgraded = false; let text = '';
      client.on('error', reject); client.on('data', b => { text += b.toString(); if (!upgraded && text.includes('\r\n\r\n')) { assert(text.startsWith('HTTP/1.1 101')); upgraded = true; client.write('echo'); } else if (upgraded && text.endsWith('echo')) { client.destroy(); resolve(); } });
      client.write(`GET http://127.0.0.1:${port}/socket HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n`);
    });
  } finally { await router.close(); await close(origin); await fs.rm(directory, { recursive: true }); }
});

test('context pins survive changing measurements; new context learns and reset epoch excludes live old writers', async () => {
  const directory = await temp(); const env = { HTTPS_PROXY: 'http://proxy.example:3128' }; const router = new Router({ env, directory, bypassTarget: () => false });
  await router.start(); const target = { host: 'example.com', port: 443, secure: true }; const key = keyOf(target);
  router.dial = async () => ({ destroy() {} }); router.schedule = () => {};
  await router.open(target); assert.equal(router.pins.get(key), 'direct');
  for (let i = 0; i < 3; i++) for (const route of ['direct', 'proxy']) router.store.add({ target: key, route, kind: 'probe', ms: route === 'direct' ? 500 : 100, ok: true, failure: null });
  await router.open(target); assert.equal(router.pins.get(key), 'direct'); await router.store.writes;
  const other = new Router({ env, directory }); await other.start(); assert.equal(other.store.choose(key), 'proxy');
  await other.clear(); router.store.add({ target: key, route: 'direct', kind: 'probe', ms: 10, ok: true, failure: null }); await router.store.writes;
  const fresh = new Router({ env, directory }); await fresh.start(); assert.equal(fresh.store.samples.length, 0);
  await Promise.all([router.close(), other.close(), fresh.close()]); await fs.rm(directory, { recursive: true });
});

test('TLS probes validate the target through CONNECT and send no HTTP data', async () => {
  const { execFileSync } = require('node:child_process');
  const directory = await temp(); const keyFile = path.join(directory, 'key.pem'), certFile = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=example.test', '-addext', 'subjectAltName=DNS:example.test'], { stdio: 'ignore' });
  const cert = await fs.readFile(certFile), key = await fs.readFile(keyFile);
  let applicationBytes = 0, plain; const sockets = new Set();
  const origin = tls.createServer({ key, cert }, socket => { sockets.add(socket); socket.on('data', b => applicationBytes += b.length); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
  const port = await listen(origin); const proxy = await proxyServer();
  const router = new Router({ env: { HTTPS_PROXY: `http://127.0.0.1:${proxy.port}` }, directory: path.join(directory, 'cache'), tlsConnect: options => tls.connect({ ...options, ca: cert }) });
  await router.start();
  try {
    await router.dial({ host: 'example.test', port, secure: true }, 'proxy', true);
    assert.equal(applicationBytes, 0); assert.equal(router.store.samples[0].ok, true); assert(proxy.count() > 0);
    assert.equal(router.metricSummary().probe.stages.targetTlsMs.count, 1);
    // A listening HTTP proxy is not proof that target TLS is healthy.
    plain = net.createServer(socket => { sockets.add(socket); socket.on('data', () => {}); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
    const plainPort = await listen(plain);
    const started = performance.now();
    await assert.rejects(router.dial({ host: 'example.test', port: plainPort, secure: true }, 'proxy', true));
    assert(performance.now() - started >= 2800); assert(performance.now() - started < 4000);
    assert.equal(router.store.samples[0].failure, 'timeout');
    for (const s of sockets) s.destroy(); await close(plain); plain = null;
  } finally { await router.close(); for (const s of sockets) s.destroy(); if (plain) await close(plain); await proxy.close(); await close(origin); await fs.rm(directory, { recursive: true }); }
});

test('probe concurrency and frequency are bounded without delaying the business lane', async () => {
  const directory = await temp(); let now = Date.now();
  const router = new Router({ env: { HTTPS_PROXY: 'http://proxy.example:1' }, directory, now: () => now, bypassTarget: () => false });
  await router.start(); let active = 0, max = 0, calls = 0; const release = [];
  router.dial = async (target, route, probe) => {
    if (!probe) return { destroy() {} };
    active++; calls++; max = Math.max(max, active);
    await new Promise(resolve => release.push(resolve)); active--; return { destroy() {} };
  };
  const a = { host: 'a.example', port: 443, secure: true }, b = { host: 'b.example', port: 443, secure: true };
  const before = performance.now(); await router.open(a); await router.open(b);
  assert(performance.now() - before < 100);
  const waitFor = async predicate => { const end = Date.now() + 1000; while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 5)); assert(predicate()); };
  await waitFor(() => calls === 2); assert.equal(max, 2);
  await router.open(a); assert.equal(calls, 2);
  while (router.activeProbes || router.pending.length) { release.splice(0).forEach(fn => fn()); await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.equal(calls, 4); assert.equal(max, 2);
  await router.open(a); assert.equal(calls, 4);
  now += 5 * 60_000 + 1; await router.open(a); await waitFor(() => calls === 6);
  release.splice(0).forEach(fn => fn()); await Promise.allSettled([...router.probeTasks]);
  await router.close(); await fs.rm(directory, { recursive: true });
});

test('cache expiry, bounded targets and hot choice latency', async t => {
  const directory = await temp(); let now = Date.now(); const store = new Samples(directory, 'net', () => now);
  const samples = Array.from({ length: 1100 }, (_, i) => ({ target: `https://host${i}.example:443`, route: 'direct', kind: 'probe', at: now, ms: 50, ok: true, failure: null }));
  store.samples = store.bounded(samples); assert.equal(new Set(store.samples.map(s => s.target)).size, 1000);
  const timings = []; for (let i = 0; i < 100; i++) { const t = performance.now(); store.choose('https://host0.example:443'); timings.push(performance.now() - t); }
  timings.sort((a, b) => a - b); assert(timings[94] < 5, `choice P95 ${timings[94]} ms`);
  const router = new Router({ env: { HTTPS_PROXY: 'http://proxy.example:1' }, directory,
    now: () => now, bypassTarget: () => false, connector: async () => ({ destroy() {} }) });
  const target = { host: 'host0.example', port: 443, secure: true };
  router.store.samples = Array.from({ length: 16 }, () => store.samples).flat();
  router.pins.set(keyOf(target), 'direct');
  for (const route of ['direct', 'proxy']) router.recentProbes.set(`${keyOf(target)}|${route}`, now);
  const hot = [];
  for (let i = 0; i < 100; i++) { const start = performance.now(); await router.open(target); hot.push(performance.now() - start); }
  hot.sort((a, b) => a - b);
  assert(hot[94] < 5, `hot routing P95 ${hot[94]} ms`);
  t.diagnostic(`1000 targets / 16000 records, cached routing P95 ${hot[94].toFixed(3)} ms (socket IO excluded)`);
  await router.close();
  store.add(samples[0]); await store.writes; now += 86400_000 + 1;
  const fresh = new Samples(directory, 'net', () => now); await fresh.load(); assert.equal(fresh.samples.length, 0);
  await fs.rm(directory, { recursive: true });
});

test('browser business errors do not affect routing and transport failure only schedules probes', async () => {
  const directory = await temp(); const router = new Router({ env: { HTTPS_PROXY: 'http://proxy.example:1' }, directory, bypassTarget: () => false });
  let scheduled = 0; router.schedule = () => scheduled++;
  router.pins.set('https://example.com:443', 'direct');
  const req = errorText => ({ failure: () => ({ errorText }), url: () => 'https://example.com/private?token=secret' });
  router.noteBrowserFailure(req('net::ERR_ABORTED')); assert.equal(scheduled, 0);
  router.noteBrowserFailure(req('net::ERR_CONNECTION_RESET')); await new Promise(resolve => setImmediate(resolve)); assert.equal(scheduled, 1);
  assert.equal(router.pins.get('https://example.com:443'), 'direct'); assert.equal(router.store.samples.length, 0);
  await router.close(); await fs.rm(directory, { recursive: true });
});

test('real Chromium preserves cookies and storage while a newly faster route stays deferred', async () => {
  const { resolveRuntime } = require('../scripts/resolve-runtime');
  const spec = resolveRuntime({ root: path.resolve(__dirname, '..') });
  const { chromium } = require(path.join(spec.nodeModules, 'playwright'));
  const directory = await temp(); const proxy = await proxyServer(); let requests = 0;
  const origin = http.createServer((req, res) => {
    requests++; res.setHeader('content-type', 'text/html');
    if (req.url === '/start') { res.setHeader('set-cookie', 'session=preserved; Path=/'); res.end('<title>routing fixture</title><main>ready</main>'); }
    else res.end(req.headers.cookie || 'missing');
  }); const port = await listen(origin);
  const router = new Router({ env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }, directory, bypassTarget: () => false });
  const original = router.connect.bind(router); let blockDirect = true;
  router.connect = (target, route, signal) => blockDirect && route === 'direct' ? Promise.reject(Object.assign(new Error('unreachable'), { code: 'ECONNREFUSED' })) : original(target, route, signal);
  const endpoint = await router.start(); let browser;
  try {
    browser = await chromium.launch({ executablePath: spec.browserExecutablePath, headless: true, proxy: { server: endpoint, bypass: '<-loopback>' } });
    const context = await browser.newContext(); const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/start`); await page.evaluate(() => localStorage.setItem('state', 'preserved'));
    assert(proxy.count() > 0, 'Chromium must actually reach the test proxy'); assert.equal(router.fallbacks, 1);
    blockDirect = false;
    const target = `http://127.0.0.1:${port}`;
    for (let i = 0; i < 3; i++) for (const route of ['direct', 'proxy']) router.store.add({ target, route, kind: 'probe', ms: route === 'direct' ? 1 : 500, ok: true, failure: null });
    await page.goto(`http://127.0.0.1:${port}/cookie`);
    assert.match(await page.locator('body').innerText(), /session=preserved/);
    assert.equal(await page.evaluate(() => localStorage.getItem('state')), 'preserved');
    assert.equal(router.pins.get(target), 'proxy'); assert(requests >= 2);
  } finally { await browser?.close(); await router.close(); await proxy.close(); await close(origin); await fs.rm(directory, { recursive: true }); }
});

test('HTTPS upstream authenticates without forwarding or persisting credentials', async () => {
  const { execFileSync } = require('node:child_process'); const directory = await temp();
  const keyFile = path.join(directory, 'key.pem'), certFile = path.join(directory, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyFile, '-out', certFile, '-days', '1', '-subj', '/CN=example.test', '-addext', 'subjectAltName=DNS:example.test'], { stdio: 'ignore' });
  const cert = await fs.readFile(certFile), key = await fs.readFile(keyFile);
  let credentialAtOrigin;
  const origin = http.createServer((req, res) => { credentialAtOrigin = req.headers['proxy-authorization']; res.end('secure-proxy-ok'); });
  const port = await listen(origin);
  const proxy = await proxyServer({ secureOptions: { key, cert }, requiredAuth: `Basic ${Buffer.from('user:private-password').toString('base64')}` });
  const router = new Router({ env: { HTTP_PROXY: `https://user:private-password@127.0.0.1:${proxy.port}` }, directory: path.join(directory, 'cache'), bypassTarget: () => false, tlsConnect: opts => tls.connect({ ...opts, ca: cert, servername: 'example.test' }) });
  const endpoint = new URL(await router.start()); router.pins.set(`http://127.0.0.1:${port}`, 'proxy');
  try {
    const result = await request(Number(endpoint.port), `http://127.0.0.1:${port}/private?secret=query`);
    assert.equal(result.data, 'secure-proxy-ok'); assert.equal(credentialAtOrigin, undefined); assert(proxy.count() > 0);
    await Promise.allSettled([...router.probeTasks]); await router.store.writes;
    for (const name of await fs.readdir(path.join(directory, 'cache'))) {
      const text = await fs.readFile(path.join(directory, 'cache', name), 'utf8');
      assert(!text.includes('private-password')); assert(!text.includes('secret=query'));
    }
  } finally { await router.close(); await proxy.close(); await close(origin); await fs.rm(directory, { recursive: true }); }
});

test('failed upstream tunnel falls back before delivery', async () => {
  const directory = await temp(); const proxy = await proxyServer({ reject: true });
  const origin = http.createServer((req, res) => res.end('direct fallback')); const port = await listen(origin);
  const router = new Router({ env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }, directory, bypassTarget: () => false });
  const endpoint = new URL(await router.start()); router.pins.set(`http://127.0.0.1:${port}`, 'proxy');
  try {
    assert.equal((await request(Number(endpoint.port), `http://127.0.0.1:${port}/`)).data, 'direct fallback');
    assert.equal(router.fallbacks, 1); assert.equal(router.pins.get(`http://127.0.0.1:${port}`), 'direct');
  } finally { await router.close(); await proxy.close(); await close(origin); await fs.rm(directory, { recursive: true }); }
});

test('host-wide probe budget caps multiple processes and deduplicates a route for five minutes', async () => {
  const directory = await temp(); let now = Date.now(); const a = new ProbeBudget(directory, () => now), b = new ProbeBudget(directory, () => now);
  const keys = ['a', 'b', 'c'].map(x => require('node:crypto').createHash('sha256').update(x).digest('hex'));
  const first = await a.acquire(keys[0]), second = await b.acquire(keys[1]);
  assert(first && second); assert.equal(await b.acquire(keys[2]), false);
  await a.release(first); assert.equal(await b.acquire(keys[0]), false);
  const third = await b.acquire(keys[2]); assert(third);
  await Promise.all([a.release(second), b.release(third)]);
  now += 5 * 60_000 + 1; const renewed = await a.acquire(keys[0]); assert(renewed); await a.release(renewed);
  await fs.rm(directory, { recursive: true });
});

test('route preference does not flap on a small difference and reverses on sufficient evidence', async () => {
  const directory = await temp(); const now = Date.now(); const store = new Samples(directory, 'net', () => now); const target = 'https://example.com:443';
  const sample = (route, ms, kind = 'probe') => ({ target, route, kind, at: now, ms, ok: true, failure: null });
  store.samples = [sample('proxy', 0, 'selection'), ...Array.from({ length: 3 }, () => [sample('proxy', 100), sample('direct', 95)]).flat()];
  assert.equal(store.choose(target), 'proxy');
  store.samples = [sample('proxy', 0, 'selection'), ...Array.from({ length: 3 }, () => [sample('proxy', 500), sample('direct', 100)]).flat()];
  assert.equal(store.choose(target), 'direct'); await fs.rm(directory, { recursive: true });
});

test('closing the router cancels an unfinished TLS probe without waiting for its deadline', async () => {
  const directory = await temp(); let accepted; const ready = new Promise(resolve => accepted = resolve); const peers = new Set();
  const blackhole = net.createServer(s => { peers.add(s); s.on('error', () => {}); s.on('data', () => {}); s.on('close', () => peers.delete(s)); accepted(); }); const port = await listen(blackhole);
  const router = new Router({ env: { HTTPS_PROXY: 'http://127.0.0.1:1' }, directory }); await router.start();
  const pending = router.dial({ host: '127.0.0.1', port, secure: true }, 'direct', true).catch(() => {});
  await ready; const start = performance.now(); await router.close(); await pending;
  assert(performance.now() - start < 500); assert.equal(router.controllers.size, 0);
  for (const peer of peers) peer.destroy(); await close(blackhole); await fs.rm(directory, { recursive: true });
});

function delayedConnector(router, delays, fail = []) {
  return (target, route, signal) => new Promise((resolve, reject) => {
    let socket;
    const abort = () => { clearTimeout(timer); socket?.destroy(); reject(signal.reason); };
    const timer = setTimeout(() => {
      if (fail.includes(route)) { signal.removeEventListener('abort', abort); reject(Object.assign(new Error('fixture refused'), { code: 'ECONNREFUSED' })); return; }
      socket = router.track(net.connect({ host: '127.0.0.1', port: target.port }));
      socket.once('connect', () => resolve(socket)); socket.once('error', reject);
      socket.once('close', () => signal.removeEventListener('abort', abort));
    }, delays[route]);
    signal.addEventListener('abort', abort, { once: true }); if (signal.aborted) abort();
  });
}

test('delayed competition reduces first-connection waiting, sends POST once and pins the winner', async t => {
  const directory = await temp(); let posts = 0;
  const origin = http.createServer((req, res) => { req.resume(); req.on('end', () => { posts++; res.end('saved'); }); });
  const port = await listen(origin); const observed = {};
  for (const mode of ['off', 'on']) {
    const router = new Router({ env: { HTTP_PROXY: 'http://proxy.example:1', PLAYWRIGHT_FAST_CONNECT_RACE: mode }, directory: path.join(directory, mode), bypassTarget: () => false });
    router.connector = delayedConnector(router, { direct: 900, proxy: 20 }); router.schedule = () => {};
    await router.start(); const start = performance.now(); const before = posts;
    const result = await request(router.server.address().port, `http://public.example:${port}/submit`, 'POST', 'one');
    observed[mode] = performance.now() - start; assert.equal(result.data, 'saved'); assert.equal(posts, before + 1);
    if (mode === 'on') {
      assert.equal(router.pins.get(`http://public.example:${port}`), 'proxy');
      const races = router.races;
      await request(router.server.address().port, `http://public.example:${port}/submit`, 'POST', 'two');
      assert.equal(router.races, races); assert.equal(posts, before + 2);
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(router.store.samples.filter(s => !s.ok).length, 0);
      assert.equal(router.metricSummary().connection.cancelled, 1);
    }
    await router.close();
  }
  assert(observed.off - observed.on > 400, JSON.stringify(observed));
  t.diagnostic(`Controlled 900 ms direct / 20 ms proxy: off ${observed.off.toFixed(1)} ms, on ${observed.on.toFixed(1)} ms; POST once per call`);
  await close(origin); await fs.rm(directory, { recursive: true });
});

test('fast first connection avoids speculation; concurrent opens share selection but not sockets', async () => {
  const directory = await temp(); const origin = net.createServer(s => { s.on('error', () => {}); s.on('data', () => {}); }); const port = await listen(origin);
  const router = new Router({ env: { HTTPS_PROXY: 'http://proxy.example:1', PLAYWRIGHT_FAST_CONNECT_RACE: 'on' }, directory, bypassTarget: () => false });
  router.connector = delayedConnector(router, { direct: 10, proxy: 20 }); router.schedule = () => {}; await router.start();
  const target = { host: 'public.example', port, secure: true };
  const sockets = await Promise.all([router.open(target), router.open(target)]);
  assert.notEqual(sockets[0], sockets[1]); assert.equal(router.races, 0); assert.equal(router.pins.get(keyOf(target)), 'direct');
  for (const socket of sockets) socket.destroy(); await router.close(); await close(origin); await fs.rm(directory, { recursive: true });
});

test('competition handles both failures and shutdown without leftover timers or false penalties', async () => {
  const directory = await temp(); const target = { host: 'public.example', port: 1234, secure: true };
  const router = new Router({ env: { HTTPS_PROXY: 'http://proxy.example:1', PLAYWRIGHT_FAST_CONNECT_RACE: 'on' }, directory, bypassTarget: () => false });
  router.connector = delayedConnector(router, { direct: 5, proxy: 5 }, ['direct', 'proxy']); router.schedule = () => {}; await router.start();
  await assert.rejects(router.open(target)); assert.equal(router.store.samples.filter(s => !s.ok).length, 2);
  router.connector = delayedConnector(router, { direct: 1500, proxy: 1500 });
  const pending = router.open({ ...target, host: 'second.example' }); const rejected = assert.rejects(pending);
  await new Promise(resolve => setTimeout(resolve, 20)); await router.close(); await rejected;
  assert.equal(router.activeRaces, 0); assert.equal(router.selecting.size, 0); assert.equal(router.controllers.size, 0);
  assert.equal(router.store.samples.filter(s => !s.ok).length, 2);
  await fs.rm(directory, { recursive: true });
});

test('phase metrics distinguish actual TCP and proxy CONNECT without storing URL paths', async () => {
  const directory = await temp(); const origin = http.createServer((req, res) => res.end('ok')); const port = await listen(origin); const proxy = await proxyServer();
  const router = new Router({ env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }, directory, bypassTarget: () => false }); await router.start(); router.schedule = () => {};
  router.pins.set(`http://public.example:${port}`, 'proxy');
  await request(router.server.address().port, `http://public.example:${port}/secret?token=secret`);
  const summary = router.metricSummary();
  assert.equal(summary.connection.stages.tcpMs.count, 1); assert.equal(summary.connection.stages.proxyConnectMs.count, 1);
  assert.equal(summary.connection.stages.dnsMs.p50, 0); assert(summary.policy.stages.policyMs.count === 1);
  assert(!JSON.stringify(router.metrics).includes('secret'));
  for (let i = 0; i < 600; i++) router.recordMetric({ kind: 'navigation', navigationMs: 10 });
  assert.equal(router.metrics.length, 500); assert.equal(router.metricSummary().navigation.count, 500);
  await router.close(); await proxy.close(); await close(origin); await fs.rm(directory, { recursive: true });
});

test('PAC classifies WS by scheme even on the same port and is absent without routing', async () => {
  const directory = await temp(); const router = new Router({ env: { HTTP_PROXY: 'http://proxy.example:1' }, directory });
  await router.start();
  const encoded = router.browserArgs()[0].split('base64,')[1];
  const find = new Function(Buffer.from(encoded, 'base64').toString() + '; return FindProxyForURL;')();
  const ws = find('ws://same.example:443/socket', 'same.example');
  const wss = find('wss://same.example:443/socket', 'same.example');
  assert.notEqual(ws, wss); assert(ws.endsWith(`:${router.wsServer.address().port}`));
  assert.equal(find('https://same.example:443/', 'same.example'), wss);
  for (const env of [{}, { PLAYWRIGHT_FAST_ROUTING: 'off', HTTP_PROXY: 'http://proxy.example:1' }]) {
    const disabled = new Router({ env, directory }); assert.deepEqual(disabled.browserArgs(), []); await disabled.close();
  }
  await router.close(); assert.equal(router.wsServer.listening, false); await fs.rm(directory, { recursive: true });
});

test('Chromium PAC keeps WS and WSS proxies separate, preserves frames/cookies, and never replays rejected upgrades', async () => {
  const { resolveRuntime } = require('../scripts/resolve-runtime'); const { execFileSync } = require('node:child_process');
  const crypto = require('node:crypto'); const runtime = resolveRuntime();
  const { chromium } = require(path.join(runtime.nodeModules, 'playwright'));
  const { wsServer } = require(path.join(runtime.nodeModules, 'playwright-core/lib/utilsBundle.js'));
  const directory = await temp();
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(directory, 'key'), '-out', path.join(directory, 'cert'), '-days', '1', '-subj', '/CN=bench.test', '-addext', 'subjectAltName=DNS:bench.test'], { stdio: 'ignore' });
  const key = await fs.readFile(path.join(directory, 'key')), cert = await fs.readFile(path.join(directory, 'cert'));
  const spki = crypto.createHash('sha256').update(new crypto.X509Certificate(cert).publicKey.export({ type: 'spki', format: 'der' })).digest('base64');
  const wss = new wsServer({ noServer: true }); let rejected = 0; const cookies = [];
  const handler = (_req, res) => { res.setHeader('set-cookie', 'state=kept; Path=/'); res.end('<main>fixture</main>'); };
  const plain = http.createServer(handler), secure = https.createServer({ key, cert }, handler);
  for (const server of [plain, secure]) server.on('upgrade', (req, socket, head) => {
    if (req.url === '/reject') { rejected++; socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    cookies.push(req.headers.cookie || '');
    wss.handleUpgrade(req, socket, head, client => { client.on('error', () => {}); client.on('message', (data, binary) => client.send(data, { binary })); });
  });
  const plainPort = await listen(plain), securePort = await listen(secure);
  const httpProxy = await proxyServer(), httpsProxy = await proxyServer();
  try {
    for (const scope of ['both', 'http', 'https']) {
      const env = { ...(scope !== 'https' ? { HTTP_PROXY: `http://127.0.0.1:${httpProxy.port}` } : {}), ...(scope !== 'http' ? { HTTPS_PROXY: `http://127.0.0.1:${httpsProxy.port}` } : {}) };
      const router = new Router({ env, directory: path.join(directory, scope), bypassTarget: () => false, tlsConnect: options => tls.connect({ ...options, ca: cert }) });
      const original = router.connect.bind(router); const used = [];
      router.connect = (target, route, signal, stages) => {
        if (target.host !== 'bench.test' || route === 'direct') return Promise.reject(Object.assign(new Error('Controlled direct failure'), { code: 'ECONNREFUSED' }));
        used.push({ port: target.port, secure: target.secure, proxyPort: router.proxy(target)?.port });
        return original(target, route, signal, stages);
      };
      await router.start(); let browser;
      try {
        browser = await chromium.launch({ headless: true, executablePath: runtime.browserExecutablePath,
          args: [...router.browserArgs(), `--ignore-certificate-errors-spki-list=${spki}`] });
        const context = await browser.newContext(); const page = await context.newPage();
        await context.addCookies([
          { name: 'state', value: 'kept', domain: 'bench.test', path: '/' },
          { name: 'secureState', value: 'kept', domain: 'bench.test', path: '/', secure: true, sameSite: 'None' },
        ]);
        await page.goto(`${scope === 'https' ? 'https' : 'http'}://bench.test:${scope === 'https' ? securePort : plainPort}/`);
        await page.evaluate(() => localStorage.setItem('value', 'kept'));
        const exchange = url => page.evaluate(url => new Promise(resolve => {
          const socket = new WebSocket(url, 'echo'); socket.binaryType = 'arraybuffer';
          const timer = setTimeout(() => { socket.close(); resolve({ ok: false, timeout: true }); }, 4000);
          socket.onopen = () => socket.send(new Uint8Array([1, 2, 255]));
          socket.onmessage = e => { clearTimeout(timer); const result = { ok: true, protocol: socket.protocol, bytes: [...new Uint8Array(e.data)] }; socket.close(); resolve(result); };
          socket.onerror = () => { clearTimeout(timer); resolve({ ok: false }); };
        }), url);
        for (const [scheme, port, allowed] of [['ws', plainPort, scope !== 'https'], ['wss', securePort, scope !== 'http']]) {
          if (scope === 'https') await page.goto(scheme === 'ws' ? 'about:blank' : `https://bench.test:${securePort}/`);
          const result = await exchange(`${scheme}://bench.test:${port}/echo`);
          assert.equal(result.ok, allowed, `${scope} ${scheme}: ${JSON.stringify(result)}`);
          if (allowed) { assert.deepEqual(result.bytes, [1, 2, 255]); assert.equal(result.protocol, 'echo'); }
        }
        if (scope === 'both') {
          const before = rejected; assert.equal((await exchange(`ws://bench.test:${plainPort}/reject`)).ok, false); assert.equal(rejected, before + 1);
          await page.reload(); assert.equal(await page.evaluate(() => localStorage.getItem('value')), 'kept');
        }
        assert(used.filter(u => u.port === plainPort).every(u => !u.secure && u.proxyPort === String(httpProxy.port)));
        assert(used.filter(u => u.port === securePort).every(u => u.secure && u.proxyPort === String(httpsProxy.port)));
        assert(!router.store.samples.some(s => s.kind === 'probe' && s.target === `https://bench.test:${plainPort}`), 'plain WS must never be probed as TLS');
      } finally { await browser?.close(); await router.close(); }
    }
    assert(cookies.length >= 4); assert(cookies.every(cookie => cookie.includes('state=kept') || cookie.includes('secureState=kept')), JSON.stringify(cookies));
  } finally {
    for (const client of wss.clients) client.terminate(); await new Promise(resolve => wss.close(resolve));
    await httpProxy.close(); await httpsProxy.close(); await close(plain); await close(secure); await fs.rm(directory, { recursive: true });
  }
});

test('HTTP pools reuse sockets within one context and route, without mixing outlets or replaying POST', async () => {
  const directory = await temp(); const sockets = new Set(); const accepted = { direct: 0, proxy: 0 }; let posts = 0, breakResponse = false;
  const servers = {};
  for (const route of ['direct', 'proxy']) {
    servers[route] = http.createServer((req, res) => { req.resume(); req.on('end', () => {
      if (req.method === 'POST') posts++;
      if (breakResponse) req.socket.destroy(); else res.end(route);
    }); });
    servers[route].on('connection', socket => { accepted[route]++; sockets.add(socket); socket.on('error', () => {}); socket.on('close', () => sockets.delete(socket)); });
    await listen(servers[route]);
  }
  const make = async suffix => {
    const router = new Router({ env: { HTTP_PROXY: 'http://proxy.example:1' }, directory: path.join(directory, suffix), bypassTarget: () => false });
    router.schedule = () => {};
    router.connector = (_target, route, signal) => new Promise((resolve, reject) => {
      const socket = router.track(net.connect({ host: '127.0.0.1', port: servers[route].address().port }));
      const abort = () => socket.destroy(signal.reason); signal.addEventListener('abort', abort, { once: true });
      socket.once('close', () => signal.removeEventListener('abort', abort)); socket.once('connect', () => resolve(socket)); socket.once('error', reject);
    });
    await router.start(); return router;
  };
  const router = await make('first'); let other;
  const url = 'http://public.example:80/task', key = 'http://public.example:80';
  try {
    for (let i = 0; i < 3; i++) assert.equal((await request(router.server.address().port, url)).data, 'direct');
    assert.equal(accepted.direct, 1);
    router.pins.set(key, 'proxy');
    for (let i = 0; i < 3; i++) assert.equal((await request(router.server.address().port, url)).data, 'proxy');
    assert.equal(accepted.proxy, 1); assert.equal(accepted.direct, 1);
    other = await make('second'); assert.equal((await request(other.server.address().port, url)).data, 'direct'); assert.equal(accepted.direct, 2);
    breakResponse = true;
    assert.equal((await request(router.server.address().port, url, 'POST', 'once')).status, 502); assert.equal(posts, 1);
    breakResponse = false;
    assert.equal((await request(router.server.address().port, url)).data, 'proxy'); assert.equal(accepted.proxy, 2);
    assert(router.status().httpPools.idleSockets > 0);
  } finally {
    await other?.close(); await router.close(); assert.equal(router.httpAgents.size, 0); assert.equal(router.httpPools.size, 0);
    for (const socket of sockets) socket.destroy(); await Promise.all(Object.values(servers).map(close)); await fs.rm(directory, { recursive: true });
  }
});

test('queued pooled POSTs survive pre-delivery fallback once each without pooling the wrong route', async () => {
  const directory = await temp(); const received = [];
  const origin = http.createServer((req, res) => { let body = ''; req.on('data', chunk => body += chunk); req.on('end', () => { received.push(body); res.end(body); }); });
  const port = await listen(origin), proxy = await proxyServer();
  const router = new Router({ env: { HTTP_PROXY: `http://127.0.0.1:${proxy.port}` }, directory, bypassTarget: () => false });
  router.schedule = () => {}; const connect = router.connect.bind(router);
  router.connect = (target, route, signal, stages) => route === 'direct' ? Promise.reject(Object.assign(new Error('Refused'), { code: 'ECONNREFUSED' })) : connect(target, route, signal, stages);
  await router.start();
  try {
    const url = `http://public.example:${port}/save`;
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => request(router.server.address().port, url, 'POST', String(i))));
    assert(results.every(result => result.status === 200)); assert.equal(received.length, 12); assert.equal(new Set(received).size, 12);
    const oldPool = router.httpPools.get(`http://public.example:${port}|direct`);
    assert(!oldPool || Object.values(oldPool.freeSockets).flat().length === 0);
    assert.equal(router.pins.get(`http://public.example:${port}`), 'proxy');
  } finally { await router.close(); await proxy.close(); await close(origin); await fs.rm(directory, { recursive: true }); }
});
