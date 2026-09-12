#!/usr/bin/env node
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const pluginDir = path.resolve(__dirname, "..");

function percentile(values, ratio) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * ratio) - 1];
}

function createClient() {
  const child = spawn("bash", ["scripts/start.sh"], { cwd: pluginDir, stdio: ["pipe", "pipe", "pipe"] });
  const messages = [];
  const waiters = [];
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  readline.createInterface({ input: child.stdout, crlfDelay: Infinity }).on("line", (line) => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    messages.push(message);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(message)) continue;
      clearTimeout(waiter.timer);
      waiters.splice(waiters.indexOf(waiter), 1);
      waiter.resolve(message);
    }
  });
  const waitFor = (predicate, timeoutMs = 15_000) => {
    const existing = messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve, reject) => {
      const waiter = { predicate, resolve, timer: null };
      waiter.timer = setTimeout(() => {
        waiters.splice(waiters.indexOf(waiter), 1);
        reject(new Error(`Timed out waiting for MCP response. ${stderr}`));
      }, timeoutMs);
      waiters.push(waiter);
    });
  };
  return {
    write(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
    waitFor,
    async close() {
      child.stdin.end();
      await new Promise((resolve) => child.exitCode !== null ? resolve() : child.once("exit", resolve));
    },
  };
}

async function main() {
  const iterationsArg = process.argv.find((arg) => arg.startsWith("--iterations="));
  const iterations = Number(iterationsArg?.split("=")[1] || 30);
  const enforce = process.argv.includes("--enforce");
  if (!Number.isInteger(iterations) || iterations < 5 || iterations > 500) throw new Error("iterations must be between 5 and 500");

  const evidence = process.argv.find(arg => arg.startsWith("--evidence="))?.split("=")[1] || "ultra";
  if (!["ultra", "health", "visual"].includes(evidence)) throw new Error("Unsupported evidence");
  const coldStarted = performance.now();
  const client = createClient();
  try {
    client.write({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
    await client.waitFor((message) => message.id === 1);
    client.write({
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "run", arguments: { id: "benchmark-warmup", steps: [{ op: "setContent", html: "<main>ready</main>" }] } },
    });
    await client.waitFor((message) => message.id === 2);

    const coldStartMs = performance.now() - coldStarted;
    const wallTimes = [];
    const runtimeTimes = [];
    for (let index = 0; index < iterations; index += 1) {
      const id = index + 3;
      const started = performance.now();
      client.write({
        jsonrpc: "2.0", id, method: "tools/call",
        params: {
          name: "run",
          arguments: {
            id: `benchmark-${index}`,
            evidence,
            steps: [{ op: "readText", target: { css: "main" }, as: "text" }],
            expect: [{ target: { css: "main" }, text: "ready" }],
          },
        },
      });
      const reply = await client.waitFor((message) => message.id === id);
      wallTimes.push(performance.now() - started);
      const result = JSON.parse(reply.result.content[0].text);
      if (!result.ok) throw new Error(JSON.stringify(result));
      runtimeTimes.push(result.elapsedMs);
    }
    const summary = {
      iterations,
      evidence,
      coldStartMs: Math.round(coldStartMs * 10) / 10,
      wallP50Ms: Math.round(percentile(wallTimes, 0.5) * 10) / 10,
      wallP95Ms: Math.round(percentile(wallTimes, 0.95) * 10) / 10,
      runtimeP50Ms: percentile(runtimeTimes, 0.5),
      runtimeP95Ms: percentile(runtimeTimes, 0.95),
      targets: { wallP50Ms: 100, wallP95Ms: 250 },
    };
    summary.passed = summary.wallP50Ms <= summary.targets.wallP50Ms && summary.wallP95Ms <= summary.targets.wallP95Ms;
    process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
    if (enforce && !summary.passed) process.exitCode = 1;
  } finally {
    await client.close();
  }
}

if (require.main === module) main().catch((error) => {
  process.stderr.write(`${error.stack || error.message}\n`);
  process.exitCode = 1;
});

module.exports = { createClient };
