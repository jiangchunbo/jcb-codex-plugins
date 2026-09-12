const http = require('node:http');
const net = require('node:net');
const tls = require('node:tls');
const dns = require('node:dns');
const os = require('node:os');
const fs = require('node:fs/promises');
const syncFs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const TIMEOUT = 3000;
const CONNECT_TIMEOUT = 2000;
const RACE_DELAY = 250;
const WINDOW = 30 * 60_000;
const INTERVAL = 5 * 60_000;
const MAX_TARGETS = 1000;
const hash = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const envValue = (env, lower, upper) => env[lower] !== undefined ? env[lower] : env[upper];
const cleanHost = host => {
  const value = host.toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  return net.isIPv6(value) ? new URL(`http://[${value}]/`).hostname.slice(1, -1) : value;
};
const authority = target => `${net.isIPv6(target.host) ? `[${target.host}]` : target.host}:${target.port}`;
const keyOf = target => `${target.secure ? 'https' : 'http'}://${authority(target)}`;

function discover(env = process.env) {
  const warnings = [];
  const fallback = envValue(env, 'all_proxy', 'ALL_PROXY');
  function parse(value) {
    if (!value?.trim()) return null;
    try {
      const url = new URL(value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error();
      decodeURIComponent(url.username); decodeURIComponent(url.password);
      if (!url.hostname || (url.pathname !== '/' && url.pathname !== '') || url.search || url.hash) throw new Error();
      return url;
    } catch { warnings.push('unsupported-or-invalid-inherited-proxy'); return null; }
  }
  const proxies = {
    http: parse(envValue(env, 'http_proxy', 'HTTP_PROXY') ?? fallback),
    https: parse(envValue(env, 'https_proxy', 'HTTPS_PROXY') ?? fallback),
  };
  const mode = env.PLAYWRIGHT_FAST_ROUTING || 'auto';
  if (!['auto', 'off'].includes(mode)) throw new Error('PLAYWRIGHT_FAST_ROUTING must be auto or off');
  return { proxies, enabled: mode === 'auto' && Boolean(proxies.http || proxies.https),
    reason: mode === 'off' ? 'disabled' : (proxies.http || proxies.https) ? 'adaptive' : 'no-supported-inherited-proxy',
    noProxy: envValue(env, 'no_proxy', 'NO_PROXY') || '', warnings: [...new Set(warnings)] };
}

function privateAddress(host) {
  host = cleanHost(host);
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || !host.includes('.') && !host.includes(':')) return true;
  if (net.isIPv4(host)) {
    const [a, b] = host.split('.').map(Number);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (net.isIPv6(host)) {
    if (host.startsWith('::ffff:')) {
      const tail = host.slice(7);
      if (net.isIPv4(tail)) return privateAddress(tail);
      const parts = tail.split(':');
      if (parts.length === 2) {
        const n = parseInt(parts[0], 16) * 65536 + parseInt(parts[1], 16);
        return privateAddress([n >>> 24, n >>> 16 & 255, n >>> 8 & 255, n & 255].join('.'));
      }
    }
    return host === '::' || host === '::1' || /^(fc|fd|fe[89ab])/i.test(host);
  }
  return false;
}

function bypass(target, noProxy = '') {
  const host = cleanHost(target.host);
  if (privateAddress(host)) return true;
  return noProxy.split(',').some(raw => {
    let entry = raw.trim().toLowerCase();
    if (!entry) return false;
    if (entry === '*') return true;
    // Support common NO_PROXY host suffixes, optional ports, IPv4 CIDR and wildcard patterns.
    const cidr = /^(\d+\.\d+\.\d+\.\d+)\/(\d+)$/.exec(entry);
    if (cidr && net.isIPv4(cidr[1]) && net.isIPv4(host) && Number(cidr[2]) <= 32) {
      const number = ip => ip.split('.').reduce((n, x) => (n * 256 + Number(x)) >>> 0, 0);
      const mask = Number(cidr[2]) === 0 ? 0 : (0xffffffff << (32 - Number(cidr[2]))) >>> 0;
      return (number(host) & mask) === (number(cidr[1]) & mask);
    }
    const withPort = /^(\[[^\]]+\]|[^:]+):(\+?\d+)$/.exec(entry);
    if (withPort) { if (Number(withPort[2]) !== target.port) return false; entry = withPort[1]; }
    entry = cleanHost(entry).replace(/^\./, '');
    if (entry.includes('*')) return new RegExp(`^${entry.split('*').map(s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`).test(host);
    return host === entry || host.endsWith(`.${entry}`);
  });
}

