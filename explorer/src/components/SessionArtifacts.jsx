import PathContext from './PathContext.jsx';
import { commonDirectory, relativeDisplayPath } from './path-presentation.js';
import { useEffect, useRef, useState } from 'react';
import { apiRequest, isDemoMode } from '../api.js';
import '../styles/session-artifacts.css';

// Only the image-serving endpoint returned by our API may become an image src.
// Transcript text is evidence, never an instruction to contact another host.
function localPreview(value, endpoint = '/api/session/artifact') {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin && url.pathname === endpoint
      ? url.pathname + url.search : null;
  } catch { return null; }
}

function evidenceHref(transcriptPath, evidence, timestamp) {
  if (evidence.eventId) {
    const time = new Date(timestamp).getTime();
    if (!Number.isFinite(time)) return null;
    const params = new URLSearchParams({ q: evidence.eventId, view: 'chronological', from: new Date(time - 60000).toISOString(), through: new Date(time + 60000).toISOString(), mode: 'fixed', lower: 'closed' });
    return `${import.meta.env.BASE_URL || '/'}timeline?${params}`;
  }
  if (!transcriptPath || !evidence.messageId) return null;
  const params = new URLSearchParams({ uuid: evidence.messageId, return: window.location.pathname + window.location.search });
  if (evidence.blockId) params.set('block', evidence.blockId);
  return `${import.meta.env.BASE_URL || '/'}session/${encodeURIComponent(transcriptPath)}?${params}`;
}

function ActionIcon({ source = false, download = false }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {download ? <><path d="M12 3v12m-4-4 4 4 4-4M4 16v5h16v-5" /></> : source ? <><path d="M14 3H5v18h14V8z" /><path d="M14 3v5h5M8 12h8M8 16h6" /></> : <><path d="M14 3h7v7M21 3l-9 9" /><path d="M10 5H3v16h16v-7" /></>}
  </svg>;
}

function EvidenceActions({ evidence = [], name, transcriptPath, onLocate, onOpenTranscript, timestamp, fullRow = false, rowContent }) {
  const references = evidence.filter(item => item.messageId || item.eventId);
  const linked = item => Boolean(evidenceHref(transcriptPath, item, timestamp) || (item.messageId && onLocate));
  const referenceName = item => (item.label || (item.eventId ? 'Commit record' : 'Transcript')).replace(/^Recorded /, '').replace(/^git_commit event$/, 'Commit record').replace(/^git commit output$/, 'Git output');
  const link = (item, index) => {
    if (!linked(item)) return <div key={item.eventId || index} className="session-artifact-event"><span>{referenceName(item)}</span></div>;
    const label = references.length === 1 ? `View ${item.eventId ? 'commit' : 'transcript'} evidence for ${name}` : `${referenceName(item)} for ${name}`;
    return <a key={`${item.blockId || item.messageId}-${index}`} className={`${rowContent && references.length === 1 ? 'session-artifact-commit-target' : 'session-artifact-icon'}${references.length > 1 ? ' session-artifact-source-link' : fullRow ? ' session-artifact-output-evidence' : ''}`} href={evidenceHref(transcriptPath, item, timestamp) || '#'} title={item.label || label} aria-label={label}
      onClick={event => {
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        if (item.eventId) return;
        if (onLocate) { event.preventDefault(); onLocate(item); }
        else if (onOpenTranscript && transcriptPath) { event.preventDefault(); onOpenTranscript(transcriptPath, item.messageId, '', item.blockId); }
      }}>{references.length === 1 && rowContent}<ActionIcon source />{references.length > 1 && <span>{referenceName(item)}</span>}</a>;
  };
  if (!references.length) return rowContent || null;
  if (references.length === 1 && linked(references[0])) return link(references[0], 0);
  return <details className={`session-artifact-references${rowContent ? ' session-artifact-commit' : fullRow ? ' session-artifact-output-evidence' : ''}`}><summary className={rowContent ? "session-artifact-commit-target" : "session-artifact-icon"} aria-label={`View ${references.length} evidence references for ${name}`} title={`Evidence for ${name}`}>{rowContent}<span className="session-artifact-commit-cue"><ActionIcon source /><span className="session-artifact-ref-count">{references.length}</span><span className="session-artifact-ref-close" aria-hidden="true">▴</span></span></summary><div className="session-artifact-reference-list">{references.map(link)}</div></details>;
}

