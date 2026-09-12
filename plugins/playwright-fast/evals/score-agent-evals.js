#!/usr/bin/env node
const fs = require("node:fs");
const path = require("node:path");

function percentile(values, ratio) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(ratio * sorted.length) - 1];
}

function parseMaybeJson(value) {
  if (value === null || value === undefined) return value;
  if (typeof value !== "string") return value;
  try { return JSON.parse(value); } catch { return value; }
}

function findResult(value, depth = 0) {
  if (depth > 6 || value === null || value === undefined) return null;
  const parsed = parseMaybeJson(value);
  if (parsed !== value) return findResult(parsed, depth + 1);
  if (typeof parsed !== "object") return null;
  if (typeof parsed.ok === "boolean" && (parsed.failureKind || parsed.stepResults || parsed.outputs || parsed.elapsedMs !== undefined)) return parsed;
  if (Array.isArray(parsed)) {
    for (const item of parsed) {
      const found = findResult(item, depth + 1);
      if (found) return found;
    }
    return null;
  }
  for (const key of ["result", "output", "content", "text", "structuredContent", "item"]) {
    if (!(key in parsed)) continue;
    const found = findResult(parsed[key], depth + 1);
    if (found) return found;
  }
  return null;
}

function normalizeToolName(item) {
  return String(item.tool || item.name || item.tool_name || item.function || "");
}

function extractItems(events) {
  return events
    .filter((event) => event.type === "item.completed" && event.item)
    .map((event) => event.item);
}

function extractFinalAnswer(items) {
  const messages = items.filter((item) => item.type === "agent_message" && typeof item.text === "string");
  const text = messages.at(-1)?.text || "";
  const parsed = parseMaybeJson(text);
  return { text, parsed: typeof parsed === "object" && parsed !== null ? parsed : null };
}

function extractToolCalls(items) {
  const calls = [];
  for (const item of items) {
    const type = String(item.type || "");
    const name = normalizeToolName(item);
    const looksLikeTool = type.includes("tool") || type === "command_execution" || name.length > 0;
    if (!looksLikeTool) continue;
    const haystack = `${type} ${name} ${item.server || ""}`.toLowerCase();
    const isPlaywright = haystack.includes("playwright_fast") || haystack.includes("playwright-fast");
    const action = /(?:^|__)(run|reset|status)$/.exec(name)?.[1] || name.split(".").at(-1) || type;
    const args = parseMaybeJson(item.arguments ?? item.args ?? item.input ?? null);
    const result = findResult(item);
    const command = item.command || "";
    const allowedSkillRead = type === "command_execution" && /sed .*playwright-fast\/.+\/skills\/playwright\/SKILL\.md/.test(command);
    calls.push({ type, name, action, isPlaywright, allowedSkillRead, command, args, result, error: item.error || null, status: item.status || null });
  }
  return calls;
}

function includesAll(value, needles) {
  const text = String(value || "").toLowerCase();
  return needles.every((needle) => text.includes(String(needle).toLowerCase()));
}

function includesAnyGroup(value, groups) {
  const text = String(value || "").toLowerCase();
  return groups.every((group) => group.some((needle) => text.includes(String(needle).toLowerCase())));
}

function oracleMatches(actual, expected = {}) {
  return Object.entries(expected).every(([key, value]) => JSON.stringify(actual?.[key]) === JSON.stringify(value));
}

function classify(record) {
  if (record.execution.timedOut) return record.metrics.playwrightCalls > 0 ? "task-timeout" : "environment";
  if (record.execution.exitCode !== 0 || record.metrics.playwrightCalls === 0) return "environment";
  if (record.toolCalls.some((call) => /requires approval|tool.*unavailable|server.*unavailable/i.test(JSON.stringify(call.error || "")))) return "environment";
  if (record.metrics.unrelatedToolCalls > 0 || !record.metrics.firstRunContractValid) return "model-misuse";
  if (record.testCase.diagnostic && record.finalChecksPassed) return "expected-business-failure";
  const failureKinds = record.toolCalls.map((call) => call.result?.failureKind).filter(Boolean);
  if (failureKinds.includes("runtime")) {
    const runtimeErrors = record.toolCalls
      .filter((call) => call.result?.failureKind === "runtime")
      .map((call) => String(call.result?.error || ""));
    if (runtimeErrors.some((error) => /evaluate: SyntaxError|is not defined|is not a function/i.test(error))) return "model-misuse";
    return "plugin-runtime";
  }
  if (!record.success) return "unclassified-friction";
  return "none";
}