function fingerprint(config, network) {
  if (!network) {
    let resolver = ''; try { resolver = syncFs.readFileSync('/etc/resolv.conf', 'utf8'); } catch {}
    network = { interfaces: os.networkInterfaces(), dns: [dns.getServers(), resolver] };
  }
  const interfaces = Object.entries(network.interfaces).sort().map(([name, addresses]) => [name,
    (addresses || []).map(a => [a.address, a.netmask, a.family, a.internal]).sort()]);
  return hash({ machine: [os.hostname(), os.platform(), os.arch()], interfaces, dns: network.dns, proxies: Object.fromEntries(Object.entries(config.proxies).map(([k, v]) => [k, v?.href || null])), noProxy: config.noProxy });
}

class Samples {
  constructor(directory, fingerprintValue, now = Date.now) {
    this.directory = directory; this.fingerprint = fingerprintValue; this.now = now;
    this.id = `${process.pid}-${crypto.randomUUID()}.json`; this.samples = []; this.own = [];
    this.writes = Promise.resolve(); this.warning = null;
  }
  valid(s) {
    return s && typeof s.target === 'string' && s.target.length <= 300 && /^https?:\/\/[^/?#@]+:\d+$/.test(s.target) &&
      ['direct', 'proxy'].includes(s.route) && ['probe', 'connection', 'selection'].includes(s.kind) &&
      Number.isFinite(s.at) && s.at <= this.now() + 1000 && s.at > this.now() - 86400_000 &&
      Number.isFinite(s.ms) && s.ms >= 0 && s.ms <= TIMEOUT && typeof s.ok === 'boolean' &&
      [null, 'dns', 'timeout', 'connect', 'tls', 'proxy'].includes(s.failure);
  }
  bounded(samples) {
    const recent = samples.filter(s => this.valid(s)).sort((a, b) => b.at - a.at);
    const targets = new Set();
    return recent.filter(s => { if (!targets.has(s.target) && targets.size >= MAX_TARGETS) return false; targets.add(s.target); return true; }).slice(0, 16000);
  }
  async load() {
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      const entries = await fs.readdir(this.directory);
      for (const name of entries.filter(n => /^\d+-[a-f0-9-]+\.json$/.test(n))) {
        const file = path.join(this.directory, name);
        try {
          const stat = await fs.stat(file);
          if (stat.mtimeMs < this.now() - 86400_000) { await fs.unlink(file); continue; }
          if (stat.size > 4_000_000) continue;
          const data = JSON.parse(await fs.readFile(file, 'utf8'));
          if (data.version === 1 && data.fingerprint === this.fingerprint && Array.isArray(data.samples)) this.samples.push(...data.samples.filter(s => this.valid(s)));
        } catch { this.warning = 'some-routing-cache-records-unreadable'; }
      }
      this.samples = this.bounded(this.samples);
    } catch { this.warning = 'routing-cache-unavailable'; }
  }
  add(sample) {
    const s = { ...sample, ms: Math.min(TIMEOUT, sample.ms), at: this.now() };
    this.samples = this.bounded([s, ...this.samples]); this.own = this.bounded([s, ...this.own]);
    const body = JSON.stringify({ version: 1, fingerprint: this.fingerprint, samples: this.own });
    this.writes = this.writes.then(async () => {
      const file = path.join(this.directory, this.id); const tmp = `${file}.tmp`;
      try { await fs.mkdir(this.directory, { recursive: true, mode: 0o700 }); await fs.writeFile(tmp, body, { mode: 0o600 }); await fs.rename(tmp, file); }
      catch { this.warning = 'routing-cache-write-failed'; await fs.unlink(tmp).catch(() => {}); }
    });
  }
  stats(target, route) {
    const rows = this.samples.filter(s => s.target === target && s.route === route && s.kind === 'probe' && s.at > this.now() - WINDOW);
    // Newer observations carry more weight (15-minute half life).
    const weights = rows.map(s => 2 ** (-(this.now() - s.at) / 900_000));
    const sum = weights.reduce((a, b) => a + b, 0);
    return { count: rows.length, successRate: sum ? rows.reduce((a, s, i) => a + Number(s.ok) * weights[i], 0) / sum : null,
      score: sum ? rows.reduce((a, s, i) => a + (s.ok ? s.ms : TIMEOUT) * weights[i], 0) / sum : null };
  }
  suspended(target, route) {
    const rows = this.samples.filter(s => s.target === target && s.route === route && s.kind !== 'selection').sort((a, b) => b.at - a.at).slice(0, 2);
    return rows.length === 2 && rows.every(s => !s.ok) && rows[0].at > this.now() - 30_000;
  }
  choose(target) {
    if (this.suspended(target, 'direct') && !this.suspended(target, 'proxy')) return 'proxy';
    if (this.suspended(target, 'proxy')) return 'direct';
    const incumbent = this.samples.filter(s => s.target === target && s.kind === 'selection' && s.at > this.now() - WINDOW).sort((a, b) => b.at - a.at)[0]?.route || 'direct';
    const alternative = incumbent === 'direct' ? 'proxy' : 'direct';
    const a = this.stats(target, incumbent), b = this.stats(target, alternative);
    if (a.count >= 3 && b.count >= 3 && b.score <= a.score * .8 && a.score - b.score >= 50) return alternative;
    return incumbent;
  }
}