function Artifact({ artifact, transcriptPath, onLocate, onOpenTranscript }) {
  const [broken, setBroken] = useState(false);
  const preview = artifact.status === 'available' ? localPreview(artifact.previewUrl) : null;
  const name = artifact.name || artifact.path?.split(/[\\/]/).at(-1) || 'Recorded image';
  useEffect(() => { setBroken(false); }, [preview]);
  const provenance = artifact.source === 'created' ? 'Created in this session' : 'Referenced in this session';
  return <figure className="session-artifact" data-artifact-status={broken ? 'preview-error' : artifact.status}>
    {preview && !broken
      ? <a className="session-artifact-preview" href={preview} target="_blank" rel="noopener noreferrer" aria-label={`Open image: ${name}`}>
        <img src={preview} alt={name} loading="lazy" decoding="async" onError={() => setBroken(true)} />
      </a>
      : <div className="session-artifact-placeholder"><strong>{broken ? 'Preview could not be loaded' : artifact.status === 'missing' ? 'Image no longer available' : 'Preview unavailable'}</strong><span>{broken ? 'The reference is retained below.' : artifact.reason || 'The recorded reference has no local image preview.'}</span></div>}
    <figcaption title={provenance}>
      <strong className="session-artifact-name" title={artifact.path || name}>{name}</strong><span className="sr-only">{provenance}</span>
      <div className="session-artifact-actions">
        {preview && <a className="session-artifact-icon" href={preview} target="_blank" rel="noopener noreferrer" aria-label={`Open original image: ${name}`} title={`Open image: ${name}`}><ActionIcon /></a>}
        <EvidenceActions evidence={artifact.evidence} name={name} transcriptPath={transcriptPath} onLocate={onLocate} onOpenTranscript={onOpenTranscript} />
      </div>
    </figcaption>
  </figure>;
}

function OutputList({ items, kind, transcriptPath, onLocate, onOpenTranscript, onReviewDocument, reviewablePaths = [] }) {
  const reviewable = reviewablePaths instanceof Set ? reviewablePaths : new Set(reviewablePaths);
  const root = kind === 'documents' ? commonDirectory(items.map(item=>item.path)) : '';
  return <><PathContext root={root} /><ul className="session-artifact-outputs">{items.map(item => {
    const name = kind === 'documents' ? relativeDisplayPath(item.path,root) || item.name : item.subject || item.shortHash || item.hash;
    const canReview = kind === 'documents' && onReviewDocument && reviewable.has(item.path);
    if (kind === 'commits') return <li key={item.id || item.hash} className="session-artifact-commit-row">
      <EvidenceActions evidence={item.evidence} timestamp={item.timestamp} name={name} transcriptPath={transcriptPath} onLocate={onLocate} onOpenTranscript={onOpenTranscript}
        rowContent={<span className="session-artifact-output-title"><strong data-copy-content>{name}</strong><code>{item.shortHash || item.hash?.slice(0, 8)}</code></span>} />
    </li>;
    return <li key={item.id || item.path || item.hash} data-has-evidence={item.evidence?.some(source => source.messageId || source.eventId) || undefined}>
      <div className="session-artifact-output-title">{canReview ? <button className="session-artifact-review" onClick={() => onReviewDocument(item)} aria-label={`Review document: ${name}`} title={item.path}>{name}</button> : <strong data-copy-content title={item.path}>{name}</strong>}{kind === 'documents' ? <><span className="session-artifact-operation">{item.source === 'created' ? 'Created' : 'Edited'}</span>{item.status === 'missing' && <span className="session-artifact-availability">Missing now</span>}</> : <code>{item.shortHash || item.hash?.slice(0, 8)}</code>}</div>
      <div className="session-artifact-output-actions">{kind === 'documents' && localPreview(item.downloadUrl, '/api/session/document') && <a className="session-artifact-icon" href={localPreview(item.downloadUrl, '/api/session/document')} download aria-label={`Download document: ${name}`} title={`Download ${name}`}><ActionIcon download /></a>}</div><EvidenceActions evidence={item.evidence} timestamp={item.timestamp} name={name} transcriptPath={transcriptPath} onLocate={onLocate} onOpenTranscript={onOpenTranscript} fullRow />
    </li>;
  })}</ul></>;
}

