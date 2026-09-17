const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const path = require('node:path');
const { resolveRuntime } = require('../scripts/resolve-runtime');
const { editorOperation } = require('../shared/editors');
let browser, page;
before(async () => {
  const runtime = resolveRuntime({ root: path.resolve(__dirname, '..') });
  browser = await require(path.join(runtime.nodeModules, 'playwright')).chromium.launch({ headless: true, executablePath: runtime.browserExecutablePath });
  page = await browser.newPage();
});
after(async () => { await browser?.close(); });
test('native editor bounded read, hash guarded patch, events and exact verification', async () => {
  await page.setContent('<textarea id="code">hello world</textarea>');
  const locator = page.locator('#code');
  await locator.evaluate(el => { el.addEventListener('input', () => el.dataset.input = 'yes'); });
  const read = await editorOperation(locator, { op: 'editorRead', maxChars: 5 });
  assert.deepEqual({ ...read, hash: null }, { text: 'hello', hash: null, totalChars: 11, truncated: true, adapter: 'textarea' });
  const changed = await editorOperation(locator, { op: 'editorPatch', oldText: 'world', newText: 'browser', expectedHash: read.hash });
  assert.equal(changed.verified, true);
  assert.equal(changed.changed, true);
  assert.equal(changed.chars, 13);
  assert.equal('text' in changed, false);
  assert.equal(await locator.inputValue(), 'hello browser');
  assert.equal(await locator.getAttribute('data-input'), 'yes');
  assert.equal((await editorOperation(locator, { op: 'editorRead' })).hash, changed.afterHash);
});
test('invalid patch, duplicate match, stale hash, disabled and read-only refuse without mutation', async () => {
  await page.setContent('<textarea>aaaa</textarea>');
  const locator = page.locator('textarea');
  for (const args of [{ oldText: '', newText: 'b' }, { oldText: 'aa', newText: 'b' }, { oldText: 'missing', newText: 'b' }, { oldText: 'aaaa', newText: 'b', expectedHash: '0'.repeat(64) }]) {
    await assert.rejects(editorOperation(locator, { op: 'editorPatch', ...args }));
    assert.equal(await locator.inputValue(), 'aaaa');
  }
  for (const attribute of ['readonly', 'disabled']) {
    await locator.evaluate((el, name) => el.setAttribute(name, ''), attribute);
    await assert.rejects(editorOperation(locator, { op: 'editorPatch', oldText: 'aaaa', newText: 'b' }), /read-only or disabled/);
    await locator.evaluate((el, name) => el.removeAttribute(name), attribute);
  }
});
test('between-read conflict is rejected and synchronous application rewrite is detected', async () => {
  await page.setContent('<input value="original">');
  const locator = page.locator('input');
  let calls = 0;
  const racing = { evaluate: async (...args) => {
    if (++calls === 2) await locator.fill('concurrent edit');
    return locator.evaluate(...args);
  } };
  await assert.rejects(editorOperation(racing, { op: 'editorPatch', oldText: 'original', newText: 'ours' }), /changed since preflight/);
  assert.equal(await locator.inputValue(), 'concurrent edit');
  await locator.evaluate(el => { el.addEventListener('input', () => el.value = 'normalized'); });
  await assert.rejects(editorOperation(locator, { op: 'editorPatch', oldText: 'concurrent edit', newText: 'ours' }), /verification failed after write/);
});
// Simulated public editor APIs in real Chromium, not a bundled real Monaco distribution.
async function installEditor(react = false, readOnly = false) {
  await page.setContent('<div id="editor" class="monaco-editor"><textarea></textarea></div>');
  await page.evaluate(({ react, readOnly }) => {
    delete window.monaco;
    const node = document.querySelector('#editor');
    let value = 'pipeline original';
    const editor = { getDomNode: () => node, getValue: () => value, setValue: text => value = text, getRawOptions: () => ({ readOnly }) };
    if (react) node.__reactFiber$test = { return: { stateNode: { editor } } };
    else window.monaco = { editor: { getEditors: () => [editor] } };
  }, { react, readOnly });
  return page.locator('#editor');
}
test('public Monaco and bounded React class adapter patch the model', async () => {
  for (const react of [false, true]) {
    const locator = await installEditor(react);
    const read = await editorOperation(locator, { op: 'editorRead' });
    assert.equal(read.adapter, react ? 'react-monaco' : 'monaco');
    assert.equal(read.text, 'pipeline original');
    await editorOperation(locator, { op: 'editorPatch', oldText: 'original', newText: 'updated', expectedHash: read.hash });
    assert.equal((await editorOperation(locator, { op: 'editorRead' })).text, 'pipeline updated');
    assert.equal(await page.locator('textarea').inputValue(), '');
  }
});
test('editor API read-only and unavailable model fail explicitly', async () => {
  let locator = await installEditor(false, true);
  await assert.rejects(editorOperation(locator, { op: 'editorPatch', oldText: 'original', newText: 'updated' }), /read-only/);
  await page.evaluate(() => delete window.monaco);
  await assert.rejects(editorOperation(locator, { op: 'editorRead' }), /API unavailable/);
  await page.setContent('<div id="editor"><input><textarea></textarea></div>');
  await assert.rejects(editorOperation(page.locator('#editor'), { op: 'editorRead' }), /ambiguous/);
});
