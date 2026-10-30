// A deliberately small lexical reader for literal tool inputs inside the
// functions.exec wrapper. It never runs JavaScript, expands variables, parses
// a shell command, or matches strings/comments as executable tool calls.
function literals(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const c = source[i];
    if (/\s/.test(c)) { i++; continue; }
    if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end + 1; continue; }
    if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2; continue; }
    if ('"\'`'.includes(c)) {
      const quote = c;
      let value = '';
      let valid = true;
      i++;
      while (i < source.length && source[i] !== quote) {
        if (quote === '`' && source.startsWith('${', i)) valid = false;
        if (source[i] !== '\\') { value += source[i++]; continue; }
        i++;
        const escaped = source[i++];
        const simple = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0' };
        if (escaped === 'u' || escaped === 'x') {
          const length = escaped === 'u' ? 4 : 2;
          const hex = source.slice(i, i + length);
          if (!new RegExp(`^[a-fA-F0-9]{${length}}$`).test(hex)) valid = false;
          else value += String.fromCharCode(parseInt(hex, 16));
          i += length;
        } else if (escaped !== '\n') value += simple[escaped] ?? escaped;
      }
      if (source[i] !== quote) valid = false;
      i++;
      tokens.push({ type: 'string', value: valid ? value : null });
      continue;
    }
    const identifier = source.slice(i).match(/^[A-Za-z_$][\w$]*/)?.[0];
    if (identifier) { tokens.push({ type: 'identifier', value: identifier }); i += identifier.length; continue; }
    tokens.push({ type: 'punctuation', value: c });
    i++;
  }
  return tokens;
}

export function literalToolInputs(source, { requireWorkdir = true } = {}) {
  if (typeof source !== 'string') return [];
  const tokens = literals(source);
  const calls = [];
  for (let i = 0; i < tokens.length - 4; i++) {
    if (tokens[i].type !== 'identifier' || tokens[i].value !== 'tools' || tokens[i + 1].value !== '.' || tokens[i + 3].value !== '(') continue;
    const name = tokens[i + 2].value;
    if (name === 'apply_patch' && tokens[i + 4].type === 'string' && tokens[i + 5]?.value === ')') {
      if (tokens[i + 4].value) calls.push({ name, input: tokens[i + 4].value });
    } else if (name === 'exec_command' && tokens[i + 4].value === '{') {
      const input = {};
      let depth = 1;
      for (let j = i + 5; j < tokens.length && depth; j++) {
        if (tokens[j].value === '{' && tokens[j].type === 'punctuation') depth++;
        if (tokens[j].value === '}' && tokens[j].type === 'punctuation') depth--;
        if (depth === 1 && ['cmd', 'workdir'].includes(tokens[j].value) && tokens[j + 1]?.value === ':' && tokens[j + 2]?.type === 'string' && [',', '}'].includes(tokens[j + 3]?.value)) input[tokens[j].value] = tokens[j + 2].value;
      }
      if (input.cmd && (!requireWorkdir || input.workdir)) calls.push({ name, input });
    }
  }
  return calls;
}
