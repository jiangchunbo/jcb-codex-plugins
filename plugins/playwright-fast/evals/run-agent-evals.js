#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const crypto = require("node:crypto");
const path = require("node:path");
const { spawn } = require("node:child_process");
const { createFixtureServer } = require("./fixture-server");
const { scoreRun, writeReport } = require("./score-agent-evals");

const evalDir = __dirname;
const pluginDir = path.resolve(evalDir, "..");
const cases = require("./cases.json");
const defaultModels = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
const adminProject = "/home/jcb/projects-tq/web-zwpg-2c-admin";
const uniProject = "/home/jcb/projects-tq/web-zwpg-2c";

function parseArgs(argv) {
  const options = {
    mode: "smoke",
    models: defaultModels,
    concurrency: 1,
    serviceTier: "default",
    timeoutMs: 180_000,
    includeReal: true,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--mode") options.mode = argv[++index];
    else if (arg === "--models") options.models = argv[++index].split(",").filter(Boolean);
    else if (arg === "--case") options.caseId = argv[++index];
    else if (arg === "--concurrency") options.concurrency = Number(argv[++index]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--service-tier") options.serviceTier = argv[++index];
    else if (arg === "--inline-skill") options.inlineSkill = true;
    else if (arg === "--skip-real") options.includeReal = false;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--results") options.resultsDir = path.resolve(argv[++index]);
    else if (arg === "--help") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!["smoke", "first-pass", "layered", "full"].includes(options.mode)) {
    throw new Error(`Unsupported mode: ${options.mode}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 6) {
    throw new Error("--concurrency must be an integer from 1 to 6");
  }
  if (!["default", "priority"].includes(options.serviceTier)) throw new Error("Unsupported service tier");
  return options;
}

function usage() {
  return `Usage: node evals/run-agent-evals.js [options]

  --mode smoke|first-pass|layered|full  Default: smoke
  --models model[@effort],...           Effort defaults to medium
  --case case-id,case-id                Run selected cases
  --concurrency 1..6                    Default: 1
  --timeout-ms milliseconds             Default: 180000
  --service-tier default|priority       Requested processing tier (default: default)
  --inline-skill                        Include source skill explicitly for reproducible skill evals
  --skip-real                           Exclude the two real-project cases
  --results absolute-or-relative-path   Override output directory
  --dry-run                             Print the schedule without invoking Codex

Modes:
  smoke       Three representative fixture cases per model (9 runs)
  first-pass  Every selected case once per model (up to 48 runs)
  layered     First pass plus two extra core repetitions and failed-case reruns (cap 90)
  full        Every selected case three times per model (up to 144 runs)`;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function httpReady(url, timeoutMs = 1000) {
  return new Promise((resolve) => {
    const request = http.get(url, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(response.statusCode < 500);
    });
    request.on("timeout", () => { request.destroy(); resolve(false); });
    request.on("error", () => resolve(false));
  });
}

async function waitForHttp(url, child, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await httpReady(url)) return;
    if (child?.exitCode !== null) throw new Error(`Dev server exited before becoming ready: ${url}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function ensureDevServer({ origin, cwd, command, args }) {
  if (await httpReady(origin)) return { origin, child: null, reused: true };
  const child = spawn(command, args, {
    cwd,
    env: { ...process.env, BROWSER: "none" },
    detached: process.platform !== "win32",
    stdio: "ignore",
  });
  try {
    await waitForHttp(origin, child);
    return { origin, child, reused: false };
  } catch (error) {
    await stopChild(child);
    throw error;
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null) return;
  const signal = (name) => {
    try {
      if (process.platform !== "win32") process.kill(-child.pid, name);
      else child.kill(name);
    } catch {}
  };
  signal("SIGTERM");
  await Promise.race([
    new Promise((resolve) => child.once("close", resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  if (child.exitCode === null) signal("SIGKILL");
}

function replaceTokens(value, tokens) {
  return Object.entries(tokens).reduce((text, [key, replacement]) => text.replaceAll(`\${${key}}`, replacement), value);
}

function buildPrompt(testCase, tokens, inlineSkill = false) {
  const task = replaceTokens(testCase.prompt, tokens);
  return [
    "使用 $playwright 完成下面的浏览器任务。",
    "只通过 Playwright Fast 提供的浏览器工具操作和验证页面，不读取项目源码，不使用 shell、其他浏览器工具或外部网络搜索。",
    "不要把截图另存为工作区文件；视觉任务使用工具返回的内嵌截图证据。",
    "不要使用真实账号或真实业务数据。完成后简短报告实际观察，不要把任务原文当成结果。",
    "最终返回符合给定 JSON Schema 的对象：completed 表示浏览器检查任务是否执行完成（即使确认目标不存在也应为 true），answer 是答案，evidence 是实际观察依据。",
    "",
    task,
    ...(inlineSkill ? ["", "以下为本轮使用的 Playwright Fast 技能全文：", typeof inlineSkill === "string" ? inlineSkill : fs.readFileSync(path.join(pluginDir, "skills/playwright/SKILL.md"), "utf8")] : []),
  ].join("\n");
}

function createSchedule(selectedCases, models, mode) {
  const schedule = [];
  const addRound = (roundCases, repeat) => {
    for (const testCase of roundCases) {
      for (const model of models) schedule.push({ model, testCase, repeat });
    }
  };
  if (mode === "smoke") {
    const smokeIds = new Set(["basic-form", "element-control", "targeted-diagnostic"]);
    addRound(selectedCases.filter((entry) => smokeIds.has(entry.id)), 1);
    return schedule;
  }
  addRound(selectedCases, 1);
  if (mode === "layered") {
    const core = selectedCases.filter((entry) => entry.core);
    addRound(core, 2);
    addRound(core, 3);
  } else if (mode === "full") {
    addRound(selectedCases, 2);
    addRound(selectedCases, 3);
  }
  return schedule;
}

function parseJsonLines(stdout) {
  const events = [];
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try { events.push(JSON.parse(line)); } catch {}
  }
  return events;
}

function runCodex({ model, prompt, timeoutMs, ephemeral = true, serviceTier = "default" }) {
  return new Promise((resolve) => {
    const [modelSlug, effort = "medium"] = model.split("@");
    const sourceMcp = `mcp_servers.playwright-fast={command="bash",args=["./scripts/start.sh"],cwd=${JSON.stringify(pluginDir)},env={PLAYWRIGHT_FAST_TTL_MS="1800000"},startup_timeout_sec=5,tool_timeout_sec=60,enabled_tools=["run","reset","status"]}`;
    const args = [
      "exec", ...(ephemeral ? ["--ephemeral"] : []), "--json", "--color", "never",
      "--model", modelSlug,
      "--config", `model_reasoning_effort="${effort}"`,
      "--config", `service_tier="${serviceTier}"`,
      "--sandbox", "danger-full-access",
      "--config", "approval_policy=\"never\"",
      "--cd", pluginDir,
      "--output-schema", path.join(evalDir, "answer.schema.json"),
      "--config", "mcp_servers.idea.enabled=false",
      "--config", "mcp_servers.lanhu.enabled=false",
      "--config", sourceMcp,
      prompt,
    ];
    const startedAt = Date.now();
    const child = spawn("codex", args, { cwd: pluginDir, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    let stdout = "";
    let pending = "";
    const timedEvents = [];
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.exitCode === null && child.kill("SIGKILL"), 3000).unref();
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      pending += chunk;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) {
        try { timedEvents.push({ ...JSON.parse(line), observedAtMs: Date.now() - startedAt }); } catch {}
      }
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ exitCode: null, timedOut, elapsedMs: Date.now() - startedAt, stdout, stderr: `${stderr}\n${error.message}`, events: [] });
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      if (pending.trim()) {
        try { timedEvents.push({ ...JSON.parse(pending), observedAtMs: Date.now() - startedAt }); } catch {}
      }
      resolve({ serviceTier, exitCode, timedOut, elapsedMs: Date.now() - startedAt, stdout, stderr, events: timedEvents });
    });
  });
}

async function readOracle(origin, runId) {
  await new Promise((resolve) => setTimeout(resolve, 100));
  return new Promise((resolve) => {
    http.get(`${origin}/__oracle/${encodeURIComponent(runId)}`, (response) => {
      let raw = "";
      response.on("data", (chunk) => { raw += chunk; });
      response.on("end", () => {
        try { resolve(JSON.parse(raw)); } catch { resolve({}); }
      });
    }).on("error", () => resolve({}));
  });
}

async function runPool(items, concurrency, worker) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }

  let selectedCases = cases.filter((entry) => options.includeReal || entry.group !== "real");
  if (options.caseId) selectedCases = selectedCases.filter((entry) => options.caseId.split(",").includes(entry.id));
  if (selectedCases.length === 0) throw new Error("No evaluation cases selected");
  const schedule = createSchedule(selectedCases, options.models, options.mode);
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(schedule.map(({ model, testCase, repeat }) => ({ model, caseId: testCase.id, repeat })), null, 2)}\n`);
    return;
  }

  const resultsDir = options.resultsDir || path.join(evalDir, "results", timestamp());
  fs.mkdirSync(resultsDir, { recursive: true });
  const skillText = fs.readFileSync(path.join(pluginDir, "skills/playwright/SKILL.md"), "utf8");
  fs.writeFileSync(path.join(resultsDir, "manifest.json"), JSON.stringify({
    startedAt: new Date().toISOString(), options, requestedServiceTier: options.serviceTier,
    runtime: JSON.parse(fs.readFileSync(path.join(pluginDir, "runtime.json"), "utf8")),
    skillDelivery: options.inlineSkill ? "inline source" : "implicit installed skill reference; loading unverified",
    sourceSkillSha256: crypto.createHash("sha256").update(skillText).digest("hex"),
  }, null, 2));
  if (options.inlineSkill) fs.writeFileSync(path.join(resultsDir, "skill.md"), skillText);
  const fixture = createFixtureServer();
  const fixtureOrigin = await fixture.start();
  const startedServers = [];
  let adminOrigin = "http://127.0.0.1:5174";
  let uniOrigin = "http://127.0.0.1:8081";
  try {
    if (selectedCases.some((entry) => entry.id === "real-admin")) {
      const admin = await ensureDevServer({
        origin: adminOrigin,
        cwd: adminProject,
        command: "npm",
        args: ["run", "dev", "--", "--host", "127.0.0.1", "--port", "5174", "--strictPort"],
      });
      if (admin.child) startedServers.push(admin.child);
    }
    if (selectedCases.some((entry) => entry.id === "real-uni")) {
      const uni = await ensureDevServer({
        origin: uniOrigin,
        cwd: uniProject,
        command: "npm",
        args: ["run", "dev:h5", "--", "--host", "127.0.0.1", "--port", "8081", "--strictPort"],
      });
      if (uni.child) startedServers.push(uni.child);
    }

    process.stdout.write(`Running ${schedule.length} evaluations with concurrency ${options.concurrency}. Results: ${resultsDir}\n`);
    const firstResults = await runPool(schedule, options.concurrency, async ({ model, testCase, repeat }, index) => {
      const runId = `${testCase.id}-${model.replace(/[^a-z0-9]+/gi, "-")}-${repeat}-${Date.now()}-${index}`;
      const prompt = buildPrompt(testCase, {
        FIXTURE_URL: fixtureOrigin,
        ADMIN_URL: adminOrigin,
        UNI_URL: uniOrigin,
        RUN_ID: runId,
        UPLOAD_PATH: path.join(pluginDir, "runtime.json"),
      }, options.inlineSkill ? skillText : false);
      const execution = await runCodex({ model, prompt, timeoutMs: options.timeoutMs, serviceTier: options.serviceTier });
      const oracle = await readOracle(fixtureOrigin, runId);
      const record = scoreRun({ model, testCase, repeat, runId, prompt, oracle, execution });
      const filename = `${String(index + 1).padStart(3, "0")}-${testCase.id}-${model}-${repeat}.json`;
      fs.writeFileSync(path.join(resultsDir, filename), `${JSON.stringify(record, null, 2)}\n`);
      process.stdout.write(`${record.success ? "PASS" : "FAIL"} ${model} ${testCase.id} #${repeat} (${record.metrics.elapsedMs}ms)\n`);
      return record;
    });

    let allResults = firstResults;
    if (options.mode === "layered" && allResults.length < 90) {
      const failedKeys = new Set(allResults.filter((entry) => !entry.success).map((entry) => `${entry.model}\0${entry.caseId}`));
      const extra = [];
      for (const entry of allResults) {
        const key = `${entry.model}\0${entry.caseId}`;
        if (!failedKeys.has(key)) continue;
        const priorCount = allResults.filter((item) => `${item.model}\0${item.caseId}` === key).length;
        for (let repeat = priorCount + 1; repeat <= 3 && allResults.length + extra.length < 90; repeat += 1) {
          extra.push({ model: entry.model, testCase: cases.find((item) => item.id === entry.caseId), repeat });
        }
        failedKeys.delete(key);
      }
      if (extra.length > 0) {
        const offset = allResults.length;
        const extraResults = await runPool(extra, options.concurrency, async ({ model, testCase, repeat }, index) => {
          const runId = `${testCase.id}-${model.replace(/[^a-z0-9]+/gi, "-")}-${repeat}-${Date.now()}-${offset + index}`;
          const prompt = buildPrompt(testCase, {
            FIXTURE_URL: fixtureOrigin, ADMIN_URL: adminOrigin, UNI_URL: uniOrigin,
            RUN_ID: runId, UPLOAD_PATH: path.join(pluginDir, "runtime.json"),
          }, options.inlineSkill ? skillText : false);
          const execution = await runCodex({ model, prompt, timeoutMs: options.timeoutMs, serviceTier: options.serviceTier });
          const oracle = await readOracle(fixtureOrigin, runId);
          const record = scoreRun({ model, testCase, repeat, runId, prompt, oracle, execution });
          const filename = `${String(offset + index + 1).padStart(3, "0")}-${testCase.id}-${model}-${repeat}.json`;
          fs.writeFileSync(path.join(resultsDir, filename), `${JSON.stringify(record, null, 2)}\n`);
          process.stdout.write(`${record.success ? "PASS" : "FAIL"} ${model} ${testCase.id} #${repeat} (${record.metrics.elapsedMs}ms)\n`);
          return record;
        });
        allResults = allResults.concat(extraResults);
      }
    }
    writeReport(allResults, resultsDir);
  } finally {
    await Promise.all(startedServers.map((child) => stopChild(child)));
    await fixture.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { buildPrompt, createSchedule, parseArgs, parseJsonLines, runCodex };
