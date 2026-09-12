const assert = require("node:assert/strict");
const http = require("node:http");
const test = require("node:test");
const cases = require("./cases.json");
const delegationCases = require("./delegation-cases.json");
const { createFixtureServer } = require("./fixture-server");
const { createSchedule, parseJsonLines } = require("./run-agent-evals");
const { extractDelegationCalls, report: delegationReport, scoreDelegation } = require("./run-delegation-evals");
const { aggregate, percentile, scoreRun } = require("./score-agent-evals");

test("catalog contains the 14 fixture and two real cases", () => {
  assert.equal(cases.length, 16);
  assert.equal(cases.filter((entry) => entry.group === "fixture").length, 14);
  assert.equal(cases.filter((entry) => entry.group === "real").length, 2);
  assert.equal(new Set(cases.map((entry) => entry.id)).size, cases.length);
});

test("layered schedule stays below the 90-run cap before failure reruns", () => {
  const models = ["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"];
  const schedule = createSchedule(cases, models, "layered");
  assert(schedule.length <= 90);
  assert(schedule.some((entry) => entry.testCase.id === "real-admin"));
  assert(schedule.some((entry) => entry.testCase.id === "real-uni"));
});

test("delegation catalog covers direct, stateful, and independent verification decisions", () => {
  assert.deepEqual(delegationCases.map((entry) => entry.expectedDelegation), [false, false, true]);
  assert.equal(new Set(delegationCases.map((entry) => entry.id)).size, 3);
});

test("delegation scorer validates one Luna low self-contained assignment", () => {
  const runId = "delegated-run";
  const events = [
    {
      type: "item.completed",
      item: {
        type: "collab_tool_call",
        tool: "spawn_agent",
        receiver_thread_ids: ["child-thread"],
        arguments: JSON.stringify({
          model: "gpt-5.6-luna",
          reasoning_effort: "low",
          fork_turns: "none",
          message: `Use Playwright Fast at http://127.0.0.1:3000/form?run=${runId}; fill fake data 陈伟 and 已付款, accept 268.00, report evidence, do not delegate, and do not modify business source.`,
        }),
      },
    },
    { type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ completed: true, answer: "Chromium 1243 and 268.00", evidence: "fixture" }) } },
  ];
  assert.equal(extractDelegationCalls(events).length, 1);
  const result = scoreDelegation({
    model: "gpt-5.6-sol",
    testCase: {
      id: "delegated", title: "delegated", expectedDelegation: true,
      finalIncludes: ["1243", "268.00"], oracle: { search: "陈伟|已付款" },
    },
    runId,
    oracle: { search: "陈伟|已付款" },
    execution: { exitCode: 0, timedOut: false, elapsedMs: 10, stderr: "", events },
  });
  assert.equal(result.success, true);
  assert.equal(delegationReport([result]).summary.decisionRate, 100);
  assert.equal(result.metrics.recursiveOrDuplicateDelegations, 0);
});

test("delegation scorer rejects a subagent for a browser-primary task", () => {
  const events = [{
    type: "item.completed",
    item: { type: "function_call", name: "spawn_agent", arguments: JSON.stringify({ model: "gpt-5.6-terra" }) },
  }];
  const result = scoreDelegation({
    model: "gpt-5.6-luna",
    testCase: { id: "direct", title: "direct", expectedDelegation: false, finalIncludes: [], oracle: {} },
    runId: "direct-run",
    oracle: {},
    execution: { exitCode: 0, timedOut: false, elapsedMs: 10, stderr: "", events },
  });
  assert.equal(result.success, false);
  assert.equal(result.checks.delegationCountPassed, false);
});

test("JSONL parsing ignores stderr-like noise and scorer recognizes a clean run", () => {
  const events = parseJsonLines([
    "startup noise",
    JSON.stringify({ type: "item.completed", item: { type: "mcp_tool_call", server: "playwright-fast", tool: "run", arguments: { evidence: "ultra" }, result: JSON.stringify({ ok: true, elapsedMs: 12, outputs: {} }) } }),
    JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: JSON.stringify({ completed: true, answer: "268.00", evidence: "table" }) } }),
    JSON.stringify({ type: "turn.completed", usage: { input_tokens: 10 } }),
  ].join("\n"));
  const result = scoreRun({
    model: "test-model",
    testCase: { id: "basic", title: "basic", group: "fixture", finalIncludes: ["268.00"], oracle: { search: "ok" } },
    repeat: 1,
    runId: "run",
    prompt: "prompt",
    oracle: { search: "ok" },
    execution: { exitCode: 0, timedOut: false, elapsedMs: 20, stdout: "", stderr: "", events },
  });
  assert.equal(result.success, true);
  assert.equal(result.metrics.firstRunContractValid, true);
  assert.equal(result.metrics.runCalls, 1);
});

test("aggregate exposes cross-model friction and percentile boundaries", () => {
  const base = {
    caseId: "same-case", group: "fixture", success: false, classification: "model-misuse",
    metrics: { elapsedMs: 10, runCalls: 1, firstRunContractValid: false, unnecessaryStatusCalls: 0, unnecessaryResetCalls: 0, unrelatedToolCalls: 0 },
    toolCalls: [{ result: { failureKind: "contract" } }],
  };
  const result = aggregate([{ ...base, model: "a" }, { ...base, model: "b" }]);
  assert.equal(result.frictionCandidates.length, 1);
  assert.equal(percentile([1, 2, 3, 4], 0.5), 2);
});