// CLI events expose item boundaries, not token deltas or server-side reasoning time.
function timingMetrics(execution) {
  const events = execution.events || [];
  const starts = new Map();
  const intervals = [];
  let firstBrowserActionMs = null;
  for (const event of events) {
    const item = event.item;
    if (!item || !Number.isFinite(event.observedAtMs)) continue;
    const isTool = item.type === "mcp_tool_call" || item.type === "command_execution";
    if (!isTool) continue;
    if (event.type === "item.started") {
      starts.set(item.id, event.observedAtMs);
      if (firstBrowserActionMs === null && /playwright[-_]fast/.test(item.server || "")) firstBrowserActionMs = event.observedAtMs;
    }
    if (event.type === "item.completed" && starts.has(item.id)) {
      intervals.push([starts.get(item.id), event.observedAtMs]);
      starts.delete(item.id);
    }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let toolWallMs = 0, end = 0;
  for (const [start, stop] of intervals) {
    toolWallMs += Math.max(0, stop - Math.max(start, end));
    end = Math.max(end, stop);
  }
  const usage = events.find(event => event.type === "turn.completed")?.usage;
  const observed = events.some(event => Number.isFinite(event.observedAtMs));
  return {
    firstBrowserActionMs,
    toolWallMs: observed ? toolWallMs : null,
    nonToolWallMs: observed ? Math.max(0, execution.elapsedMs - toolWallMs) : null,
    outputTokens: usage?.output_tokens ?? null,
    reasoningOutputTokens: usage?.reasoning_output_tokens ?? null,
    inputTokens: usage?.input_tokens ?? null,
    cachedInputTokens: usage?.cached_input_tokens ?? null,
    effectiveOutputTokensPerSecond: usage?.output_tokens != null && execution.elapsedMs > 0
      ? usage.output_tokens / (execution.elapsedMs / 1000) : null,
    reasoningTimeMs: null,
    decodingTokensPerSecond: null,
  };
}

function hasReloadEvidence(runCalls, needles) {
  if (!needles) return true;
  let reloaded = false;
  const defaults = { evaluate: "evaluation", readText: "text", readAllText: "texts", readValue: "value" };
  for (const call of runCalls) {
    const steps = call.args?.steps || [];
    const executed = index => call.result?.ok === true || call.result?.stepResults?.some(step => step.index === index && step.ok);
    for (let index = 0; index < steps.length; index += 1) {
      if (!executed(index)) continue;
      const step = steps[index];
      if (step.op === "reload") reloaded = true;
      if (!reloaded || !defaults[step.op]) continue;
      const value = call.result?.outputs?.[step.as || defaults[step.op]];
      if (value !== undefined && includesAll(JSON.stringify(value), needles)) return true;
    }
  }
  return false;
}

function scoreRun({ model, testCase, repeat, runId, prompt, oracle, execution }) {
  const items = extractItems(execution.events);
  const final = extractFinalAnswer(items);
  const toolCalls = extractToolCalls(items);
  const playwrightCalls = toolCalls.filter((call) => call.isPlaywright);
  const runCalls = playwrightCalls.filter((call) => call.action === "run");
  const firstRun = runCalls[0];
  const finalText = final.parsed?.answer || final.text;
  const finalChecksPassed = (testCase.diagnostic || Boolean(final.parsed?.completed)) &&
    includesAll(finalText, testCase.finalIncludes || []) &&
    includesAnyGroup(finalText, testCase.finalIncludesAny || []);
  const oraclePassed = oracleMatches(oracle, testCase.oracle);
  const reloadEvidencePassed = hasReloadEvidence(runCalls, testCase.afterReloadIncludes);
  const visualPassed = !testCase.requiresVisual || runCalls.some((call) => call.args?.evidence === "visual");
  const hasSuccessfulRun = runCalls.some((call) => call.result?.ok === true);
  const hasUsablePageEvidence = runCalls.some((call) =>
    call.result?.failureKind === "page" && call.result?.outputs && Object.keys(call.result.outputs).length > 0,
  );
  const hasOracleEvidence = testCase.oracle && Object.keys(testCase.oracle).length > 0 && oraclePassed;
  const callBudgetPassed = testCase.diagnostic ? runCalls.length <= 2 : runCalls.length >= 1;
  const success = execution.exitCode === 0 && !execution.timedOut && finalChecksPassed && oraclePassed && reloadEvidencePassed && visualPassed &&
    (hasSuccessfulRun || hasUsablePageEvidence || hasOracleEvidence) && callBudgetPassed;
  const record = {
    model,
    requestedServiceTier: execution.serviceTier || "default",
    caseId: testCase.id,
    title: testCase.title,
    group: testCase.group,
    complexity: testCase.complexity || "unspecified",
    repeat,
    runId,
    success,
    finalChecksPassed,
    oraclePassed,
    reloadEvidencePassed,
    visualPassed,
    callBudgetPassed,
    oracle,
    final,
    metrics: {
      ...timingMetrics(execution),
      elapsedMs: execution.elapsedMs,
      playwrightElapsedMs: runCalls.reduce((total, call) => total + Number(call.result?.elapsedMs || 0), 0),
      toolCalls: toolCalls.length,
      playwrightCalls: playwrightCalls.length,
      runCalls: runCalls.length,
      failedRunCalls: runCalls.filter((call) => call.result?.ok === false).length,
      correctionCalls: Math.max(0, runCalls.length - 1),
      firstRunContractValid: Boolean(firstRun?.result && firstRun.result.failureKind !== "contract"),
      unnecessaryStatusCalls: playwrightCalls.filter((call) => call.action === "status").length,
      unnecessaryResetCalls: playwrightCalls.filter((call) => call.action === "reset" || call.args?.reset === true).length,
      nonVisualTaskScreenshotCalls: testCase.requiresVisual || testCase.diagnostic ? 0 : runCalls.filter(call => ["visual", "diag"].includes(call.args?.evidence)).length,
      networkIdleCalls: runCalls.filter(call => call.args?.waitUntil === "networkidle").length,
      fixedWaitSteps: runCalls.reduce((sum, call) => sum + (call.args?.steps || []).filter(step => step.op === "waitForTimeout" || (step.op === "wait" && step.ms !== undefined)).length, 0),
      skillReadCalls: toolCalls.filter((call) => call.allowedSkillRead).length,
      unrelatedToolCalls: toolCalls.filter((call) => !call.isPlaywright && !call.allowedSkillRead).length,
    },
    toolCalls,
    execution: {
      serviceTier: execution.serviceTier || "default",
      exitCode: execution.exitCode,
      timedOut: execution.timedOut,
      stderr: execution.stderr,
      usage: execution.events.find((event) => event.type === "turn.completed")?.usage || null,
      events: execution.events,
    },
    prompt,
    testCase: { diagnostic: Boolean(testCase.diagnostic), core: Boolean(testCase.core) },
  };
  record.classification = classify(record);
  return record;
}

function percentage(numerator, denominator) {
  return denominator === 0 ? null : Math.round((numerator / denominator) * 1000) / 10;
}

function displayPercent(value) {
  return value === null ? "N/A" : `${value}%`;
}

function aggregate(results) {
  const byModel = {};
  for (const model of [...new Set(results.map((entry) => entry.model))]) {
    const entries = results.filter((entry) => entry.model === model);
    byModel[model] = summarize(entries);
  }
  const summary = summarize(results);
  const attribution = Object.fromEntries(
    [...new Set(results.map((entry) => entry.classification))]
      .filter(Boolean)
      .sort()
      .map((classification) => [classification, results.filter((entry) => entry.classification === classification).length]),
  );
  const signatures = new Map();
  for (const entry of results) {
    const failedCalls = entry.toolCalls.filter((call) => call.result?.ok === false);
    const runSignatures = failedCalls.length > 0
      ? failedCalls.map(normalizeFailureSignature)
      : entry.success ? [] : [`task:${entry.classification}`];
    for (const signature of new Set(runSignatures)) {
      const current = signatures.get(signature) || { signature, cases: new Set(), models: new Set(), repeatsByModel: {} };
      current.cases.add(entry.caseId);
      current.models.add(entry.model);
      current.repeatsByModel[entry.model] = (current.repeatsByModel[entry.model] || 0) + 1;
      signatures.set(signature, current);
    }
  }
  const frictionCandidates = [...signatures.values()]
    .filter((entry) => entry.models.size >= 2 || Object.values(entry.repeatsByModel).some((count) => count >= 2))
    .map((entry) => ({ ...entry, cases: [...entry.cases], models: [...entry.models] }));
  return { summary, byModel, attribution, frictionCandidates };
}

function normalizeFailureSignature(call) {
  const kind = call.result?.failureKind || "unknown";
  const error = String(call.result?.error || call.error?.message || "");
  if (/must not exceed \d+ms/.test(error)) return `${kind}:operation-timeout-limit`;
  if (/Estimated contract budget/.test(error)) return `${kind}:estimated-budget`;
  if (/target is required/.test(error)) return `${kind}:missing-target`;
  if (/cannot define both ms and target/.test(error)) return `${kind}:wait-target-and-ms`;
  if (/not supported for readAllText/.test(error)) return `${kind}:read-all-timeout`;
  if (/getByLabel/.test(error)) return `${kind}:label-match`;
  if (/Network\.getResponseBody.*No data found/.test(error)) return `${kind}:empty-response-body`;
  if (/locator\.waitFor/.test(error) && /getByText/.test(error)) return `${kind}:text-wait`;
  if (/locator\.selectOption/.test(error)) return `${kind}:select-option`;
  const firstLine = error.split("\n", 1)[0]
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/\b\d+ms\b/g, "<time>")
    .replace(/\b\d+\b/g, "<n>");
  return `${kind}:${firstLine || "unknown"}`;
}

