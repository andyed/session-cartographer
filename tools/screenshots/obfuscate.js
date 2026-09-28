import { createHash, randomBytes } from 'node:crypto';
import path from 'node:path';

const adjectives = 'amber arctic autumn azure bright cedar coral crystal dusk ember fern golden hazel indigo ivory jade lunar maple mist moss ocean olive opal quiet river silver solar spruce stone velvet violet willow winter zephyr'.split(' ');
const nouns = 'atlas beacon bridge brook canvas cloud compass delta field forest garden harbor island lantern meadow mosaic orbit paper peak prism ridge signal spring studio summit trail valley wave window'.split(' ');
const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Presentation aliases only: this is not a general secret or prose redactor. */
export function obfuscateSnapshot(input, { seed = randomBytes(12).toString('hex'), replacements = {} } = {}) {
  if (!Array.isArray(input.sessions) || !Array.isArray(input.evidenceIndex)) throw new Error('Expected a Memory state snapshot with sessions and evidenceIndex.');
  const projects = new Set(input.groups || []);
  const paths = new Set();
  const filenames = new Set();
  const sessions = new Set(input.sessions.map(s => s.id));
  const collect = value => {
    if (!value || typeof value !== 'object') return;
    for (const [key, item] of Object.entries(value)) {
      if (['project', 'group', 'repo'].includes(key) && typeof item === 'string' && item) projects.add(item);
      if (key === 'projects' && Array.isArray(item)) item.filter(x => typeof x === 'string').forEach(x => projects.add(x));
      if (['path', 'file_path', 'cwd', 'transcript', 'transcript_path'].includes(key) && typeof item === 'string' && item.includes('/')) paths.add(item);
      if (['files', 'files_changed'].includes(key) && Array.isArray(item)) item.filter(x => typeof x === 'string').forEach(x => paths.add(x));
      collect(item);
    }
  };
  collect(input);
  for (const file of paths) {
    const base = path.posix.basename(file);
    if (/\.[a-zA-Z0-9]{1,12}$/.test(base)) filenames.add(base);
  }
  // File names also occur only in task titles or edit summaries.
  const strings = value => typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(strings) : [];
  for (const text of strings(input)) {
    for (const match of text.matchAll(/(?<![\w.-])[\w@-]+(?:\.[\w-]+)*\.(?:md|mdx|js|jsx|ts|tsx|json|css|html|sh|py|yml|yaml|toml|swift|rs|png|jpg|svg|txt|csv)(?![\w.-])/g)) filenames.add(match[0]);
  }
  const dictionary = new Map();
  const aliases = new Set();
  function alias(kind, original) {
    const hash = createHash('sha256').update(`${seed}\0${kind}\0${original}`).digest();
    let name = `${adjectives[hash[0] % adjectives.length]}-${nouns[hash[1] % nouns.length]}`;
    if (aliases.has(name)) name += `-${hash.subarray(2, 6).toString('hex')}`;
    aliases.add(name);
    return name;
  }
  for (const project of [...projects].sort()) if (project && project !== 'Unattributed') dictionary.set(project, alias('project', project));
  const conventionalStems = new Set(['readme', 'index', 'main', 'app', 'package', 'config', 'test', 'types', 'utils', 'settings']);
  for (const file of [...filenames].sort()) {
    const extension = path.posix.extname(file);
    const stem = path.posix.basename(file, extension);
    const name = alias('file', file);
    dictionary.set(file, name + extension);
    // Titles often mention a module without its extension. Avoid replacing
    // common English/technical words such as "app" throughout the prose.
    if (stem.length >= 5 && /[a-z][A-Z]|[-_]/.test(stem) && !conventionalStems.has(stem.toLowerCase()) && !dictionary.has(stem)) dictionary.set(stem, name);
  }
  // Preserve identity joins while keeping session identifiers out of the images.
  for (const id of [...sessions].sort()) dictionary.set(id, `session-${createHash('sha256').update(`${seed}\0${id}`).digest('hex').slice(0, 12)}`);
  for (const [real, fake] of Object.entries(replacements)) {
    if (!real || typeof fake !== 'string') throw new Error('Replacements must map nonempty strings to strings.');
    dictionary.set(real, fake);
  }
  const entries = [...dictionary].sort(([a], [b]) => b.length - a.length || a.localeCompare(b));
  const lookup = new Map(entries.map(([a, b]) => [a.toLowerCase(), b]));
  // One pass prevents aliases containing another original name from being rewritten.
  const pattern = entries.length ? new RegExp(`(?<![\\p{L}\\p{N}_-])(?:${entries.map(([key]) => escape(key)).join('|')})(?![\\p{L}\\p{N}_-])`, 'giu') : null;
  const replace = text => {
    let result = pattern ? text.replace(pattern, key => lookup.get(key.toLowerCase())) : text;
    result = result.replace(/\/(?:Users|home)\/[^/\s"'<>]+/g, '/home/demo');
    // Encoded URLs and provider path slugs can otherwise retain the home owner.
    result = result.replace(/%2F(?:Users|home)%2F[^%\s"'<>]+/gi, '%2Fhome%2Fdemo');
    return result;
  };
  const protocol = new Set(['provider', 'providers', 'type', 'category', 'evidence', 'mode', 'status', 'backend', 'quadrant', 'commit_type', 'source', 'scope']);
  const identity = new Set(['id', 'key', 'event_id', 'sessionId', 'session_id', 'session']);
  const transform = (value, field = '') => {
    if (typeof value === 'string') {
      if (protocol.has(field)) return value;
      if (identity.has(field)) return sessions.has(value) ? dictionary.get(value) : value;
      return replace(value);
    }
    if (Array.isArray(value)) {
      if (field === 'events') return value.map(event => Array.isArray(event) ? event.map((item, i) => i === 3 ? transform(item, 'project') : item) : transform(event));
      return value.map(item => transform(item, field));
    }
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      ['projects', 'project_counts'].includes(field) || sessions.has(key) || key.includes('/') ? replace(key) : key,
      transform(item, key),
    ]));
    return value;
  };
  return { snapshot: transform(input), seed, counts: { projects: projects.size, filenames: filenames.size, sessions: sessions.size }, replace };
}
