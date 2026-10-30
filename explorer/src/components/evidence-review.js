import { messageBlocks } from './transcript-navigation.js';

const absolute = path => /^(?:\/|[A-Za-z]:[\\/]|\\\\)/.test(path);

/** Exact recorded links only. resultMessageIds is a distinct-message set, not
 * a parallel array to resultIds, and call_id alone is not globally unique. */
export function operationResults(call, supplied = []) {
  const expected = [...new Set(call?.resultIds || [])];
  const byId = new Map();
  for (const result of supplied || []) {
    if (result?.type !== 'tool_result' || !result.id) continue;
    if (result.callBlockId && result.callBlockId !== call?.id) continue;
    if (!expected.includes(result.id) && result.callBlockId !== call?.id) continue;
    if (!byId.has(result.id)) byId.set(result.id, result);
  }
  const ids = [...expected, ...[...byId.keys()].filter(id => !expected.includes(id))];
  return { results: ids.map(id => byId.get(id)).filter(Boolean), missingResultIds: expected.filter(id => !byId.has(id)) };
}

export function operationState(call, results = [], missingResultIds = []) {
  if (call?.status === 'error' || results.some(result => result.isError || result.status === 'error')) return { key: 'error', label: 'Recorded error', glyph: '⚠' };
  if (missingResultIds.length) return { key: 'unavailable', label: 'Recorded result unavailable', glyph: '…' };
  if (results.length || call?.status === 'returned') return { key: 'returned', label: 'Result recorded', glyph: '↩' };
  return { key: 'missing', label: 'Result not recorded', glyph: '…' };
}

/** One exact path per bundle, with each recorded attempt kept independent.
 * Without recorded working-directory provenance, equal relative strings from
 * separate messages cannot safely be identified as the same physical file. */
export function buildEvidenceReview(evidence = {}, messages = []) {
  evidence = evidence || {};
  const blocks = new Map(), positions = new Map(), timestamps = new Map();
  messages.forEach((message, index) => {
    for (const block of messageBlocks(message)) {
      blocks.set(block.id, block.messageId ? block : { ...block, messageId: message.uuid });
      positions.set(block.id, index); timestamps.set(block.id, message.timestamp || '');
    }
  });
  const resultsByCall = new Map();
  for (const block of blocks.values()) if (block.type === 'tool_result' && block.callBlockId) {
    if (!resultsByCall.has(block.callBlockId)) resultsByCall.set(block.callBlockId, []);
    resultsByCall.get(block.callBlockId).push(block);
  }
  const pair = call => operationResults(call, [...(call.resultIds || []).map(id => blocks.get(id)).filter(Boolean), ...(resultsByCall.get(call.id) || [])]);
  const indexedCalls = new Map((evidence.calls || []).filter(call => call.blockId).map(call => [call.blockId, call]));
  const errors = (evidence.errors || []).map(error => ({ ...error, result: blocks.get(error.blockId) }));
  const fileGroups = new Map(), fileCallIds = new Set(), fileErrorIds = new Set();
  for (const file of evidence.files || []) {
    if (!file.path || !file.blockId) continue;
    const key = absolute(file.path) ? file.path : `${file.path}\0${file.messageId || file.blockId}`;
    if (!fileGroups.has(key)) fileGroups.set(key, { id: key, path: file.path, relative: !absolute(file.path), operations: [] });
    const group = fileGroups.get(key);
    if (group.operations.some(operation => operation.id === file.blockId)) continue;
    const indexed = indexedCalls.get(file.blockId);
    const call = blocks.get(file.blockId) || { ...indexed, type: 'tool_call', id: file.blockId, messageId: file.messageId, name: indexed?.name || 'File operation', status: file.status, resultIds: [] };
    const paired = pair(call);
    const operationErrors = errors.filter(error => paired.results.some(result => result.id === error.blockId) || error.result?.callBlockId === call.id);
    operationErrors.forEach(error => fileErrorIds.add(error.blockId));
    fileCallIds.add(file.blockId);
    group.operations.push({
      id: file.blockId, operation: file.operation, call, ...paired, errors: operationErrors,
      state: operationState(call, paired.results, paired.missingResultIds),
      timestamp: timestamps.get(call.id) || '', position: positions.get(call.id) ?? Number.MAX_SAFE_INTEGER,
      sources: [{ messageId: call.messageId || file.messageId, blockId: call.id, kind: 'request' }, ...paired.results.map(result => ({ messageId: result.messageId, blockId: result.id, kind: 'result' }))],
    });
  }
  const files = [...fileGroups.values()].map(group => {
    group.operations.sort((a, b) => a.position - b.position);
    return { ...group, readCount: group.operations.filter(op => op.operation === 'read').length,
      writeCount: group.operations.filter(op => op.operation === 'write').length,
      errorCount: group.operations.reduce((sum, op) => sum + op.errors.length, 0) };
  });
  const activity = [...indexedCalls.values()].filter(call => !fileCallIds.has(call.blockId)).map(indexed => {
    const call = blocks.get(indexed.blockId) || { ...indexed, id: indexed.blockId, type: 'tool_call' };
    const paired = pair(call);
    return { id: indexed.blockId, call, ...paired, state: operationState(call, paired.results, paired.missingResultIds) };
  });
  return { files, activity, errors: errors.filter(error => !fileErrorIds.has(error.blockId)) };
}
