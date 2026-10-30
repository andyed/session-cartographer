import { useMemo } from 'react';
import SessionArtifacts from './SessionArtifacts.jsx';
import { sessionReview } from './session-review.js';
import { fetchSummary } from './review-bundles.js';

export default function SessionReview({messages,bundles,session,onLocate,onReviewDocument,reviewablePaths,renderContent}) {
  const review=useMemo(()=>sessionReview(messages,bundles),[messages,bundles]);
  const source=(item,label)=><button className="tr-source-action" aria-label={`View evidence for ${label}`} title="View evidence" onClick={()=>onLocate(item)}>↗</button>;
  const conclusion=review.conclusion;
  const conclusionIndexed = review.sections.some(item => item.blockId === conclusion?.blockId);
  const lead=conclusion?.text.split(/\n\s*\n/)[0].slice(0,400);
  return <div className="tr-session-review" aria-label="Session summary">
    <SessionArtifacts compact transcriptPath={session.transcript} sessionId={session.id} onLocate={onLocate} onReviewDocument={onReviewDocument} reviewablePaths={reviewablePaths}/>
    {review.sections.length > 0 && <section className="tr-recorded-conclusions" aria-label="Recorded conclusions">
      <h2>Recorded conclusions</h2>
      <p className="tr-review-attribution">From assistant responses across this session; later work may revise these claims and plans.</p>
      {['findings','decisions','validation','next'].map(kind => {
        const entries = review.sections.filter(item => item.kind === kind);
        if (!entries.length) return null;
        const render = (item, index) => <article key={`${item.blockId}:${index}`}>
          <header><h3 data-copy-content>{item.heading}</h3>{source(item,item.heading)}</header>{Number.isFinite(Date.parse(item.timestamp)) && <time data-copy-content dateTime={item.timestamp}>{new Date(item.timestamp).toLocaleString([], {month:"short",day:"numeric",hour:"numeric",minute:"2-digit"})}</time>}
          <div data-copy-content>{renderContent(item.text)}</div>
        </article>;
        return <div key={kind}>{entries.slice(-2).map(render)}{entries.length > 2 && <details><summary>Earlier {kind === 'next' ? 'plans' : kind} ({entries.length - 2})</summary>{entries.slice(0,-2).map(render)}</details>}</div>;
      })}
    </section>}
    {conclusion && !conclusionIndexed && <section className="tr-review-conclusion"><header><h2>Last response</h2>{source(conclusion,'last response')}</header><div className="tr-summary-lead" data-copy-content>{renderContent(lead+(lead.length===400 && conclusion.text.length>400?'…':''))}</div>{conclusion.text!==lead && <details><summary>Read full response</summary><div data-copy-content>{renderContent(conclusion.text)}</div></details>}</section>}
    {conclusionIndexed && <details><summary>Last response</summary><div data-copy-content>{renderContent(conclusion.text)}</div>{source(conclusion,"last response")}</details>}
    {review.request && <details className="tr-review-request"><summary>Original request</summary><div data-copy-content>{renderContent(review.request.text)}</div>{source(review.request,'original request')}</details>}
    {review.pages.length>0 && <section><h2>Research</h2><ul className="tr-review-pages">{review.pages.map(page=><li key={page.url}>
      <header><a href={page.url} target="_blank" rel="noopener noreferrer" data-copy-content>{page.title}<small>{page.domain} ↗</small></a>{source(page,page.title)}</header>
      {page.fetches.flatMap(fetch=>fetch.results.map(result=>{const content=fetchSummary(result);return <details key={result.id} data-error={content.error || undefined}><summary data-copy-content>{content.error?'⚠ ':''}{content.summary || 'Empty response'}</summary><div data-copy-content>{renderContent(content.text)}</div>{source({messageId:result.messageId,blockId:result.id},page.title+' fetched passage')}</details>;}))}
    </li>)}</ul></section>}
    {review.failures.length>0 && <details className="tr-review-failures"><summary>Recorded failures ({review.failures.length})</summary><ul>{review.failures.map(item=><li key={item.blockId}><header><strong>{item.name}</strong>{source(item,'recorded failure')}</header><div data-copy-content>{renderContent(item.text)}</div></li>)}</ul></details>}
  </div>;
}
