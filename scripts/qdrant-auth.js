/**
 * qdrant-auth.js — Which API key, if any, a request to Qdrant carries.
 *
 * Why a key at all: turning Qdrant's CORS off stops a web page *reading*
 * :6333, not writing to it. Qdrant 1.12.1 parses a `text/plain` POST, which
 * any page can send without a CORS preflight, as JSON. Measured 2026-10-16
 * with CORS off: a text/plain POST to /collections/<c>/points/delete returned
 * 200 and removed the point. With `service.api_key` set the same request gets
 * 401, and so does the preflight a page would need to attach an `api-key`
 * header itself, so the browser never sends it. `/`, `/healthz` and `/readyz`
 * stay open without a key; everything that reads or writes points does not.
 *
 * Resolution, in order (scripts/qdrant-auth.sh is the shell face of the same
 * rules; tests/unit/qdrant-auth.test.js holds the two to one answer):
 *
 *   1. CARTOGRAPHER_QDRANT_API_KEY. Sent to whatever CARTOGRAPHER_QDRANT_URL
 *      names: the caller set both, so the pairing is theirs.
 *   2. The key file scripts/start-services.sh provisions:
 *      CARTOGRAPHER_QDRANT_API_KEY_FILE, else
 *      ${CARTOGRAPHER_QDRANT_STORAGE:-~/Documents/dev/qdrant-storage}/api-key.
 *      Sent only to a loopback URL. The file belongs to the launcher's
 *      Qdrant, which binds 127.0.0.1, and a user who points the URL at a LAN
 *      or hosted Qdrant must not ship the local key there in cleartext.
 *   3. Neither: no header, which is how every client behaved before keys.
 *
 * Sending a key to a Qdrant that has none is harmless (verified on 1.12.1: an
 * unkeyed server ignores the header), so a stale key file cannot break an
 * unkeyed setup. The file is read per request rather than cached: it is ~65
 * bytes against a network round trip, and a cached miss would leave a
 * long-running Explorer or Turbo keyless after start-services provisions a key.
 *
 * The key is never logged, never put in a URL, and never written to an event
 * row. Only the `api-key` request header carries it.
 */

import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export const QDRANT_KEY_HEADER = 'api-key';

// The host as written, then an optional port. Matched on the literal text, not
// on WHATWG parsing, so the shell's `case` can apply the identical rule: `new
// URL` would also accept LOCALHOST, 127.1 and 2130706433, which the shell
// cannot match, and the two would disagree about where a key goes.
const LOOPBACK_AUTHORITY = /^(localhost|127\.0\.0\.1|\[::1\])(:.*)?$/;

/** Where start-services.sh writes the key; mirrors its QDRANT_STORAGE default. */
export function qdrantKeyFile(env = process.env) {
  if (env.CARTOGRAPHER_QDRANT_API_KEY_FILE) return env.CARTOGRAPHER_QDRANT_API_KEY_FILE;
  const storage = env.CARTOGRAPHER_QDRANT_STORAGE || join(env.HOME || homedir(), 'Documents', 'dev', 'qdrant-storage');
  return join(storage, 'api-key');
}

/**
 * True only for an http(s) URL whose host is written as localhost, 127.0.0.1
 * or [::1]. Any userinfo disqualifies it: in http://localhost:6333@evil.example/
 * the host is evil.example, and a prefix match would have sent it the key.
 */
export function isLoopbackUrl(url) {
  const match = /^https?:\/\/([^/?#]*)/.exec(String(url ?? ''));
  if (!match || match[1].includes('@')) return false;
  return LOOPBACK_AUTHORITY.test(match[1]);
}

function readKeyFile(path) {
  try {
    // First line only, trimmed: an editor's trailing newline or CRLF must not
    // become part of the header value (fetch rejects one that holds a CR/LF).
    return readFileSync(path, 'utf8').split(/\r?\n/, 1)[0].trim();
  } catch {
    return '';
  }
}

/** The key for a request to `url`, or '' when none applies. */
export function qdrantApiKey(url, env = process.env) {
  const explicit = (env.CARTOGRAPHER_QDRANT_API_KEY || '').trim();
  if (explicit) return explicit;
  if (!isLoopbackUrl(url)) return '';
  return readKeyFile(qdrantKeyFile(env));
}

/**
 * fetch() for a Qdrant URL: the same call with the `api-key` header added when
 * a key applies, and unchanged when none does. Takes the caller's own env and
 * fetch so injected test doubles keep working. A keyed request refuses
 * redirects unless the caller chose otherwise, because fetch strips only
 * standard credential headers on a cross-origin redirect, not `api-key`.
 */
export function qdrantFetch(url, init = {}, { env = process.env, fetch = globalThis.fetch } = {}) {
  const key = qdrantApiKey(url, env);
  if (!key) return fetch(url, init);
  // Every caller passes a plain object today; a Headers instance or entry
  // array would spread to nothing and drop Content-Type, so normalise those.
  const headers = init.headers instanceof Headers || Array.isArray(init.headers)
    ? Object.fromEntries(new Headers(init.headers))
    : { ...init.headers };
  return fetch(url, {
    redirect: 'error',
    ...init,
    headers: { ...headers, [QDRANT_KEY_HEADER]: key },
  });
}
