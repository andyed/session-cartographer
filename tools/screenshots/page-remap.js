// Render-time name remapping for screenshots. The returned source runs as a
// Playwright init script in every page and frame, before the app's own code:
// it rewrites text nodes, visible attributes and canvas text as they appear,
// and exposes an audit that reports anything the frame still shows that it
// should not. Remapping the rendered text covers every endpoint at once:
// prose, paths, transcripts and diffs, which a data-layer scrubber has to
// chase field by field.
import { createReplacer } from './remap-core.js';

function install(createReplacer, options) {
  const { replace, leaks } = createReplacer(options.entries, { deny: options.deny, watch: options.watch });
  const ATTRIBUTES = ['title', 'alt', 'aria-label', 'aria-description', 'placeholder', 'value', 'data-tooltip'];
  const SKIP = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);
  const canvasText = new Set();

  const fixText = node => {
    if (SKIP.has(node.parentNode?.nodeName)) return;
    const next = replace(node.data);
    if (next !== node.data) node.data = next;
  };
  const fixAttribute = (element, name) => {
    const value = element.getAttribute(name);
    if (value == null) return;
    const next = replace(value);
    if (next !== value) element.setAttribute(name, next);
  };
  const fixElement = element => {
    for (const name of ATTRIBUTES) fixAttribute(element, name);
    if ((element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') && element.value) {
      const next = replace(element.value);
      if (next !== element.value) element.value = next;
    }
  };
  const fixTree = root => {
    if (root.nodeType === 3) return fixText(root);
    if (root.nodeType !== 1 && root.nodeType !== 9 && root.nodeType !== 11) return;
    if (root.nodeType === 1) { if (SKIP.has(root.nodeName)) return; fixElement(root); }
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: node => (SKIP.has(node.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 3) fixText(node); else fixElement(node);
    }
  };

  // Replacements contain no original, so a rewrite settles in one step and
  // the observer's own changes produce no further work.
  new MutationObserver(records => {
    for (const record of records) {
      if (record.type === 'characterData') fixText(record.target);
      else if (record.type === 'attributes') fixAttribute(record.target, record.attributeName);
      else for (const node of record.addedNodes) fixTree(node);
    }
  }).observe(document, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES });
  if (document.documentElement) fixTree(document);
  // React sets an input's value as a property, which no observer sees.
  document.addEventListener('input', event => { if (event.target?.value) fixElement(event.target); }, true);

  // Canvas text is painted, not in the DOM: rewrite it at the draw call, and
  // measure the rewritten string so layout matches what is drawn.
  for (const Context of [globalThis.CanvasRenderingContext2D, globalThis.OffscreenCanvasRenderingContext2D].filter(Boolean)) {
    const proto = Context.prototype;
    for (const method of ['fillText', 'strokeText']) {
      const original = proto[method];
      proto[method] = function (text, ...rest) {
        const next = replace(String(text));
        if (canvasText.size < 20000) canvasText.add(next);
        return original.call(this, next, ...rest);
      };
    }
    const measure = proto.measureText;
    proto.measureText = function (text) { return measure.call(this, replace(String(text))); };
  }

  // What a viewport screenshot of this frame would paint and should not.
  // Only painted text can reach a PNG: text and form values inside the
  // viewport, plus every canvas string (a draw call has no position we can
  // check). Attributes and offscreen text never paint, so they are counted
  // as `unpainted` rather than failing the shot; the remap covers them anyway.
  globalThis.__screenshotAudit = () => {
    fixTree(document);
    const painted = [];
    let unpainted = 0;
    const inView = rect => rect.width > 0 && rect.height > 0 && rect.bottom > 0 && rect.right > 0 && rect.top < innerHeight && rect.left < innerWidth;
    const visible = element => {
      for (let e = element; e && e.nodeType === 1; e = e.parentElement) {
        const style = getComputedStyle(e);
        if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
      }
      return true;
    };
    const note = (where, text, shown) => {
      for (const leak of leaks(text)) {
        if (shown) painted.push({ where, leak, context: String(text).slice(0, 160) }); else unpainted += 1;
      }
    };
    const walker = document.createTreeWalker(document, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
      acceptNode: node => (SKIP.has(node.nodeName) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const range = document.createRange();
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === 3) {
        if (!leaks(node.data).length) continue;
        range.selectNodeContents(node);
        note('text', node.data, [...range.getClientRects()].some(inView) && visible(node.parentElement));
      } else {
        for (const name of ATTRIBUTES) { const value = node.getAttribute(name); if (value) note(`@${name}`, value, false); }
        if ((node.tagName === 'INPUT' || node.tagName === 'TEXTAREA') && node.value) note('value', node.value, inView(node.getBoundingClientRect()) && visible(node));
      }
    }
    for (const text of canvasText) note('canvas', text, true);
    return { painted, unpainted };
  };
}

/** Init-script source for `context.addInitScript({ content })`. */
export function pageRemapScript({ entries, deny = [], watch = [] }) {
  return `(${install.toString()})(${createReplacer.toString()}, ${JSON.stringify({ entries, deny, watch })});`;
}
