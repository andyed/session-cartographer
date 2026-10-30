import { useEffect, useMemo, useState } from 'react';
import { fetchTranscript } from '../api.js';
import { messageBlocks } from './transcript-navigation.js';
import { readableText } from './evidence-content.js';
import { toolPresentation } from './tool-presentation.js';
import { formatTimeOffset } from './memory-metrics.js';

export default function FileEvidenceHistory({ edits = [], records = [], filePath = '' }) {
  const [open, setOpen] = useState(false), [loaded, setLoaded] = useState({}), [retry, setRetry] = useState(0);
  const paths = useMemo(() => [...new Set(edits.filter(edit => edit.callId && edit.transcript).map(edit => edit.transcript))], [edits]);
  const pathKey = JSON.stringify(paths);
  useEffect(() => {
    if (!open || !paths.length) return;
    const controller = new AbortController();
    Promise.all(paths.map(async path => {
      try { return [path, { data: await fetchTranscript(path, { signal: controller.signal }) }]; }
      catch (error) { return [path, { error: error.message }]; }
    })).then(entries => { if (!controller.signal.aborted) setLoaded(Object.fromEntries(entries)); });
    return () => controller.abort();
  }, [open, pathKey, retry]);
  if (!edits.length) return null;
  const ordered = [...edits].sort((a,b) => b.t-a.t);
  const baseline = ordered.find(edit => Number.isFinite(edit.t))?.t;
  const byId = new Map(records.map(record => [record.id || record.event_id, record]));
  return <details className="fw-file-history" onToggle={event => setOpen(event.currentTarget.open)}>
    <summary>File history ({edits.length})</summary>
    {Number.isFinite(baseline) && <p className="fw-muted">Baseline · <time dateTime={new Date(baseline).toISOString()}>{new Date(baseline).toLocaleString([], {month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})}</time></p>}
    <ol>{ordered.map((edit, i) => {
      const record = byId.get(edit.id);
      const transcript = loaded[edit.transcript];
      const candidates = (transcript?.data?.messages || []).flatMap(message => messageBlocks(message).filter(block => block.type === 'tool_call' && block.callId === edit.callId).map(block => ({...block,messageId:message.uuid})));
      const call = candidates.length === 1 ? candidates[0] : null;
      const sourceTitle = readableText(record?.text || record?.summary) || (call && toolPresentation(call).title) || 'Recorded file edit';
      // The file review already owns the full path; repeat only its local name.
      const name = filePath.split(/[\\/]/).pop();
      const title = filePath && name ? sourceTitle.split(filePath).map((part,index,all) => index < all.length-1 ? part + (/^[\w./-]/.test(all[index+1]) ? filePath : name) : part).join('') : sourceTitle;
      let href;
      if (edit.source !== 'transcript' && edit.id && Number.isFinite(edit.t)) {
        href = `${import.meta.env.BASE_URL || '/'}timeline?${new URLSearchParams({q:edit.id,view:'chronological',from:new Date(edit.t-60000).toISOString(),through:new Date(edit.t+60000).toISOString(),mode:'fixed',lower:'closed'})}`;
      } else if (call) {
        href = `${import.meta.env.BASE_URL || '/'}session/${encodeURIComponent(edit.transcript)}?${new URLSearchParams({uuid:call.messageId,block:call.id,reader:'conversation',return:window.location.pathname+window.location.search})}`;
      }
      const Tag = href ? 'a' : 'div';
      return <li key={edit.id || i}><Tag className="fw-file-history-row" href={href}>
        {Number.isFinite(edit.t) && <time dateTime={new Date(edit.t).toISOString()} title={new Date(edit.t).toLocaleString()}>{formatTimeOffset(edit.t,baseline)}</time>}
        <span data-copy-content>{title}</span>{href ? <span aria-hidden="true">↗</span> : <span className="fw-muted">{!transcript && edit.transcript ? 'Loading source…' : 'Exact source unavailable'}</span>}
      </Tag></li>;
    })}</ol>
    {paths.some(path => loaded[path]?.error) && <div><p role="alert">Some recorded sources could not be loaded.</p><button onClick={() => setRetry(value => value+1)}>Retry sources</button></div>}
  </details>;
}
