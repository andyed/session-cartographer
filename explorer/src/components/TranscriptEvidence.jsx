import { useEffect, useMemo, useState } from 'react';
import EvidenceValue from './EvidenceValue.jsx';
import { readableText } from './evidence-content.js';
import { excerpt, outputText, searchResultLinks, toolPresentation, toolInput } from './tool-presentation.js';
import { fetchSummary } from './review-bundles.js';
import PathContext from './PathContext.jsx';
import { commonDirectory, relativeDisplayPath } from './path-presentation.js';
import { formatTimeOffset } from './memory-metrics.js';
import { buildEvidenceReview, operationResults, operationState } from './evidence-review.js';

function RequestContent({ block, filePath, renderText }) {
  let input = toolInput(block);
  if (filePath && input && typeof input === 'object' && !Array.isArray(input)) {
    const { file_path, filePath: inputPath, path, ...content } = input;
    input = content;
  }
  if (input && typeof input.old_string === 'string' && typeof input.new_string === 'string') {
    const { old_string, new_string, ...context } = input;
    return <section className="tr-requested-change" aria-label="Requested replacement">
      {Object.keys(context).length > 0 && <EvidenceValue value={context} renderText={renderText} />}
      <h4>Requested</h4>
      <del><pre data-copy-content>{renderText ? renderText(old_string) : old_string}</pre></del>
      <ins><pre data-copy-content>{renderText ? renderText(new_string) : new_string}</pre></ins>
    </section>;
  }
  return <EvidenceValue value={input} renderText={renderText} />;
}

function ResultReview({ result, canonical, active, onLocate, renderText }) {
  const [open, setOpen] = useState(true);
  useEffect(() => { if (active) setOpen(true); }, [active]);
  const error = result.isError || result.status === 'error';
  const text = outputText(result.output);
  const label = error ? 'Recorded error' : 'Response';
  return <details id={canonical ? result.id : undefined} className="tr-tool-result" data-result-block-id={result.id} data-active={active || undefined} data-error={error || undefined} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><span>{open ? label : excerpt(text, 160) || label}</span>{result.orphan && <span>Call not recorded</span>}<span aria-hidden="true">▾</span></summary>
    <EvidenceValue value={result.output} renderText={renderText} />
    <button className="tr-source-action" aria-label={`Locate ${error ? 'error' : 'response'}${text ? `: ${excerpt(text, 100)}` : ''}`} title="Locate original response" onClick={() => onLocate({ messageId: result.messageId, blockId: result.id })}>↗</button>
  </details>;
}

export function ToolEvidenceBlock({ block, pairedCall, pairedResults, resultAnchorMode = 'copy', anchorMode = 'canonical', activeBlockId, bundlePages, membership, active, onLocate, renderText, renderContent }) {
  const [open, setOpen] = useState(false);
  const call = block.type === 'tool_call';
  const pairing = call ? operationResults(block, pairedResults) : { results: [], missingResultIds: [] };
  const activeHere = active || activeBlockId === block.id || pairing.results.some(result => result.id === activeBlockId);
  useEffect(() => { if (activeHere) setOpen(true); }, [activeHere]);
  const presentation = toolPresentation(block, pairedCall);
  const links = bundlePages || searchResultLinks(block);
  const inline = call && pairedResults !== undefined && !links.length && !membership && !/(?:^|[_.])Web(?:Search|Fetch)$/i.test(block.name || '');
  const state = inline ? operationState(block, pairing.results, pairing.missingResultIds) : null;
  return <div className="tr-tool-evidence" data-active={activeHere || undefined}>
    {links.length > 0 && <section className="tr-web-results" aria-label="Web search results">
      <ul>{links.map(link => <li key={link.url}>
        <a href={link.url} target="_blank" rel="noopener noreferrer"><span>{link.title}</span><small>{link.domain} ↗</small></a>
        {link.fetches?.map(fetch => <div className="tr-fetch-bundle" key={fetch.call.id}>
          {fetch.results.length ? fetch.results.map(result => {
            const content = fetchSummary(result);
            return <details className="tr-fetched-page" key={result.id} data-fetch-result={result.id} data-error={content.error || undefined}>
              <summary><span aria-hidden="true">{content.error ? '⚠' : '▸'}</span><span className="tr-fetch-preview" data-copy-content>{content.summary || 'Empty response'}</span><span className="tr-fetch-expanded">{content.error ? 'Fetch error' : 'Retrieved passage'}</span></summary>
              <div className="tr-fetch-content" data-copy-content>{renderContent ? renderContent(content.text) : <pre>{renderText(content.text)}</pre>}</div>
              {fetch.prompt && <details className="tr-fetch-request"><summary>Fetch request</summary><p className="tr-fetch-purpose" data-copy-content>{fetch.prompt}</p></details>}
              <button aria-label={`View fetch evidence for ${link.title}`} title="View fetch evidence" onClick={() => onLocate({messageId:result.messageId,blockId:result.id})}>↗</button>
            </details>;
          }) : <p className="tr-fetch-pending">No fetch result recorded</p>}
        </div>)}
      </li>)}</ul>
    </section>}
    <details id={anchorMode === 'canonical' ? block.id : undefined} className="tr-tool" data-source-block-id={block.id} data-active={activeHere || undefined} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><strong>{links.length ? 'Search evidence' : membership ? `${block.type === 'tool_call' ? 'Fetch' : 'Fetch output'} · ${membership.title}` : presentation.title}</strong>{state ? <span className="tr-tool-status" title={state.label} aria-label={state.label}>{state.glyph}</span> : presentation.status && <span className="tr-tool-status">{presentation.status}</span>}{!open && !links.length && !membership && presentation.detail && <span className="tr-tool-preview">{presentation.detail}</span>}</summary>
    {membership && <button onClick={() => onLocate({messageId:membership.searchMessageId,blockId:membership.searchBlockId})}>Review with search results ↑</button>}
    {!links.length && (call ? <RequestContent block={block} renderText={renderText} /> : <EvidenceValue value={block.output} renderText={renderText} />)}
    {inline && pairing.results.map(result => <ResultReview key={result.id} result={result} canonical={resultAnchorMode === 'canonical'} active={activeBlockId === result.id} onLocate={onLocate} renderText={renderText} />)}
    {inline && pairing.missingResultIds.length > 0 && <p className="tr-result-gap">{pairing.missingResultIds.length} recorded {pairing.missingResultIds.length === 1 ? 'response is' : 'responses are'} unavailable.</p>}
    {!inline && call && block.resultIds?.map((resultId, index) => <button key={resultId} onClick={() => onLocate({ blockId: resultId })}>Go to result{block.resultIds.length > 1 ? ` ${index + 1}` : ''} ↓</button>)}
    {!call && block.callMessageId && <button onClick={() => onLocate({ messageId: block.callMessageId, blockId: block.callBlockId })}>Go to call ↑</button>}
  </details></div>;
}

