import { useEffect, useMemo, useRef, useState } from 'react';
import { createMemoryWeather } from './memory-weather.js';
import { projectMemoryScope } from '../../shared/activity-scope.js';
import { memoryAxes } from '../api.js';
export default function MemoryActivity({ workspace, onSession, hrefForSession }) {
  const host = useRef(null), weather = useRef(null), latest = useRef(workspace);
  latest.current = { ...workspace, onSession, hrefForSession };
  const [axes, setAxes] = useState(null);
  const chartData = useMemo(() => workspace.data && workspace.interval ? projectMemoryScope(workspace.data, { ...workspace.route, ...workspace.interval, brush: null }) : null, [workspace.data, workspace.interval?.from, workspace.interval?.through, workspace.interval?.lower, workspace.route.q, workspace.route.project, workspace.route.result, workspace.route.kind, JSON.stringify(workspace.route.providers), JSON.stringify(workspace.route.evidence)]);
  useEffect(() => { let alive = true; memoryAxes().then(value => alive && setAxes(value)).catch(() => alive && setAxes([])); return () => { alive = false; }; }, []);
  useEffect(() => {
    if (!chartData || axes === null || !host.current) return;
    if (!weather.current) weather.current = createMemoryWeather(host.current, chartData, {
      axes, compact: false, route: { ...workspace.route, at: workspace.interval.through, end: workspace.interval.through },
      onSelect: session => latest.current.onSession(session), hrefForSession: session => latest.current.hrefForSession(session),
      onBrush: brush => latest.current.navigate({ brush }),
      onNavigate: patch => {
        const presentation = Object.fromEntries(Object.entries(patch).filter(([key]) => ['view', 'x', 'y', 'cam', 'panels', 'brush'].includes(key)));
        if (Object.keys(presentation).length) latest.current.navigate(presentation);
      },
    });
    else weather.current.update(chartData, Boolean(workspace.status?.ready));
    weather.current.applyRoute({ ...workspace.route, at: workspace.interval.through, end: workspace.interval.through });
  }, [chartData, workspace.route, axes]);
  useEffect(() => () => { weather.current?.destroy(); weather.current = null; }, []);
  return <section className="fw-activity" aria-label="Explore activity"><div className="fw-activity-intro"><p>Field, Wake and Compare describe the same focus. Selecting a cohort does not change the interval.</p><button onClick={() => workspace.handoff('timeline', { timelineView: 'concurrent' })}>Open Concurrent timeline ↗</button></div><div ref={host} id="memory-weather" /></section>;
}
