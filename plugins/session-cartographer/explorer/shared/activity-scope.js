const SEGMENT_GAP_MS = 15 * 60 * 1000;

function clean(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function list(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => clean(String(item)).toLowerCase()).filter(Boolean))];
}

function identities(value) {
  return [...new Set((Array.isArray(value) ? value : []).map((item) => clean(String(item))).filter(Boolean))];
}

function finite(value, fallback) {
  const number = typeof value === 'number' ? value : /^\d+$/.test(String(value || '')) ? Number(value) : Date.parse(value);
  return Number.isFinite(number) ? number : fallback;
}

export function normalizeActivityScope(scope = {}, snapshot = {}) {
  const from = finite(scope.from, snapshot.start ?? null);
  const through = finite(scope.through, snapshot.end ?? null);
  if (!Number.isFinite(from) || !Number.isFinite(through) || from > through) throw new RangeError('Activity scope requires valid ordered from and through timestamps.');
  return {
    from,
    through,
    lower: scope.lower === 'open' ? 'open' : 'closed',
    project: clean(scope.project),
    providers: list(scope.providers),
    evidence: list(scope.evidence),
    brush: identities(scope.brush),
    q: clean(scope.q),
    result: scope.result === 'files' ? 'files' : 'tasks',
    kind: clean(scope.kind) || 'all',
  };
}

export function containsActivityTimestamp(timestamp, scope) {
  return (scope.lower === 'open' ? timestamp > scope.from : timestamp >= scope.from) && timestamp <= scope.through;
}

function literalProject(value, expected) {
  return !expected || clean(value).toLowerCase() === expected.toLowerCase();
}

function baseRecordMatch(record, scope) {
  return containsActivityTimestamp(record.t, scope)
    && literalProject(record.project, scope.project)
    && (scope.providers.length === 0 || scope.providers.includes(clean(record.provider).toLowerCase()))
    && (scope.brush.length === 0 || scope.brush.includes(clean(record.sessionId)));
}

function evidenceMatch(record, expected) {
  if (expected.length === 0) return true;
  const values = [record.category, record.type, ...(record.evidence || [])].map((item) => clean(item).toLowerCase());
  return expected.some((needle) => values.includes(needle));
}

function queryReasons(session, records, files, query) {
  if (!query) return [];
  const needle = query.toLowerCase();
  const reasons = [];
  if ([session.title, session.fullTitle, session.id].some((value) => clean(value).toLowerCase().includes(needle))) reasons.push('task');
  if (records.some((record) => [record.text, record.type, record.id].some((value) => clean(value).toLowerCase().includes(needle)))) reasons.push('evidence');
  if (files.some((file) => [file.path, file.name].some((value) => clean(value).toLowerCase().includes(needle)))) reasons.push('file');
  return reasons;
}

function kindMatches(file, kind) {
  if (!kind || kind === 'all') return true;
  if (kind === 'md' || kind === 'markdown') return /\.(?:md|mdx|markdown)$/i.test(file.path);
  return clean(file.path).toLowerCase().endsWith(`.${kind.toLowerCase().replace(/^\./, '')}`);
}

function cloneFile(file, edits, matchReasons) {
  return { ...file, edits: edits.map((edit) => ({ ...edit })), matchReasons };
}

const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'total'];

function scopedTokens(session, tokenSeries) {
  const source = session.metrics?.tokens?.source || null;
  if (!tokenSeries.length) return {
    status: 'missing', input: null, output: null, cacheRead: null, cacheWrite: null, total: null,
    samples: 0, source, scope: 'focus', reason: 'No token usage samples are recorded in the selected interval.', capturedUntil: null,
  };
  const totals = Object.fromEntries(TOKEN_FIELDS.map((field) => [field, tokenSeries.reduce((sum, sample) => sum + (Number(sample[field]) || 0), 0)]));
  const partial = session.metrics?.tokens?.status === 'partial';
  return {
    ...totals, status: partial ? 'partial' : 'available', samples: tokenSeries.length, source,
    scope: 'focus', reason: partial ? session.metrics.tokens.reason : null, capturedUntil: tokenSeries.at(-1).t,
  };
}

