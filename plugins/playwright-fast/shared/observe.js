const DEFAULT_MAX_CHARS = 6000;

// ARIA snapshot supplies accessible names; DOM metadata deliberately does not
// approximate the accessible-name algorithm or expose form values.
async function observe(locator, step = {}) {
  const maxChars = Math.max(1, Math.min(30000, step.maxChars ?? DEFAULT_MAX_CHARS));
  // Failure recovery prioritizes a single visible dialog without guessing among peers.
  let scope = 'requested';
  if (step.preferDialog) {
    const dialogs = locator.locator('dialog:visible,[role="dialog"]:visible,[role="alertdialog"]:visible');
    if (await dialogs.count() === 1) { locator = dialogs; scope = 'dialog'; }
  }
  const snapshot = await locator.ariaSnapshot({ timeout: step.timeoutMs || 2000 });
  const safeSnapshot = snapshot.replace(/^(\s*- (?:textbox|searchbox|spinbutton|combobox)(?:\s+"(?:[^"\\]|\\.)*")?(?:\s+\[[^\]]*\])*)\s*:.*$/gm, '$1');
  const metadata = await locator.evaluate((root) => {
    const controls = [], dialogs = [], editors = [];
    const limit = 40, scanLimit = 4000;
    let scanned = 0, truncated = false;
    const clip = value => value ? value.slice(0, 180) : undefined;
    const visible = el => {
      let ancestor = el;
      while (ancestor) {
        if (ancestor.closest('[hidden],[aria-hidden="true"],[inert]')) return false;
        ancestor = ancestor.getRootNode().host;
      }
      const style = getComputedStyle(el);
      return style.visibility !== 'hidden' && style.visibility !== 'collapse' && el.getClientRects().length > 0;
    };
    const labelText = el => {
      if (!el || el.matches('input,textarea,select,[contenteditable]')) return '';
      const copy = el.cloneNode(true);
      copy.querySelectorAll('input,textarea,select,[contenteditable],script,style').forEach(node => node.remove());
      return copy.textContent.trim();
    };
    const describe = el => {
      const result = { tag: el.localName };
      for (const [key, attr] of [['id', 'id'], ['role', 'role'], ['ariaLabel', 'aria-label'], ['placeholder', 'placeholder'], ['type', 'type']]) {
        const value = clip(el.getAttribute(attr));
        if (value) result[key] = value;
      }
      const labels = Array.from(el.labels || []).map(label => labelText(label)).filter(Boolean);
      if (labels.length) result.labels = labels.map(clip).slice(0, 3);
      const labelledBy = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)
        .map(id => labelText(el.getRootNode().getElementById?.(id))).filter(Boolean);
      if (labelledBy.length) result.labelledBy = labelledBy.map(clip).slice(0, 3);
      // Only suggest selectors proven unique in this document. No guessed label locators.
      if (el.getRootNode() === document) {
        const candidates = [];
        if (el.id) candidates.push('#' + CSS.escape(el.id));
        if (el.getAttribute('placeholder')) candidates.push(el.localName + '[placeholder=' + CSS.escape(el.getAttribute('placeholder')) + ']');
        if (el.getAttribute('aria-label')) candidates.push(el.localName + '[aria-label=' + CSS.escape(el.getAttribute('aria-label')) + ']');
        for (const css of candidates) {
          if (document.querySelectorAll(css).length === 1) { result.target = { css }; break; }
        }
      }
      if ('disabled' in el || el.hasAttribute('aria-disabled')) result.disabled = !!el.disabled || el.getAttribute('aria-disabled') === 'true';
      return result;
    };
    const add = (list, value) => { if (list.length < limit) list.push(value); else truncated = true; };
    const roots = [root];
    while (roots.length && scanned < scanLimit) {
      const subtree = roots.shift();
      const walker = document.createTreeWalker(subtree, NodeFilter.SHOW_ELEMENT);
      let el = subtree.nodeType === Node.ELEMENT_NODE ? subtree : walker.nextNode();
      while (el && scanned < scanLimit) {
        scanned++;
        if (el.shadowRoot) roots.push(el.shadowRoot);
        if (visible(el)) {
          if (el.matches('button,input,textarea,select,a[href],[role],[contenteditable="true"],[tabindex]')) add(controls, describe(el));
          if (el.matches('dialog,[role="dialog"],[role="alertdialog"]')) add(dialogs, describe(el));
          if (el.matches('.monaco-editor,.CodeMirror,.cm-editor,.ace_editor,textarea,[contenteditable="true"]')) {
            const info = describe(el);
            info.kind = el.matches('.monaco-editor') ? 'monaco' : el.matches('.CodeMirror,.cm-editor') ? 'codemirror' : el.matches('.ace_editor') ? 'ace' : el.localName === 'textarea' ? 'textarea' : 'contenteditable';
            info.category = ['monaco', 'codemirror', 'ace'].includes(info.kind) ? 'code' : 'field';
            if (info.category === 'field') info.codeEditorConfirmed = false;
            // Do not advertise the implementation textarea inside a code editor as a second editor.
            if (info.category === 'code' || !el.parentElement?.closest('.monaco-editor,.CodeMirror,.cm-editor,.ace_editor')) add(editors, info);
          }
        }
        el = walker.nextNode();
      }
      if (el) truncated = true;
    }
    if (roots.length) truncated = true;
    return { controls, dialogs, editors, metadataTruncated: truncated };
  }, undefined, { timeout: step.timeoutMs || 2000 });
  return { scope, ariaSnapshot: safeSnapshot.slice(0, maxChars), ...metadata,
    truncated: safeSnapshot.length > maxChars || metadata.metadataTruncated };
}

module.exports = { observe };
