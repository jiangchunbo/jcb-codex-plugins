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
  assert.deepEqual(button.controls, [{ tag: 'button', id: 'save', target: { css: '#save' }, disabled: true }]);
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


test('observe distinguishes description fields from code and suggests only unique selectors', async t => {
  const page = await fixture(t, `<label for="description">Description</label><textarea id="description"></textarea>
    <input placeholder="Email"><input placeholder="Repeated"><input placeholder="Repeated">
    <div class="monaco-editor" id="code"><textarea></textarea></div>`);
  const result = await observe(page.locator('body'));
  assert.equal(result.editors.length, 2);
  assert.equal(result.editors[0].category, 'field');
  assert.equal(result.editors[0].codeEditorConfirmed, false);
  assert.deepEqual(result.editors[0].labels, ['Description']);
  assert.equal(result.editors[1].category, 'code');
  const email = result.controls.find(x => x.placeholder === 'Email');
  assert.equal(await page.locator(email.target.css).count(), 1);
  assert.ok(result.controls.filter(x => x.placeholder === 'Repeated').every(x => !x.target));
});

test('failure recovery observes a unique dialog and leaves ambiguous dialogs unselected', async t => {
  const page = await fixture(t, '<nav>Unrelated navigation</nav><dialog open><button>Confirm</button></dialog>');
  const focused = await observe(page.locator('body'), { preferDialog: true });
  assert.equal(focused.scope, 'dialog');
  assert.doesNotMatch(focused.ariaSnapshot, /Unrelated navigation/);
  assert.match(focused.ariaSnapshot, /Confirm/);
  await page.locator('body').evaluate(el => el.insertAdjacentHTML('beforeend', '<dialog open>Other</dialog>'));
  assert.equal((await observe(page.locator('body'), { preferDialog: true })).scope, 'requested');
});


test('label metadata does not disclose nested field contents', async t => {
  const page = await fixture(t, '<label>Description<textarea>PRIVATE_NESTED</textarea></label>');
  const result = await observe(page.locator('body'));
  // ARIA names can reflect label contents; metadata itself must never copy nested values.
  assert.doesNotMatch(JSON.stringify(result.controls), /PRIVATE_NESTED/);
  assert.doesNotMatch(JSON.stringify(result.editors), /PRIVATE_NESTED/);
  assert.deepEqual(result.editors[0].labels, ['Description']);
});