function ErrorSource({ error, onLocate }) {
  const text = readableText(error.result?.output ?? error.summary);
  return <button className="tr-error-source" onClick={() => onLocate({ messageId: error.messageId || error.result?.messageId, blockId: error.blockId })}>
    <span>{text || error.name || 'Recorded tool error'}</span><span aria-hidden="true">↗</span>
  </button>;
}

function FileOperation({ operation, filePath, baseline, onLocate }) {
  const [open, setOpen] = useState(operation.state.key === 'error');
  const errorIds = new Set(operation.errors.map(error => error.blockId));
  return <details className="tr-file-operation" data-call-block-id={operation.id} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><strong>{operation.call.name}</strong><span className="tr-operation-state" title={operation.state.label} aria-label={operation.state.label}>{operation.state.glyph}</span>{operation.timestamp && Number.isFinite(Date.parse(operation.timestamp)) && <time dateTime={operation.timestamp} title={operation.timestamp}>{formatTimeOffset(Date.parse(operation.timestamp), baseline)}</time>}<span aria-hidden="true">▾</span></summary>
    <RequestContent block={operation.call} filePath={filePath} />
    {operation.errors.map(error => <ErrorSource key={error.blockId} error={error} onLocate={onLocate} />)}
    {operation.results.filter(result => !errorIds.has(result.id)).map(result => <ResultReview key={result.id} result={result} canonical={false} onLocate={onLocate} />)}
    {operation.missingResultIds.length > 0 && <p className="tr-result-gap">Recorded response unavailable.</p>}
    <button className="tr-source-action" title="Locate original request" aria-label={`Locate ${operation.call.name} request for ${filePath}`} onClick={() => onLocate(operation.sources[0])}>↗</button>
  </details>;
}

function FileEvidenceBundle({ file, root, onLocate }) {
  const [open, setOpen] = useState(file.errorCount > 0);
  const baseline = Math.max(...file.operations.map(operation => Date.parse(operation.timestamp)).filter(Number.isFinite));
  const parts = [file.readCount && `${file.readCount} ${file.readCount === 1 ? 'read' : 'reads'}`, file.writeCount && `${file.writeCount} ${file.writeCount === 1 ? 'write request' : 'write requests'}`, file.errorCount && `${file.errorCount} recorded ${file.errorCount === 1 ? 'error' : 'errors'}`].filter(Boolean);
  return <details className="tr-file-evidence" data-file-path={file.path} open={open} onToggle={event => setOpen(event.currentTarget.open)}>
    <summary><strong title={file.path}>{relativeDisplayPath(file.path, root)}</strong><span>{parts.join(' · ')}</span><span aria-hidden="true">▾</span></summary>
    <details className="tr-file-location"><summary>Location</summary><code data-copy-content>{file.path}</code></details>
    {Number.isFinite(baseline) && <p className="tr-file-baseline">Baseline · <time dateTime={new Date(baseline).toISOString()} title={new Date(baseline).toLocaleString()}>{new Date(baseline).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</time></p>}
    {file.operations.map(operation => <FileOperation baseline={baseline} key={operation.id} operation={operation} filePath={file.path} onLocate={onLocate} />)}
  </details>;
}

export function TranscriptEvidenceIndex({ evidence, messages = [], onLocate }) {
  const review = useMemo(() => buildEvidenceReview(evidence, messages), [evidence, messages]);
  const root = commonDirectory(review.files.map(file => file.path));
  if (!review.files.length && !review.activity.length && !review.errors.length) return null;
  return <section className="tr-evidence-index" aria-label="Conversation evidence">
    <h3>Conversation evidence</h3>
    {review.files.length > 0 && <div className="tr-file-bundles"><PathContext root={root} />{review.files.map(file => <FileEvidenceBundle key={file.id} file={file} root={root} onLocate={onLocate} />)}</div>}
    {review.errors.length > 0 && <details className="tr-other-errors" open><summary>Recorded errors ({review.errors.length})</summary>{review.errors.map(error => <ErrorSource key={error.blockId} error={error} onLocate={onLocate} />)}</details>}
    {review.activity.length > 0 && <details className="tr-other-activity"><summary>Other activity ({review.activity.length})</summary>{review.activity.map(operation => <ToolEvidenceBlock key={operation.id} block={operation.call} pairedResults={operation.results} anchorMode="copy" resultAnchorMode="copy" onLocate={onLocate} renderText={text => text} />)}</details>}
  </section>;
}
