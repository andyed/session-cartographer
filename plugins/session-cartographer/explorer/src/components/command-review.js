// Display-only lexical cues, never shell execution or a claim about results.
// Unsupported/dynamic expressions stay in the exact request disclosure.
function segments(source) {
  const result = []; let words = [], word = '', quote = '', started = false;
  const flush = () => { if (started) words.push(word); word = ''; started = false; };
  const end = () => { flush(); if (words.length) result.push(words); words = []; };
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && /["\\$`]/.test(source[i+1] || '')) word += source[++i];
      else word += c;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; started = true; }
    else if (c === '\\' && i+1 < source.length) { word += source[++i]; started = true; }
    else if (c === '#' && !started) { while (i+1 < source.length && source[i+1] !== '\n') i++; }
    else if (';|&\n'.includes(c)) end();
    else if (/\s/.test(c)) flush();
    else { word += c; started = true; }
  }
  // An unfinished quoted string is not a reliably recorded literal.
  if (!quote) end();
  return result;
}

const dynamic = value => /[$`]/.test(value);
const basename = value => value.split(/[\\/]/).pop();
const fileLike = value => !dynamic(value) && !value.startsWith('-') && /(?:^|\/)[\w.*?@+-][\w.*?@ +\/-]*\.[\w*?]{1,12}$/.test(value);
const optionValues = new Set(['--glob','-g','--type','-t','--type-not','-T','--include','--exclude','--exclude-dir','--ignore-file','--encoding','--max-count','-m','-A','-B','-C','--context','--after-context','--before-context','--threads','-j','--color','--colors']);
const fileOptions = new Set(['--glob','-g','--include']);

function anchors(pattern) {
  if (dynamic(pattern)) return [];
  // Literal anchors aid scanning; the tooltip/disclosure retains exact regex syntax.
  return pattern.split('|').flatMap(part => {
    const plain = part.replace(/\\[sSdDwWbB][*+?]?/g, ' ').replace(/\[[^\]]*\]/g, ' ').replace(/\\([.\-])/g, '$1').replace(/[()^?*+{}"']/g, ' ');
    return (plain.match(/[A-Za-z_][\w.-]*(?:[ =]+[A-Za-z_][\w.-]*)*/g) || []).map(value => value.replace(/[. -]+$/, ''));
  }).filter(Boolean);
}

export function commandReview(input) {
  const args = input && typeof input === 'object' ? input : {};
  const commands = Array.isArray(input) ? input.map(item => item?.Command).filter(value => typeof value === 'string')
    : typeof (args.command || args.cmd) === 'string' ? [args.command || args.cmd] : [];
  if (!commands.length) return null;
  const operations = [], cues = [], seen = new Set();
  const add = (kind, text, source = text) => {
    const key = `${kind}:${kind === 'file' ? source : text}`;
    if (text && !seen.has(key)) { seen.add(key); cues.push({kind,text,source}); }
  };
  const file = value => {
    if (!fileLike(value)) return;
    const parts = value.split('/');
    add('file', value.startsWith('/') ? parts.slice(-2).join('/') : value.replace(/^\.\//,''), value);
  };
  const pattern = value => anchors(value).forEach(text => add('term',text,value));
  for (const source of commands) for (const recorded of segments(source)) {
    const words = [...recorded];
    while (/^[A-Za-z_]\w*=/.test(words[0] || '')) words.shift();
    const program = basename(words.shift() || '');
    if (!program || dynamic(program) || ['cd','pwd','head','tail','true'].includes(program)) continue;
    let operation;
    if (['grep','rg','egrep','fgrep'].includes(program)) {
      operation = words.includes('--files') ? 'List files' : 'Search';
      let hasPattern = operation === 'List files', positional = false;
      for (let i=0;i<words.length;i++) {
        const word = words[i];
        if (!positional && word === '--') { positional = true; continue; }
        if (!positional && ['-e','--regexp'].includes(word)) { pattern(words[++i] || ''); hasPattern = true; continue; }
        if (!positional && word.startsWith('--regexp=')) { pattern(word.slice(9)); hasPattern = true; continue; }
        if (!positional && /^--(?:include|glob)=/.test(word)) { file(word.slice(word.indexOf('=')+1)); continue; }
        if (!positional && optionValues.has(word)) { const value=words[++i] || ''; if (fileOptions.has(word)) file(value); continue; }
        if (!positional && word.startsWith('-')) continue;
        if (!hasPattern) { pattern(word); hasPattern = true; } else file(word);
      }
    } else {
      if (program === 'git') {
        const verb = words.find(word => /^(?:status|diff|log|show|commit|push|add|checkout|switch)$/.test(word));
        operation = verb ? `Git ${verb}` : 'Git';
      } else operation = ({sed:'Read',cat:'Read',less:'Read',ls:'List files',find:'Find files',xcodebuild:'Build'})[program] || program;
      words.forEach(file);
    }
    if (!operations.includes(operation)) operations.push(operation);
  }
  const description = typeof args.description === 'string' ? args.description.trim() : '';
  // Secondary operations matter (for example git status after a source search).
  operations.slice(1).forEach(operation => add('operation',operation));
  const files = cues.filter(cue => cue.kind === 'file');
  for (const cue of files) {
    const parts = cue.source.split('/'); let count = cue.text.split('/').length;
    while (count < parts.length && files.some(other => other !== cue && other.source.split('/').slice(-count).join('/') === parts.slice(-count).join('/'))) count++;
    cue.text = parts.slice(-count).join('/');
  }
  return { title: description || operations[0] || 'Command', cues };
}
