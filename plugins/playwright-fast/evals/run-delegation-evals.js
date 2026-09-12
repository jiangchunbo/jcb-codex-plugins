#!/usr/bin/env node
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { createFixtureServer } = require("./fixture-server");
const { runCodex } = require("./run-agent-evals");
const { extractToolCalls } = require("./score-agent-evals");

const evalDir = __dirname;
const pluginDir = path.resolve(evalDir, "..");
const sessionsDir = path.join(process.env.CODEX_HOME || path.join(process.env.HOME, ".codex"), "sessions");
const cases = require("./delegation-cases.json");
const runtime = require("../runtime.json");
const defaultModels = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];

function parseArgs(argv) {
  const options = { models: defaultModels, concurrency: 3, timeoutMs: 240_000 };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--models") options.models = argv[++index].split(",").filter(Boolean);
    else if (arg === "--case") options.caseId = argv[++index];
    else if (arg === "--concurrency") options.concurrency = Number(argv[++index]);
    else if (arg === "--timeout-ms") options.timeoutMs = Number(argv[++index]);
    else if (arg === "--results") options.resultsDir = path.resolve(argv[++index]);
    else if (arg === "--dry-run") options.dryRun = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(options.concurrency) || options.concurrency < 1 || options.concurrency > 6) {
    throw new Error("--concurrency must be an integer from 1 to 6");
  }
  return options;
}

function timestamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function replaceTokens(value, tokens) {
  return Object.entries(tokens).reduce((text, [key, replacement]) => text.replaceAll(`\${${key}}`, replacement), value);
}

function buildPrompt(task) {
  return [
    "使用 $playwright Skill 决定浏览器部分由当前 Agent 还是 Playwright 专用子代理执行。",
    "只读取任务明确列出的文件，不读取记忆文件，不访问外部网络，不修改任何源码。",
    "页面部分只能使用 Playwright Fast；使用假数据，不使用真实账号或真实业务数据。",
    "最终返回符合 JSON Schema 的对象：completed 表示两部分均完成，answer 汇总实际结果，evidence 说明实际证据。",
    "",
    task,
    "以下为本轮使用的 Playwright Fast 技能全文：",
    fs.readFileSync(path.join(pluginDir, "skills/playwright/SKILL.md"), "utf8"),
  ].join("\n");
}

function extractCompletedItems(events) {
  return events.filter((event) => event.type === "item.completed" && event.item).map((event) => event.item);
}

function extractFinal(events) {
  const messages = extractCompletedItems(events).filter((item) => item.type === "agent_message");
  const text = String(messages.at(-1)?.text || "");
  try { return { text, parsed: JSON.parse(text) }; } catch { return { text, parsed: null }; }
}

function extractDelegationCalls(events) {
  return extractCompletedItems(events).flatMap((item) => {
    const name = String(item.tool || item.name || "");
    if (name !== "spawn_agent" && !/(?:^|\.)spawn_agent$/.test(name)) return [];
    let args = item.arguments || item.args || {};
    if (typeof args === "string") {
      try { args = JSON.parse(args); } catch { args = {}; }
    }
    const message = String(args.message || item.prompt || "");
    return [{
      name,
      args: { ...args, message },
      receiverThreadIds: item.receiver_thread_ids || [],
      jsonlConfigObservable: args.model !== undefined || args.reasoning_effort !== undefined || args.fork_turns !== undefined,
    }];
  });
}

function findRolloutPath(threadId, root = sessionsDir) {
  if (!threadId || !fs.existsSync(root)) return null;
  const pending = [root];
  while (pending.length > 0) {
    const current = pending.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const candidate = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(candidate);
      else if (entry.isFile() && entry.name.endsWith(`-${threadId}.jsonl`)) return candidate;
    }
  }
  return null;
}