function sessionMetrics(session, events, tokenSeries) {
  const counts = { activity: 0, edit: 0, research: 0, commit: 0, lifecycle: 0 };
  let activeMs = 0;
  let previous = null;
  for (const [timestamp, category] of events) {
    counts[category] = (counts[category] || 0) + 1;
    if (category !== 'lifecycle') {
      if (previous !== null && timestamp - previous <= SEGMENT_GAP_MS) activeMs += timestamp - previous;
      previous = timestamp;
    }
  }
  return {
    spanMs: events.length ? events.at(-1)[0] - events[0][0] : 0,
    activeMs,
    counts,
    tokens: scopedTokens(session, tokenSeries),
  };
}

/**
 * Project an already-normalized memory snapshot. Project/provider/time are
 * record predicates. Query/evidence qualify a task cohort, after which every
 * base-scoped record from those tasks remains visible in every lens.
 */
export function projectMemoryScope(snapshot, inputScope = {}) {
  const scope = normalizeActivityScope(inputScope, snapshot);
  const allEvidence = Array.isArray(snapshot.evidenceIndex) ? snapshot.evidenceIndex : [];
  const baseEvidence = allEvidence.filter((record) => baseRecordMatch(record, scope));
  const bySession = new Map();
  const anonymous = [];
  for (const record of baseEvidence) {
    if (!record.sessionId) anonymous.push(record);
    else {
      if (!bySession.has(record.sessionId)) bySession.set(record.sessionId, []);
      bySession.get(record.sessionId).push(record);
    }
  }

  const sessions = [];
  const files = Object.create(null);
  const includedIds = new Set();
  for (const original of snapshot.sessions || []) {
    const records = bySession.get(original.id) || [];
    if (records.length === 0) continue;
    const sourceFiles = snapshot.files?.[original.id] || [];
    const baseRecordIds = new Set(records.map((record) => record.id).filter(Boolean));
    const intervalFiles = sourceFiles.map((file) => {
      const edits = (file.edits || []).filter((edit) => containsActivityTimestamp(edit.t, scope)
        && ((!scope.project && scope.providers.length === 0) || baseRecordIds.has(edit.id)));
      const reasons = [];
      if (scope.q && [file.path, file.name].some((value) => clean(value).toLowerCase().includes(scope.q.toLowerCase()))) reasons.push('query:file');
      if (scope.project && literalProject(file.project, scope.project)) reasons.push('project');
      return edits.length && kindMatches(file, scope.result === 'files' ? scope.kind : 'all') ? cloneFile(file, edits, reasons) : null;
    }).filter(Boolean);
    const query = queryReasons(original, records, intervalFiles, scope.q);
    const evidence = scope.evidence.length === 0 || records.some((record) => evidenceMatch(record, scope.evidence));
    if ((scope.q && query.length === 0) || !evidence) continue;
    const directFileOnly = scope.q && query.length === 1 && query[0] === 'file';
    const selectedFiles = directFileOnly ? intervalFiles.filter((file) => file.matchReasons.includes('query:file')) : intervalFiles;
    includedIds.add(original.id);
    const events = records.map((record) => [record.t, record.category, record.id, record.project]);
    const allNotes = records.filter((record) => record.text).map((record) => ({ t: record.t, id: record.id, type: record.type, text: record.text }));
    const notes = allNotes.slice(-60);
    const outcomes = records.filter((record) => record.evidence?.includes('outcome')).map((record) => ({ t: record.t, id: record.id, type: record.type, text: record.text }));
    const wraps = records.filter((record) => /wrapup/.test(record.type)).map((record) => ({ t: record.t, id: record.id }));
    const tokenSeries = (original.tokenSeries || []).filter((sample) => containsActivityTimestamp(sample.t, scope));
    const projects = Object.create(null);
    for (const record of records) projects[record.project || 'Unattributed'] = (projects[record.project || 'Unattributed'] || 0) + 1;
    const matchReasons = [
      ...(scope.project ? ['project'] : []),
      ...(scope.providers.length ? ['provider'] : []),
      ...(scope.evidence.length ? ['evidence'] : []),
      ...(scope.brush.length ? ['task-cohort'] : []),
      ...query.map((reason) => `query:${reason}`),
    ];
    sessions.push({
      ...original,
      events,
      notes,
      outcomes,
      wraps,
      projects,
      count: records.length,
      lifecycleOnly: records.every((record) => record.category === 'lifecycle'),
      noteCount: allNotes.length,
      notePreview: { total: allNotes.length, shown: notes.length, truncated: allNotes.length > notes.length },
      metrics: sessionMetrics(original, events, tokenSeries),
      tokenSeries,
      matchReasons,
      fullRange: original.fullRange || (original.events?.length ? { from: original.events[0][0], through: original.events.at(-1)[0] } : null),
    });
    files[original.id] = selectedFiles.map((file) => ({
      ...file,
      matchReasons: [...new Set([
        ...file.matchReasons,
        ...(scope.project ? ['project'] : []),
        ...(scope.providers.length ? ['provider'] : []),
        ...(scope.brush.length ? ['task-cohort'] : []),
        ...(scope.evidence.length ? ['from-matching-task:evidence'] : []),
        ...(query.some((reason) => reason !== 'file') ? ['from-matching-task:query'] : []),
      ])],
    }));
  }

  const directAnonymous = anonymous.filter((record) => (!scope.q || [record.text, record.type, record.id].some((value) => clean(value).toLowerCase().includes(scope.q.toLowerCase()))) && evidenceMatch(record, scope.evidence));
  const evidenceIndex = baseEvidence.filter((record) => record.sessionId ? includedIds.has(record.sessionId) : directAnonymous.includes(record));
  const groups = [...new Set(sessions.map((session) => session.group).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const groupedFiles = new Map();
  for (const session of sessions) for (const file of files[session.id] || []) {
    if (!groupedFiles.has(file.path)) groupedFiles.set(file.path, { path: file.path, name: file.name, project: file.project, edits: [], contributors: [], matchReasons: [] });
    const grouped = groupedFiles.get(file.path);
    grouped.contributors.push(session.id);
    grouped.edits.push(...file.edits.map((edit) => ({ ...edit, session: session.id })));
    grouped.matchReasons.push(...file.matchReasons);
  }
  const fileIndex = [...groupedFiles.values()].map((file) => ({
    ...file,
    contributors: [...new Set(file.contributors)],
    contributorCount: new Set(file.contributors).size,
    edits: file.edits.sort((a, b) => a.t - b.t || clean(a.id).localeCompare(clean(b.id))),
    lastEdited: file.edits.reduce((latest, edit) => Math.max(latest, edit.t), 0),
    matchReasons: [...new Set(file.matchReasons)],
  })).sort((a, b) => b.lastEdited - a.lastEdited || a.path.localeCompare(b.path));
  const totalFiles = fileIndex.length;
  const requestedRange = { from: scope.from, through: scope.through, lower: scope.lower };
  const observed = snapshot.observedExtent || { from: snapshot.availableStart ?? null, through: snapshot.availableEnd ?? null };
  const coverageStatus = observed.from === null || observed.through === null
    ? 'unknown-history'
    : scope.through < observed.from || scope.from > observed.through
      ? 'outside-observed-extent'
      : scope.from < observed.from || scope.through > observed.through
        ? 'partly-outside-observed-extent'
        : 'within-observed-extent-unknown-history';
  const coverage = {
    ...(snapshot.coverage || {}),
    status: coverageStatus,
    requestedRange,
    loadedRange: { from: scope.from, through: scope.through },
    evidenceComplete: snapshot.evidenceComplete !== false,
    indexedRecords: evidenceIndex.length,
    notePreview: {
      limitPerSession: 60,
      truncatedSessions: sessions.filter((session) => session.notePreview?.truncated).length,
      omitted: sessions.reduce((sum, session) => sum + Math.max(0, (session.noteCount || 0) - (session.notes?.length || 0)), 0),
    },
  };
  const counts = {
    events: evidenceIndex.length,
    sessions: sessions.length,
    files: totalFiles,
    fileEdits: fileIndex.reduce((sum, file) => sum + file.edits.length, 0),
    recordedCommits: evidenceIndex.filter((record) => record.category === 'commit').length,
    outcomes: evidenceIndex.filter((record) => record.evidence?.includes('outcome')).length,
    unattributed: directAnonymous.length,
  };
  return {
    ...snapshot,
    start: scope.from,
    end: scope.through,
    windowHours: (scope.through - scope.from) / (60 * 60 * 1000),
    requestedRange,
    loadedRange: coverage.loadedRange,
    scope,
    total: evidenceIndex.length,
    unattributed: directAnonymous.length,
    groups,
    sessions,
    files,
    fileIndex,
    evidenceIndex,
    evidenceComplete: snapshot.evidenceComplete !== false,
    indexedRecordCount: evidenceIndex.length,
    providers: [...new Set(evidenceIndex.map((record) => record.provider).filter(Boolean))].sort((a, b) => a.localeCompare(b)),
    counts,
    coverage,
    coverageStatus,
  };
}

function segments(records) {
  const result = [];
  for (const record of records) {
    const previous = result.at(-1);
    if (!previous || record.t - previous.through > SEGMENT_GAP_MS) result.push({ from: record.t, through: record.t, eventCount: 1 });
    else { previous.through = record.t; previous.eventCount += 1; }
  }
  return result;
}

export function activityFromMemory(snapshot) {
  const events = [...(snapshot.evidenceIndex || [])];
  const recordsBySession = new Map();
  for (const record of events) {
    if (!record.sessionId) continue;
    if (!recordsBySession.has(record.sessionId)) recordsBySession.set(record.sessionId, []);
    recordsBySession.get(record.sessionId).push(record);
  }
  const sessions = (snapshot.sessions || []).map((session) => {
    const records = (recordsBySession.get(session.id) || []).sort((a, b) => a.t - b.t || clean(a.id).localeCompare(clean(b.id)));
    const projects = Object.create(null), providers = Object.create(null), types = Object.create(null);
    for (const record of records) {
      projects[record.project || 'Unattributed'] = (projects[record.project || 'Unattributed'] || 0) + 1;
      if (record.provider) providers[record.provider] = (providers[record.provider] || 0) + 1;
      types[record.type || record.category || 'activity'] = (types[record.type || record.category || 'activity'] || 0) + 1;
    }
    return {
      session_id: session.id,
      title: session.title,
      start: records[0]?.timestamp || null,
      end: records.at(-1)?.timestamp || null,
      firstObserved: records[0]?.t ?? null,
      lastObserved: records.at(-1)?.t ?? null,
      fullStart: session.fullRange?.from ?? null,
      fullEnd: session.fullRange?.through ?? null,
      event_count: records.length,
      project: Object.entries(projects).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || session.group,
      projects: Object.keys(projects),
      project_counts: projects,
      provider: Object.entries(providers).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))[0]?.[0] || session.provider || '',
      providers: Object.keys(providers),
      types,
      segments: segments(records),
      matchReasons: session.matchReasons || [],
      transcript_path: session.transcript || '',
    };
  }).filter((session) => session.event_count > 0);
  const overlaps = [];
  for (let left = 0; left < sessions.length; left++) for (let right = left + 1; right < sessions.length; right++) {
    for (const a of sessions[left].segments) for (const b of sessions[right].segments) {
      const from = Math.max(a.from, b.from), through = Math.min(a.through, b.through);
      if (from <= through) overlaps.push({ sessions: [sessions[left].session_id, sessions[right].session_id], start: new Date(from).toISOString(), end: new Date(through).toISOString(), from, through, method: 'observed-segments-15m-gap' });
    }
  }
  return {
    sessions,
    overlaps,
    events,
    segmentGapMs: SEGMENT_GAP_MS,
    totalEvents: events.length,
    totalSessions: sessions.length,
    totalFiles: snapshot.counts?.files ?? snapshot.fileIndex?.length ?? 0,
  };
}

export { SEGMENT_GAP_MS };