function summarize(entries) {
  const fixture = entries.filter((entry) => entry.group === "fixture");
  const real = entries.filter((entry) => entry.group === "real");
  const ordinary = entries.filter((entry) => !entry.testCase?.diagnostic);
  const runCounts = ordinary.map((entry) => entry.metrics.runCalls);
  const elapsed = entries.map((entry) => entry.metrics.elapsedMs);
  const pluginElapsed = entries.map((entry) => entry.metrics.playwrightElapsedMs);
  const modelOverhead = entries.map((entry) => Math.max(0, entry.metrics.elapsedMs - entry.metrics.playwrightElapsedMs));
  return {
    runs: entries.length,
    firstBrowserActionP50Ms: percentile(entries.map(e => e.metrics.firstBrowserActionMs).filter(Number.isFinite), 0.5),
    nonToolWallP50Ms: percentile(entries.map(e => e.metrics.nonToolWallMs).filter(Number.isFinite), 0.5),
    reasoningOutputTokensP50: percentile(entries.map(e => e.metrics.reasoningOutputTokens).filter(Number.isFinite), 0.5),
    outputTokensP50: percentile(entries.map(e => e.metrics.outputTokens).filter(Number.isFinite), 0.5),
    effectiveOutputTokensPerSecondP50: percentile(entries.map(e => e.metrics.effectiveOutputTokensPerSecond).filter(Number.isFinite), 0.5),
    successRate: percentage(entries.filter((entry) => entry.success).length, entries.length),
    fixtureSuccessRate: percentage(fixture.filter((entry) => entry.success).length, fixture.length),
    realSuccessRate: percentage(real.filter((entry) => entry.success).length, real.length),
    firstRunContractValidRate: percentage(entries.filter((entry) => entry.metrics.firstRunContractValid).length, entries.length),
    medianRunCalls: percentile(runCounts, 0.5),
    unnecessaryStatusCalls: entries.reduce((total, entry) => total + entry.metrics.unnecessaryStatusCalls, 0),
    unnecessaryResetCalls: entries.reduce((total, entry) => total + entry.metrics.unnecessaryResetCalls, 0),
    unrelatedToolCalls: entries.reduce((total, entry) => total + entry.metrics.unrelatedToolCalls, 0),
    pluginRuntimeFailures: entries.filter((entry) => entry.classification === "plugin-runtime").length,
    elapsedP50Ms: percentile(elapsed, 0.5),
    elapsedP95Ms: percentile(elapsed, 0.95),
    modelOverheadP50Ms: percentile(modelOverhead, 0.5),
    modelOverheadP95Ms: percentile(modelOverhead, 0.95),
    pluginP50Ms: percentile(pluginElapsed, 0.5),
    pluginP95Ms: percentile(pluginElapsed, 0.95),
  };
}