function readJsonLines(filename) {
  if (!filename) return [];
  return fs.readFileSync(filename, "utf8").split(/\r?\n/).filter(Boolean).flatMap((line) => {
    try { return [JSON.parse(line)]; } catch { return []; }
  });
}

function extractSpawnInputs(rolloutEvents) {
  return rolloutEvents.flatMap((event) => {
    const payload = event.type === "response_item" ? event.payload : null;
    if (!payload || !["custom_tool_call", "function_call"].includes(payload.type)) return [];
    const raw = String(payload.input || payload.arguments || "");
    if (!/(?:spawn_agent|multi_agent_v\d+__spawn_agent)\s*\(/.test(raw) && payload.name !== "spawn_agent") return [];
    let args = {};
    if (payload.name === "spawn_agent") {
      try { args = JSON.parse(raw); } catch {}
    }
    return [{
      raw,
      args,
      forkMode: args.fork_turns === "none" || args.fork_context === false || /fork_context\s*:\s*false/.test(raw),
    }];
  });
}

function extractRolloutDelegation(execution) {
  const threadId = execution.events.find((event) => event.type === "thread.started")?.thread_id;
  const rolloutPath = findRolloutPath(threadId);
  const rolloutEvents = readJsonLines(rolloutPath);
  const spawnInputs = extractSpawnInputs(rolloutEvents);
  const completedSpawns = rolloutEvents.filter((event) => {
    const item = event.type === "event_msg" && event.payload?.type === "item_completed" ? event.payload.item : null;
    return item?.type === "CollabAgentToolCall" && item.tool === "spawn_agent" && item.status === "completed";
  });
  const eventCalls = completedSpawns.map((event, index) => {
    const item = event.payload.item;
    const input = spawnInputs[index] || {};
    return {
      name: "spawn_agent",
      args: {
        ...input.args,
        message: item.prompt || input.args?.message || "",
        model: item.model || input.args?.model,
        reasoning_effort: item.reasoning_effort || input.args?.reasoning_effort,
      },
      receiverThreadIds: item.receiver_thread_ids || [],
      forkModePassed: Boolean(input.forkMode),
      jsonlConfigObservable: Boolean(item.model || item.reasoning_effort || input.args?.model),
    };
  });
  const functionCalls = rolloutEvents.filter((event) =>
    event.type === "response_item" && event.payload?.type === "function_call" &&
    event.payload?.name === "spawn_agent" && event.payload?.namespace === "collaboration",
  ).map((event) => {
    let args = {};
    try { args = JSON.parse(event.payload.arguments || "{}"); } catch {}
    const activity = rolloutEvents.find((candidate) => {
      const item = candidate.type === "event_msg" && candidate.payload?.type === "item_completed" ? candidate.payload.item : null;
      return item?.type === "SubAgentActivity" && item.kind === "started" && item.id === event.payload.call_id;
    });
    return {
      name: "spawn_agent",
      args,
      receiverThreadIds: activity?.payload?.item?.agent_thread_id ? [activity.payload.item.agent_thread_id] : [],
      forkModePassed: args.fork_turns === "none" || args.fork_context === false,
      jsonlConfigObservable: true,
    };
  });
  const calls = [...eventCalls, ...functionCalls];
  let nestedDelegations = 0;
  for (const call of calls) {
    for (const childThreadId of call.receiverThreadIds) {
      const childEvents = readJsonLines(findRolloutPath(childThreadId));
      const childText = JSON.stringify(childEvents);
      const childContext = childEvents.find((event) => event.type === "turn_context")?.payload || {};
      const childPlaywrightCalls = childEvents.filter((event) => {
        const item = event.type === "event_msg" && event.payload?.type === "item_completed" ? event.payload.item : null;
        return item?.type === "McpToolCall" && item.server === "playwright-fast";
      }).length;
      const childFileChanges = childEvents.filter((event) => {
        const item = event.type === "event_msg" && event.payload?.type === "item_completed" ? event.payload.item : null;
        return item?.type === "FileChange";
      }).length;
      call.childModel = childContext.model;
      call.childEffort = childContext.effort;
      call.childPlaywrightCalls = childPlaywrightCalls;
      call.assignmentObserved = childPlaywrightCalls > 0 && childFileChanges === 0 &&
        childText.includes(childThreadId) && childText.includes("陈伟") && childText.includes("已付款") && childText.includes("268.00");
      nestedDelegations += childEvents.filter((event) => {
        const item = event.type === "event_msg" && event.payload?.type === "item_completed" ? event.payload.item : null;
        return item?.type === "CollabAgentToolCall" && item.tool === "spawn_agent" && item.status === "completed";
      }).length + childEvents.filter((event) =>
        event.type === "response_item" && event.payload?.type === "function_call" &&
        event.payload?.name === "spawn_agent" && event.payload?.namespace === "collaboration",
      ).length;
    }
  }
  return { calls, nestedDelegations, rolloutPath };
}

function includesAll(text, values) {
  const normalized = String(text || "").toLowerCase();
  return values.every((value) => normalized.includes(String(value).toLowerCase()));
}

function oracleMatches(actual, expected) {
  return Object.entries(expected || {}).every(([key, value]) => JSON.stringify(actual?.[key]) === JSON.stringify(value));
}

function scoreDelegation({ model, testCase, runId, execution, oracle }) {
  const items = extractCompletedItems(execution.events);
  const toolCalls = extractToolCalls(items);
  const delegationCalls = execution.delegationTrace?.calls || extractDelegationCalls(execution.events);
  const playwrightCalls = toolCalls.filter((call) => call.isPlaywright);
  const final = extractFinal(execution.events);
  const expectedCount = testCase.expectedDelegation ? 1 : 0;
  const delegationCountPassed = delegationCalls.length === expectedCount &&
    (!testCase.expectedDelegation || delegationCalls[0].receiverThreadIds.length === 1);
  const call = delegationCalls[0];
  const delegationConfigPassed = !testCase.expectedDelegation || Boolean(
    call?.args?.model === "gpt-5.6-luna" &&
    call?.args?.reasoning_effort === "low" &&
    (call.forkModePassed || call.args.fork_turns === "none" || call.args.fork_context === false) &&
    (!call.childModel || call.childModel === "gpt-5.6-luna") &&
    (!call.childEffort || call.childEffort === "low"),
  );
  const assignment = String(call?.args?.message || "");
  const assignmentTextPassed = assignment.includes(runId) &&
    /https?:\/\/127\.0\.0\.1:\d+\/form/.test(assignment) &&
    /playwright fast/i.test(assignment) &&
    /陈伟/.test(assignment) && /已付款/.test(assignment) && /268\.00/.test(assignment) &&
    /evidence|证据|实际观察/i.test(assignment) &&
    /fake|fixture|假数据|测试数据|不要使用真实|不得使用真实/i.test(assignment) &&
    /not delegate|do not delegate|不得.*委派|不要.*委派/i.test(assignment) &&
    /not modify.*(?:business|source)|do not modify.*(?:business|source)|不修改.*(?:业务|源码)/i.test(assignment);
  const assignmentPassed = !testCase.expectedDelegation || assignmentTextPassed || Boolean(call?.assignmentObserved);
  const executionLanePassed = testCase.expectedDelegation
    ? playwrightCalls.length === 0 && (call?.childPlaywrightCalls === undefined || call.childPlaywrightCalls > 0)
    : playwrightCalls.length > 0;
  const finalText = final.parsed ? `${final.parsed.answer || ""}\n${final.parsed.evidence || ""}` : final.text;
  const finalPassed = Boolean(final.parsed?.completed) && includesAll(finalText, testCase.finalIncludes || []);
  const oraclePassed = oracleMatches(oracle, testCase.oracle);
  const success = execution.exitCode === 0 && !execution.timedOut && delegationCountPassed &&
    delegationConfigPassed && assignmentPassed && executionLanePassed && finalPassed && oraclePassed;
  return {
    model,
    caseId: testCase.id,
    title: testCase.title,
    runId,
    success,
    expectedDelegation: testCase.expectedDelegation,
    checks: { delegationCountPassed, delegationConfigPassed, assignmentPassed, executionLanePassed, finalPassed, oraclePassed },
    metrics: {
      elapsedMs: execution.elapsedMs,
      delegationCalls: delegationCalls.length,
      parentPlaywrightCalls: playwrightCalls.length,
      recursiveOrDuplicateDelegations: Math.max(0, delegationCalls.length - expectedCount) + Number(execution.delegationTrace?.nestedDelegations || 0),
      configObservableInJsonl: delegationCalls.some((entry) => entry.jsonlConfigObservable),
    },
    delegationCalls,
    final,
    oracle,
    execution: {
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      stderr: execution.stderr,
      events: execution.events,
      delegationTrace: execution.delegationTrace ? {
        rolloutPath: execution.delegationTrace.rolloutPath,
        nestedDelegations: execution.delegationTrace.nestedDelegations,
      } : null,
    },
  };
}

function percentage(count, total) {
  return total === 0 ? null : Math.round((count / total) * 1000) / 10;
}

function report(results) {
  const byModel = Object.fromEntries([...new Set(results.map((entry) => entry.model))].map((model) => {
    const entries = results.filter((entry) => entry.model === model);
    return [model, {
      runs: entries.length,
      successRate: percentage(entries.filter((entry) => entry.success).length, entries.length),
      decisionRate: percentage(entries.filter((entry) => entry.checks.delegationCountPassed).length, entries.length),
      executionLaneRate: percentage(entries.filter((entry) => entry.checks.executionLanePassed).length, entries.length),
      configRate: percentage(entries.filter((entry) => entry.checks.delegationConfigPassed).length, entries.length),
    }];
  }));
  const summary = {
    runs: results.length,
    successRate: percentage(results.filter((entry) => entry.success).length, results.length),
    decisionRate: percentage(results.filter((entry) => entry.checks.delegationCountPassed).length, results.length),
    executionLaneRate: percentage(results.filter((entry) => entry.checks.executionLanePassed).length, results.length),
    configRate: percentage(results.filter((entry) => entry.checks.delegationConfigPassed).length, results.length),
    assignmentRate: percentage(results.filter((entry) => entry.checks.assignmentPassed).length, results.length),
    browserSuccessRate: percentage(results.filter((entry) => entry.checks.oraclePassed).length, results.length),
    recursiveOrDuplicateDelegations: results.reduce((sum, entry) => sum + entry.metrics.recursiveOrDuplicateDelegations, 0),
  };
  return { summary, byModel };
}

function markdown(aggregate, results) {
  const rows = Object.entries(aggregate.byModel).map(([model, item]) =>
    `| ${model} | ${item.runs} | ${item.successRate}% | ${item.decisionRate}% | ${item.executionLaneRate}% | ${item.configRate}% |`,
  );
  const failures = results.filter((entry) => !entry.success);
  return `# Playwright Fast Delegation Evaluation\n\n` +
    `Generated: ${new Date().toISOString()}\n\n` +
    `- Runs: ${aggregate.summary.runs}\n` +
    `- Overall success: ${aggregate.summary.successRate}%\n` +
    `- Delegation decision accuracy: ${aggregate.summary.decisionRate}%\n` +
    `- Required execution-lane accuracy: ${aggregate.summary.executionLaneRate}%\n` +
    `- Luna/low configuration accuracy: ${aggregate.summary.configRate}%\n` +
    `- Self-contained assignment accuracy: ${aggregate.summary.assignmentRate}%\n` +
    `- Browser oracle success: ${aggregate.summary.browserSuccessRate}%\n` +
    `- Recursive or duplicate delegations: ${aggregate.summary.recursiveOrDuplicateDelegations}\n\n` +
    `| Parent model | Runs | Success | Decision | Execution lane | Configuration |\n` +
    `|---|---:|---:|---:|---:|---:|\n${rows.join("\n")}\n\n` +
    `## Failures\n\n` +
    (failures.length === 0 ? "None.\n" : failures.map((entry) => `- ${entry.model} / ${entry.caseId}: ${JSON.stringify(entry.checks)}`).join("\n") + "\n");
}

function readOracle(origin, runId) {
  return new Promise((resolve) => {
    setTimeout(() => {
      http.get(`${origin}/__oracle/${encodeURIComponent(runId)}`, (response) => {
        let raw = "";
        response.on("data", (chunk) => { raw += chunk; });
        response.on("end", () => {
          try { resolve(JSON.parse(raw)); } catch { resolve({}); }
        });
      }).on("error", () => resolve({}));
    }, 100);
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
  const selectedCases = options.caseId ? cases.filter((entry) => entry.id === options.caseId) : cases;
  if (selectedCases.length === 0) throw new Error("No delegation evaluation cases selected");
  const schedule = options.models.flatMap((model) => selectedCases.map((testCase) => ({ model, testCase })));
  if (options.dryRun) {
    process.stdout.write(`${JSON.stringify(schedule.map(({ model, testCase }) => ({ model, caseId: testCase.id })), null, 2)}\n`);
    return;
  }
  const resultsDir = options.resultsDir || path.join(evalDir, "results", `delegation-${timestamp()}`);
  fs.mkdirSync(resultsDir, { recursive: true });
  const fixture = createFixtureServer();
  const fixtureOrigin = await fixture.start();
  try {
    process.stdout.write(`Running ${schedule.length} delegation evaluations. Results: ${resultsDir}\n`);
    const results = await runPool(schedule, options.concurrency, async ({ model, testCase }, index) => {
      const runId = `${testCase.id}-${model.replace(/[^a-z0-9]+/gi, "-")}-${Date.now()}-${index}`;
      const prompt = buildPrompt(replaceTokens(testCase.prompt, {
        FIXTURE_URL: fixtureOrigin,
        RUN_ID: runId,
        RUNTIME_PATH: path.join(pluginDir, "runtime.json"),
        CHROMIUM_VERSION: runtime.chromiumVersion,
      }));
      const resolvedCase = { ...testCase, finalIncludes: (testCase.finalIncludes || []).map((item) => replaceTokens(item, { CHROMIUM_VERSION: runtime.chromiumVersion })) };
      const execution = await runCodex({ model, prompt, timeoutMs: options.timeoutMs, ephemeral: false });
      execution.delegationTrace = extractRolloutDelegation(execution);
      const oracle = await readOracle(fixtureOrigin, runId);
      const result = scoreDelegation({ model, testCase: resolvedCase, runId, execution, oracle });
      const filename = `${String(index + 1).padStart(3, "0")}-${testCase.id}-${model}.json`;
      fs.writeFileSync(path.join(resultsDir, filename), `${JSON.stringify(result, null, 2)}\n`);
      process.stdout.write(`${result.success ? "PASS" : "FAIL"} ${model} ${testCase.id} (${execution.elapsedMs}ms)\n`);
      return result;
    });
    const aggregate = report(results);
    fs.writeFileSync(path.join(resultsDir, "summary.json"), `${JSON.stringify(aggregate, null, 2)}\n`);
    fs.writeFileSync(path.join(resultsDir, "report.md"), markdown(aggregate, results));
    if (results.some((entry) => !entry.success)) process.exitCode = 1;
  } finally {
    await fixture.close();
  }
}

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error.stack || error.message}\n`);
    process.exitCode = 1;
  });
}

module.exports = { extractDelegationCalls, extractRolloutDelegation, parseArgs, report, scoreDelegation };