// Host-wide probe allocation; never runs in the business connection's awaited path.
class ProbeBudget {
  constructor(directory, now = Date.now) { this.directory = directory; this.now = now; }
  async update(callback) {
    const lock = path.join(this.directory, 'probe-budget.lock');
    try {
      await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
      try { await fs.mkdir(lock, { mode: 0o700 }); }
      catch (error) {
        if (error.code !== 'EEXIST') throw error;
        // The allocator holds this lock only for a tiny local JSON update, never for network IO.
        const stat = await fs.stat(lock);
        if (Date.now() - stat.mtimeMs < 10_000) return null;
        await fs.rmdir(lock).catch(() => {});
        try { await fs.mkdir(lock, { mode: 0o700 }); } catch { return null; }
      }
      try {
        let data = { active: [], recent: {} };
        const file = path.join(this.directory, 'probe-budget.json');
        try { const parsed = JSON.parse(await fs.readFile(file, 'utf8')); if (Array.isArray(parsed.active) && parsed.recent && typeof parsed.recent === 'object') data = parsed; } catch {}
        data.active = data.active.filter(row => typeof row.id === 'string' && Number.isFinite(row.at) && this.now() - row.at < 6000 && row.at <= this.now());
        data.recent = Object.fromEntries(Object.entries(data.recent).filter(([key, at]) => /^[a-f0-9]{64}$/.test(key) && Number.isFinite(at) && at > this.now() - INTERVAL && at <= this.now()).sort((a, b) => b[1] - a[1]).slice(0, 2000));
        const result = callback(data);
        const tmp = `${file}.${crypto.randomUUID()}.tmp`;
        await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 }); await fs.rename(tmp, file);
        return result;
      } finally { await fs.rmdir(lock).catch(() => {}); }
    } catch { return null; }
  }
  async acquire(key) {
    // Brief contention is retried only in the background probe lane.
    for (let i = 0; i < 3; i++) {
      const result = await this.update(data => {
        if (data.active.length >= 2 || data.recent[key] !== undefined || Object.keys(data.recent).length >= 2000) return false;
        const id = crypto.randomUUID(); data.active.push({ id, at: this.now() }); data.recent[key] = this.now(); return id;
      });
      if (result !== null) return result;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return false;
  }
  async release(id) {
    for (let i = 0; i < 3; i++) {
      if (await this.update(data => { data.active = data.active.filter(row => row.id !== id); return true; })) return;
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  }
}

function failure(error) {
  if (error.code === 'ETIMEDOUT') return 'timeout';
  if (['ENOTFOUND', 'EAI_AGAIN'].includes(error.code)) return 'dns';
  if (error.code === 'EPROXY') return 'proxy';
  if (/CERT|TLS|SSL|SELF_SIGNED/.test(error.code || '')) return 'tls';
  return 'connect';
}

class Router {
  constructor({ env = process.env, now = Date.now, network, directory, connector, bypassTarget, lookup = dns.lookup, tlsConnect = tls.connect } = {}) {
    this.config = discover(env); this.env = env; this.now = now; this.network = network;
    this.directory = directory || path.join(env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'cache/playwright-fast/routing');
    this.raceEnabled = env.PLAYWRIGHT_FAST_CONNECT_RACE === 'on';
    if (env.PLAYWRIGHT_FAST_CONNECT_RACE && !['on', 'off'].includes(env.PLAYWRIGHT_FAST_CONNECT_RACE)) throw new Error('PLAYWRIGHT_FAST_CONNECT_RACE must be on or off');
    this.metrics = []; this.selecting = new Map(); this.races = 0; this.raceWins = 0; this.activeRaces = 0;
    this.httpPools = new Map(); this.httpAgents = new Set(); this.idleTimers = new WeakMap();
    this.tlsConnect = tlsConnect;
    this.lookup = lookup;
    this.connector = connector; this.bypassTarget = bypassTarget;
    this.sockets = new Set(); this.controllers = new Set(); this.pins = new Map(); this.recentProbes = new Map();
    this.pending = []; this.activeProbes = 0; this.probeTasks = new Set(); this.closed = false; this.fallbacks = 0;
    this.budget = new ProbeBudget(this.directory, now);
    this.store = new Samples(this.directory, fingerprint(this.config, network), now);
    this.stores = new Set([this.store]);
    this.server = null; this.wsServer = null; this.resolvedPrivate = new Map(); this.lastNetworkCheck = 0;
  }
  proxy(target) { return this.config.proxies[target.secure ? 'https' : 'http']; }
  track(socket) { this.sockets.add(socket); socket.on('error', () => {}); socket.once('close', () => this.sockets.delete(socket)); return socket; }
  async start() {
    if (!this.config.enabled) return null;
    await this.refreshNetwork(true);
    this.server = http.createServer((req, res) => this.forward(req, res));
    this.server.on('connect', (req, socket, head) => this.tunnel(req, socket, head));
    this.server.on('upgrade', (req, socket, head) => this.forward(req, socket, head));
    this.server.on('connection', socket => this.track(socket));
    this.server.on('clientError', (_, socket) => socket.destroy());
    await new Promise((resolve, reject) => { this.server.once('error', reject); this.server.listen(0, '127.0.0.1', resolve); });
    // CONNECT has no application scheme. Chromium PAC chooses the plain-WS entry
    // before tunnelling; both entries share one policy, cache, and context pins.
    this.wsServer = http.createServer((req, res) => this.forward(req, res));
    this.wsServer.on('connect', (req, socket, head) => this.tunnel(req, socket, head, false));
    this.wsServer.on('upgrade', (req, socket, head) => this.forward(req, socket, head));
    this.wsServer.on('connection', socket => this.track(socket));
    this.wsServer.on('clientError', (_, socket) => socket.destroy());
    try {
      await new Promise((resolve, reject) => { this.wsServer.once('error', reject); this.wsServer.listen(0, '127.0.0.1', resolve); });
    } catch (error) { await this.close(); throw error; }
    return `http://127.0.0.1:${this.server.address().port}`;
  }
  browserArgs() {
    if (!this.config.enabled) return [];
    if (!this.server?.listening || !this.wsServer?.listening) throw new Error('Start routing before configuring Chromium');
    const pac = `function FindProxyForURL(url, host) { return url.substring(0, 3) === "ws:" ? "PROXY 127.0.0.1:${this.wsServer.address().port}" : "PROXY 127.0.0.1:${this.server.address().port}"; }`;
    return [`--proxy-pac-url=data:application/x-ns-proxy-autoconfig;base64,${Buffer.from(pac).toString('base64')}`];
  }
  async isBypassed(target) {
    if (this.bypassTarget) return this.bypassTarget(target);
    if (bypass(target, this.config.noProxy)) return true;
    // A locally resolvable intranet hostname must never be sent to the inherited proxy.
    const cached = this.resolvedPrivate.get(target.host);
    if (cached && cached.until > this.now()) return cached.value;
    const addresses = await new Promise(resolve => {
      // When local DNS is merely slow, stay direct for this connection rather than
      // risking an intranet hostname at an upstream proxy. Do not cache uncertainty.
      const timer = setTimeout(() => resolve(null), 250);
      this.lookup(target.host, { all: true }, (err, rows) => { clearTimeout(timer); resolve(err ? [] : rows); });
    });
    if (addresses === null) return true;
    const value = addresses.some(a => privateAddress(a.address));
    if (this.resolvedPrivate.size >= MAX_TARGETS) this.resolvedPrivate.delete(this.resolvedPrivate.keys().next().value);
    this.resolvedPrivate.set(target.host, { value, until: this.now() + INTERVAL });
    return value;
  }
  async connect(target, route, signal, stages = {}) {
    const began = performance.now();
    if (signal.aborted) throw signal.reason;
    if (this.connector) return this.connector(target, route, signal);
    const proxy = route === 'proxy' ? this.proxy(target) : null;
    const host = proxy ? cleanHost(proxy.hostname) : target.host;
    const port = proxy ? Number(proxy.port || (proxy.protocol === 'https:' ? 443 : 80)) : target.port;
    const socket = this.track(proxy?.protocol === 'https:' ? this.tlsConnect({ host, port, servername: net.isIP(host) ? undefined : host }) : net.connect({ host, port }));
    let resolvedAt = began;
    if (net.isIP(host)) stages.dnsMs = 0;
    socket.once('lookup', () => { resolvedAt = performance.now(); stages.dnsMs = resolvedAt - began; });
    let connectedAt;
    socket.once('connect', () => { connectedAt = performance.now(); stages.tcpMs = connectedAt - resolvedAt; });
    socket.once('secureConnect', () => { if (connectedAt !== undefined) stages.proxyTlsMs = performance.now() - connectedAt; });
    const abort = () => socket.destroy(typeof signal.reason?.code === 'string' ? signal.reason : Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' }));
    signal.addEventListener('abort', abort, { once: true });
    socket.once('close', () => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
    await new Promise((resolve, reject) => {
      const event = proxy?.protocol === 'https:' ? 'secureConnect' : 'connect';
      const ok = () => { socket.off('error', bad); resolve(); };
      const bad = error => { socket.off(event, ok); reject(error); };
      socket.once(event, ok); socket.once('error', bad);
    });
    const tunnelStarted = performance.now();
    if (proxy) await new Promise((resolve, reject) => {
      let buffer = Buffer.alloc(0);
      const cleanup = () => { socket.off('data', data); socket.off('error', bad); socket.off('end', ended); };
      const bad = error => { cleanup(); socket.destroy(); reject(error); };
      const ended = () => bad(Object.assign(new Error('Proxy closed tunnel'), { code: 'EPROXY' }));
      const data = chunk => {
        buffer = Buffer.concat([buffer, chunk]);
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0 && buffer.length <= 16384) return;
        if (end < 0 || !/^HTTP\/1\.[01] 200(?: |\r)/.test(buffer.subarray(0, end).toString())) return bad(Object.assign(new Error('Proxy rejected tunnel'), { code: 'EPROXY' }));
        cleanup(); socket.pause(); if (buffer.length > end + 4) socket.unshift(buffer.subarray(end + 4)); resolve();
      };
      socket.on('data', data); socket.once('error', bad); socket.once('end', ended);
      const auth = proxy.username || proxy.password ? `Proxy-Authorization: Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}\r\n` : '';
      socket.write(`CONNECT ${authority(target)} HTTP/1.1\r\nHost: ${authority(target)}\r\n${auth}\r\n`);
    });
    if (proxy) stages.proxyConnectMs = performance.now() - tunnelStarted;
    return socket;
  }
  recordMetric(row) {
    this.metrics.push({ at: this.now(), ...row });
    if (this.metrics.length > 500) this.metrics.shift();
  }
  metricSummary() {
    const rows = this.metrics.filter(row => row.at > this.now() - WINDOW);
    const summary = {};
    for (const kind of ['connection', 'probe', 'policy', 'navigation']) {
      const group = rows.filter(row => row.kind === kind);
      if (!group.length) continue;
      const stages = {};
      for (const field of ['totalMs', 'dnsMs', 'tcpMs', 'proxyTlsMs', 'proxyConnectMs', 'targetTlsMs', 'policyMs', 'navigationMs']) {
        const values = group.filter(row => row.outcome !== 'cancelled').map(row => row[field]).filter(Number.isFinite).sort((a, b) => a - b);
        if (values.length) stages[field] = { count: values.length, p50: +values[Math.ceil(values.length * .5) - 1].toFixed(3), p95: +values[Math.ceil(values.length * .95) - 1].toFixed(3) };
      }
      summary[kind] = { count: group.length, failures: group.filter(row => row.outcome === 'failed').length, cancelled: group.filter(row => row.outcome === 'cancelled').length, stages };
    }
    return summary;
  }
  async dial(target, route, probe = false, externalSignal) {
    const controller = new AbortController(); this.controllers.add(controller);
    const cancel = () => controller.abort(externalSignal.reason);
    if (externalSignal) { externalSignal.addEventListener('abort', cancel, { once: true }); if (externalSignal.aborted) cancel(); }
    const stages = {}; let outcome = 'ok', failureCategory = null;
    const store = this.store;
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('Connection timed out'), { code: 'ETIMEDOUT' })), probe ? TIMEOUT : CONNECT_TIMEOUT); const started = performance.now(); let socket;
    try {
      socket = await this.connect(target, route, controller.signal, stages);
      if (controller.signal.aborted) throw controller.signal.reason;
      if (probe && target.secure) {
        const tlsStarted = performance.now();
        socket = this.track(this.tlsConnect({ socket, servername: net.isIP(target.host) ? undefined : target.host, host: target.host }));
        const abort = () => socket.destroy(Object.assign(new Error('TLS probe timed out'), { code: 'ETIMEDOUT' }));
        controller.signal.addEventListener('abort', abort, { once: true });
        await new Promise((resolve, reject) => { socket.once('secureConnect', resolve); socket.once('error', reject); socket.resume(); });
        controller.signal.removeEventListener('abort', abort);
        stages.targetTlsMs = performance.now() - tlsStarted;
      }
      if (probe && !this.closed) store.add({ target: keyOf(target), route, kind: 'probe', ms: performance.now() - started, ok: true, failure: null });
      else if (!this.closed && store.samples.some(s => s.target === keyOf(target) && s.route === route && !s.ok && s.at > this.now() - 30_000))
        store.add({ target: keyOf(target), route, kind: 'connection', ms: performance.now() - started, ok: true, failure: null });
      return socket;
    } catch (error) {
      outcome = error.code === 'ECANCELED' || this.closed ? 'cancelled' : 'failed';
      if (outcome === 'failed') failureCategory = failure(error);
      if (!this.closed && outcome !== 'cancelled') store.add({ target: keyOf(target), route, kind: probe ? 'probe' : 'connection', ms: performance.now() - started, ok: false, failure: failure(error) });
      socket?.destroy(); throw error;
    } finally {
      this.recordMetric({ kind: probe ? 'probe' : 'connection', target: keyOf(target), route, outcome, failure: failureCategory, totalMs: performance.now() - started, ...stages });
      externalSignal?.removeEventListener('abort', cancel);
      clearTimeout(timer); this.controllers.delete(controller); if (probe) socket?.destroy();
    }
  }
  schedule(target) {
    for (const route of ['direct', 'proxy']) {
      const id = `${keyOf(target)}|${route}`;
      let last = this.recentProbes.get(id);
      if (last === undefined) {
        last = Math.max(0, ...this.store.samples.filter(s => s.target === keyOf(target) && s.route === route && s.kind === 'probe').map(s => s.at));
        if (this.recentProbes.size >= MAX_TARGETS * 2) this.recentProbes.delete(this.recentProbes.keys().next().value);
        this.recentProbes.set(id, last);
      }
      if (this.now() - last < INTERVAL || this.store.suspended(keyOf(target), route)) continue;
      if (this.pending.length >= 32) continue;
      if (this.recentProbes.size >= MAX_TARGETS * 2) this.recentProbes.delete(this.recentProbes.keys().next().value);
      this.recentProbes.set(id, this.now()); this.pending.push({ target, route, queuedAt: this.now() });
    }
    this.pump();
  }
  pump() {
    while (!this.closed && this.activeProbes < 2 && this.pending.length) {
      const { target, route, queuedAt } = this.pending.shift();
      if (this.now() - queuedAt > 30_000) continue;
      this.activeProbes++;
      const task = (async () => {
        const lease = await this.budget.acquire(hash([this.store.fingerprint, keyOf(target), route]));
        if (!lease) return;
        try { if (!this.closed) await this.dial(target, route, true); }
        finally { await this.budget.release(lease); }
      })().catch(() => {}).finally(() => { this.activeProbes--; this.probeTasks.delete(task); this.pump(); });
      this.probeTasks.add(task);
    }
  }
  async race(target, selected) {
    this.activeRaces++;
    try { return await new Promise((resolve, reject) => {
      const controllers = [new AbortController(), new AbortController()];
      const routes = [selected, selected === 'direct' ? 'proxy' : 'direct'];
      let done = false, secondary = false, failures = 0;
      const cancelled = () => Object.assign(new Error('Unused competing connection'), { code: 'ECANCELED' });
      const start = index => {
        if (index === 1) { if (secondary || done) return; secondary = true; this.races++; }
        this.dial(target, routes[index], false, controllers[index].signal).then(socket => {
          if (done || this.closed) { socket.destroy(); if (!done) { done = true; clearTimeout(timer); reject(cancelled()); } return; }
          done = true; clearTimeout(timer); controllers[1 - index].abort(cancelled());
          if (index === 1) this.raceWins++;
          resolve({ socket, route: routes[index] });
        }, error => {
          if (done) return;
          if (this.closed) { done = true; clearTimeout(timer); controllers[1 - index].abort(cancelled()); reject(error); return; }
          failures++;
          if (index === 0) start(1);
          if (failures === 2) { done = true; clearTimeout(timer); reject(error); }
        });
      };
      const timer = setTimeout(() => start(1), RACE_DELAY);
      start(0);
    }); } finally { this.activeRaces--; }
  }
  async open(target) {
    const policyStarted = performance.now();
    const skip = !this.config.enabled || !this.proxy(target) || await this.isBypassed(target);
    if (skip) { this.recordMetric({ kind: 'policy', policyMs: performance.now() - policyStarted }); return this.dial(target, 'direct'); }
    const key = keyOf(target);
    if (this.selecting.has(key)) await this.selecting.get(key).catch(() => {});
    const first = !this.pins.has(key);
    if (!this.pins.has(key)) {
      if (this.pins.size >= MAX_TARGETS) return this.dial(target, 'direct');
      const route = this.store.choose(key);
      this.pins.set(key, route);
      this.store.add({ target: key, route, kind: 'selection', ms: 0, ok: true, failure: null });
    }
    let selected = this.pins.get(key);
    const alternate = selected === 'direct' ? 'proxy' : 'direct';
    if (this.store.suspended(key, selected) && !this.store.suspended(key, alternate)) { selected = alternate; this.pins.set(key, alternate); }
    // Probes run asynchronously; they never gate the business connection.
    this.schedule(target);
    this.recordMetric({ kind: 'policy', policyMs: performance.now() - policyStarted });
    // Compete only on the first connection of an origin in this context. Concurrent
    // opens wait for its selection, then create their own socket on the pinned route.
    if (first && this.raceEnabled && this.activeRaces < 2) {
      const selection = this.race(target, selected).then(({ socket, route }) => {
        this.pins.set(key, route);
        this.store.add({ target: key, route, kind: 'selection', ms: 0, ok: true, failure: null });
        return socket;
      }).finally(() => this.selecting.delete(key));
      this.selecting.set(key, selection);
      return selection;
    }
    try { return await this.dial(target, selected); }
    catch (error) {
      if (this.closed) throw error;
      const other = selected === 'direct' ? 'proxy' : 'direct';
      const socket = await this.dial(target, other);
      this.pins.set(key, other); this.fallbacks++;
      this.store.add({ target: key, route: other, kind: 'selection', ms: 0, ok: true, failure: null });
      return socket;
    }
  }
  target(url) {
    if (!['http:', 'ws:'].includes(url.protocol) || url.username || url.password) throw new Error('Unsupported forwarding URL');
    return { host: cleanHost(url.hostname), port: Number(url.port || 80), secure: false };
  }
  httpAgent(target) {
    const targetKey = keyOf(target), route = this.pins.get(targetKey) || 'direct';
    const poolKey = `${targetKey}|${route}`;
    if (this.httpPools.has(poolKey)) return { agent: this.httpPools.get(poolKey), pooled: true };
    const pooled = this.httpPools.size < 128;
    const agent = new http.Agent({ keepAlive: pooled, maxSockets: 6, maxFreeSockets: 6 });
    this.httpAgents.add(agent);
    if (pooled) this.httpPools.set(poolKey, agent);
    const clearIdle = socket => { clearTimeout(this.idleTimers.get(socket)); this.idleTimers.delete(socket); };
    const socketRoutes = new WeakMap();
    agent.reuseSocket = (socket, request) => { clearIdle(socket); http.Agent.prototype.reuseSocket.call(agent, socket, request); };
    agent.keepSocketAlive = socket => {
      if (agent.retired || socketRoutes.get(socket) !== route || (this.pins.get(targetKey) || 'direct') !== route) return false;
      return http.Agent.prototype.keepSocketAlive.call(agent, socket);
    };
    agent.createConnection = (_options, callback) => {
      this.open(target).then(socket => {
        const connectedRoute = this.pins.get(targetKey) || 'direct';
        socketRoutes.set(socket, connectedRoute);
        // Retire a pool whose initial dial changed route. Already queued requests can
        // finish; new requests select a correctly labelled pool. Let Agent's own
        // keepSocketAlive hook retire idle sockets, never destroy during its free event.
        if (connectedRoute !== route) {
          agent.retired = true;
          if (this.httpPools.get(poolKey) === agent) this.httpPools.delete(poolKey);
          for (const idle of Object.values(agent.freeSockets).flat()) idle.destroy();
        }
        socket.once('close', () => {
          clearIdle(socket);
          if (agent.retired) setImmediate(() => {
            if (!Object.values(agent.sockets).flat().length && !Object.values(agent.requests).flat().length) this.httpAgents.delete(agent);
          });
        });
        callback(null, socket);
        socket.resume();
      }, callback);
    };
    agent.on('free', (socket, options) => {
      if (!agent.freeSockets[agent.getName(options)]?.includes(socket)) return;
      clearIdle(socket);
      const timer = setTimeout(() => socket.destroy(), 30_000); timer.unref(); this.idleTimers.set(socket, timer);
    });
    return { agent, pooled };
  }
  async tunnel(req, client, head, secure = true) {
    let upstream;
    try {
      const url = new URL(`${secure ? 'https' : 'http'}://${req.url}`);
      if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Invalid CONNECT target');
      upstream = await this.open({ host: cleanHost(url.hostname), port: Number(url.port || (secure ? 443 : 80)), secure });
      if (client.destroyed || this.closed) return upstream.destroy();
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      upstream.pipe(client); client.pipe(upstream); upstream.resume();
      client.once('close', () => upstream.destroy()); upstream.once('close', () => client.destroy());
    } catch { if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); upstream?.destroy(); }
  }
  async forward(req, response, head) {
    let upstream;
    req.pause();
    try {
      const url = new URL(req.url); const target = this.target(url);
      if (response.destroyed || this.closed) return;
      const headers = { ...req.headers, host: url.host };
      delete headers['proxy-authorization']; delete headers['proxy-connection'];
      if (head !== undefined) {
        upstream = await this.open(target);
        if (response.destroyed || this.closed) return upstream.destroy();
        const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
        upstream.write(`${req.method} ${url.pathname}${url.search} HTTP/1.1\r\n${lines}\r\n\r\n`);
        if (head.length) upstream.write(head);
        upstream.pipe(response); response.pipe(upstream); upstream.resume();
        response.once('close', () => upstream.destroy()); upstream.once('close', () => response.destroy());
      } else {
        for (const h of String(headers.connection || '').split(',')) delete headers[h.trim().toLowerCase()];
        delete headers.connection; delete headers['keep-alive'];
        const { agent, pooled } = this.httpAgent(target);
        const outgoing = http.request({ hostname: target.host, port: target.port, path: `${url.pathname}${url.search}`, method: req.method, headers, agent }, incoming => {
          response.writeHead(incoming.statusCode, incoming.headers); incoming.pipe(response);
          incoming.on('error', () => response.destroy());
        });
        outgoing.on('error', () => { if (!response.headersSent) response.writeHead(502); response.end(); });
        response.once('close', () => {
          if (!response.writableFinished) outgoing.destroy();
          if (!pooled) { agent.destroy(); this.httpAgents.delete(agent); }
        });
        req.once('aborted', () => outgoing.destroy()); req.pipe(outgoing); req.resume();
      }
    } catch { if (!response.destroyed) { if (head !== undefined) response.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); else { response.writeHead(502); response.end(); } } upstream?.destroy(); }
  }
  noteBrowserRequest(request) {
    try {
      const url = new URL(request.url());
      if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return;
      const secure = ['https:', 'wss:'].includes(url.protocol);
      const target = { host: cleanHost(url.hostname), port: Number(url.port || (secure ? 443 : 80)), secure };
      // A reused HTTP/2 connection still generates request events: exploration must not
      // depend on a new TCP connection, nor switch the route of an existing connection.
      if (this.pins.has(keyOf(target)) && !this.closed) {
        this.isBypassed(target).then(skip => { if (!skip && !this.closed) this.schedule(target); }).catch(() => {});
      }
    } catch {}
  }
  noteBrowserFailure(request) {
    const error = request.failure()?.errorText || '';
    if (/ERR_(CONNECTION|PROXY|TUNNEL|TIMED_OUT|NAME_NOT_RESOLVED|SSL_PROTOCOL)/.test(error)) this.noteBrowserRequest(request);
  }

  status() {
    return { mode: this.config.reason, warnings: [...this.config.warnings, ...(this.store.warning ? [this.store.warning] : [])],
      race: { enabled: this.raceEnabled && this.config.enabled, delayMs: RACE_DELAY, started: this.races, alternateWins: this.raceWins, active: this.activeRaces },
      timings: this.metricSummary(), recentConnections: this.metrics.filter(row => row.kind === 'connection' && row.at > this.now() - WINDOW).slice(-8),
      browserRouting: this.config.enabled ? 'pac-with-plain-websocket-entry' : 'unchanged',
      httpPools: { count: this.httpPools.size, idleSockets: [...this.httpPools.values()].reduce((n, agent) => n + Object.values(agent.freeSockets).flat().length, 0) },
      active: Boolean(this.server?.listening), pinnedTargets: this.pins.size, cachedTargets: new Set(this.store.samples.map(s => s.target)).size,
      activeProbes: this.activeProbes, fallbackConnections: this.fallbacks,
      recentRoutes: [...this.pins.entries()].slice(-8).map(([target, route]) => ({ target, route, direct: this.store.stats(target, 'direct'), proxy: this.store.stats(target, 'proxy') })),
      choices: Object.fromEntries(['direct', 'proxy'].map(route => [route, [...this.pins.values()].filter(v => v === route).length])) };
  }
  async close() {
    this.closed = true; this.pending = [];
    for (const agent of this.httpAgents) agent.destroy();
    this.httpAgents.clear(); this.httpPools.clear();
    for (const controller of this.controllers) controller.abort();
    for (const socket of this.sockets) socket.destroy();
    await Promise.all([this.server, this.wsServer].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
    await Promise.allSettled([...this.probeTasks]); await Promise.all([...this.stores].map(store => store.writes));
  }
  async refreshNetwork(force = false) {
    if (!this.config.enabled || (!force && this.now() - this.lastNetworkCheck < 60_000)) return;
    this.lastNetworkCheck = this.now();
    let epoch = ''; try { epoch = await fs.readFile(path.join(this.directory, 'epoch'), 'utf8'); } catch {}
    const id = hash([fingerprint(this.config, this.network), epoch]);
    if (!force && this.store.fingerprint === id) return;
    await this.store.writes;
    this.store = new Samples(this.directory, id, this.now);
    this.stores.add(this.store);
    await this.store.load();
    this.pending = []; this.recentProbes.clear(); this.resolvedPrivate.clear();
  }
  async clear() {
    await this.store.writes;
    // An epoch excludes records that another live process may write after this reset.
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    const file = path.join(this.directory, 'epoch'); const tmp = `${file}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tmp, crypto.randomUUID(), { mode: 0o600 }); await fs.rename(tmp, file);
    await this.refreshNetwork(true);
    this.pins.clear();
  }
}
module.exports = { Router, Samples, ProbeBudget, discover, bypass, privateAddress, fingerprint, keyOf, TIMEOUT };
