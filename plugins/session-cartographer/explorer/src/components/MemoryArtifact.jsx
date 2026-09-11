import { useMemo, useState } from 'react';
import { parseArtifactMarkdown, parseUnifiedDiff, safeArtifactLink } from './memory-artifact.js';
import '../styles/memory-artifact.css';

function inline(text, depth = 0) {
  if (depth > 8) return text;
  const tokens = /(`+)([^`]+?)\1|(!?)\[([^\]\n]+)\]\(([^\s)]+)(?:\s+"[^"]*")?\)|\*\*([^*]+)\*\*|__([^_]+)__|\*([^*\n]+)\*|_([^_\n]+)_|~~([^~]+)~~/g;
  const children = [];
  let start = 0;
  let match;
  while ((match = tokens.exec(text))) {
    if (match.index > start) children.push(text.slice(start, match.index));
    const key = match.index;
    if (match[1]) children.push(<code key={key}>{match[2]}</code>);
    else if (match[4]) {
      const href = !match[3] && safeArtifactLink(match[5]);
      children.push(href
        ? <a key={key} href={href.startsWith('#') ? `#memory-artifact-${href.slice(1)}` : href} target={href.startsWith('#') ? undefined : '_blank'} rel="noreferrer noopener">{inline(match[4], depth + 1)}</a>
        : <span key={key} title={match[5]}>{match[3] ? `Image: ${match[4]}` : inline(match[4], depth + 1)} <span className="memory-artifact-link-path">({match[5]})</span></span>);
    } else if (match[6] || match[7]) children.push(<strong key={key}>{inline(match[6] || match[7], depth + 1)}</strong>);
    else if (match[8] || match[9]) children.push(<em key={key}>{inline(match[8] || match[9], depth + 1)}</em>);
    else children.push(<del key={key}>{inline(match[10], depth + 1)}</del>);
    start = tokens.lastIndex;
  }
  if (start < text.length) children.push(text.slice(start));
  return children;
}

function MarkdownBlocks({ blocks }) {
  return blocks.map((block, index) => {
    if (block.type === 'heading') {
      const Heading = `h${block.level}`;
      const slug = block.text.toLowerCase().replace(/[^\p{L}\p{N}\s-]/gu, '').trim().replace(/\s+/g, '-');
      return <Heading key={index} id={`memory-artifact-${slug}`}>{inline(block.text)}</Heading>;
    }
    if (block.type === 'code') return <div className="memory-artifact-code" key={index}>{block.language && <span className="memory-artifact-language">{block.language}</span>}<pre tabIndex={0}><code>{block.text}</code></pre></div>;
    if (block.type === 'rule') return <hr key={index} />;
    if (block.type === 'quote') return <blockquote key={index}><MarkdownBlocks blocks={block.blocks} /></blockquote>;
    if (block.type === 'list') {
      const List = block.ordered ? 'ol' : 'ul';
      return <List key={index} start={block.start}>{block.items.map((item, itemIndex) => <li key={itemIndex} className={item.checked === null ? undefined : 'memory-artifact-task'}>
        {item.checked !== null && <span className="memory-artifact-checkbox" role="img" aria-label={item.checked ? 'Completed' : 'Incomplete'}>{item.checked ? '☑' : '☐'}</span>}
        {inline(item.text)}<MarkdownBlocks blocks={item.blocks} />
      </li>)}</List>;
    }
    if (block.type === 'table') return <div key={index} className="memory-artifact-table-scroll" tabIndex={0} role="region" aria-label="Markdown table"><table>
      <thead><tr>{block.header.map((cell, col) => <th scope="col" key={col} style={{ textAlign: block.align[col] }}>{inline(cell)}</th>)}</tr></thead>
      <tbody>{block.rows.map((row, rowIndex) => <tr key={rowIndex}>{block.header.map((_, col) => <td key={col} style={{ textAlign: block.align[col] }}>{inline(row[col] || '')}</td>)}</tr>)}</tbody>
    </table></div>;
    return <p key={index}>{inline(block.text)}</p>;
  });
}

function Diff({ diff }) {
  const parsed = useMemo(() => parseUnifiedDiff(diff), [diff]);
  return <div className="memory-artifact-diff">
    <div className="memory-artifact-diff-summary" aria-label="Change summary">
      <span className="memory-artifact-added">+{parsed.additions} added</span>
      <span className="memory-artifact-deleted">−{parsed.deletions} removed</span>
      <span>Old → new line numbers</span>
    </div>
    <div className="memory-artifact-diff-scroll" tabIndex={0} role="region" aria-label="Unified diff">
      <table className="memory-artifact-diff-table">
        <caption className="memory-artifact-sr-only">Current workspace changes. Old and new line numbers appear before each line.</caption>
        <thead className="memory-artifact-sr-only"><tr><th>Old line</th><th>New line</th><th>Change</th><th>Content</th></tr></thead>
        <tbody>{parsed.rows.map((row, index) => <tr key={index} className={`memory-artifact-diff-${row.kind}`}>
          <td className="memory-artifact-line">{row.oldLine ?? ''}</td>
          <td className="memory-artifact-line">{row.newLine ?? ''}</td>
          <td className="memory-artifact-sign" aria-label={row.kind === 'addition' ? 'Added' : row.kind === 'deletion' ? 'Removed' : undefined}>{row.kind === 'addition' ? '+' : row.kind === 'deletion' ? '−' : ''}</td>
          <td className="memory-artifact-diff-text"><code>{row.text || ' '}</code></td>
        </tr>)}</tbody>
      </table>
    </div>
  </div>;
}

export default function MemoryArtifact({ review, mode = 'file' }) {
  const [sourcePath, setSourcePath] = useState(null);
  const path = review?.path || review?.name || '';
  const markdown = /\.(?:md|markdown|mdown)$/i.test(path);
  const showSource = sourcePath === path;
  const blocks = useMemo(() => markdown ? parseArtifactMarkdown(review?.content || '') : [], [markdown, review?.content]);
  if (!review) return null;
  if (mode === 'changes') return <section className="memory-artifact" aria-label="Artifact changes">
    {review.diff ? <Diff diff={review.diff} /> : <p className="memory-artifact-empty">{review.diffReason || 'No current changes to display.'}</p>}
  </section>;
  return <section className="memory-artifact" aria-label="Artifact reader">
    <div className="memory-artifact-toolbar">
      <span>{markdown ? 'Markdown document' : 'Source file'}</span>
      {markdown && <div className="memory-artifact-view-options" role="group" aria-label="Document view">
        <button type="button" aria-pressed={!showSource} onClick={() => setSourcePath(null)}>Preview</button>
        <button type="button" aria-pressed={showSource} onClick={() => setSourcePath(path)}>Source</button>
      </div>}
    </div>
    {review.content === '' ? <p className="memory-artifact-empty">This file is empty.</p> : markdown && !showSource
      ? <article className="memory-artifact-prose"><MarkdownBlocks blocks={blocks} /></article>
      : <pre className="memory-artifact-source" tabIndex={0} aria-label="File source"><code>{review.content}</code></pre>}
  </section>;
}