function markdownReport(results, aggregateResult) {
  const { summary, byModel, attribution, frictionCandidates } = aggregateResult;
  const rows = Object.entries(byModel).map(([model, item]) =>
    `| ${model} | ${item.runs} | ${displayPercent(item.successRate)} | ${displayPercent(item.fixtureSuccessRate)} | ${displayPercent(item.realSuccessRate)} | ${displayPercent(item.firstRunContractValidRate)} | ${item.medianRunCalls} | ${item.elapsedP50Ms}/${item.elapsedP95Ms} | ${item.modelOverheadP50Ms}/${item.modelOverheadP95Ms} | ${item.pluginP50Ms}/${item.pluginP95Ms} |`,
  );
  const failed = results.filter((entry) => !entry.success);
  const attributionRows = Object.entries(attribution).map(([classification, count]) => `- ${classification}: ${count}`);
  const ordinary = results.filter((entry) => !entry.testCase?.diagnostic);
  const oneRunCount = ordinary.filter((entry) => entry.metrics.runCalls === 1).length;
  const priorities = [
    summary.medianRunCalls > 1 ? `Reduce multi-call planning: ${oneRunCount}/${ordinary.length} ordinary runs completed with one run call; median is ${summary.medianRunCalls}.` : null,
    summary.firstRunContractValidRate < 97 ? `Absorb remaining first-contract friction: validity is ${summary.firstRunContractValidRate}% against the 97% target.` : null,
    summary.unnecessaryResetCalls > 0 ? `Remove unnecessary explicit resets: observed ${summary.unnecessaryResetCalls}.` : null,
    ...frictionCandidates.map((entry) => `Investigate ${entry.signature}: cases=${entry.cases.join(", ")}; models=${entry.models.join(", ")}.`),
  ].filter(Boolean);
  return `# Playwright Fast Agent Evaluation\n\n` +
    `Generated: ${new Date().toISOString()}\n\n` +
    `## Summary\n\n` +
    `- Runs: ${summary.runs}\n` +
    `- Overall success: ${displayPercent(summary.successRate)}\n` +
    `- Fixture success: ${displayPercent(summary.fixtureSuccessRate)} (target ≥ 95%)\n` +
    `- Real-page success: ${displayPercent(summary.realSuccessRate)} (target ≥ 85%)\n` +
    `- First-run contract validity: ${displayPercent(summary.firstRunContractValidRate)} (target ≥ 97%)\n` +
    `- Median run calls: ${summary.medianRunCalls} (target 1 for ordinary cases)\n` +
    `- Unnecessary status/reset/unrelated calls: ${summary.unnecessaryStatusCalls}/${summary.unnecessaryResetCalls}/${summary.unrelatedToolCalls}\n` +
    `- Plugin runtime failures: ${summary.pluginRuntimeFailures}\n\n` +
    `## By Model\n\n` +
    `| Model | Runs | Success | Fixture | Real | First contract valid | Median runs | E2E P50/P95 ms | Model overhead P50/P95 ms | Plugin P50/P95 ms |\n` +
    `|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|\n${rows.join("\n")}\n\n` +
    `## Observed latency and effective token rate\n\n` +
    `Non-tool wall time includes startup, prefill, network, queuing, reasoning and generation; it is not reasoning time. Effective token/s is output usage divided by total wall time, not decoding throughput. CLI exposes neither token deltas nor isolated reasoning time.\n\n` +
    `| Configuration | First browser action P50 ms | Non-tool wall P50 ms | Output tokens P50 | Effective output token/s P50 |\n|---|---:|---:|---:|---:|\n` +
    Object.entries(byModel).map(([model, m]) => `| ${model} | ${m.firstBrowserActionP50Ms ?? "N/A"} | ${m.nonToolWallP50Ms ?? "N/A"} | ${m.outputTokensP50 ?? "N/A"} | ${m.effectiveOutputTokensPerSecondP50?.toFixed(1) ?? "N/A"} |`).join("\n") + "\n\n" +
    `## Failures\n\n` +
    (failed.length === 0 ? "None.\n" : failed.map((entry) => `- ${entry.model} / ${entry.caseId} #${entry.repeat}: ${entry.classification}`).join("\n") + "\n") +
    `\n## Attribution\n\n` +
    (attributionRows.length === 0 ? "None.\n" : `${attributionRows.join("\n")}\n`) +
    `\n## Prioritized Findings\n\n` +
    (priorities.length === 0 ? "No threshold-driven follow-up.\n" : priorities.map((item, index) => `${index + 1}. ${item}`).join("\n") + "\n") +
    `\n## Repeated Friction Candidates\n\n` +
    (frictionCandidates.length === 0 ? "None met the cross-model or repeated-failure threshold.\n" : frictionCandidates.map((entry) => `- ${entry.signature}; cases=${entry.cases.join(", ")}; models=${entry.models.join(", ")}`).join("\n") + "\n");
}

