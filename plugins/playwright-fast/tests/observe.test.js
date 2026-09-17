const assert = require('node:assert/strict');
const { before, after, test } = require('node:test');
const path = require('node:path');
const { resolveRuntime } = require('../scripts/resolve-runtime');
const { observe } = require('../shared/observe');
let browser;
before(async () => {
  const runtime = resolveRuntime();
  const { chromium } = require(path.join(runtime.nodeModules, 'playwright'));
  browser = await chromium.launch({ headless: true, executablePath: runtime.browserExecutablePath });
});
after(async () => { await browser?.close(); });
async function fixture(t, html) {
  const page = await browser.newPage();
  t.after(() => page.close());
  await page.setContent(html);
  return page;
}
test('observe uses accessible names and omits hidden controls and input values', async t => {
  const page = await fixture(t, `<button hidden>Duplicate</button><button aria-label="Actual action">Different text</button>
    <label for="entry">Account</label><input id="entry" value="PRIVATE_VALUE"><input type="password" value="SECRET">
    <div aria-hidden="true"><button>Hidden group</button></div><textarea>PRIVATE_TEXTAREA
PRIVATE_SECOND_LINE</textarea>`);
  const result = await observe(page.locator('body'));
  assert.match(result.ariaSnapshot, /Actual action/);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_VALUE|SECRET|PRIVATE_TEXTAREA|PRIVATE_SECOND_LINE|Duplicate|Hidden group/);
  assert.equal(result.controls.filter(x => x.tag === 'button').length, 1);
  assert.equal(result.editors[0].kind, 'textarea');
  assert.equal(result.truncated, false);
});
test('observe scopes to dialog and includes the root control', async t => {
  const page = await fixture(t, `<button>Outside</button><dialog open aria-label="Settings"><button id="save" disabled>Save</button></dialog>`);
  const result = await observe(page.locator('dialog'));
  assert.equal(result.dialogs.length, 1);
  assert.doesNotMatch(result.ariaSnapshot, /Outside/);
  const button = await observe(page.locator('#save'));
  assert.deepEqual(button.controls, [{ tag: 'button', id: 'save', disabled: true }]);
});
test('observe bounds snapshot and metadata and works inside frames', async t => {
  const page = await fixture(t, '<iframe></iframe>');
  const frame = page.frames()[1];
  await frame.setContent(Array.from({ length: 80 }, (_, i) => `<button>Action ${i}</button>`).join(''));
  const result = await observe(page.frameLocator('iframe').locator('body'), { maxChars: 70 });
  assert.equal(result.ariaSnapshot.length, 70);
  assert.equal(result.controls.length, 40);
  assert.equal(result.truncated, true);
  assert.equal(result.metadataTruncated, true);
});

test('observe detects contenteditable and excludes aria-hidden shadow hosts', async t => {
  const page = await fixture(t, '<div contenteditable="true">Editable page text</div><div id="host" aria-hidden="true"></div>');
  await page.locator('#host').evaluate(el => { el.attachShadow({ mode: 'open' }).innerHTML = '<button>Shadow hidden</button>'; });
  const result = await observe(page.locator('body'));
  assert.equal(result.editors[0].kind, 'contenteditable');
  assert.doesNotMatch(JSON.stringify(result), /Shadow hidden/);
  assert.equal(result.controls.filter(x => x.tag === 'button').length, 0);
});
