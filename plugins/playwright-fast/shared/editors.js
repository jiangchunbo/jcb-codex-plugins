const { createHash } = require('node:crypto');
const hash = text => createHash('sha256').update(text).digest('hex');

// Runs synchronously in the page: resolve, compare, write, and verify without yielding.
function accessEditor(element, request) {
  const matches = editor => {
    if (!editor || typeof editor.getDomNode !== 'function' || typeof editor.getValue !== 'function' || typeof editor.setValue !== 'function') return false;
    const node = editor.getDomNode();
    return node && (node === element || node.contains(element) || element.contains(node));
  };
  let adapter, editor;
  const candidates = [...new Set((window.monaco?.editor?.getEditors?.() || []).filter(matches))];
  if (candidates.length > 1) throw Error('Editor target matches multiple editors; select one editor container.');
  if (candidates.length === 1) { editor = candidates[0]; adapter = 'monaco'; }
  if (!editor) {
    const found = new Set();
    for (let node = element, depth = 0; node && depth < 12; node = node.parentElement, depth++) {
      const key = Object.keys(node).find(name => name.startsWith('__reactFiber$') || name.startsWith('__reactInternalInstance$'));
      for (let fiber = key && node[key], level = 0; fiber && level < 12; fiber = fiber.return, level++) {
        const candidate = fiber.stateNode?.editor;
        if (matches(candidate)) found.add(candidate);
      }
    }
    if (found.size > 1) throw Error('Editor target matches multiple React editor instances.');
    if (found.size) { editor = [...found][0]; adapter = 'react-monaco'; }
  }
  let read, write, readonly;
  if (editor) {
    read = () => editor.getValue();
    write = value => editor.setValue(value);
    const raw = editor.getRawOptions?.();
    const readOnlyOption = window.monaco?.editor?.EditorOption?.readOnly;
    readonly = raw ? !!(raw.readOnly || raw.domReadOnly) : readOnlyOption !== undefined && typeof editor.getOption === 'function' ? !!editor.getOption(readOnlyOption) : null;
  } else {
    const controls = element.matches('textarea,input') ? [element] : [...element.querySelectorAll('textarea,input')];
    if (controls.length !== 1) throw Error('Unsupported or ambiguous editor target; select a textarea, text input, or supported Monaco container.');
    const control = controls[0];
    if (control.tagName === 'INPUT' && !['text', 'search', 'url', 'tel', 'email', 'password'].includes(control.type)) throw Error('Unsupported input type for editor operation.');
    // Monaco hidden textareas must never be treated as the document model.
    if (control.closest('.monaco-editor')) throw Error('Monaco editor API unavailable; refusing to edit its hidden textarea.');
    adapter = control.tagName.toLowerCase();
    read = () => control.value;
    readonly = control.readOnly || control.matches(':disabled') || control.getAttribute('aria-readonly') === 'true';
    write = value => {
      const prototype = control.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, 'value').set.call(control, value);
      control.dispatchEvent(new Event('input', { bubbles: true }));
      control.dispatchEvent(new Event('change', { bubbles: true }));
    };
  }
  const text = read();
  if (typeof text !== 'string') throw Error('Editor API did not return text.');
  if (request.mode === 'read') return { text, adapter };
  if (readonly === null) throw Error('Cannot establish editor read-only state; refusing to write.');
  if (editor && editor.getDomNode().matches('[aria-disabled="true"],[aria-readonly="true"]')) readonly = true;
  if (readonly || element.closest('[aria-disabled="true"],[aria-readonly="true"]')) throw Error('Editor is read-only or disabled.');
  if (text !== request.before || adapter !== request.adapter) throw Error('Editor changed since preflight; no edit applied. Read again before retrying.');
  const position = text.indexOf(request.oldText);
  if (position < 0) throw Error('oldText was not found; no edit applied.');
  if (text.indexOf(request.oldText, position + 1) !== -1) throw Error('oldText is not unique; no edit applied.');
  const after = text.slice(0, position) + request.newText + text.slice(position + request.oldText.length);
  if (after !== text) write(after);
  if (read() !== after) throw Error('Editor verification failed after write; inspect current content before retrying.');
  return { text: after, adapter, changed: after !== text, verified: true };
}

async function editorOperation(locator, step) {
  if (!['editorRead', 'editorPatch'].includes(step.op)) throw Error('Unsupported editor operation.');
  if (step.op === 'editorPatch' && (typeof step.oldText !== 'string' || !step.oldText.length || typeof step.newText !== 'string')) throw Error('editorPatch requires nonempty oldText and string newText.');
  if (step.expectedHash !== undefined && !/^[a-f0-9]{64}$/i.test(step.expectedHash)) throw Error('expectedHash must be a SHA-256 hex digest.');
  const before = await locator.evaluate(accessEditor, { mode: 'read' }, { timeout: step.timeoutMs || 2000 });
  const beforeHash = hash(before.text);
  if (step.op === 'editorRead') {
    const maxChars = step.maxChars ?? 6000;
    if (!Number.isInteger(maxChars) || maxChars < 1 || maxChars > 100000) throw Error('maxChars must be an integer from 1 to 100000.');
    return { text: before.text.slice(0, maxChars), hash: beforeHash, totalChars: before.text.length, truncated: before.text.length > maxChars, adapter: before.adapter };
  }
  if (step.expectedHash && step.expectedHash.toLowerCase() !== beforeHash) throw Error('expectedHash does not match current editor; no edit applied.');
  const after = await locator.evaluate(accessEditor, { mode: 'patch', before: before.text, adapter: before.adapter, oldText: step.oldText, newText: step.newText }, { timeout: step.timeoutMs || 2000 });
  return { changed: after.changed, verified: after.verified, beforeHash, afterHash: hash(after.text), chars: after.text.length, adapter: after.adapter };
}
module.exports = { editorOperation };
