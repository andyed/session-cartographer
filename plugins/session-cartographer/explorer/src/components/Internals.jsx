import { useCallback, useMemo, useState } from 'react';
import { fetchInternals } from '../api';
import { useStaleResource } from '../hooks/useStaleResource';

const WINDOWS = [
  ['7d', '7 days'],
  ['30d', '30 days'],
  ['all', 'All'],
];

const FIRST_USE_ORDER = ['1–3', '1-3', '4–7', '4-7', '8–15', '8-15', '16+', 'unknown', 'none', 'no use'];

function at(value, path) {
  return path.split('.').reduce((current, part) => current?.[part], value);
}

function firstValue(value, paths) {
  for (const path of paths) {
    const candidate = at(value, path);
    if (candidate !== undefined && candidate !== null && candidate !== '') return candidate;
  }
  return null;
}

function firstNumber(value, paths) {
  const candidate = firstValue(value, paths);
  if (candidate === null) return null;
  const number = Number(candidate);
  return Number.isFinite(number) ? number : null;
}

function formatNumber(value) {
  return Number.isFinite(value) ? Math.round(value).toLocaleString() : '—';
}

function formatDecimal(value) {
  return Number.isFinite(value) ? value.toFixed(2) : '—';
}

function formatRank(value) {
  return Number.isFinite(value) ? `#${Math.round(value).toLocaleString()}` : '—';
}

function formatMilliseconds(value) {
  if (!Number.isFinite(value)) return '—';
  if (value < 1000) return `${Math.round(value).toLocaleString()} ms`;
  const seconds = value / 1000;
  return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return '—';
  const units = ['B', 'KB', 'MB', 'GB'];
  let amount = value;
  let unit = 0;
  while (amount >= 1024 && unit < units.length - 1) {
    amount /= 1024;
    unit += 1;
  }
  return `${amount >= 10 || unit === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[unit]}`;
}

function ratePercent(value) {
  if (!Number.isFinite(value)) return null;
  return value <= 1 ? value * 100 : value;
}

function formatRate(value) {
  const percent = ratePercent(value);
  if (!Number.isFinite(percent)) return '—';
  return `${percent.toFixed(percent < 10 ? 1 : 0)}%`;
}

