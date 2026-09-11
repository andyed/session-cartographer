import test from 'node:test';
import assert from 'node:assert/strict';
import { parseArtifactMarkdown, parseUnifiedDiff, safeArtifactLink, splitTableRow } from '../../explorer/src/components/memory-artifact.js';

test('diff preserves file/hunk provenance and advances old/new lines independently', () => {
  const diff = [
    'diff --git a/plan.md b/plan.md', '--- a/plan.md', '+++ b/plan.md',
    '@@ -10,3 +10,4 @@ phase one', ' context', '-old decision', '+new decision', '+next step', ' tail',
    '@@ -80 +81 @@ phase two', '--- markdown rule', '+++ markdown addition', '\\ No newline at end of file',
    'diff --git a/new.md b/new.md', 'new file mode 100644', '--- /dev/null', '+++ b/new.md',
    '@@ -0,0 +1,2 @@', '+# New artifact', '+body', '',
  ].join('\n');
  const parsed = parseUnifiedDiff(diff);
  assert.equal(parsed.additions, 5);
  assert.equal(parsed.deletions, 2);
  assert.deepEqual(parsed.rows.filter(row => row.kind === 'context'), [
    { kind: 'context', text: 'context', oldLine: 10, newLine: 10 },
    { kind: 'context', text: 'tail', oldLine: 12, newLine: 13 },
  ]);
  assert.deepEqual(parsed.rows.find(row => row.text === '-- markdown rule'), { kind: 'deletion', text: '-- markdown rule', oldLine: 80 });
  assert.deepEqual(parsed.rows.find(row => row.text === '++ markdown addition'), { kind: 'addition', text: '++ markdown addition', newLine: 81 });
  assert.deepEqual(parsed.rows.find(row => row.text === '# New artifact'), { kind: 'addition', text: '# New artifact', newLine: 1 });
  assert.equal(parsed.rows.find(row => row.text === '+++ b/new.md').kind, 'meta');
  assert.equal(parsed.rows.find(row => row.text.startsWith('\\ No newline')).oldLine, undefined);
});

test('binary and combined diffs stay legible without invented line numbers or counts', () => {
  const parsed = parseUnifiedDiff('Binary files a/image and b/image differ\n@@@ -1,2 -1,2 +1,3 @@@\n++combined content\n');
  assert.equal(parsed.additions, 0);
  assert.ok(parsed.rows.every(row => row.kind === 'meta' && !row.oldLine && !row.newLine));
  assert.deepEqual(parseUnifiedDiff(''), { rows: [], additions: 0, deletions: 0 });
});

test('artifact links only admit explicit safe destinations', () => {
  assert.equal(safeArtifactLink('https://example.com/docs?q=one#two'), 'https://example.com/docs?q=one#two');
  assert.equal(safeArtifactLink('mailto:reader@example.com'), 'mailto:reader@example.com');
  assert.equal(safeArtifactLink('#next-step'), '#next-step');
  for (const href of ['javascript:alert(1)', 'java\nscript:alert(1)', 'data:text/html,hello', '//example.com', 'file:///etc/passwd', '/etc/passwd', '../README.md', 'https://', 'https://example.com/\u0000', 'vbscript:alert(1)']) {
    assert.equal(safeArtifactLink(href), null, href);
  }
});

test('Markdown retains semantic hierarchy, fenced source, tasks, and table cells', () => {
  const source = [
    '# Return to work', '', 'First paragraph', 'continued here.', '',
    '## In flight', '- [x] Capture context', '  - Preserve evidence', '- [ ] Review the result', '',
    '3. Read artifact', '4. Continue thread', '',
    '| Kind | Evidence |', '| :--- | ---: |', '| Edit | `a|b` |', '| Note | escaped \\| pipe |', '',
    '> Carry the decision forward.', '',
    '```js', 'const text = "<script>alert(1)</script>";', '## still code', '```', '',
    '<img src=x onerror=alert(1)>',
  ].join('\n');
  const blocks = parseArtifactMarkdown(source);
  assert.deepEqual(blocks.map(block => block.type), ['heading', 'paragraph', 'heading', 'list', 'list', 'table', 'quote', 'code', 'paragraph']);
  assert.equal(blocks[0].level, 1);
  assert.equal(blocks[1].text, 'First paragraph\ncontinued here.');
  assert.equal(blocks[3].items[0].checked, true);
  assert.equal(blocks[3].items[1].checked, false);
  assert.equal(blocks[3].items[0].blocks[0].items[0].text, 'Preserve evidence');
  assert.equal(blocks[4].start, 3);
  assert.deepEqual(blocks[5].align, ['left', 'right']);
  assert.deepEqual(blocks[5].rows, [['Edit', '`a|b`'], ['Note', 'escaped | pipe']]);
  assert.equal(blocks[7].text, 'const text = "<script>alert(1)</script>";\n## still code');
  assert.equal(blocks[8].text, '<img src=x onerror=alert(1)>');
});

test('unclosed fences retain remaining content and table code pipes do not become columns', () => {
  assert.deepEqual(parseArtifactMarkdown('~~~text\n## title\n<div>literal</div>'), [{ type: 'code', language: 'text', text: '## title\n<div>literal</div>' }]);
  assert.deepEqual(splitTableRow('| ``a`|b`` | escaped \\| pipe |'), ['``a`|b``', 'escaped | pipe']);
  assert.deepEqual(parseArtifactMarkdown(''), []);
});