test("host approval rejection is environment failure and not a valid first contract", () => {
  const events = [{
    type: "item.completed",
    item: {
      type: "mcp_tool_call", server: "playwright-fast", tool: "run", arguments: {}, result: null,
      error: { message: "MCP tool call requires approval, but approval policy is never" }, status: "failed",
    },
  }];
  const result = scoreRun({
    model: "test-model",
    testCase: { id: "blocked", title: "blocked", group: "fixture", finalIncludes: [], oracle: {} },
    repeat: 1, runId: "blocked", prompt: "prompt", oracle: {},
    execution: { exitCode: 0, timedOut: false, elapsedMs: 10, stdout: "", stderr: "", events },
  });
  assert.equal(result.classification, "environment");
  assert.equal(result.metrics.firstRunContractValid, false);
});

test("fixture records browser-visible actions through its oracle endpoint", async () => {
  const fixture = createFixtureServer();
  const origin = await fixture.start();
  try {
    await new Promise((resolve, reject) => {
      const request = http.request(`${origin}/__event/test-run`, { method: "POST", headers: { "content-type": "application/json" } }, (response) => {
        response.resume(); response.on("end", resolve);
      });
      request.on("error", reject);
      request.end(JSON.stringify({ key: "selectedRole", value: "管理员" }));
    });
    assert.deepEqual(fixture.state.get("test-run"), { selectedRole: "管理员" });
  } finally {
    await fixture.close();
  }
});

test("timing uses union of tool intervals and never fabricates decoding or reasoning speed", () => {
  const { timingMetrics } = require("./score-agent-evals");
  const event = (type, id, observedAtMs) => ({ type, observedAtMs, item: { id, type: "mcp_tool_call", server: "playwright-fast" } });
  const result = timingMetrics({ elapsedMs: 1000, events: [
    event("item.started", "a", 200), event("item.started", "b", 300),
    event("item.completed", "a", 500), event("item.completed", "b", 600),
    { type: "turn.completed", usage: { output_tokens: 100 } },
  ] });
  assert.equal(result.firstBrowserActionMs, 200);
  assert.equal(result.toolWallMs, 400);
  assert.equal(result.nonToolWallMs, 600);
  assert.equal(result.effectiveOutputTokensPerSecond, 100);
  assert.equal(result.reasoningTimeMs, null);
  assert.equal(result.decodingTokensPerSecond, null);
  assert.equal(timingMetrics({ elapsedMs: 1000, events: [] }).toolWallMs, null);
});

test("procurement fixture persists a confirmed UI order and exposes its oracle", async () => {
  const { createClient } = require('./benchmark-hot-run');
  const fixture = createFixtureServer();
  const origin = await fixture.start();
  const client = createClient();
  try {
    client.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    await client.waitFor(message => message.id === 1);
    client.write({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run', arguments: {
      url: `${origin}/procurement?run=oracle-test`, evidence: 'ultra', steps: [
        { op: 'click', target: { role: 'button', name: '下一页' } },
        { op: 'click', target: { css: 'button[data-name="Dahlia"]' } },
        { op: 'fill', target: { label: '数量' }, value: '3' },
        { op: 'select', target: { label: '部门' }, value: { label: '研发部' } },
        { op: 'click', target: { role: 'button', name: '核对订单' } },
        { op: 'click', target: { role: 'button', name: '确认采购' } },
        { op: 'wait', target: { css: '#receipt', hasText: '采购成功' } },
        { op: 'reload' },
        { op: 'readText', target: { css: '#receipt' }, as: 'receipt' },
      ],
    } } });
    const reply = await client.waitFor(message => message.id === 2);
    const result = JSON.parse(reply.result.content[0].text);
    assert.equal(result.ok, true, JSON.stringify(result));
    const expected = { model: 'Dahlia', quantity: 3, department: '研发部', total: 9900 };
    assert.deepEqual(JSON.parse(result.outputs.receipt), expected);
    assert.deepEqual(fixture.state.get('oracle-test'), { purchase: expected });
  } finally { await client.close(); await fixture.close(); }
});

test("reload evidence must be observed after an executed reload, even if a later assertion fails", () => {
  const { hasReloadEvidence } = require('./score-agent-evals');
  const call = { args: { steps: [{ op: 'reload' }, { op: 'readText', as: 'receipt' }] }, result: {
    ok: false, stepResults: [{ index: 0, ok: true }, { index: 1, ok: true }], outputs: { receipt: 'Dahlia 9900' },
  } };
  assert.equal(hasReloadEvidence([call], ['Dahlia', '9900']), true);
  assert.equal(hasReloadEvidence([{ ...call, result: { ...call.result, stepResults: [] } }], ['Dahlia']), false);
  assert.equal(hasReloadEvidence([{ ...call, args: { steps: [{ op: 'readText', as: 'receipt' }] }, result: { ...call.result, ok: true } }], ['Dahlia']), false);
});

test('routing task summaries keep fast failures out of successful latency percentiles', () => {
  const { summarize } = require('./benchmark-routing-tasks');
  const row = { scenario: 'normal', mode: 'auto', attempts: { direct: 1, proxy: 1 }, originConnections: 1, probeAttempts: 1, posts: 1 };
  const summary = summarize([{ ...row, ok: false, elapsedMs: 2 }, { ...row, ok: true, elapsedMs: 100 }]);
  assert.equal(summary.length, 1);
  assert.equal(summary[0].runs, 2); assert.equal(summary[0].successes, 1);
  assert.equal(summary[0].successP50Ms, 100); assert.equal(summary[0].successP95Ms, 100);
  const failed = summarize([{ ...row, ok: false, elapsedMs: 2, posts: 2 }])[0];
  assert.equal(failed.successP50Ms, null); assert.equal(failed.successP95Ms, null);
  assert.equal(failed.duplicatePosts, 1);
});
