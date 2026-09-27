/**
 * The day digest for the Memory Desk: GET /api/memory/day.
 *
 * The endpoint runs `scripts/session-digest.js --day` and returns what it
 * printed. The command line and the scheduled pulse run that same script, so
 * the desk cannot show a different count for the same day: there is one fold,
 * not a second one to keep in step. A child process also keeps the fold's cost
 * (reading the changelog, ~1.3 s with its git checks on a 140k-event corpus)
 * off the event loop that answers recall.
 *
 * Read-only. The digest reads the changelog and asks git; the child runs with
 * GIT_OPTIONAL_LOCKS=0 so a `git status` from the desk never takes the index
 * lock out from under a session committing in the same repository.
 */
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const DAY_DIGEST_SCHEMA = 'carto.day-digest/1';
const SCRIPT = fileURLToPath(new URL('../../scripts/session-digest.js', import.meta.url));
const DAY = /^\d{4}-\d{2}-\d{2}$/;
// Project names are directory basenames; the digest expands aliases itself.
const PROJECTS = /^[\w.@+-]+(?:,[\w.@+-]+)*$/;
const MAX_RUNNING = 3;
const TIMEOUT_MS = 30000;

export class DayDigestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * The client sends a calendar date it computed in its own time zone, never
 * "today": the server's clock and the reader's can disagree about which day
 * that is, and the response names the zone it used.
 */
export function readDayParams(params) {
  const day = params.get('day') || '';
  if (!DAY.test(day)) throw new DayDigestError(400, 'day must be a date, YYYY-MM-DD.');
  const format = params.get('format') || 'json';
  if (format !== 'json' && format !== 'md') throw new DayDigestError(400, 'format must be json or md.');
  const projects = params.get('projects');
  if (projects !== null && (projects.length > 2000 || !PROJECTS.test(projects))) {
    throw new DayDigestError(400, 'projects must be a comma-separated list of project names.');
  }
  return { day, format, projects: projects || null };
}

export function createDayDigestSource({ corpusRoot, script = SCRIPT, env = process.env, run = execFile, timeoutMs = TIMEOUT_MS } = {}) {
  const running = new Map();
  return function dayDigest({ day, format, projects }) {
    // Repeated clicks on one day share a run instead of starting another.
    const key = JSON.stringify([day, format, projects]);
    if (running.has(key)) return running.get(key);
    if (running.size >= MAX_RUNNING) {
      return Promise.reject(new DayDigestError(503, 'Several day digests are already running. Try again in a moment.'));
    }
    const args = [script, '--day', day, format === 'md' ? '--md' : '--json'];
    if (projects) args.push('--projects', projects);
    const pending = new Promise((resolve, reject) => {
      run(process.execPath, args, {
        env: { ...env, CARTOGRAPHER_DEV_DIR: corpusRoot, GIT_OPTIONAL_LOCKS: '0' },
        timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, encoding: 'utf8',
      }, (error, stdout, stderr) => {
        if (error) {
          const detail = String(stderr || error.message || '').trim().split('\n').pop().slice(0, 300);
          // The script's own exit codes: 2 is a bad request, 1 is a missing
          // event log. A missing log is an outage and must not read as a quiet day.
          if (error.killed) reject(new DayDigestError(504, `The day digest did not finish within ${Math.round(timeoutMs / 1000)} s.`));
          else if (error.code === 2) reject(new DayDigestError(400, detail || 'The day digest refused this request.'));
          else if (error.code === 1) reject(new DayDigestError(503, detail || 'The event log is unavailable.'));
          else reject(new DayDigestError(500, `The day digest failed: ${detail || 'no diagnostics'}`));
          return;
        }
        if (format === 'md') {
          resolve({ schema: DAY_DIGEST_SCHEMA, format: 'md', day, text: stdout.replace(/\n$/, '') });
          return;
        }
        let doc;
        try { doc = JSON.parse(stdout); } catch { doc = null; }
        if (!doc || doc.schema !== DAY_DIGEST_SCHEMA) {
          reject(new DayDigestError(500, `The day digest did not return ${DAY_DIGEST_SCHEMA}.`));
          return;
        }
        resolve(doc);
      });
    });
    running.set(key, pending);
    pending.then(() => running.delete(key), () => running.delete(key));
    return pending;
  };
}