function writeReport(results, resultsDir) {
  const aggregated = aggregate(results);
  fs.writeFileSync(path.join(resultsDir, "summary.json"), `${JSON.stringify(aggregated, null, 2)}\n`);
  fs.writeFileSync(path.join(resultsDir, "report.md"), markdownReport(results, aggregated));
  return aggregated;
}

function loadResults(resultsDir) {
  const cases = require("./cases.json");
  return fs.readdirSync(resultsDir)
    .filter((name) => /^\d+-.+\.json$/.test(name))
    .sort()
    .map((name) => JSON.parse(fs.readFileSync(path.join(resultsDir, name), "utf8")))
    .map((record) => {
      const testCase = cases.find((entry) => entry.id === record.caseId);
      if (!testCase || !record.execution?.events) return record;
      return scoreRun({
        model: record.model,
        testCase,
        repeat: record.repeat,
        runId: record.runId,
        prompt: record.prompt,
        oracle: record.oracle,
        execution: { ...record.execution, elapsedMs: record.metrics?.elapsedMs },
      });
    });
}

if (require.main === module) {
  const args = process.argv.slice(2);
  const outputIndex = args.indexOf("--output");
  const outputDir = outputIndex >= 0 ? path.resolve(args[outputIndex + 1] || "") : null;
  if (outputIndex >= 0) args.splice(outputIndex, 2);
  const resultsDirs = args.map((entry) => path.resolve(entry));
  if (resultsDirs.length === 0 || resultsDirs.some((entry) => !fs.existsSync(entry)) || (outputIndex >= 0 && !outputDir)) {
    process.stderr.write("Usage: node evals/score-agent-evals.js <results-directory> [overlay-directory ...] [--output directory]\n");
    process.exitCode = 1;
  } else {
    const latestByRun = new Map();
    for (const resultsDir of resultsDirs) {
      for (const result of loadResults(resultsDir)) latestByRun.set(`${result.model}\0${result.caseId}\0${result.repeat}`, result);
    }
    const results = [...latestByRun.values()];
    const destination = outputDir || resultsDirs[0];
    fs.mkdirSync(destination, { recursive: true });
    const aggregated = writeReport(results, destination);
    process.stdout.write(`${JSON.stringify(aggregated, null, 2)}\n`);
  }
}

module.exports = { hasReloadEvidence, timingMetrics, aggregate, extractToolCalls, findResult, markdownReport, percentile, scoreRun, writeReport };
