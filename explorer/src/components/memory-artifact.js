/** Text-only parsing: renderers create React elements, never trust artifact HTML. */
export function safeArtifactLink(value) {
  const href = String(value || '').trim();
  if (!href || /[\u0000-\u0020\u007f]/.test(href)) return null;
  if (href.startsWith('#')) return href;
  if (/^https?:\/\//i.test(href)) {
    try { return new URL(href).href; } catch { return null; }
  }
  if (/^mailto:[^@]+@[^@]+$/i.test(href)) return href;
  return null;
}

export function parseUnifiedDiff(value = '') {
  let oldLine = null;
  let newLine = null;
  let inHunk = false;
  let additions = 0;
  let deletions = 0;
  const lines = String(value).replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const rows = lines.map(text => {
    const hunk = text.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      inHunk = true;
      return { kind: 'hunk', text };
    }
    if (text.startsWith('diff --git ') || text.startsWith('@@@')) inHunk = false;
    if (inHunk && text.startsWith('+')) {
      additions++;
      return { kind: 'addition', text: text.slice(1), newLine: newLine++ };
    }
    if (inHunk && text.startsWith('-')) {
      deletions++;
      return { kind: 'deletion', text: text.slice(1), oldLine: oldLine++ };
    }
    if (inHunk && text.startsWith(' ')) {
      return { kind: 'context', text: text.slice(1), oldLine: oldLine++, newLine: newLine++ };
    }
    return { kind: 'meta', text };
  });
  return { rows, additions, deletions };
}

export function splitTableRow(line) {
  let value = line.trim();
  if (value.startsWith('|')) value = value.slice(1);
  if (value.endsWith('|') && !value.endsWith('\\|')) value = value.slice(0, -1);
  const cells = [];
  let cell = '';
  let codeFence = 0;
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '\\' && value[i + 1] === '|') { cell += '|'; i++; continue; }
    if (value[i] === '`') {
      const run = value.slice(i).match(/^`+/)[0];
      if (!codeFence) codeFence = run.length;
      else if (codeFence === run.length) codeFence = 0;
      cell += run;
      i += run.length - 1;
    } else if (value[i] === '|' && !codeFence) { cells.push(cell.trim()); cell = ''; }
    else cell += value[i];
  }
  cells.push(cell.trim());
  return cells;
}

function tableDivider(line) {
  const cells = splitTableRow(line || '');
  return cells.length > 0 && cells.every(cell => /^:?-{3,}:?$/.test(cell));
}

/** A bounded Markdown subset, retaining unsupported syntax as readable text. */
export function parseArtifactMarkdown(value = '') {
  const lines = String(value).replace(/\r\n/g, '\n').split('\n');
  const blocks = [];
  const listPattern = /^(\s*)([-+*]|\d+[.)])\s+(.+)$/;
  const startsBlock = index => !lines[index]?.trim() || /^(?: {0,3}#{1,6}\s|\s*```|\s*~~~|\s*>|\s*(?:[-+*]|\d+[.)])\s)/.test(lines[index]) || /^(?:\s*[-*_]){3,}\s*$/.test(lines[index]) || (lines[index].includes('|') && tableDivider(lines[index + 1]));
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const fence = line.match(/^\s*(`{3,}|~{3,})(.*)$/);
    if (fence) {
      const content = [];
      i++;
      const closing = new RegExp(`^\\s*${fence[1][0]}{${fence[1].length},}\\s*$`);
      while (i < lines.length && !closing.test(lines[i])) content.push(lines[i++]);
      if (i < lines.length) i++;
      blocks.push({ type: 'code', language: fence[2].trim(), text: content.join('\n') });
      continue;
    }
    const heading = line.match(/^ {0,3}(#{1,6})\s+(.+?)(?:\s+#+\s*)?$/);
    if (heading) { blocks.push({ type: 'heading', level: heading[1].length, text: heading[2] }); i++; continue; }
    if (/^(?:\s*[-*_]){3,}\s*$/.test(line)) { blocks.push({ type: 'rule' }); i++; continue; }
    if (line.includes('|') && tableDivider(lines[i + 1])) {
      const header = splitTableRow(line);
      const align = splitTableRow(lines[i + 1]).map(cell => cell.startsWith(':') && cell.endsWith(':') ? 'center' : cell.endsWith(':') ? 'right' : 'left');
      const rows = [];
      i += 2;
      while (i < lines.length && lines[i].trim() && lines[i].includes('|')) rows.push(splitTableRow(lines[i++]));
      blocks.push({ type: 'table', header, align, rows });
      continue;
    }
    if (/^\s*>/.test(line)) {
      const content = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) content.push(lines[i++].replace(/^\s*> ?/, ''));
      blocks.push({ type: 'quote', blocks: parseArtifactMarkdown(content.join('\n')) });
      continue;
    }
    const list = line.match(listPattern);
    if (list) {
      const indent = list[1].length;
      const ordered = /^\d/.test(list[2]);
      const items = [];
      while (i < lines.length) {
        const next = lines[i].match(listPattern);
        if (!next || next[1].length !== indent || /^\d/.test(next[2]) !== ordered) break;
        let text = next[3];
        const task = text.match(/^\[([ xX])\]\s+(.*)$/);
        if (task) text = task[2];
        i++;
        const children = [];
        while (i < lines.length && lines[i].trim() && lines[i].match(/^\s*/)[0].length > indent) children.push(lines[i++].slice(indent + 2));
        items.push({ text, checked: task ? task[1].toLowerCase() === 'x' : null, blocks: parseArtifactMarkdown(children.join('\n')) });
      }
      blocks.push({ type: 'list', ordered, start: ordered ? parseInt(list[2], 10) : undefined, items });
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && !startsBlock(i)) paragraph.push(lines[i++]);
    blocks.push({ type: 'paragraph', text: paragraph.join('\n') });
  }
  return blocks;
}
