import { brushHits, semanticLevel, zoomCameraAt } from './memory-brush';
import { sessionMetricsAt, formatDuration, formatCount } from './memory-metrics';
import { plainLinkClick, normalizeMemoryRoute, CAM_MIN_SCALE, CAM_MAX_SCALE } from './memory-route';
// Canvas field and semantic zoom. Data comes from the warm corpus; positions stay stable as it updates.

export function createMemoryWeather(root, initialData, {
  onSelect, onNavigate, hrefForSession, route = {}, axes = [], compact = false, onHover, onBrush, onRestoreFocus
} = {}) {
  let data = initialData;
  root.classList.toggle('mw-compact', compact);
  root.innerHTML = `
<div class="mw-controls">
 <div class="mw-modes mw-now"><button type="button" class="mw-control mw-live" data-live aria-pressed="true">Live</button><output class="mw-clock"></output></div>
</div>
<div class="mw-compare-controls">
 <label>Across <select data-x aria-label="Horizontal dimension"><option value="spanMs">Recorded span</option><option value="activeMs">Active periods</option></select></label>
 <label>Up <select data-y aria-label="Vertical dimension"><option value="output">Generated tokens</option><option value="total">Processed tokens</option><option value="edit">Edit records</option><option value="files">Files touched</option><option value="research">Research actions</option><option value="commit">Commits</option><option value="events">All activity</option></select></label>
</div>
<div class="mw-brush-label" aria-live="polite"><strong>Brush a thread to identify it</strong><span>Hover or focus a mark</span><span class="mw-brush-values"></span></div><div class="mw-gesture"><button type="button" class="mw-control" data-gesture="brush" aria-pressed="false" title="Drag to select instead of pan">Brush</button></div><div class="mw-stages"></div>
<details class="mw-about"><summary>Chart key</summary><div class="mw-reading"></div><p class="mw-note"></p></details>
<p class="mw-brush-hint">Hover to identify · drag to select · Space to pin · Esc to clear</p>
<div class="mw-bottom"><button type="button" class="mw-control" data-play>Replay</button><input type="range" min="0" max="1440" value="1440" step="1" aria-label="Time across the last 24 hours"></div>
`;
  const controls = new Map();
  const $ = s => root.querySelector(s) || controls.get(s),
    stages = $('.mw-stages');
  for (const selector of ['.mw-compare-controls','[data-x]','[data-y]','.mw-gesture']) controls.set(selector,$(selector));
  // An empty list means "no restriction" — live data can fill every axis. A
  // populated one comes from a corpus that knows which measures it actually
  // carries, and the ones it does not are removed rather than left to plot a
  // flat zero line that reads as a finding.
  if (axes.length) {
    for (const option of [...$('[data-y]').options]) if (!axes.includes(option.value)) option.remove();
    if (!$('[data-y]').options.length) $('.mw-compare-controls').hidden = true;
  }
  // The surviving options are the one authority on what the Y axis can be.
  // render() assigns state.y straight onto the select, and assigning a value no
  // option carries sets selectedIndex to -1 — which the compare readout then
  // dereferences. That is reachable from a permalink alone (?y=files), so the
  // clamp is not specific to a filtered demo.
  const yOptions = [...$('[data-y]').options].map(option => option.value);
  const MODES = ['field', 'wake', 'compare'];
  // Semantic zoom: positions transform, glyph and label sizes do not.
  // Magnifying the raster would only blur it; the point of zooming here is to
  // reach detail that simply is not drawn when zoomed out.
  const MIN_SCALE = CAM_MIN_SCALE,
    MAX_SCALE = CAM_MAX_SCALE;
  let view = { x: 0, y: 0, scale: 1 };
  const fieldCamera = { x: route.cam?.x ?? 0, y: route.cam?.y ?? 0, scale: route.cam?.scale ?? 1 };
  // Which panels the viewer wants. Honoured when the layout has room for more
  // than one; below that the same buttons pick the single visible mode.
  const shown = new Set(route.panels?.length ? route.panels : MODES);
  const vx = wx => wx * view.scale + view.x,
    vy = wy => wy * view.scale + view.y,
    tierOf = scale => ({projects:'project',sessions:'session',artifacts:'artifact'})[semanticLevel(scale)];
  // One panel per visible mode. field/wake/compare each write a point's hit
  // position, so those coordinates have to live per panel: with three panels
  // drawn at once, a single shared p.hx would keep only the last one and
  // hit-testing would break in the other two.
  const panels = [];
  let canvas = null,
    ctx = null,
    coords = new Map();
  function createPanel(mode) {
    const stage = document.createElement('div');
    stage.className = 'mw-stage';
    stage.dataset.panel = mode;
    const c = document.createElement('canvas');
    c.setAttribute('role', 'img');
    const targetsHost = document.createElement('div');
    targetsHost.className = 'mw-targets';
    const header = document.createElement('header');
    header.className = 'mw-panel-header';
    const caption = document.createElement('h3');
    caption.className = 'mw-panel-title';
    caption.textContent = mode === 'field' ? 'Field' : mode === 'wake' ? 'Wake' : 'Compare';
    header.append(caption);
    if (mode === 'wake') {
      const period = document.createElement('span');
      period.className = 'mw-panel-meta';
      period.textContent = '24h';
      header.append(period);
    }
    if (mode === 'compare') {
      const settings = document.createElement('details');
      settings.className = 'mw-axis-settings';
      settings.innerHTML = '<summary aria-label="Comparison axes">Axes</summary>';
      settings.append($('.mw-compare-controls'));
      settings.open = route.view === 'compare';
      header.append(settings);
    }
    stage.append(c, targetsHost, header);
    if (mode === 'field') {
      const nav = document.createElement('div');
      nav.className = 'mw-nav';
      nav.innerHTML = '<button type="button" class="mw-control" data-zoom="in" aria-label="Zoom in">+</button>'
        + '<button type="button" class="mw-control" data-zoom="out" aria-label="Zoom out">\u2212</button>'
        + '<button type="button" class="mw-control" data-zoom="fit" aria-label="Fit the whole field">Fit</button>';
      header.append($('.mw-gesture'), nav);
    }
    return {
      mode, stage, canvas: c, ctx: c.getContext('2d'), targetsHost,
      W: 736, H: 550, coords: new Map(),
      // Each panel keeps its own camera: zooming the field must not move the
      // wake trace beside it. The field's is the shared one, so a linked zoom
      // applies on mount rather than only on a later navigation.
      view: mode === 'field' ? fieldCamera : { x: 0, y: 0, scale: 1 }
    };
  }
  /** Reconcile the mounted panels to `modes`, keeping existing ones in place. */
  function syncPanels(modes) {
    const keep = new Map(panels.map(panel => [panel.mode, panel]));
    panels.length = 0;
    for (const mode of modes) panels.push(keep.get(mode) || createPanel(mode));
    stages.replaceChildren(...panels.map(panel => panel.stage));
    for (const panel of panels) wirePanel?.(panel);
    stages.dataset.count = String(panels.length);
    return panels;
  }
  const state = {
    mode: route.view || 'field',
    time: route.at ?? data.end,
    live: route.at == null,
    connected: true,
    selected: route.session || null,
    brush: route.brush || [],
    preview: null,
    playing: false,
    x: route.x || 'spanMs',
    y: yOptions.includes(route.y) ? route.y : (yOptions[0] || 'output')
  };
  // A direct detail link starts with hidden, unsized canvases. Controls must
  // already reflect its route, independently of the first paint or resize.
  $('[data-x]').value = state.x;
  $('[data-y]').value = state.y;
  const camKey = cam => cam ? `${cam.x},${cam.y},${cam.scale}` : '';
  const routeKey = r => [r.view, r.x, r.y, r.at, r.end, camKey(r.cam), (r.panels || []).join(), (r.brush || []).join()].join('|');
  const fieldPanel = () => panels.find(panel => panel.mode === 'field');
  let pendingRouteKey = null;
  let lastPublished = 0;
  function viewState() {
    const v = fieldPanel()?.view;
    return {
      view: state.mode, x: state.x, y: state.y,
      at: state.live ? null : Math.round(state.time), end: state.live ? null : data.end,
      cam: v ? { x: v.x, y: v.y, scale: v.scale } : null,
      panels: [...shown], brush: state.brush
    };
  }
  function publish(options) {
    const next = viewState();
    pendingRouteKey = routeKey(normalizeMemoryRoute(next));
    onNavigate?.(next, options);
  }
  const hash = value => {
    let n = 2166136261;
    for (const c of value) n = Math.imul(n ^ c.charCodeAt(0), 16777619);
    return n >>> 0;
  };
  const groupIndex = s => hash(s.group) % 5;
  const points = data.sessions.map((s, i) => ({
    ...s,
    i,
    label: shortLabel(s.title),
    x: 0,
    y: 0,
    hx: 0,
    hy: 0
  }));
  function shortLabel(title) {
    return title.length > 34 ? title.slice(0, 31) + '…' : title;
  }
  const colorTokens = ['--mw-cyan', '--mw-blue', '--mw-violet', '--mw-green', '--mw-muted'];
  const probe = document.createElement('span');
  probe.style.display = 'none';
  root.append(probe);
  let W = 736,
    H = 550,
    dpr = 1,
    palette = [],
    ink = '',
    bg = '',
    muted = '',
    raf = 0,
    lastFrame = 0,
    lastPaint = 0;
  const gridCanvas = document.createElement('canvas'),
    gctx = gridCanvas.getContext('2d');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  function color(token) {
    probe.style.color = `var(${token})`;
    return getComputedStyle(probe).color;
  }
  function rgb(s) {
    const nums = s.match(/[\d.]+/g)?.map(Number) || [];
    if (s.startsWith('color(srgb')) return nums.slice(0, 3).map(v => v * 255);
    return nums.slice(0, 3);
  }
  function theme() {
    palette = colorTokens.map(t => ({
      css: color(t),
      rgb: rgb(color(t))
    }));
    ink = color('--mw-ink');
    bg = color('--mw-bg');
    muted = color('--mw-muted');
  }
  function setup() {
    const modes = visibleModes();
    if (panels.length !== modes.length || panels.some((panel, i) => panel.mode !== modes[i])) syncPanels(modes);
    dpr = Math.min(devicePixelRatio || 1, 2);
    let sized = false;
    for (const panel of panels) {
      if (!panel.stage.clientWidth || !panel.stage.clientHeight) continue;
      panel.W = panel.stage.clientWidth;
      panel.H = panel.stage.clientHeight;
      panel.canvas.width = Math.round(panel.W * dpr);
      panel.canvas.height = Math.round(panel.H * dpr);
      panel.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      sized = true;
    }
    if (!sized) return;
    theme();
    layout();
    render();
  }
  function projectAffinity(a, b) {
    let intersection = 0,
      union = 0;
    for (const k of new Set([...Object.keys(a.projects), ...Object.keys(b.projects)])) {
      if (k === 'dev') continue;
      const av = (a.projects[k] || 0) / a.count,
        bv = (b.projects[k] || 0) / b.count;
      intersection += Math.min(av, bv);
      union += Math.max(av, bv);
    }
    return union ? intersection / union : 0;
  }
  let affinity = points.map(a => points.map(b => projectAffinity(a, b)));
  /** Every mode at once when there is room; otherwise the one the buttons pick. */
  const ALL_PANELS_MIN = 1180;
  const roomForMany = () => (stages.clientWidth || root.clientWidth || 0) >= ALL_PANELS_MIN;
  function visibleModes() {
    if (!compact && !roomForMany()) return [state.mode];
    const list = MODES.filter(mode => shown.has(mode));
    // Turning the last panel off would leave nothing to look at.
    return list.length ? list : [state.mode];
  }
  function layout() {
    const {W,H} = panels.find(panel=>panel.mode==='field') || panels[0] || {W:736,H:550};
    const margin = 36;
    for (const p of points) {
      const seed = hash(p.group),
        angle = hash(p.id) * 2.3999632297;
      const a = [.22 + seed % 57 / 100, .22 + (seed >>> 8) % 53 / 100];
      p.ax = a[0] * W;
      p.ay = a[1] * H;
      p.x = p.ax + Math.cos(angle) * 55;
      p.y = p.ay + Math.sin(angle) * 55;
    }
    for (let step = 0; step < 300; step++) {
      for (const p of points) {
        p.x += (p.ax - p.x) * .013;
        p.y += (p.ay - p.y) * .013;
      }
      for (let i = 0; i < points.length; i++) for (let j = i + 1; j < points.length; j++) {
        const a = points[i],
          b = points[j];
        let dx = b.x - a.x,
          dy = b.y - a.y,
          dist = Math.hypot(dx, dy) || .1;
        const desired = 53 + (affinity[i][j] > .1 ? 5 : 25);
        const push = dist < desired ? (desired - dist) * .20 : affinity[i][j] > .35 ? (desired - dist) * .0012 : 0;
        const nx = dx / dist,
          ny = dy / dist;
        a.x -= nx * push;
        a.y -= ny * push;
        b.x += nx * push;
        b.y += ny * push;
      }
      for (const p of points) {
        p.x = clamp(p.x, margin, W - margin);
        p.y = clamp(p.y, 56, Math.max(56,H - margin));
      }
    }
  }
  function sample() {
    return points.map(p => {
      let heat = 0,
        last = -Infinity,
        count = 0,
        recent = [];
      for (const e of p.events) {
        if (e[0] > state.time) break;
        count++;
        last = e[0];
        if (e[1] !== 'lifecycle') {
          const age = (state.time - e[0]) / 60000;
          if (age < 360) heat += Math.exp(-age / 36);
          if (age < 7) recent.push(e);
        }
      }
      return {
        p,
        heat,
        last,
        count,
        recent,
        age: state.time - last,
        weight: Math.log1p(heat) * .43
      };
    });
  }
  function contour(values, nx, ny, threshold) {
    const dx = W / (nx - 1),
      dy = H / (ny - 1);
    ctx.beginPath();
    const cases = {
      1: [[3, 0]],
      2: [[0, 1]],
      3: [[3, 1]],
      4: [[1, 2]],
      5: [[3, 0], [1, 2]],
      6: [[0, 2]],
      7: [[3, 2]],
      8: [[2, 3]],
      9: [[0, 2]],
      10: [[0, 1], [2, 3]],
      11: [[1, 2]],
      12: [[3, 1]],
      13: [[0, 1]],
      14: [[3, 0]]
    };
    for (let y = 0; y < ny - 1; y++) for (let x = 0; x < nx - 1; x++) {
      const v = [values[y * nx + x], values[y * nx + x + 1], values[(y + 1) * nx + x + 1], values[(y + 1) * nx + x]],
        code = v.reduce((n, a, i) => n + (a >= threshold ? 1 << i : 0), 0),
        pairs = cases[code];
      if (!pairs) continue;
      const corners = [[x * dx, y * dy], [(x + 1) * dx, y * dy], [(x + 1) * dx, (y + 1) * dy], [x * dx, (y + 1) * dy]];
      function edge(k) {
        const next = (k + 1) % 4,
          t = clamp((threshold - v[k]) / (v[next] - v[k] || 1), 0, 1);
        return [corners[k][0] + (corners[next][0] - corners[k][0]) * t, corners[k][1] + (corners[next][1] - corners[k][1]) * t];
      }
      for (const [a, b] of pairs) {
        const pa = edge(a),
          pb = edge(b);
        ctx.moveTo(...pa);
        ctx.lineTo(...pb);
      }
    }
    ctx.stroke();
  }
  function density(samples) {
    const nx = Math.max(40, Math.round(W / 9)),
      ny = Math.max(35, Math.round(H / 9));
    gridCanvas.width = nx;
    gridCanvas.height = ny;
    const pixels = gctx.createImageData(nx, ny),
      values = new Float32Array(nx * ny),
      active = samples.filter(s => s.weight > .045);
    for (let y = 0; y < ny; y++) for (let x = 0; x < nx; x++) {
      const px = x / (nx - 1) * W,
        py = y / (ny - 1) * H;
      let sum = 0,
        rr = 0,
        gg = 0,
        bb = 0;
      for (const s of active) {
        const radius = (22 + Math.sqrt(s.heat) * 5.5) * (W < 450 ? .75 : 1) * view.scale;
        const d2 = (px - vx(s.p.x)) ** 2 + (py - vy(s.p.y)) ** 2;
        const value = s.weight * Math.exp(-d2 / (2 * radius * radius));
        sum += value;
        const c = palette[groupIndex(s.p)].rgb;
        rr += c[0] * value;
        gg += c[1] * value;
        bb += c[2] * value;
      }
      values[y * nx + x] = sum;
      const k = (y * nx + x) * 4;
      pixels.data[k] = rr / (sum || 1);
      pixels.data[k + 1] = gg / (sum || 1);
      pixels.data[k + 2] = bb / (sum || 1);
      pixels.data[k + 3] = Math.min(72, sum * 21);
    }
    gctx.putImageData(pixels, 0, 0);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(gridCanvas, 0, 0, W, H);
    ctx.strokeStyle = ink;
    ctx.lineWidth = .8;
    for (const level of [.14, .28, .52, .84, 1.25, 1.8, 2.5, 3.3, 4.2]) {
      ctx.globalAlpha = .13 + Math.min(.12, level * .025);
      contour(values, nx, ny, level);
    }
    ctx.globalAlpha = 1;
  }
  function drawLabel(text, x, y, used, force = false) {
    ctx.font = '500 16px ui-sans-serif,system-ui,sans-serif';
    const width = ctx.measureText(text).width;
    const tx = clamp(x - width / 2, 6, W - width - 6),
      ty = clamp(y, 18, H - 8);
    const box = {
      x: tx - 3,
      y: ty - 16,
      w: width + 6,
      h: 21
    };
    if (!force && used.some(b => box.x < b.x + b.w && box.x + box.w > b.x && box.y < b.y + b.h && box.y + box.h > b.y)) return false;
    ctx.lineWidth = 5;
    ctx.strokeStyle = bg;
    ctx.lineJoin = 'round';
    ctx.globalAlpha = 1;
    ctx.strokeText(text, tx, ty);
    ctx.fillStyle = ink;
    ctx.fillText(text, tx, ty);
    used.push(box);
    return true;
  }
  const CODE_EXT = /\.(js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|c|h|cpp|css|scss|html|sh|sql|swift|kt|vue|svelte)$/i;
  const DOC_EXT = /\.(md|mdx|txt|rst|adoc|json|ya?ml|toml)$/i;
  /** commit / code / doc / research — the artifact kinds the near tier exposes. */
  function artifactsFor(p) {
    const items = [];
    for (const e of p.events) {
      if (e[0] > state.time) continue;
      if (e[1] === 'commit') items.push({ kind: 'commit', label: 'commit' });
      else if (e[1] === 'research') items.push({ kind: 'research', label: 'research' });
    }
    for (const f of data.files?.[p.id] || []) {
      const first = f.edits?.[0]?.t;
      if (first && first > state.time) continue;
      items.push({ kind: CODE_EXT.test(f.name) ? 'code' : DOC_EXT.test(f.name) ? 'doc' : 'file', label: f.name, path: f.path });
    }
    return items;
  }
  const ARTIFACT_ORDER = { commit: 0, code: 1, doc: 2, file: 3, research: 4 };
  /** drawLabel clamps into the panel, so a name whose anchor has been panned
   *  out of view would strand itself against an edge, detached from its mark. */
  const labelVisible = (x, y) => x > 8 && y > 8 && x < W - 8 && y < H - 4;
  function drawArtifact(kind, x, y, c) {
    ctx.beginPath();
    if (kind === 'commit') {
      ctx.fillStyle = c;
      ctx.rect(x - 3, y - 3, 6, 6);
      ctx.fill();
    } else if (kind === 'research') {
      ctx.strokeStyle = c;
      ctx.lineWidth = 1.2;
      ctx.arc(x, y, 3.2, 0, Math.PI * 2);
      ctx.stroke();
    } else if (kind === 'code') {
      ctx.fillStyle = c;
      ctx.arc(x, y, 2.6, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = c;
      ctx.lineWidth = 1;
      ctx.moveTo(x - 2.6, y);
      ctx.lineTo(x + 2.6, y);
      ctx.moveTo(x, y - 2.6);
      ctx.lineTo(x, y + 2.6);
      ctx.stroke();
    }
  }
  /** Near tier: a session's own commits, touched code and touched docs. */
  function fieldArtifacts(samples, selected, used) {
    for (const s of samples) {
      if (!s.count) continue;
      const p = s.p,
        X = vx(p.x),
        Y = vy(p.y),
        c = palette[groupIndex(p)].css;
      if (X < -180 || Y < -180 || X > W + 180 || Y > H + 180) continue;
      const items = artifactsFor(p).sort((a, b) => ARTIFACT_ORDER[a.kind] - ARTIFACT_ORDER[b.kind]);
      const focus = selected === p.id;
      ctx.globalAlpha = focus ? 1 : .5;
      ctx.strokeStyle = c;
      ctx.fillStyle = c;
      ctx.beginPath();
      ctx.arc(X, Y, 3, 0, Math.PI * 2);
      ctx.fill();
      // Spacing is in screen pixels, so zooming in separates the clouds
      // instead of magnifying one blob.
      const step = 13,
        perRing = 9;
      items.forEach((item, i) => {
        const ring = Math.floor(i / perRing) + 1,
          angle = (i % perRing) / perRing * Math.PI * 2 + ring * .7,
          ax = X + Math.cos(angle) * step * ring,
          ay = Y + Math.sin(angle) * step * ring;
        if (ax < -20 || ay < -20 || ax > W + 20 || ay > H + 20) return;
        ctx.globalAlpha = focus ? .95 : .62;
        drawArtifact(item.kind, ax, ay, item.kind === 'commit' ? ink : c);
        const named = item.kind === 'code' || item.kind === 'doc' || item.kind === 'file';
        if (focus && named && labelVisible(ax, ay - 9) && view.scale > 2.9) {
          ctx.globalAlpha = focus ? .95 : .6;
          drawLabel(item.label, ax, ay - 9, used, focus);
        }
      });
      if (focus) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(X, Y, 8, 0, Math.PI * 2);
        ctx.stroke();
      }
      coords.set(p.id, [X, Y]);
    }
  }
  /** Far tier: sessions collapse into the project they belong to. */
  function fieldProjects(samples, selected, used) {
    const groups = new Map();
    for (const s of samples) {
      if (!s.count) continue;
      const g = groups.get(s.p.group) || { group: s.p.group, x: 0, y: 0, n: 0, heat: 0, p: s.p, members: [] };
      g.x += s.p.x;
      g.y += s.p.y;
      g.n++;
      g.heat += s.heat;
      g.members.push(s.p);
      groups.set(s.p.group, g);
    }
    // Marks first, then labels, so no mark is drawn over a name.
    const marks = [];
    for (const g of groups.values()) {
      const X = vx(g.x / g.n),
        Y = vy(g.y / g.n),
        r = 4 + Math.min(10, Math.sqrt(g.n) * 3),
        c = palette[groupIndex(g.p)].css,
        focus = g.members.some(m => m.id === selected);
      marks.push({ g, X, Y, r, focus });
      ctx.globalAlpha = focus ? 1 : .8;
      ctx.fillStyle = c;
      ctx.strokeStyle = c;
      ctx.beginPath();
      ctx.arc(X, Y, r, 0, Math.PI * 2);
      ctx.fill();
      if (focus) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(X, Y, r + 6, 0, Math.PI * 2);
        ctx.stroke();
      }
      // Members still answer clicks, so a project reads as its sessions.
      for (const m of g.members) coords.set(m.id, [X, Y]);
    }
    // A handful of projects, and every one of them should be named. Nudge a
    // colliding label around its mark instead of dropping it; force the last
    // resort so a close pair still reads as two projects rather than one.
    ctx.globalAlpha = 1;
    for (const { g, X, Y, r } of marks.sort((a, b) => b.g.n - a.g.n)) {
      if (!labelVisible(X, Y) || (compact && !g.members.some(m => m.id === selected))) continue;
      const label = `${g.group} · ${g.n}`;
      const spots = [[0, -r - 12], [0, r + 20], [-r - 34, 4], [r + 34, 4], [0, -r - 30], [0, r + 38]];
      if (!spots.some(([ox, oy]) => drawLabel(label, X + ox, Y + oy, used, false))) {
        drawLabel(label, X, Y - r - 12, used, true);
      }
    }
  }
  function field(samples) {
    if (!compact) density(samples);
    const selected = state.preview ?? (state.brush.length === 1 ? state.brush[0] : state.selected);
    const tier = tierOf(view.scale);
    const used = [];
    if (tier === 'project') {
      fieldProjects(samples, selected, used);
      ctx.globalAlpha = 1;
      return;
    }
    if (tier === 'artifact') {
      fieldArtifacts(samples, selected, used);
      ctx.globalAlpha = 1;
      return;
    }
    // Only a shared recorded project earns a bridge; co-presence alone does not.
    for (let i = 0; i < samples.length; i++) for (let j = i + 1; j < samples.length; j++) {
      const a = samples[i],
        b = samples[j];
      if (!a.count || !b.count || affinity[i][j] < .12) continue;
      const focus = selected === a.p.id || selected === b.p.id,
        hot = a.heat > .5 && b.heat > .5;
      if (!focus && !hot) continue;
      ctx.globalAlpha = focus ? .38 : .10;
      ctx.strokeStyle = palette[groupIndex(a.p)].css;
      ctx.lineWidth = focus ? 1.2 : .7;
      const ax = vx(a.p.x), ay = vy(a.p.y), bx = vx(b.p.x), by = vy(b.p.y);
      const mx = (ax + bx) / 2,
        my = (ay + by) / 2;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.quadraticCurveTo(mx + (ay - by) * .08, my + (bx - ax) * .08, bx, by);
      ctx.stroke();
    }
    for (const s of samples) {
      const p = s.p;
      if (!s.count) continue;
      const X = vx(p.x),
        Y = vy(p.y);
      p.hx = X;
      p.hy = Y;
      coords.set(p.id, [X, Y]);
      const c = palette[groupIndex(p)].css;
      ctx.strokeStyle = c;
      ctx.fillStyle = c;
      for (const e of s.recent.slice(-3)) {
        const age = (state.time - e[0]) / 420000;
        ctx.globalAlpha = (1 - age) * .48;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(X, Y, 8 + Math.sqrt(age) * 23, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.globalAlpha = s.heat > .2 ? 1 : .28;
      const r = 2.5 + Math.min(6, Math.sqrt(s.heat) * .5);
      ctx.beginPath();
      ctx.arc(X, Y, r, 0, Math.PI * 2);
      if (p.lifecycleOnly) ctx.stroke();else ctx.fill();
      if (p.wraps.some(w => w.t <= state.time)) {
        ctx.globalAlpha = .65;
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.arc(X, Y, r + 5, -Math.PI * .7, Math.PI * .7);
        ctx.stroke();
      }
      if (selected === p.id) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ink;
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(X, Y, r + 11, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    const candidates = [...samples].filter(s => s.count && s.p.label).sort((a, b) => (b.p.id === selected ? 1 : 0) - (a.p.id === selected ? 1 : 0) || b.heat - a.heat);
    let n = 0;
    for (const s of candidates) {
      if (compact) continue;
      if (s.p.id !== selected && (n >= (W < 450 ? 4 : 7) || s.heat < .45)) continue;
      const lx = vx(s.p.x),
        ly = vy(s.p.y) - 20;
      if (!labelVisible(lx, ly)) continue;
      if (drawLabel(s.p.label, lx, ly, used, s.p.id === selected)) n++;
    }
    ctx.globalAlpha = 1;
  }
  function pathThrough(coords) {
    if (!coords.length) return;
    ctx.moveTo(coords[0][0], coords[0][1]);
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1],
        b = coords[i],
        mid = (a[0] + b[0]) / 2;
      ctx.bezierCurveTo(mid, a[1], mid, b[1], b[0], b[1]);
    }
  }
  function wake(samples) {
    const left = 12, right = W - 12, top = 42, bottom = H - 24;
    const xOf = t => left + (t - data.start) / Math.max(1, data.end - data.start) * (right - left);
    const ordered = [...samples].filter(s => s.count).sort((a, b) => groupIndex(a.p) - groupIndex(b.p) || a.p.i - b.p.i);
    const step = (bottom - top) / Math.max(1, ordered.length);
    const selected = state.preview ?? (state.brush.length === 1 ? state.brush[0] : state.selected);
    for (const [index, s] of ordered.entries()) {
      const y = top + step * (index + .5);
      const events = s.p.events.filter(e => e[0] <= state.time);
      const first = events[0]?.[0], last = events.at(-1)?.[0];
      if (first == null) continue;
      const chosen = selected === s.p.id || state.brush.includes(s.p.id);
      ctx.strokeStyle = palette[groupIndex(s.p)].css;
      ctx.fillStyle = ctx.strokeStyle;
      ctx.globalAlpha = chosen ? 1 : .48;
      ctx.lineWidth = chosen ? 2 : 1;
      ctx.beginPath(); ctx.moveTo(xOf(first), y); ctx.lineTo(xOf(last), y); ctx.stroke();
      for (const event of events) {
        ctx.globalAlpha = chosen ? 1 : .7;
        ctx.fillRect(xOf(event[0]) - 1, y - Math.min(3, step * .35), event[1] === 'commit' ? 3 : 1.5, Math.max(1, Math.min(6, step * .7)));
      }
      coords.set(s.p.id, [xOf(last), y]);
      s.p.hx = xOf(last); s.p.hy = y;
      if (!compact && selected === s.p.id) {
        ctx.globalAlpha = 1;
        drawLabel(s.p.label, Math.min(W - 80, Math.max(80, xOf(last))), Math.max(43, y - 12), [], true);
      }
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = muted; ctx.font = '500 16px ui-sans-serif,system-ui,sans-serif';
    const clock = t => new Date(t).toLocaleTimeString([], {hour:'numeric',minute:'2-digit'});
    ctx.textAlign = 'left'; ctx.fillText('−24h', left, H - 3);
    ctx.textAlign = 'right'; ctx.fillText(clock(data.end), right, H - 3); ctx.textAlign = 'left';
  }
  let rebuildingTargets = false;
  function targets(panel, samples) {
    const host = panel.targetsHost;
    if (host.dataset.level !== 'sessions' || host.children.length !== points.length) {
      rebuildingTargets = true;
      host.replaceChildren();
      host.dataset.level = 'sessions';
      for (const p of points) {
        const b = document.createElement('a');
        b.className = 'mw-target';
        b.setAttribute('aria-label', 'Explore ' + p.title);
        b.onclick = event => {
          if (!plainLinkClick(event)) return;
          event.preventDefault();
          if (compact && event.detail > 0) { state.brush = [p.id]; onBrush?.([p.id]); render(); }
          else enter(p);
        };
        b.onpointerenter = () => {
          if (rebuildingTargets) return;
          state.preview = p.id;
          onHover?.(p.id);
          render();
        };
        b.onpointerleave = () => {
          if (rebuildingTargets) return;
          state.preview = null;
          onHover?.(null);
          render();
        };
        b.onfocus = () => {
          if (rebuildingTargets) return;
          state.preview = p.id;
          onHover?.(p.id);
          render();
        };
        b.onblur = () => {
          if (rebuildingTargets) return;
          state.preview = null;
          onHover?.(null);
          render();
        };
        b.onkeydown = event => {
          if (event.code !== 'Space') return;
          event.preventDefault();
          const ids = state.brush.includes(p.id) ? state.brush.filter(id => id !== p.id) : [...state.brush, p.id];
          state.brush = ids;
          onBrush?.(ids);
          render();
        };
        host.append(b);
      }
    }
    rebuildingTargets = false;
    [...host.children].forEach((b, i) => {
      const s = samples[i];
      const at = panel.coords.get(s.p.id);
      b.hidden = !s.count || !at;
      b.dataset.session = s.p.id;
      b.setAttribute('aria-label', panel.mode === (panels.some(p => p.mode === 'field') ? 'field' : state.mode) ? 'Explore ' + s.p.title : `Brush ${s.p.title} in ${panel.mode}`);
      b.href = hrefForSession?.(s.p, viewState()) || '#';
      if (at) {
        b.style.left = at[0] + 'px';
        b.style.top = at[1] + 'px';
      }
      b.setAttribute('aria-current', String(state.brush.includes(s.p.id)));
      b.dataset.brushed = String(state.preview === s.p.id || state.brush.includes(s.p.id));
    });
  }
  function detail() {
    const p = points.find(p => p.id === (state.preview ?? (state.brush.length === 1 ? state.brush[0] : state.selected)));
    const label = $('.mw-brush-label');
    label.querySelector('strong').textContent = p ? p.title : state.brush.length ? `${state.brush.length} threads selected` : 'Hover or brush to identify';
    label.querySelector('span').textContent = p ? p.group : state.brush.length ? 'Esc to clear selection' : 'Drag to select · Space to pin · Esc to clear';
    const values = label.querySelector('.mw-brush-values');
    if (!p) { values.textContent = ''; return; }
    const m = sessionMetricsAt(p, state.time, data.files[p.id] || []);
    const tokenValue = m.tokens.output === null ? 'Usage unrecorded' : `${m.tokens.status === 'partial' ? '≥' : ''}${formatCount(m.tokens.output)} generated tokens`;
    values.textContent = `${formatDuration(m.spanMs)} span · ${tokenValue} · ${m.fileCount} files`;
  }
  function enter(p) {
    stop();
    state.selected = p.id;
    state.preview = null;
    render();
    onSelect?.(p, viewState());
  }
  function dimensionValue(metrics) {
    if (state.y === 'output' || state.y === 'total') return metrics.tokens[state.y];
    if (state.y === 'files') return metrics.fileCount;
    if (state.y === 'events') return metrics.eventCount;
    return metrics.counts[state.y];
  }
  function compare(samples) {
    const left = 74,
      right = W - 24,
      top = 60,
      bottom = H - 76;
    const tokenAxis = ['output', 'total'].includes(state.y);
    const rows = samples.filter(s => s.count).map(s => ({
      ...s,
      m: sessionMetricsAt(s.p, state.time, data.files[s.p.id] || [])
    }));
    const maxX = Math.max(60000, ...rows.map(s => s.m[state.x]));
    const maxY = Math.max(1, ...rows.map(s => dimensionValue(s.m) || 0));
    const x = v => left + v / maxX * (right - left),
      y = v => bottom - v / maxY * (bottom - top);
    ctx.font = '500 16px ui-sans-serif,system-ui,sans-serif';
    ctx.fillStyle = muted;
    for (const i of [0, 4]) {
      const xx = x(maxX * i / 4),
        yy = y(maxY * i / 4);
      ctx.globalAlpha = .16;
      ctx.strokeStyle = ink;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(xx, top);
      ctx.lineTo(xx, bottom);
      ctx.stroke();
      ctx.beginPath();
      ctx.moveTo(left, yy);
      ctx.lineTo(right, yy);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.textAlign = 'center';
      ctx.fillText(formatDuration(maxX * i / 4), xx, bottom + 23);
      ctx.textAlign = 'right';
      ctx.fillText(formatCount(maxY * i / 4), left - 9, yy + 5);
    }
    ctx.textAlign = 'left';
    ctx.fillStyle = ink;
    ctx.font = '500 16px ui-sans-serif,system-ui,sans-serif';
    const ylabel = $('[data-y]').selectedOptions[0].textContent;
    if (!compact) ctx.fillText(ylabel, left, 23);
    ctx.textAlign = 'right';
    if (!compact) ctx.fillText(state.x === 'spanMs' ? 'Recorded span' : 'Active periods', right, H - 15);
    ctx.textAlign = 'left';
    let missing = 0;
    const used = [];
    for (const s of rows) {
      const value = dimensionValue(s.m),
        unknown = !Number.isFinite(value),
        px = x(s.m[state.x]),
        py = unknown ? H - 12 : y(value);
      s.p.hx = px;
      s.p.hy = py;
      coords.set(s.p.id, [px, py]);
      if (unknown) missing++;
      const chosen = state.preview === s.p.id || state.brush.includes(s.p.id) || state.selected === s.p.id;
      ctx.strokeStyle = palette[groupIndex(s.p)].css;
      ctx.fillStyle = palette[groupIndex(s.p)].css;
      const partial = tokenAxis && s.m.tokens.status === 'partial';
      ctx.globalAlpha = unknown ? 1 : s.age < 900000 ? 1 : .68;
      ctx.lineWidth = partial ? 2 : 1.5;
      ctx.setLineDash(partial ? [2, 2] : []);
      ctx.beginPath();
      ctx.arc(px, py, chosen ? 8 : 5, 0, Math.PI * 2);
      if (unknown || partial) ctx.stroke();else ctx.fill();
      ctx.setLineDash([]);
      if (chosen) {
        ctx.globalAlpha = 1;
        ctx.strokeStyle = ink;
        ctx.beginPath();
        ctx.arc(px, py, 13, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    ctx.globalAlpha = 1;
    if (missing) {
      ctx.fillStyle = muted;
      ctx.font = '500 16px ui-sans-serif,system-ui,sans-serif';
      ctx.fillText(`Unrecorded usage · ${missing}`, left, H - 30);
    }
    for (const s of [...rows].sort((a, b) => ((state.preview ?? state.selected) === b.p.id ? 1 : 0) - ((state.preview ?? state.selected) === a.p.id ? 1 : 0) || b.heat - a.heat).slice(0, W < 450 ? 3 : 5)) {
      if (!compact && (state.preview === s.p.id || (state.brush.length === 1 && state.brush[0] === s.p.id)) && Number.isFinite(dimensionValue(s.m))) {
        const label = W < 450 && s.p.label.length > 24 ? s.p.label.slice(0, 21) + '…' : s.p.label;
        drawLabel(label, s.p.hx, s.p.hy < top + 28 ? s.p.hy + 30 : s.p.hy - 17, used, (state.preview ?? state.selected) === s.p.id);
      }
    }
  }
  /** The mode the reading speaks for: the chosen one when it is visible. */
  function readingMode() {
    if (panels.some(panel => panel.mode === state.mode)) return state.mode;
    return panels[0]?.mode ?? state.mode;
  }
  function reading() {
    const mode = readingMode();
    let text;
    if (mode === 'field') {
      const tier = tierOf(panels.find(panel => panel.mode === 'field')?.view.scale ?? 1);
      text = tier === 'project'
        ? 'Zoomed out: one mark per project, sized by sessions. Zoom in for sessions, further for their commits and touched files.'
        : tier === 'artifact'
          ? 'Zoomed in: each session shows its own artifacts \u2014 filled squares are commits, dots are code, crosses are docs, rings are research. Zoom out for sessions.'
          : 'One point per session. Color groups projects; halos show recent recorded activity. Zoom in for commits and touched files; hover for measures; select to explore.';
    }else if (mode === 'wake') text = 'One row per session. Ticks are recorded events; squares include commits. Drag over rows to select their activity interval.';else {
      const visible = points.map(p => sessionMetricsAt(p, state.time)).filter(m => m.eventCount);
      const count = visible.filter(m => Number.isFinite(m.tokens[state.y])).length;
      text = state.y === 'output' || state.y === 'total' ? `Usage recorded for ${count} of ${visible.length} sessions. Hollow points below the axis have no token record; dashed points are partial. ` : '';
      text += state.x === 'spanMs' ? 'Span measures first to last recorded event in this window.' : 'Active periods join recorded events at most 15 minutes apart; this is an activity estimate.';
      if (state.y === 'total') text += ' Processed tokens include cached input; they are not a cost estimate.';
      if (state.y === 'output') text += ' Generated tokens include recorded model output and reasoning.';
    }
    if ($('.mw-reading').textContent !== text) $('.mw-reading').textContent = text;
    // Every mounted canvas carries the reading; with more than one panel the
    // last-rebound canvas is not the only one a screen reader will reach.
    for (const panel of panels) panel.canvas.setAttribute('aria-label', panel.mode === 'field' ? 'Sessions grouped by project affinity. Hover or focus to identify; zoom for artifacts.' : panel.mode === 'wake' ? 'One row per session, showing recorded events in the last 24 hours. Drag to select.' : `Compare ${$('[data-x]').selectedOptions[0]?.textContent} horizontally and ${$('[data-y]').selectedOptions[0]?.textContent} vertically. Hollow points have unrecorded usage.`);
  }
  function timeLabel(t) {
    return new Date(t).toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    });
  }
  function render() {
    // A permalink may mount directly into a session with the field hidden.
    // ResizeObserver initializes the canvas when the overview is first shown.
    // Control state does not depend on canvas visibility or initialized paint.
    $('[data-x]').value = state.x;
    $('[data-y]').value = state.y;
    if (!panels.length || !palette.length) return;
    if (!panels.some(panel => panel.stage.clientWidth && panel.stage.clientHeight)) return;
    const samples = sample();
    $('[data-live]').textContent = state.connected ? 'Live' : 'Disconnected';
    $('[data-live]').setAttribute('aria-label',state.connected ? 'Live' : 'Disconnected');
    $('[data-live]').setAttribute('aria-pressed', String(state.live && state.connected));
    $('.mw-note').textContent = (data.sessions.length ? '' : 'No session activity in the last 24 hours. ') + (data.unattributed ? data.unattributed + ' events without a session. ' : '') + (!state.connected ? 'Last received · ' + timeLabel(data.end) : state.live ? 'Updates every 5 seconds' : 'Replay · ' + timeLabel(state.time));
    root.dataset.mode = state.mode;
    $('.mw-compare-controls').hidden = false;
    const axisSummary = $('.mw-axis-settings summary');
    if (axisSummary) axisSummary.textContent = `${state.x === 'spanMs' ? 'Span' : 'Active'} × ${{output:'tokens',total:'processed',edit:'edits',files:'files',research:'research',commit:'commits',events:'events'}[state.y]}`;
    $('[data-x]').value = state.x;
    $('[data-y]').value = state.y;
    for (const panel of panels) {
      if (!panel.stage.clientWidth || !panel.stage.clientHeight) continue;
      // Rebind the drawing context to this panel; the renderers below are
      // written against these bindings and need no per-panel awareness.
      canvas = panel.canvas;
      ctx = panel.ctx;
      W = panel.W;
      H = panel.H;
      coords = panel.coords;
      view = panel.view;
      coords.clear();
      ctx.clearRect(0, 0, W, H);
      if (panel.mode === 'field') field(samples);else if (panel.mode === 'wake') wake(samples);else compare(samples);
      const lit = state.brush;
      ctx.globalAlpha = 1; ctx.strokeStyle = ink; ctx.lineWidth = 1.5;
      for (const id of lit) {
        const at = coords.get(id);
        if (at) { ctx.beginPath(); ctx.arc(at[0], at[1], 9, 0, Math.PI * 2); ctx.stroke(); }
      }
      if (panel.brushRect) {
        const r = panel.brushRect;
        ctx.fillStyle = '#55d9e619'; ctx.strokeStyle = '#55d9e6'; ctx.lineWidth = 1;
        ctx.fillRect(r.x0, r.y0, r.x1-r.x0, r.y1-r.y0);
        ctx.strokeRect(r.x0, r.y0, r.x1-r.x0, r.y1-r.y0);
      }
      targets(panel, samples);
    }
    reading();
    detail();
    $('.mw-clock').textContent = timeLabel(state.time);
    $('input').value = (state.time - data.start) / 60000;
    const many = !compact && roomForMany();
    root.dataset.panels = panels.length > 1 ? 'all' : 'one';
    root.querySelectorAll('[data-mode]').forEach(b => {
      const on = many ? panels.some(panel => panel.mode === b.dataset.mode) : state.mode === b.dataset.mode;
      b.setAttribute('aria-pressed', String(on));
      b.disabled = false;
    });
  }
  function stop() {
    state.playing = false;
    $('[data-play]').textContent = 'Replay';
    cancelAnimationFrame(raf);
    lastFrame = 0;
  }
  function animate(now) {
    if (!state.playing) return;
    if (!lastFrame) lastFrame = now;
    state.time = Math.min(data.end, state.time + (now - lastFrame) * 1440);
    lastFrame = now;
    if (now - lastPaint > 65) {
      render();
      lastPaint = now;
    }
    if (state.time >= data.end) {
      render();
      stop();
      publish({ replace: true });
    } else {
      if (now - lastPublished >= 1000) { lastPublished = now; publish({ replace: true }); }
      raf = requestAnimationFrame(animate);
    }
  }
  $('[data-live]').onclick = () => {
    stop();
    state.live = true;
    state.time = data.end;
    render();
    publish();
  };
  $('[data-play]').onclick = () => {
    state.live = false;
    if (state.playing) {
      stop();
      render();
      publish({ replace: true });
      return;
    }
    if (state.time >= data.end) state.time = data.start;
    state.playing = true;
    $('[data-play]').textContent = 'Pause';
    lastFrame = 0;
    render();
    publish();
    raf = requestAnimationFrame(animate);
  };
  $('input').oninput = e => {
    stop();
    state.live = false;
    state.time = data.start + Number(e.target.value) * 60000;
    render();
  };
  $('input').onchange = () => publish({ replace: true });
  root.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => {
    const mode = b.dataset.mode;
    if (!compact && roomForMany()) {
      // Toggle this panel, but never empty the layout.
      if (shown.has(mode) && shown.size > 1) shown.delete(mode);
      else shown.add(mode);
      if (shown.has(mode)) state.mode = mode;
      else if (!shown.has(state.mode)) state.mode = MODES.find(m => shown.has(m)) || state.mode;
    } else {
      state.mode = mode;
      if (compact) shown.add(mode);
    }
    syncPanels(visibleModes());
    setup();
    state.preview = null;
    render();
    publish();
  });
  $('[data-x]').onchange = e => {
    state.x = e.target.value;
    render();
    publish();
  };
  $('[data-y]').onchange = e => {
    state.y = e.target.value;
    render();
    publish();
  };
  /** Clamp, apply and redraw one panel's camera. */
  function setView(panel, next) {
    const scale = clamp(next.scale, MIN_SCALE, MAX_SCALE);
    panel.view.scale = scale;
    panel.view.x = next.x;
    panel.view.y = next.y;
    render();
    if (panel.mode === 'field') publishCamera();
  }
  // Panning emits a move per pointer event; coalesce and never stack history.
  let cameraPublish = 0;
  function publishCamera() {
    clearTimeout(cameraPublish);
    cameraPublish = setTimeout(() => publish({ replace: true }), 220);
  }
  function zoomPanelAt(panel, cx, cy, factor) {
    const next = zoomCameraAt(panel.view, { x: cx, y: cy }, factor, MIN_SCALE, MAX_SCALE);
    if (next.scale === panel.view.scale) return;
    setView(panel, next);
  }
  function wirePanel(panel) {
    if (panel.wired) return;
    panel.wired = true;
    const local = e => {
      const r = panel.canvas.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    let brush = null;
    panel.stage.addEventListener('pointerdown', e => {
      if (e.button !== 0 || e.target.closest('.mw-panel-header')) return;
      if (panel.mode === 'field' && !e.shiftKey && root.dataset.gesture !== 'brush') return;
      const [x, y] = local(e);
      brush = { id: e.pointerId, x, y, moved: false, target: e.target.closest('.mw-target') };
      panel.stage.setPointerCapture(e.pointerId);
    });
    panel.stage.addEventListener('pointermove', e => {
      if (!brush && e.pointerType !== 'touch') {
        if (e.target.closest('.mw-panel-header')) return;
        const [x, y] = local(e);
        const near = [...panel.coords].map(([id, at]) => ({ id, distance: panel.mode === 'wake' ? Math.abs(at[1]-y) : Math.hypot(at[0]-x,at[1]-y) })).sort((a,b)=>a.distance-b.distance)[0];
        const id = near && near.distance <= (panel.mode === 'wake' ? 8 : 24) ? near.id : null;
        if (state.preview !== id) { state.preview = id; onHover?.(id); render(); }
        return;
      }
      if (brush?.id !== e.pointerId) return;
      const [x, y] = local(e);
      if (!brush.moved && Math.hypot(x-brush.x, y-brush.y) < 5) return;
      brush.moved = true;
      panel.brushRect = { x0: brush.x, y0: brush.y, x1: x, y1: y };
      render();
    });
    const endBrush = e => {
      if (brush?.id !== e.pointerId) return;
      const cancelled = e.type === 'pointercancel';
      if (brush.moved && !cancelled) {
        let candidates = [...panel.coords].map(([id, [x, y]]) => ({id, x, y}));
        // Wake brush spans event time, not only each row's final mark.
        if (panel.mode === 'wake') candidates = points.flatMap(p => {
          const at = panel.coords.get(p.id);
          return !at ? [] : p.events.filter(e => e[0] <= state.time).map(e => ({id:p.id, x:12+(e[0]-data.start)/(data.end-data.start)*(panel.W-24), y:at[1]}));
        });
        state.brush = brushHits(candidates, panel.brushRect);
        onBrush?.(state.brush);
        panel.suppressClick = true;
        setTimeout(() => { panel.suppressClick = false; }, 0);
      }
      if (!cancelled && !brush.moved && brush.target) {
        const nearest = [...panel.coords].map(([id, at]) => ({ id, distance: panel.mode === 'wake' ? Math.abs(at[1]-brush.y) : Math.hypot(at[0]-brush.x,at[1]-brush.y) })).sort((a,b)=>a.distance-b.distance)[0];
        const id = nearest?.id;
        if (id) {
          state.brush = [id]; onBrush?.([id]);
          panel.suppressClick = true;
          setTimeout(() => { panel.suppressClick = false; }, 400);
        }
      }
      brush = null; panel.brushRect = null; render();
    };
    panel.stage.addEventListener('pointerup', endBrush);
    panel.stage.addEventListener('pointercancel', endBrush);
    panel.stage.addEventListener('pointerleave', () => { if (!brush) { state.preview = null; onHover?.(null); render(); } });
    panel.stage.addEventListener('click', e => {
      if (panel.suppressClick) { e.preventDefault(); e.stopImmediatePropagation(); }
    }, true);
    if (panel.mode !== 'field') return;
    // Scroll pans, ctrl/cmd-scroll (and trackpad pinch) zooms — the grammar
    // the spatial wall already uses; plain-scroll-to-zoom makes a trackpad
    // unusable.
    panel.stage.addEventListener('wheel', e => {
      e.preventDefault();
      const [cx, cy] = local(e);
      if (e.ctrlKey || e.metaKey) zoomPanelAt(panel, cx, cy, Math.exp(-e.deltaY * .01));
      else setView(panel, { x: panel.view.x - e.deltaX, y: panel.view.y - e.deltaY, scale: panel.view.scale });
    }, { passive: false });
    let dragging = null;
    panel.stage.addEventListener('pointerdown', e => {
      if (e.shiftKey || root.dataset.gesture === 'brush' || e.target.closest('.mw-target, .mw-panel-header')) return;
      dragging = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
      panel.stage.setPointerCapture(e.pointerId);
    });
    panel.stage.addEventListener('pointermove', e => {
      if (!dragging || dragging.id !== e.pointerId) return;
      const dx = e.clientX - dragging.x,
        dy = e.clientY - dragging.y;
      if (!dragging.moved && Math.hypot(dx, dy) < 3) return;
      dragging.moved = true;
      dragging.x = e.clientX;
      dragging.y = e.clientY;
      panel.stage.classList.add('mw-panning');
      setView(panel, { x: panel.view.x + dx, y: panel.view.y + dy, scale: panel.view.scale });
    });
    const endDrag = e => {
      if (!dragging || dragging.id !== e.pointerId) return;
      dragging = null;
      panel.stage.classList.remove('mw-panning');
    };
    panel.stage.addEventListener('pointerup', endDrag);
    panel.stage.addEventListener('pointercancel', endDrag);
    panel.stage.addEventListener('dblclick', e => {
      if (e.target.closest('.mw-target, .mw-panel-header')) return;
      const [cx, cy] = local(e);
      zoomPanelAt(panel, cx, cy, 1.8);
    });
    panel.stage.querySelector('.mw-nav')?.addEventListener('click', e => {
      const button = e.target.closest('[data-zoom]');
      if (!button) return;
      if (button.dataset.zoom === 'fit') return setView(panel, { x: 0, y: 0, scale: 1 });
      zoomPanelAt(panel, panel.W / 2, panel.H / 2, button.dataset.zoom === 'in' ? 1.5 : 1 / 1.5);
    });
  }
  root.dataset.gesture = 'pan';
  root.querySelectorAll('[data-gesture]').forEach(button => button.onclick = () => {
    root.dataset.gesture = root.dataset.gesture === 'brush' ? 'pan' : 'brush';
    button.setAttribute('aria-pressed', String(root.dataset.gesture === 'brush'));
  });
  const resize = new ResizeObserver(setup);
  resize.observe(stages);
  setup();
  return {
    applyRoute(next) {
      const acknowledged = pendingRouteKey === routeKey(next);
      pendingRouteKey = null;
      const previous = state.selected;
      state.selected = next.session;
      state.brush = next.brush || [];
      if (!acknowledged) {
        stop();
        state.mode = next.view;
        state.x = next.x;
        state.y = next.y;
        state.live = next.at === null;
        state.time = next.at ?? data.end;
        const wanted = next.panels?.length ? next.panels : MODES;
        shown.clear();
        for (const mode of wanted) shown.add(mode);
        fieldCamera.x = next.cam?.x ?? 0;
        fieldCamera.y = next.cam?.y ?? 0;
        fieldCamera.scale = next.cam?.scale ?? 1;
      }
      render();
      if (previous && !next.session) requestAnimationFrame(() => {
        setup();
        if (onRestoreFocus?.()) return;
        const index = points.findIndex(p => p.id === previous);
        if (index >= 0) $('.mw-targets').children[index]?.focus({ preventScroll: true });
      });
    },
    setScale(scale, ids) {
      state.brush = ids || [];
      const panel = fieldPanel();
      const members = points.filter(p => state.brush.includes(p.id));
      if (panel && members.length) {
        const center = members.reduce((v, p) => ({x:v.x+p.x/members.length,y:v.y+p.y/members.length}), {x:0,y:0});
        setView(panel, {x:panel.W/2-center.x*scale,y:panel.H/2-center.y*scale,scale});
      } else if (panel) zoomPanelAt(panel, panel.W / 2, panel.H / 2, scale / panel.view.scale);
      else fieldCamera.scale = scale;
      clearTimeout(cameraPublish);
      publish({ replace: true });
    },
    setFocus(id, ids) {
      state.preview = id;
      state.brush = ids || [];
      render();
    },
    viewState,
    update(next, connected = true) {
      const topology = points.map(p => p.id + '|' + p.group).join();
      data = next;
      affinity = data.sessions.map(a => data.sessions.map(b => projectAffinity(a, b)));
      state.connected = connected;
      const existing = new Map(points.map(p => [p.id, p]));
      points.splice(0, points.length, ...data.sessions.map((s, i) => Object.assign(existing.get(s.id) || {
        x: 0,
        y: 0,
        hx: 0,
        hy: 0
      }, s, {
        i,
        label: shortLabel(s.title)
      })));
      if (state.live) state.time = data.end;else state.time = clamp(state.time, data.start, data.end);
      if (topology !== points.map(p => p.id + '|' + p.group).join()) {
        affinity = points.map(a => points.map(b => projectAffinity(a, b)));
        layout();
        $('.mw-targets').dataset.level = '';
      }
      render();
    },
    clearSelection() {
      const index = points.findIndex(p => p.id === state.selected);
      state.selected = null;
      state.preview = null;
      requestAnimationFrame(() => {
        setup();
        render();
        if (index >= 0) $('.mw-targets').children[index]?.focus({ preventScroll: true });
      });
    },
    setConnected(connected) {
      state.connected = connected;
      render();
    },
    pause() {
      stop();
    },
    destroy() {
      stop();
      resize.disconnect();
      root.replaceChildren();
    }
  };
}
