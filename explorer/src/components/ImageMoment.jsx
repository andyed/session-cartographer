import { useState } from 'react';
import ProjectBadge from './ProjectBadge';
import AgentBadge from './AgentBadge';
import { relativeTime } from './EventGroup.jsx';
import '../styles/image-moments.css';

const BASE = import.meta.env.BASE_URL || '/';

// Only the image endpoint our API returned may become an src or href.
// Transcript text is evidence, never an instruction to contact another host.
function localImage(value) {
  if (typeof value !== 'string' || !value) return null;
  try {
    const url = new URL(value, window.location.origin);
    return url.origin === window.location.origin && url.pathname === '/api/images/file' ? url.pathname + url.search : null;
  } catch { return null; }
}

// Tiles keep the image's shape within limits, so a panorama or a phone
// screenshot cannot take the row.
const aspectOf = image => (image.width > 0 && image.height > 0 ? Math.min(2.4, Math.max(0.5, image.width / image.height)) : 4 / 3);

function Thumb({ image }) {
  const [broken, setBroken] = useState(false);
  const src = localImage(image.thumb), href = localImage(image.full);
  const size = image.width ? ` · ${image.width} × ${image.height}` : '';
  return <li className="image-moment-thumb" style={{ '--aspect': aspectOf(image) }}>
    <a className="image-moment-frame" href={href || undefined} target="_blank" rel="noopener noreferrer" aria-label={`Open image: ${image.name}`} title={`${image.path}${size}${image.copy ? ' · shown from a copy' : ''}`}>
      {src && !broken
        ? <img src={src} alt="" loading="lazy" decoding="async" onError={() => setBroken(true)} />
        : <span className="image-moment-missing">Preview unavailable</span>}
    </a>
    <span className="image-moment-name" title={image.name}>{image.name}</span>
  </li>;
}

function transcriptHref(image) {
  if (!image?.transcript || !image.link?.messageId) return null;
  const params = new URLSearchParams({ reader: 'conversation', uuid: image.link.messageId, return: window.location.pathname + window.location.search });
  if (image.link.blockId) params.set('block', image.link.blockId);
  return `${BASE}session/${encodeURIComponent(image.transcript)}?${params}`;
}

const clock = ms => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

/**
 * One session's burst of written images in the event feed, shown by a few
 * representatives. Newest first, like the feed around it: the image a burst
 * ended on leads.
 */
export default function ImageMoment({ moment, onOpenTranscript, onInspect, onProjectClick }) {
  const [expanded, setExpanded] = useState(false);
  const total = moment.images.length;
  const shown = [...(expanded ? moment.images : moment.representatives)].reverse();
  const omitted = total - moment.representatives.length;
  const iso = new Date(moment.t).toISOString();
  const span = moment.t - moment.start >= 60 * 1000 ? `${clock(moment.start)}–${clock(moment.t)}` : clock(moment.t);
  const href = transcriptHref(moment.newest);
  const label = moment.session || 'Unattributed session';
  return <section className="image-moment" data-moment-key={moment.key} tabIndex={-1} aria-label={`${total} ${total === 1 ? 'image' : 'images'} written in ${label}`}>
    <header className="image-moment-head">
      <time dateTime={iso} title={new Date(moment.t).toLocaleString()}>{relativeTime(iso)}</time>
      <span className="image-moment-count">{total} {total === 1 ? 'image' : 'images'} written · {span}</span>
      {onInspect && moment.sessionId
        ? <button className="image-moment-session" title="Inspect this session" onClick={event => onInspect({ session_id: moment.sessionId }, event.currentTarget)}>{label}</button>
        : <span className="image-moment-session">{label}</span>}
      {moment.project && <ProjectBadge project={moment.project} onClick={onProjectClick} />}
      {moment.provider && <AgentBadge provider={moment.provider} />}
      {href && <a className="image-moment-transcript" href={href} title="Open transcript at the newest image" aria-label="Open transcript at the newest image"
        onClick={event => {
          if (!onOpenTranscript || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
          event.preventDefault();
          onOpenTranscript(moment.newest.transcript, moment.newest.link.messageId, '', moment.newest.link.blockId);
        }}>
        <svg aria-hidden="true" width="16" height="16" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}><path strokeLinecap="round" strokeLinejoin="round" d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" /></svg>
      </a>}
    </header>
    <ul className="image-moment-strip" data-expanded={expanded || undefined}>
      {shown.map(image => <Thumb key={image.id} image={image} />)}
    </ul>
    {omitted > 0 && <button className="image-moment-more" aria-expanded={expanded} onClick={() => setExpanded(value => !value)}>
      {expanded ? 'Show fewer images' : `Show all ${total} images`}
    </button>}
  </section>;
}

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/**
 * The focus window's images at a glance, above the feed. Each pick stands for
 * one moment and jumps to it, on whichever page of the feed it falls.
 */
export function ImageOverview({ picks, moments, status, error, stats, onJump }) {
  if (!picks.length) {
    return status === 'error' ? <p className="image-overview-note" role="status">Images could not be listed: {error}</p> : null;
  }
  const images = moments.reduce((sum, moment) => sum + moment.images.length, 0);
  const sessions = new Set(moments.map(moment => moment.sessionId)).size;
  const skipped = stats?.blocked ? ` · ${plural(stats.blocked, 'image')} in ${stats.blockedRoots.join(', ')} skipped: macOS has not let the Explorer read ${stats.blockedRoots.length === 1 ? 'that folder' : 'those folders'}` : '';
  return <section className="image-overview" aria-label="Images written in this focus">
    <p className="image-overview-summary">
      <strong>{plural(images, 'image')} written</strong> in {plural(moments.length, 'burst')} across {plural(sessions, 'session')}
      {picks.length < moments.length && <span> · {picks.length} shown</span>}{skipped}
    </p>
    <ul className="image-overview-strip">
      {picks.map(({ moment, image }) => {
        const src = localImage(image.thumb);
        return <li key={moment.key} className="image-moment-thumb image-overview-thumb" style={{ '--aspect': aspectOf(image) }}>
          <button className="image-moment-frame" onClick={() => onJump(moment)}
            title={`${image.name} · ${moment.session} · ${new Date(moment.t).toLocaleString()}`}
            aria-label={`Go to ${plural(moment.images.length, 'image')} from ${moment.session || 'an unattributed session'}, ${relativeTime(new Date(moment.t).toISOString())}`}>
            {src ? <img src={src} alt="" loading="lazy" decoding="async" /> : <span className="image-moment-missing">Preview unavailable</span>}
          </button>
          <span className="image-moment-name">{clock(moment.t)} · {plural(moment.images.length, 'image')}</span>
        </li>;
      })}
    </ul>
  </section>;
}
