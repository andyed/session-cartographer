import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { safeArtifactLink } from '../../explorer/src/components/memory-artifact.js';

// EventCard puts a corpus `url` into an anchor. The corpus holds whatever a
// hook or agent wrote: measured 2026-10-16, 4,485 https, 12 http, 399 empty
// and one bare slug, which rendered as a broken link relative to the Explorer.
// React 19 rewrites only a javascript: href, so the card goes through the same
// allowlist as the Memory Desk and shows a refused url as text.
const card = fs.readFileSync(new URL('../../explorer/src/components/EventCard.jsx', import.meta.url), 'utf8');

test('event urls link only when the allowlist admits them', () => {
  for (const url of [
    'https://github.com/andyed/session-cartographer/commit/041f3e1',
    'http://example.com/paper.pdf?page=2#fig-3',
    'mailto:reader@example.com',
  ]) assert.equal(safeArtifactLink(url), url, url);
  for (const url of [
    'javascript:alert(document.domain)',
    ' JavaScript:alert(1)',
    'java\tscript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    '//evil.example/path',
    'notes-2026-research-slug',
    '',
    undefined,
  ]) assert.equal(safeArtifactLink(url), null, String(url));
});

test('corpus hrefs are allowlisted and transcript hrefs use the canonical local builder', () => {
  const hrefs = [...card.matchAll(/\bhref=\{([^}]*)\}/g)].map(match => match[1].trim());
  // The header link icon, the commit's "view on GitHub", the detail's url.
  assert.equal(hrefs.filter(name => name === 'href').length, 3);
  assert.equal(hrefs.filter(name => name === 'transcriptHref').length, 2);
  assert.equal(hrefs.length, 5);
  for (const expression of hrefs) {
    assert.match(expression, /^\w+$/, `href={${expression}} is an expression, not a guarded name`);
    if (expression === 'transcriptHref') {
      assert.ok(/const transcriptHref = eventTranscriptHref\(/.test(card));
      continue;
    }
    // assert.ok, not assert.match: a failing match prints the whole component.
    assert.ok(new RegExp(`\\bconst ${expression} = safeArtifactLink\\(`).test(card), `href={${expression}} does not come from safeArtifactLink`);
  }
});
