export function eventTranscriptHighlight(event) {
  return event.uuid ? '' : (event.summary || event.query || event.prompt || '').slice(0, 80);
}

// Only the transcript path is untrusted. Encoding it as one route segment keeps
// it inside Explorer; server transcript authorization remains authoritative.
export function eventTranscriptHref(event, returnTo, base = '/') {
  if (typeof event.transcript_path !== 'string' || !event.transcript_path) return null;
  const params = new URLSearchParams({ reader: 'conversation', return: returnTo });
  if (event.uuid) params.set('uuid', event.uuid);
  if (event.block_id || event.blockId) params.set('block', event.block_id || event.blockId);
  const highlight = eventTranscriptHighlight(event);
  if (highlight) params.set('highlight', highlight);
  return `${base}session/${encodeURIComponent(event.transcript_path)}?${params}`;
}
