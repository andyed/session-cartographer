import { useEffect, useMemo, useState } from 'react';
import { MAX_FOCUS_DURATION_MS } from '../../shared/focus.js';
import { isDemoMode } from '../api.js';
import { readSavedFocus, saveFocus, undoSavedFocus, readLegacyFocusSeed } from '../components/memory-focus-storage.js';
const storage = () => { try { return window.localStorage; } catch { return null; } };
export default function useSavedFocus(workspace) {
  const { route, interval, data, activate, sourceId } = workspace;
  const identity = useMemo(() => ({ corpusId: data?.source?.corpusId || 'local', source: isDemoMode ? 'demo' : 'live' }), [sourceId]);
  const [record, setRecord] = useState(() => readSavedFocus(storage(), identity));
  const [notice, setNotice] = useState('');
  useEffect(() => {
    const read = () => setRecord(readSavedFocus(storage(), identity));
    read(); window.addEventListener('storage', read);
    window.addEventListener('cartographer-saved-focus', read);
    return () => { window.removeEventListener('storage', read); window.removeEventListener('cartographer-saved-focus', read); };
  }, [identity]);
  useEffect(() => {
    if (notice !== 'Return point set.') return;
    const timer = setTimeout(() => setNotice(''), 4000);
    return () => clearTimeout(timer);
  }, [notice]);
  const saved = record.ok ? record.value : null;
  const update = (next, success) => {
    setRecord(next); setNotice(next.ok ? success : next.error.message);
    if (next.ok) window.dispatchEvent(new Event('cartographer-saved-focus'));
  };
  const restore = () => { if (saved) activate(saved, { brush: null, filter: 'all', ...saved.scope, session: null, file: null, review: null, contributor: null }, 'fixed'); };
  const since = () => {
    if (!saved) return;
    const through = isDemoMode ? data.end : Date.now();
    if (saved.through > through) { setNotice('The saved focus ends after this source snapshot.'); return; }
    if (through - saved.through > MAX_FOCUS_DURATION_MS) { setNotice('The return point is more than 90 days behind this snapshot. Return to it, or choose a newer time range.'); return; }
    activate({ from: saved.through, through, lower: 'open' }, { brush: null, filter: 'all', ...saved.scope, session: null, file: null, review: null, contributor: null }, 'since-saved');
  };
  const legacy = !saved && data ? readLegacyFocusSeed(storage(), { through: data.end }) : null;
  return { saved, notice: notice || (!record.ok ? record.error.message : ''), canUndo: Boolean(record.ok && (record.value || record.undo)),
    save: (value = interval) => value && update(saveFocus(storage(), identity, { ...route, ...value }), 'Return point set.'),
    undo: () => update(undoSavedFocus(storage(), identity), 'Previous saved focus restored.'), restore, since,
    legacy: legacy?.ok && legacy.value ? legacy : null,
    useLegacy: () => legacy?.value && activate(legacy.value, {}, 'fixed') };
}
