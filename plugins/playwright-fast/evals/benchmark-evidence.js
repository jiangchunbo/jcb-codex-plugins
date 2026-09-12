#!/usr/bin/env node
const assert = require('node:assert/strict');
const { createClient } = require('./benchmark-hot-run');
const { createFixtureServer } = require('./fixture-server');

(async () => {
  const fixture = createFixtureServer();
  const origin = await fixture.start();
  const client = createClient();
  try {
    client.write({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } });
    await client.waitFor(message => message.id === 1);
    client.write({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'run', arguments: {
      url: `${origin}/form`, evidence: 'ultra', steps: [
        { op: 'readText', target: { css: 'body' }, as: 'raw' },
        { op: 'evaluate', expression: 'document.body.innerText', as: 'rendered' },
        { op: 'evaluate', expression: "Array.from(document.querySelectorAll('table tr'), row => Array.from(row.cells, cell => cell.innerText))", as: 'rows' },
      ],
    } } });
    const reply = await client.waitFor(message => message.id === 2);
    const result = JSON.parse(reply.result.content[0].text);
    assert.equal(result.ok, true);
    const { raw, rendered, rows } = result.outputs;
    assert(rendered.includes('订单状态') && rendered.includes('268.00'));
    assert(!rendered.includes('const record'));
    assert.deepEqual(rows, [['陈伟', '已付款', '268.00']]);
    console.log(JSON.stringify({
      measurement: 'JSON character lengths, not tokenizer counts; rows suffice for result reading only',
      raw: JSON.stringify(raw).length, rendered: JSON.stringify(rendered).length,
      rows: JSON.stringify(rows).length,
      renderedReductionPercent: +(100 * (1 - JSON.stringify(rendered).length / JSON.stringify(raw).length)).toFixed(1),
      rowsReductionPercent: +(100 * (1 - JSON.stringify(rows).length / JSON.stringify(raw).length)).toFixed(1),
    }, null, 2));
  } finally { await client.close(); await fixture.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
