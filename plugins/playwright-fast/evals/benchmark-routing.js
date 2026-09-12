#!/usr/bin/env node
// Explicit opt-in only: visit two public pages using the source MCP and inherited routing config.
const { createClient } = require('./benchmark-hot-run');
async function main() {
  if (!process.argv.includes('--live')) throw new Error('Use --live to visit example.com and www.wikipedia.org with inherited proxy settings.');
  const client = createClient(); let id = 1;
  const call = async (name, args = {}) => {
    const current = ++id;
    client.write({ jsonrpc: '2.0', id: current, method: 'tools/call', params: { name, arguments: args } });
    const reply = await client.waitFor(message => message.id === current, 20_000);
    return JSON.parse(reply.result.content[0].text);
  };
  try {
    client.write({ jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    await client.waitFor(message => message.id === id);
    const runs = [];
    for (const url of ['https://example.com', 'https://www.wikipedia.org']) {
      const started = performance.now();
      const result = await call('run', { url, evidence: 'ultra', steps: [{ op: 'evaluate', expression: 'document.title', as: 'title' }] });
      const observedWallMs = Math.round(performance.now() - started);
      let status = await call('status');
      const deadline = performance.now() + 3500;
      while (status.routing?.activeProbes && performance.now() < deadline) {
        await new Promise(resolve => setTimeout(resolve, 100)); status = await call('status');
      }
      runs.push({ url, ok: result.ok, title: result.outputs?.title, failureKind: result.failureKind,
        error: result.error?.split('\n')[0], browserElapsedMs: result.elapsedMs,
        observedWallMs, routing: status.routing });
    }
    console.log(JSON.stringify({ measuredAt: new Date().toISOString(), scope: 'Browser traffic only; no model API call. TLS probes are not page throughput.', runs }, null, 2));
  } finally { await client.close(); }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