function formatDate(value) {
  if (!value) return 'time unavailable';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return new Intl.DateTimeFormat(undefined, {
    month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

function cleanLabel(value, fallback = 'Unknown') {
  const text = String(value ?? '').trim();
  return text || fallback;
}

function cleanSourceLabel(value) {
  const unique = [...new Set(cleanLabel(value).split('+').map(part => part.trim()).filter(Boolean))];
  return unique.join(' + ') || 'Unknown';
}

function asRows(value, labelFields = ['label', 'name']) {
  if (Array.isArray(value)) return value;
  if (!value || typeof value !== 'object') return [];
  return Object.entries(value).map(([key, item]) => (
    item && typeof item === 'object'
      ? { ...item, [labelFields[0]]: firstValue(item, labelFields) ?? key }
      : { [labelFields[0]]: key, count: item }
  ));
}

function normalizeBreakdown(value, kind = 'source') {
  const labels = kind === 'project'
    ? ['project', 'key', 'name', 'label']
    : kind === 'purpose'
      ? ['purpose', 'key', 'name', 'label']
      : ['source', 'key', 'name', 'label'];
  const merged = new Map();

  for (const item of asRows(value, labels)) {
    let label = firstValue(item, labels);
    label = kind === 'source' ? cleanSourceLabel(label) : cleanLabel(label);
    const served = firstNumber(item, ['served', 'servedRows', 'served_rows', 'results', 'total', 'count']);
    const used = firstNumber(item, ['used', 'usedRows', 'used_rows', 'hits', 'hit', 'touches']);
    const calls = firstNumber(item, ['calls', 'callCount', 'call_count']);
    const existing = merged.get(label) || { label, served: 0, used: 0, calls: 0, hasServed: false, hasUsed: false, hasCalls: false };
    if (served !== null) { existing.served += served; existing.hasServed = true; }
    if (used !== null) { existing.used += used; existing.hasUsed = true; }
    if (calls !== null) { existing.calls += calls; existing.hasCalls = true; }
    merged.set(label, existing);
  }

  return [...merged.values()]
    .map(item => ({
      ...item,
      served: item.hasServed ? item.served : null,
      used: item.hasUsed ? item.used : null,
      calls: item.hasCalls ? item.calls : null,
    }))
    .sort((a, b) => (b.served ?? b.calls ?? b.used ?? 0) - (a.served ?? a.calls ?? a.used ?? 0));
}

function normalizeFirstUse(value) {
  const rows = asRows(value, ['bucket', 'label', 'rank']);
  return rows.map(item => ({
    label: cleanLabel(firstValue(item, ['bucket', 'label', 'rank'])),
    count: firstNumber(item, ['count', 'calls', 'value', 'total']),
  })).filter(item => item.count !== null).sort((a, b) => {
    const ai = FIRST_USE_ORDER.indexOf(a.label.toLowerCase());
    const bi = FIRST_USE_ORDER.indexOf(b.label.toLowerCase());
    return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
  });
}

function normalizeDaily(value) {
  return asRows(value, ['date', 'day', 'label']).map(item => ({
    label: cleanLabel(firstValue(item, ['date', 'day', 'label'])),
    calls: firstNumber(item, ['calls', 'call_count', 'served_calls']),
    served: firstNumber(item, ['served', 'servedRows', 'served_rows', 'results']),
    usedCalls: firstNumber(item, ['callsWithUse', 'calls_with_use', 'used_calls', 'successful_calls']),
    usedRows: firstNumber(item, ['used', 'usedRows', 'used_rows', 'hits']),
  }));
}

function normalizeModeCohorts(value) {
  const order = new Map([['explorer', 0], ['cli', 1], ['unknown', 2]]);
  return asRows(value, ['key', 'requestedBackend', 'requested_backend', 'backend']).map(item => {
    const key = cleanLabel(firstValue(item, ['key', 'requestedBackend', 'requested_backend', 'backend']), 'unknown').toLowerCase();
    const selectedBackends = firstValue(item, ['selectedBackends', 'selected_backends']) || {};
    return {
      key,
      label: key === 'explorer' ? 'Turbo on' : key === 'cli' ? 'Turbo off' : 'Historical / unclassified',
      calls: firstNumber(item, ['calls', 'callCount', 'call_count']),
      samples: firstNumber(item, ['latency.samples', 'latencySamples', 'latency_samples']),
      p50Ms: firstNumber(item, ['latency.p50Ms', 'latency.p50_ms', 'p50Ms', 'p50_ms']),
      p95Ms: firstNumber(item, ['latency.p95Ms', 'latency.p95_ms', 'p95Ms', 'p95_ms']),
      firstAccessMrr: firstNumber(item, ['firstAccessMrr', 'first_access_mrr', 'mrr']),
      lastAccessMrr: firstNumber(item, ['lastAccessMrr', 'last_access_mrr']),
      orderedCalls: firstNumber(item, ['orderedCalls', 'ordered_calls']),
      hitsConsumed: firstNumber(item, ['hitsConsumed', 'hits_consumed']),
      hitsConsumedPerCall: firstNumber(item, ['hitsConsumedPerCall', 'hits_consumed_per_call']),
      hitsConsumedPerSuccessfulCall: firstNumber(item, ['hitsConsumedPerSuccessfulCall', 'hits_consumed_per_successful_call']),
      consumptionDepthSamples: firstNumber(item, ['consumptionDepth.samples', 'consumption_depth.samples']),
      consumptionDepthP50Rank: firstNumber(item, ['consumptionDepth.p50Rank', 'consumption_depth.p50_rank']),
      consumptionDepthP95Rank: firstNumber(item, ['consumptionDepth.p95Rank', 'consumption_depth.p95_rank']),
      fallbackCalls: firstNumber(item, ['fallbackCalls', 'fallback_calls']),
      selectedBackends,
    };
  }).sort((a, b) => (order.get(a.key) ?? 99) - (order.get(b.key) ?? 99));
}

function Metric({ label, value, detail, caveat = false }) {
  return (
    <div className={`internals-metric${caveat ? ' is-caveat' : ''}`}>
      <span className="internals-metric-value">{value}</span>
      <span className="internals-metric-label">{label}</span>
      {detail && <span className="internals-metric-detail">{detail}</span>}
    </div>
  );
}

function ModeCohorts({ rows }) {
  if (!rows.length) return null;
  return (
    <section className="internals-section" aria-labelledby="internals-mode-heading">
      <div className="internals-section-heading">
        <div>
          <p className="internals-kicker">Turbo experiment</p>
          <h2 id="internals-mode-heading">Latency and use by mode</h2>
        </div>
        <p>Cohorts follow the requested mode, so a Turbo fallback stays charged to Turbo-on user experience.</p>
      </div>
      <div className="internals-mode-grid">
        {rows.map(row => {
          const selections = Object.entries(row.selectedBackends)
            .filter(([, count]) => Number.isFinite(Number(count)) && Number(count) > 0)
            .map(([backend, count]) => `${backend === 'explorer' ? 'Explorer' : backend === 'cli' ? 'CLI' : 'unknown'} ${formatNumber(Number(count))}`)
            .join(' · ');
          const lowSample = Number.isFinite(row.samples) && row.samples > 0 && row.samples < 10;
          const latencyUnavailable = !Number.isFinite(row.samples) || row.samples === 0;
          return (
            <article className="internals-mode-card" key={row.key}>
              <div className="internals-mode-card-header">
                <div><h3>{row.label}</h3><p>{selections || 'Backend attribution unavailable'}</p></div>
                <span className={lowSample || latencyUnavailable ? 'is-caveat' : ''}>{formatNumber(row.calls)} calls{lowSample ? ' · low sample' : latencyUnavailable ? ' · latency unavailable' : ''}</span>
              </div>
              <div className="internals-scoreline">
                <Metric label="Response p50" value={formatMilliseconds(row.p50Ms)} detail={`${formatNumber(row.samples)} timed calls`} caveat={lowSample} />
                <Metric label="Response p95" value={formatMilliseconds(row.p95Ms)} detail={row.fallbackCalls ? `${formatNumber(row.fallbackCalls)} fallbacks` : 'no recorded fallback'} caveat={lowSample} />
                <Metric label="Hits consumed" value={formatNumber(row.hitsConsumed)} detail={`${formatDecimal(row.hitsConsumedPerCall)} per call · ${formatDecimal(row.hitsConsumedPerSuccessfulCall)} per successful call`} />
                <Metric label="Consumption depth" value={formatRank(row.consumptionDepthP50Rank)} detail={`p50 deepest rank · p95 ${formatRank(row.consumptionDepthP95Rank)} · ${formatNumber(row.consumptionDepthSamples)} calls`} />
                <Metric label="First-access MRR" value={row.firstAccessMrr === null ? '—' : row.firstAccessMrr.toFixed(3)} detail="precision proxy · first used rank" />
                <Metric label="Last-access MRR" value={row.lastAccessMrr === null ? '—' : row.lastAccessMrr.toFixed(3)} detail={`recall-depth proxy · ${formatNumber(row.orderedCalls)} ordered calls`} />
              </div>
            </article>
          );
        })}
      </div>
    </section>
  );
}

function Pipeline({ data, windowLabel }) {
  const captured = firstNumber(data, [
    'pipeline.capture.count', 'pipeline.captured', 'meta.capturedEvents', 'meta.captured_events',
    'operations.explorer.capturedEvents', 'operations.explorer.captured_events',
    'operations.system.capturedEvents', 'operations.system.captured_events',
    'operations.capturedEvents', 'operations.captured_events', 'capture.total', 'capture.events',
  ]);
  const indexed = firstNumber(data, [
    'pipeline.index.count', 'pipeline.indexed', 'meta.keywordIndexedDocs', 'meta.keyword_indexed_docs',
    'operations.explorer.keywordIndexedDocs', 'operations.explorer.keyword_indexed_docs',
    'operations.system.keywordIndexedDocs', 'operations.system.keyword_indexed_docs',
    'operations.keywordIndexedDocs', 'operations.keyword_indexed_docs', 'index.keyword_documents',
  ]);
  const served = firstNumber(data, [
    'pipeline.serve.count', 'pipeline.served', 'utility.servedRows', 'utility.served_rows',
    'utility.resultsServed', 'utility.results_served', 'overall.total', 'coverage.served_rows',
  ]);
  const used = firstNumber(data, [
    'pipeline.use.count', 'pipeline.used', 'utility.usedRows', 'utility.used_rows',
    'utility.resultsUsed', 'utility.results_used', 'overall.hit', 'coverage.used_rows',
  ]);
  const max = Math.max(...[captured, indexed, served, used].filter(Number.isFinite), 1);
  const stages = [
    { label: 'Capture', value: captured, detail: 'live event corpus' },
    { label: 'Index', value: indexed, detail: 'keyword documents in memory' },
    { label: 'Serve', value: served, detail: `${windowLabel} exact result rows` },
    { label: 'Use', value: used, detail: `${windowLabel} explicit use rows` },
  ];

  return (
    <section className="internals-pipeline" aria-labelledby="internals-pipeline-heading">
      <div className="internals-section-heading">
        <div>
          <p className="internals-kicker">System path</p>
          <h2 id="internals-pipeline-heading">Capture → index → serve → use</h2>
        </div>
        <p>Each stage keeps its own denominator. Bar width compares observed counts; it is not a conversion rate.</p>
      </div>
      <div className="internals-pipeline-flow">
        {stages.map((stage, index) => {
          const width = Number.isFinite(stage.value) ? Math.max(stage.value === 0 ? 0 : 3, (stage.value / max) * 100) : 0;
          return (
            <div className="internals-stage-wrap" key={stage.label}>
              <div className={`internals-stage${Number.isFinite(stage.value) ? '' : ' is-missing'}`}>
                <div className="internals-stage-topline">
                  <span>{stage.label}</span>
                  <strong>{formatNumber(stage.value)}</strong>
                </div>
                <div className="internals-stage-track" aria-hidden="true">
                  <span style={{ width: `${width}%` }} />
                </div>
                <p>{Number.isFinite(stage.value) ? stage.detail : 'not supplied by current instrumentation'}</p>
              </div>
              {index < stages.length - 1 && <span className="internals-stage-arrow" aria-hidden="true">→</span>}
            </div>
          );
        })}
      </div>
    </section>
  );
}

function DailyTrace({ rows }) {
  if (!rows.length) return <EmptyState>Daily call history is not present in this snapshot.</EmptyState>;
  const hasCalls = rows.some(row => row.calls !== null);
  const primaryKey = hasCalls ? 'calls' : 'served';
  const secondaryKey = rows.some(row => row.usedCalls !== null) ? 'usedCalls' : 'usedRows';
  const primaryLabel = hasCalls ? 'calls' : 'served rows';
  const secondaryLabel = secondaryKey === 'usedCalls' ? 'calls with use' : 'used rows';
  const width = 760;
  const height = 170;
  const padX = 12;
  const padY = 20;
  const values = rows.flatMap(row => [row[primaryKey], row[secondaryKey]]).filter(Number.isFinite);
  const max = Math.max(...values, 1);
  const x = index => padX + (index / Math.max(rows.length - 1, 1)) * (width - padX * 2);
  const y = value => height - padY - ((value ?? 0) / max) * (height - padY * 2);
  const pathFor = key => rows.map((row, index) => `${index === 0 ? 'M' : 'L'}${x(index).toFixed(1)},${y(row[key]).toFixed(1)}`).join(' ');

  return (
    <div className="internals-trace">
      <div className="internals-legend" aria-hidden="true">
        <span><i className="is-primary" />{primaryLabel}</span>
        <span><i className="is-use" />{secondaryLabel}</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-labelledby="internals-trace-title internals-trace-desc">
        <title id="internals-trace-title">Daily retrieval activity</title>
        <desc id="internals-trace-desc">{primaryLabel} and {secondaryLabel} across {rows.length} daily observations.</desc>
        {[0.25, 0.5, 0.75].map(mark => (
          <line key={mark} x1={padX} x2={width - padX} y1={y(max * mark)} y2={y(max * mark)} className="internals-gridline" />
        ))}
        <text x={padX} y={16} className="internals-trace-tick">{formatNumber(max)}</text>
        <text x={padX} y={height - 3} className="internals-trace-tick">0</text>
        <path d={pathFor(primaryKey)} className="internals-trace-primary" />
        <path d={pathFor(secondaryKey)} className="internals-trace-use" />
      </svg>
      <div className="internals-trace-axis">
        <span>{rows[0].label}</span>
        <span>{rows.at(-1).label}</span>
      </div>
    </div>
  );
}

function FirstUse({ rows }) {
  if (!rows.length) return <EmptyState>First-use rank is not instrumented for this window.</EmptyState>;
  const max = Math.max(...rows.map(row => row.count), 1);
  return (
    <div className="internals-rank-list">
      {rows.map(row => {
        const noUse = /none|no use/i.test(row.label);
        return (
          <div className={`internals-rank-row${noUse ? ' is-caveat' : ''}`} key={row.label}>
            <span className="internals-rank-label">{row.label}</span>
            <div className="internals-rank-track" aria-label={`${row.label}: ${formatNumber(row.count)} calls`}>
              <span style={{ width: `${(row.count / max) * 100}%` }} />
            </div>
            <strong>{formatNumber(row.count)}</strong>
          </div>
        );
      })}
    </div>
  );
}

function ContributionBars({ rows, empty }) {
  if (!rows.length) return <EmptyState>{empty}</EmptyState>;
  const visible = rows.slice(0, 8);
  const max = Math.max(...visible.map(row => row.served ?? row.calls ?? row.used ?? 0), 1);
  return (
    <div className="internals-contributions">
      {visible.map(row => {
        const base = row.served ?? row.calls ?? row.used ?? 0;
        const servedWidth = (base / max) * 100;
        const usedWidth = row.used === null ? null : (row.used / max) * 100;
        return (
          <div className="internals-contribution" key={row.label}>
            <div className="internals-contribution-topline">
              <span title={row.label}>{row.label}</span>
              <span>
                {row.served !== null ? `${formatNumber(row.served)} served` : row.calls !== null ? `${formatNumber(row.calls)} calls` : 'served —'}
                {' · '}{row.used !== null ? `${formatNumber(row.used)} used` : 'use unavailable'}
              </span>
            </div>
            <div className="internals-contribution-track" aria-hidden="true">
              <span className="is-served" style={{ width: `${servedWidth}%` }} />
              {usedWidth !== null && <span className="is-used" style={{ width: `${usedWidth}%` }} />}
            </div>
          </div>
        );
      })}
    </div>
  );
}

function EmptyState({ children }) {
  return <p className="internals-empty">{children}</p>;
}

function OperationsRail({ data, purposeRows }) {
  const coverage = data.coverage || {};
  const operations = data.operations || {};
  const files = Array.isArray(data.files)
    ? data.files
    : Array.isArray(operations.files)
      ? operations.files
      : asRows(operations.files, ['name']);
  const exactRows = firstNumber(coverage, ['exactAttributedRows', 'exact_attributed_rows', 'attributed_rows', 'call_id_rows', 'served.exactAttributedRows']);
  const servedRows = firstNumber(data, ['coverage.served.selectedRows', 'coverage.served.totalRows', 'utility.servedRows', 'utility.served_rows', 'overall.total']);
  const sessionRows = firstNumber(coverage, ['sessionAttributedRows', 'session_attributed_rows', 'session_rows', 'served.sessionAttributedRows']);
  const purposeRowsCount = firstNumber(coverage, ['purposeAttributedRows', 'purpose_attributed_rows', 'purpose_rows', 'served.purposeAttributedRows']);
  const latencySamples = firstNumber(data, ['operations.latencySamples', 'operations.latency_samples', 'coverage.latencySamples', 'coverage.latency_samples', 'coverage.latencySamples.total', 'coverage.latencySamples.count']);
  const accessExact = firstNumber(coverage, ['access.exactRows', 'access.exact_rows']);
  const accessTotal = firstNumber(coverage, ['access.totalRows', 'access.total_rows']);
  const semanticAvailable = firstValue(data, ['operations.explorer.semanticCoverageAvailable', 'operations.semanticCoverage.available']);
  const semanticIndexed = firstNumber(data, ['operations.explorer.semanticIndexedDocs', 'operations.semanticCoverage.indexedDocs']);
  const errorStages = asRows(operations.indexErrors?.byStage, ['stage']);
  const errorCount = Array.isArray(data.errors)
    ? data.errors.reduce((sum, item) => sum + (firstNumber(item, ['count', 'total']) ?? 1), 0)
    : firstNumber(data, ['errors.count', 'errors.total', 'operations.errors', 'operations.error_count', 'operations.indexErrors.inWindow', 'operations.indexErrors.total', 'meta.indexErrors']);

  const coverageRows = [
    ['Exact result attribution', exactRows, servedRows],
    ['Purpose attribution', purposeRowsCount, servedRows],
    ['Session attribution', sessionRows, exactRows],
    ['Exact access joins', accessExact, accessTotal],
  ].filter(([, numerator]) => numerator !== null);

  return (
    <aside className="internals-rail" aria-labelledby="internals-operations-heading">
      <div className="internals-section-heading is-compact">
        <div>
          <p className="internals-kicker">Trust & operations</p>
          <h2 id="internals-operations-heading">Can we believe the readout?</h2>
        </div>
      </div>

      <div className="internals-rail-section">
        <h3>Attribution coverage</h3>
        {coverageRows.length ? coverageRows.map(([label, numerator, denominator]) => {
          const rate = Number.isFinite(numerator) && Number.isFinite(denominator) && denominator > 0 ? numerator / denominator : null;
          return (
            <div className="internals-coverage-row" key={label}>
              <span>{label}</span>
              <strong>{formatNumber(numerator)} / {formatNumber(denominator)}</strong>
              <div className="internals-coverage-track" aria-hidden="true"><span style={{ width: `${Math.min(100, ratePercent(rate) ?? 0)}%` }} /></div>
            </div>
          );
        }) : <EmptyState>Coverage denominators are not present in this snapshot.</EmptyState>}
      </div>

      <div className="internals-rail-section">
        <h3>Instrumentation</h3>
        <dl className="internals-definition-list">
          <div><dt>Search response latency</dt><dd>{!latencySamples ? 'Not instrumented' : `${formatNumber(latencySamples)} samples`}</dd></div>
          <div><dt>Semantic index coverage</dt><dd>{semanticAvailable ? `${formatNumber(semanticIndexed)} documents` : 'Unavailable'}</dd></div>
          <div><dt>Index error events</dt><dd>{errorCount === null ? 'Unavailable' : formatNumber(errorCount)}</dd></div>
        </dl>
        {errorStages.length > 0 && (
          <ul className="internals-file-list is-errors">
            {errorStages.slice(0, 4).map(row => <li key={row.stage}><span>{row.stage}</span><strong>{formatNumber(firstNumber(row, ['count', 'total']))}</strong></li>)}
          </ul>
        )}
      </div>

      {files.length > 0 && (
        <div className="internals-rail-section">
          <h3>Telemetry files</h3>
          <ul className="internals-file-list">
            {files.slice(0, 6).map((file, index) => {
              const label = firstValue(file, ['name', 'label', 'path']) || `Source ${index + 1}`;
              const bytes = firstNumber(file, ['bytes', 'size_bytes', 'size']);
              const records = firstNumber(file, ['records', 'rows', 'count', 'validRows', 'totalLines']);
              const malformed = firstNumber(file, ['malformedRows', 'malformed_rows']);
              return <li className={malformed > 0 ? 'has-caveat' : ''} key={`${label}-${index}`}><span title={label}>{label}</span><strong>{records !== null ? `${formatNumber(records)} rows${malformed > 0 ? ` · ${formatNumber(malformed)} malformed` : ''}` : formatBytes(bytes)}</strong></li>;
            })}
          </ul>
        </div>
      )}

      {purposeRows.length > 0 && (
        <div className="internals-rail-section">
          <h3>Purpose coverage</h3>
          <ul className="internals-file-list">
            {purposeRows.slice(0, 6).map(row => (
              <li key={row.label}><span>{row.label}</span><strong>{formatNumber(row.served)} served · {formatNumber(row.used)} used</strong></li>
            ))}
          </ul>
          <p className="internals-caveat">A zero use count is comparable only where that purpose emits explicit use signals.</p>
        </div>
      )}
    </aside>
  );
}

export default function Internals({ isActive = true }) {
  const [windowValue, setWindowValue] = useState('30d');
  const loader = useCallback(({ signal, refresh }) => fetchInternals({
    window: windowValue,
    purpose: 'remember',
    refresh,
    signal,
  }), [windowValue]);
  const resource = useStaleResource(`remember:${windowValue}`, loader, { enabled: isActive });

  const model = useMemo(() => {
    if (!resource.data) return null;
    const data = resource.data;
    const utility = data.utility || {};
    const calls = firstNumber(utility, ['calls', 'attributedCalls', 'attributed_calls', 'call_instances', 'total_calls']);
    const callsWithUse = firstNumber(utility, ['callsWithUse', 'calls_with_use', 'successfulCalls', 'successful_calls', 'used_calls']);
    const served = firstNumber(data, ['utility.servedRows', 'utility.served_rows', 'utility.resultsServed', 'overall.total']);
    const used = firstNumber(data, ['utility.usedRows', 'utility.used_rows', 'utility.resultsUsed', 'overall.hit']);
    const recallRate = firstNumber(utility, ['recallSuccessRate', 'recall_success_rate', 'call_success_rate'])
      ?? (Number.isFinite(calls) && calls > 0 && Number.isFinite(callsWithUse) ? callsWithUse / calls : null);
    const resultRate = firstNumber(utility, ['resultUseRate', 'result_use_rate', 'hit_rate'])
      ?? (Number.isFinite(served) && served > 0 && Number.isFinite(used) ? used / served : null);
    return {
      data,
      utility: {
        calls,
        callsWithUse,
        recallRate,
        resultRate,
        firstAccessMrr: firstNumber(utility, ['firstAccessMrr', 'first_access_mrr', 'mrr', 'meanReciprocalRank', 'mean_reciprocal_rank']),
        lastAccessMrr: firstNumber(utility, ['lastAccessMrr', 'last_access_mrr']),
        orderedCalls: firstNumber(utility, ['orderedCalls', 'ordered_calls', 'mrrOrderedCalls', 'mrr_ordered_calls']),
        orderUnknownCalls: firstNumber(utility, ['orderUnknownCalls', 'order_unknown_calls', 'mrrOrderUnknownCalls', 'mrr_order_unknown_calls']),
        hitsConsumed: firstNumber(utility, ['hitsConsumed', 'hits_consumed']),
        hitsConsumedPerCall: firstNumber(utility, ['hitsConsumedPerCall', 'hits_consumed_per_call']),
        hitsConsumedPerSuccessfulCall: firstNumber(utility, ['hitsConsumedPerSuccessfulCall', 'hits_consumed_per_successful_call']),
        consumptionDepthSamples: firstNumber(utility, ['consumptionDepth.samples', 'consumption_depth.samples']),
        consumptionDepthP50Rank: firstNumber(utility, ['consumptionDepth.p50Rank', 'consumption_depth.p50_rank']),
        consumptionDepthP95Rank: firstNumber(utility, ['consumptionDepth.p95Rank', 'consumption_depth.p95_rank']),
      },
      firstUse: normalizeFirstUse(firstValue(data, ['firstAccessRank', 'first_access_rank', 'firstUse', 'first_use', 'firstUseDistribution', 'first_use_distribution', 'utility.firstAccessRank', 'utility.first_access_rank', 'utility.firstUsefulRank', 'utility.firstUse', 'utility.first_use_rank'])),
      sources: normalizeBreakdown(firstValue(data, ['sources', 'breakdowns.sources', 'utility.sources']), 'source'),
      projects: normalizeBreakdown(firstValue(data, ['projects', 'breakdowns.projects', 'utility.projects']), 'project'),
      purposes: normalizeBreakdown(firstValue(data, ['purposes', 'breakdowns.purposes', 'utility.purposes']), 'purpose'),
      daily: normalizeDaily(firstValue(data, ['daily', 'dailyTrend', 'daily_trend', 'trend.daily'])),
      modeCohorts: normalizeModeCohorts(firstValue(data, ['modeCohorts', 'mode_cohorts', 'backendCohorts', 'backend_cohorts'])),
    };
  }, [resource.data]);

  const meta = model?.data?.meta || {};
  const generatedAt = firstValue(meta, ['generatedAt', 'generated_at', 'createdAt', 'created_at']);
  const durationMs = firstNumber(meta, ['buildDurationMs', 'build_duration_ms', 'durationMs', 'duration_ms', 'aggregationMs', 'aggregation_ms']);
  const windowLabel = WINDOWS.find(([value]) => value === windowValue)?.[1] || windowValue;
  const caveats = [
    ...asRows(model?.data?.caveats, ['message', 'label']).map(item => firstValue(item, ['message', 'label', 'text'])),
    ...asRows(model?.data?.warnings, ['message', 'label']).map(item => firstValue(item, ['message', 'label', 'text'])),
  ].filter(Boolean);

  return (
    <div className="internals-view" aria-busy={resource.refreshing}>
      <div className="internals-shell">
        <header className="internals-header">
          <div>
            <p className="internals-kicker">Cartographer / Internals</p>
            <h1>Retrieval metabolism</h1>
            <p className="internals-intro">How Cartographer captures, retrieves, serves, and observes use—kept separate from the chronology of your work.</p>
          </div>
          <div className="internals-controls">
            <div className="internals-window-switch" aria-label="Aggregation window">
              {WINDOWS.map(([value, label]) => (
                <button type="button" key={value} className={windowValue === value ? 'is-active' : ''} aria-pressed={windowValue === value} onClick={() => setWindowValue(value)}>{label}</button>
              ))}
            </div>
            <button type="button" className={`internals-refresh${resource.refreshing ? ' is-refreshing' : ''}`} onClick={resource.refresh} disabled={resource.refreshing}>
              <span aria-hidden="true">↻</span> Refresh
            </button>
          </div>
        </header>

        <div className="internals-status" role="status">
          <span className={`internals-status-dot${resource.error ? ' is-error' : resource.refreshing ? ' is-refreshing' : ''}`} aria-hidden="true" />
          <span>{resource.error ? (model ? 'Cached snapshot; refresh failed' : 'Snapshot unavailable') : resource.refreshing ? (model ? 'Refreshing; current snapshot remains visible' : 'Building first snapshot') : resource.stale ? 'Cached snapshot; revalidation pending' : 'Current snapshot'}</span>
          <span>Generated {formatDate(generatedAt || resource.cachedAt)}</span>
          {durationMs !== null && <span>Aggregation {Math.round(durationMs).toLocaleString()} ms</span>}
        </div>

        {resource.error && (
          <div className="internals-error" role="alert">
            <strong>Refresh failed.</strong> {model ? 'The last snapshot is still shown.' : 'No Internals snapshot is available.'}
            <span>{resource.error.message}</span>
          </div>
        )}

        {!model ? (
          <div className="internals-first-load">
            <span className="internals-loader" aria-hidden="true" />
            <h2>{resource.refreshing ? 'Aggregating telemetry' : 'No telemetry snapshot'}</h2>
            <p>{resource.refreshing ? 'The first view may take longer; subsequent visits keep this result visible while refreshing.' : 'Start the Explorer server or retry the on-demand aggregation.'}</p>
          </div>
        ) : (
          <>
            {caveats.length > 0 && (
              <div className="internals-caveats">
                <strong>Coverage notes</strong>
                <span>{caveats.slice(0, 3).join(' · ')}</span>
              </div>
            )}

            <Pipeline data={model.data} windowLabel={windowLabel} />

            <section className="internals-outcomes" aria-labelledby="internals-outcomes-heading">
              <div className="internals-section-heading">
                <div>
                  <p className="internals-kicker">Exact-attributed /remember cohort</p>
                  <h2 id="internals-outcomes-heading">Retrieval outcomes</h2>
                </div>
                <p>“Use” is an explicit fetch or touch—not a claim that a result was helpful.</p>
              </div>
              <div className="internals-outcome-layout">
                <div className="internals-scoreline">
                  <Metric label="Recall success" value={formatRate(model.utility.recallRate)} detail={`${formatNumber(model.utility.callsWithUse)} of ${formatNumber(model.utility.calls)} calls`} />
                  <Metric label="Hits consumed" value={formatNumber(model.utility.hitsConsumed)} detail={`${formatDecimal(model.utility.hitsConsumedPerCall)} per call · ${formatDecimal(model.utility.hitsConsumedPerSuccessfulCall)} per successful call`} />
                  <Metric label="Consumption depth" value={formatRank(model.utility.consumptionDepthP50Rank)} detail={`p50 deepest rank · p95 ${formatRank(model.utility.consumptionDepthP95Rank)} · ${formatNumber(model.utility.consumptionDepthSamples)} calls`} />
                  <Metric label="First-access MRR" value={model.utility.firstAccessMrr === null ? '—' : model.utility.firstAccessMrr.toFixed(3)} detail={model.utility.orderedCalls === null ? 'precision proxy · no-use calls score zero' : `precision proxy · ${formatNumber(model.utility.orderedCalls)} of ${formatNumber(model.utility.calls)} jointly ordered`} />
                  <Metric label="Last-access MRR" value={model.utility.lastAccessMrr === null ? '—' : model.utility.lastAccessMrr.toFixed(3)} detail={model.utility.orderUnknownCalls ? `recall-depth proxy · ${formatNumber(model.utility.orderUnknownCalls)} order unknown` : 'recall-depth proxy · final accessed rank'} />
                  <Metric label="Result-row use" value={formatRate(model.utility.resultRate)} detail="used rows / served rows" />
                </div>
                <div className="internals-rank-panel">
                  <h3>First access rank</h3>
                  <FirstUse rows={model.firstUse} />
                </div>
              </div>
            </section>

            <ModeCohorts rows={model.modeCohorts} />

            <div className="internals-diagnostic-grid">
              <div className="internals-main-diagnostics">
                <section className="internals-section" aria-labelledby="internals-trace-heading">
                  <div className="internals-section-heading is-compact">
                    <div><p className="internals-kicker">Retrieval activity</p><h2 id="internals-trace-heading">Daily trace</h2></div>
                    <p>System telemetry—not session lanes.</p>
                  </div>
                  <DailyTrace rows={model.daily} />
                </section>

                <section className="internals-section" aria-labelledby="internals-source-heading">
                  <div className="internals-section-heading is-compact">
                    <div><p className="internals-kicker">Contribution versus use</p><h2 id="internals-source-heading">Sources</h2></div>
                    <div className="internals-legend"><span><i className="is-served" />served</span><span><i className="is-use" />used</span></div>
                  </div>
                  <ContributionBars rows={model.sources} empty="Source contribution is unavailable for this window." />
                </section>

                {model.projects.length > 0 && (
                  <section className="internals-section" aria-labelledby="internals-project-heading">
                    <div className="internals-section-heading is-compact">
                      <div><p className="internals-kicker">Where retrieval runs</p><h2 id="internals-project-heading">Projects</h2></div>
                    </div>
                    <ContributionBars rows={model.projects} empty="Project breakdown is unavailable for this window." />
                  </section>
                )}
              </div>
              <OperationsRail data={model.data} purposeRows={model.purposes} />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