/** Session outputs, with exact source evidence and local image previews. */
function LocalSessionArtifacts({ transcriptPath, sessionId, compact = false, onLocate, onOpenTranscript, onReviewDocument, reviewablePaths }) {
  const root = useRef(null);
  const requestKey = transcriptPath || (sessionId ? `session:${sessionId}` : '');
  const [activated, setActivated] = useState('');
  const [result, setResult] = useState({ key: '', status: 'idle', artifacts: [] });
  const [retry, setRetry] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [expandedDocuments, setExpandedDocuments] = useState(false);
  const [expandedCommits, setExpandedCommits] = useState(false);
  useEffect(() => {
    setExpanded(false);
    setExpandedDocuments(false);
    setExpandedCommits(false);
    if (!requestKey) return;
    if (!compact || typeof IntersectionObserver === 'undefined') { setActivated(requestKey); return; }
    const observer = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting)) { setActivated(requestKey); observer.disconnect(); }
    }, { rootMargin: '160px' });
    if (root.current) observer.observe(root.current);
    return () => observer.disconnect();
  }, [requestKey, compact]);
  useEffect(() => {
    if (!requestKey || activated !== requestKey) return;
    const controller = new AbortController();
    const params = new URLSearchParams(transcriptPath ? { path: transcriptPath, ...(sessionId ? { session_id: sessionId } : {}) } : { session_id: sessionId });
    setResult({ key: requestKey, status: 'loading', artifacts: [] });
    apiRequest(`/api/session/artifacts?${params}`, { signal: controller.signal })
      .then(data => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(data.artifacts)) throw new Error('The session-artifact response was incomplete.');
        setResult({ key: requestKey, status: 'ready', path: data.path || transcriptPath, artifacts: data.artifacts, documents: data.documents || [], commits: data.commits || [] });
      })
      .catch(error => {
        if (controller.signal.aborted) return;
        const missingTranscript = !transcriptPath && (error.code === 'TRANSCRIPT_NOT_FOUND' || error.status === 404);
        setResult({ key: requestKey, status: missingTranscript ? 'missing-transcript' : 'error', artifacts: [], error: error.message });
      });
    return () => controller.abort();
  }, [requestKey, activated, retry, transcriptPath, sessionId]);

  if (!requestKey) return null;
  const current = result.key === requestKey ? result : { status: 'idle', artifacts: [] };
  if (current.status === 'missing-transcript') return null;
  const available = current.artifacts.filter(item => item.status === 'available' && localPreview(item.previewUrl));
  const unavailable = current.artifacts.filter(item => item.status !== 'available' || !localPreview(item.previewUrl));
  const recordedDocuments = (current.documents || []).filter(item => ['created', 'edited'].includes(item.source));
  const documents = recordedDocuments.filter(item => item.status === 'current');
  const missingDocuments = recordedDocuments.filter(item => item.status !== 'current');
  const commits = current.commits || [];
  // Optional evidence earns space only when it contains something to inspect.
  if (current.status === 'ready' && !available.length && !documents.length && !commits.length) return null;
  if (current.status === 'idle' || current.status === 'loading') return <div ref={root} aria-hidden="true" style={{ height: 1 }} />;
  const visible = compact && !expanded ? available.slice(0, 4) : available;
  const Heading = compact ? 'h4' : 'h3';
  const renderArtifact = artifact => <Artifact key={`${requestKey}:${artifact.id}`} artifact={artifact} transcriptPath={current.path || transcriptPath} onLocate={onLocate} onOpenTranscript={onOpenTranscript} />;
  const evidenceProps = { transcriptPath: current.path || transcriptPath, onLocate, onOpenTranscript, onReviewDocument, reviewablePaths };
  return <section ref={root} className={`session-artifacts${compact ? ' session-artifacts-compact' : ''}`} aria-label="Session artifacts">
    {current.status === 'error' && <div className="session-artifacts-error" role="status"><p>Could not load session artifacts. {current.error}</p><button onClick={() => setRetry(value => value + 1)}>Retry artifacts</button></div>}
    {current.status === 'ready' && <>
      {documents.length > 0 && <div className="session-artifacts-category" data-artifact-kind="documents"><Heading>Documents ({documents.length})</Heading><OutputList items={compact && !expandedDocuments ? documents.slice(0, 4) : documents} kind="documents" {...evidenceProps} />{compact && documents.length > 4 && <button aria-expanded={expandedDocuments} onClick={() => setExpandedDocuments(value => !value)}>{expandedDocuments ? 'Show fewer documents' : `Show all ${documents.length} documents`}</button>}{missingDocuments.length > 0 && <details className="session-artifacts-unavailable"><summary>Unavailable document references ({missingDocuments.length})</summary><OutputList items={missingDocuments} kind="documents" {...evidenceProps} /></details>}</div>}
      {commits.length > 0 && <div className="session-artifacts-category" data-artifact-kind="commits"><Heading>Commits ({commits.length})</Heading><OutputList items={compact && !expandedCommits ? commits.slice(0, 4) : commits} kind="commits" {...evidenceProps} />{compact && commits.length > 4 && <button aria-expanded={expandedCommits} onClick={() => setExpandedCommits(value => !value)}>{expandedCommits ? 'Show fewer commits' : `Show all ${commits.length} commits`}</button>}</div>}
      {available.length > 0 && <div className="session-artifacts-category" data-artifact-kind="images"><Heading>Images ({available.length})</Heading><div className="session-artifacts-grid">{visible.map(renderArtifact)}</div>
      {compact && available.length > 4 && <button className="session-artifacts-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>{expanded ? 'Show fewer images' : `Show all ${available.length} images`}</button>}
      {unavailable.length > 0 && <details className="session-artifacts-unavailable"><summary>Unavailable image references ({unavailable.length})</summary><div className="session-artifacts-grid">{unavailable.map(renderArtifact)}</div></details>}
      </div>}
    </>}
  </section>;
}

// The static demo does not ship local session image files.
export default function SessionArtifacts(props) {
  return isDemoMode ? null : <LocalSessionArtifacts {...props} />;
}
