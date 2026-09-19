import { useEffect, useMemo, useRef, useState } from 'react';
import { activityFromMemory } from '../../shared/activity-scope.js';
import { workspaceHref } from '../hooks/useFocusWorkspace.js';
import FocusRangeOverlay from './FocusRangeOverlay.jsx';

const COLORS = ['#e06c75','#c678dd','#e5c07b','#56b6c2','#61afef','#d19a66','#98c379','#ff6b9d','#c3a6ff','#8b95a7'];
const PIXELS_PER_HOUR = { overview: 20, detail: 100 };
const TIME_GUTTER = 76, MAX_CONTEXT_SESSIONS = 200;
const hashColor = value => { let hash = 0; for (const char of value || '') hash = ((hash << 5) - hash + char.charCodeAt(0)) | 0; return COLORS[Math.abs(hash) % COLORS.length]; };
const labelColor = value => '#' + hashColor(value).slice(1).match(/../g).map(channel => Math.round(parseInt(channel, 16) * .7 + 255 * .3).toString(16).padStart(2, '0')).join('');
const clock = value => new Date(value).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const day = value => new Date(value).toLocaleDateString([], { month: 'short', day: 'numeric' });
const duration = (from, through) => { const minutes = Math.max(0, Math.round((through-from)/60000)); return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes/60)}h ${minutes%60}m`; };
const eventColor = type => /commit/.test(type) ? '#98c379' : /edit/.test(type) ? '#d19a66' : /search|research|fetch/.test(type) ? '#61afef' : /wrap|session|agent/.test(type) ? '#c678dd' : '#8b95a7';
const sample = (records, limit = 160) => {
  if (records.length <= limit) return records;
  const stride = (records.length - 1) / (limit - 1);
  return Array.from({ length: limit }, (_, index) => records[Math.round(index * stride)]);
};

function recordsBySession(snapshot) {
  const result = new Map();
  for (const record of snapshot?.evidenceIndex || []) {
    if (!record.sessionId) continue;
    if (!result.has(record.sessionId)) result.set(record.sessionId, []);
    result.get(record.sessionId).push(record);
  }
  for (const records of result.values()) records.sort((a,b)=>a.t-b.t);
  return result;
}

export default function ConcurrentTimeline({ workspace, focus, onSession, scrollRef: outerScrollRef }) {
  const { route, context, scoped, interval, bounds, preview, commitRange } = workspace;
  const internalScroll = useRef(null), chartRef = useRef(null);
  const [width, setWidth] = useState(900), [hovered, setHovered] = useState(null);
  const scrollRef = outerScrollRef || internalScroll;
  useEffect(() => {
    const node = chartRef.current;
    if (!node || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setWidth(node.parentElement?.clientWidth || node.clientWidth || 900));
    observer.observe(node.parentElement || node); return () => observer.disconnect();
  }, []);
  const contextActivity = useMemo(() => context ? activityFromMemory(context) : {sessions:[],overlaps:[]}, [context]);
  const focusedActivity = useMemo(() => scoped ? activityFromMemory(scoped) : {sessions:[],overlaps:[]}, [scoped]);
  const focusedIds = useMemo(() => new Set(focusedActivity.sessions.map(session => session.session_id)), [focusedActivity]);
  const records = useMemo(() => recordsBySession(context), [context]);
  const sortedContext = useMemo(() => [...contextActivity.sessions].sort((a,b)=>(b.lastObserved||0)-(a.lastObserved||0)), [contextActivity]);
  const contextSessions = sortedContext.slice(0, MAX_CONTEXT_SESSIONS);
  const visibleIds = useMemo(() => new Set(contextSessions.map(session => session.session_id)), [contextSessions]);
  const overlaps = contextActivity.overlaps.filter(overlap => overlap.sessions.every(id => visibleIds.has(id)));
  const domain = bounds || { from: 0, through: 1 }, range = Math.max(1, domain.through-domain.from);
  const chartHeight = Math.max(480, range/3600000 * PIXELS_PER_HOUR[route.zoom]);
  const timeToY = time => chartHeight - ((Number(time)-domain.from)/range)*chartHeight;
  const lanes = useMemo(() => {
    const map = new Map();
    for (const session of contextSessions) { const project=session.project||'Unattributed'; if(!map.has(project))map.set(project,[]); map.get(project).push(session); }
    return [...map].map(([project,sessions])=>({project,sessions}));
  }, [contextSessions]);
  const laneWidth = Math.max(96, Math.min(220, (Math.max(width,480)-TIME_GUTTER)/Math.max(1,lanes.length)));
  const chartWidth = Math.max(width,TIME_GUTTER+lanes.length*laneWidth);
  const laneIndex = useMemo(() => new Map(lanes.flatMap((lane,index)=>lane.sessions.map(session=>[session.session_id,index]))), [lanes]);
  const labels = useMemo(() => { const result=[]; const step=route.zoom==='detail'?3600000:6*3600000; let cursor=Math.ceil(domain.from/step)*step; while(cursor<=domain.through){result.push({time:cursor,y:timeToY(cursor)});cursor+=step;} return result.map((label,index) => ({ ...label, showDate: index === result.length - 1 || day(label.time) !== day(result[index+1].time) })); }, [domain.from,domain.through,route.zoom,chartHeight]);
  const hours = useMemo(() => { const result=[]; let cursor=Math.floor(domain.from/3600000)*3600000; while(cursor<domain.through){const next=cursor+3600000;result.push({from:Math.max(cursor,domain.from),through:Math.min(next,domain.through),hour:new Date(cursor).getHours()});cursor=next;} return result; }, [domain.from,domain.through]);
  const sky = hour => hour<6||hour>=21?'#080812':hour<9?'#231220':hour>=17?'#201014':'#0c1019';
  const saved = focus?.saved?.interval || focus?.saved || null;

  return <div className="concurrent-focus">
    <div className="concurrent-focus-controls">
      <div className="concurrent-frame" role="group" aria-label="Context frame"><span>Context</span>{[1,3,7,30].map(value=><button key={value} aria-pressed={route.days===value} onClick={()=>workspace.frame(value)}>{value}d</button>)}</div>
      <button className="concurrent-fit" disabled={!workspace.fit} onClick={() => workspace.fit?.()}>Fit focus</button>
      <div className="concurrent-frame" role="group" aria-label="Timeline scale"><span>Scale</span>{['overview','detail'].map(value=><button key={value} aria-pressed={route.zoom===value} onClick={()=>workspace.navigate({zoom:value},{replace:true})}>{value}</button>)}</div>
      <span className="concurrent-counts"><strong>{focusedActivity.sessions.length}</strong> tasks · <strong>{scoped?.counts?.events || 0}</strong> records in focus · {contextSessions.length} context tasks</span>
    </div>
    {sortedContext.length > MAX_CONTEXT_SESSIONS && <p className="concurrent-limit" role="status">Showing the {MAX_CONTEXT_SESSIONS} most recent of {sortedContext.length} context tasks.</p>}
    {!contextSessions.length ? <p className="concurrent-empty">No recorded tasks match these context filters.</p> : <div className="concurrent-scroll" ref={scrollRef}>
      <div className="concurrent-lane-headings" style={{width:chartWidth,paddingLeft:TIME_GUTTER}}>{lanes.map(lane=><div key={lane.project} style={{width:laneWidth,color:labelColor(lane.project)}} title={lane.project}>{lane.project}</div>)}</div>
      <div className="concurrent-chart" ref={chartRef} style={{width:chartWidth,height:chartHeight}}>
        {hours.map(hour=><div key={hour.from} className="concurrent-sky" style={{top:timeToY(hour.through),height:Math.abs(timeToY(hour.from)-timeToY(hour.through)),background:sky(hour.hour)}} />)}
        {labels.map(label=><div key={label.time} className="concurrent-tick" style={{top:label.y}}><time dateTime={new Date(label.time).toISOString()}><span>{label.showDate ? day(label.time) : ''}</span><span>{clock(label.time)}</span></time><i /></div>)}
        {overlaps.map((overlap,index)=>{const a=laneIndex.get(overlap.sessions[0]),b=laneIndex.get(overlap.sessions[1]);if(a==null||b==null||a===b)return null;const left=TIME_GUTTER+Math.min(a,b)*laneWidth,right=TIME_GUTTER+(Math.max(a,b)+1)*laneWidth;return <div key={`${overlap.sessions.join(':')}:${index}`} className="concurrent-overlap" style={{left,width:right-left,top:timeToY(overlap.through),height:Math.max(2,timeToY(overlap.from)-timeToY(overlap.through))}} />;})}
        {lanes.map((lane,laneNumber)=>{const left=TIME_GUTTER+laneNumber*laneWidth,color=hashColor(lane.project);return <div key={lane.project}>{lane.sessions.map(session=>(session.segments||[]).map((segment,index)=>{const top=timeToY(segment.through),bottom=timeToY(segment.from),barTop=Math.min(top,bottom),barHeight=Math.max(4,Math.abs(bottom-top));const isFocused=focusedIds.has(session.session_id)&&(records.get(session.session_id)||[]).some(record=>record.t>=segment.from&&record.t<=segment.through&&(interval.lower==='open'?record.t>interval.from:record.t>=interval.from)&&record.t<=interval.through);const href=workspaceHref({...route,session:session.session_id,file:null,review:null},'timeline');const sessionRecords=(records.get(session.session_id)||[]).filter(record=>record.t>=segment.from&&record.t<=segment.through);return <a key={`${session.session_id}:${index}`} href={href}
          className="concurrent-session" data-in-focus={isFocused||undefined} data-hovered={hovered===session.session_id||undefined}
          style={{left:left+4,top:barTop,width:laneWidth-8,height:Math.max(12,barHeight),borderColor:color,backgroundColor:`${color}${isFocused?'66':'24'}`}}
          onClick={event=>{if(event.button===0&&!event.metaKey&&!event.ctrlKey&&!event.shiftKey&&!event.altKey){event.preventDefault();onSession(session,event.currentTarget);}}}
          onPointerEnter={()=>setHovered(session.session_id)} onPointerLeave={()=>setHovered(null)}
          aria-label={`Inspect ${session.title||session.session_id}, ${duration(segment.from,segment.through)}, ${segment.eventCount} recorded events`}
          title={`${session.title||session.session_id}\n${lane.project}\n${duration(segment.from,segment.through)} · ${segment.eventCount} events`}>
          {route.zoom==='detail'&&sample(sessionRecords).map((record,eventIndex)=><i key={record.id||eventIndex} style={{top:Math.max(0,Math.min(barHeight,timeToY(record.t)-barTop)),background:eventColor(record.type)}} />)}
        </a>}))}</div>;})}
        <FocusRangeOverlay interval={interval} bounds={domain} savedInterval={saved} onPreview={preview} onCommit={commitRange} timeToY={timeToY} height={chartHeight} gutter={{left:0,width:TIME_GUTTER}} disabled={!interval} />
      </div>
    </div>}
  </div>;
}
