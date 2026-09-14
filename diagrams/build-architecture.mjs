#!/usr/bin/env node
// build-architecture.mjs — one layout spec, three renderings.
//
// The architecture diagram in README.md is drawn from the SPEC below into:
//   diagrams/architecture.excalidraw   editable source (open in excalidraw.com)
//   diagrams/architecture.svg          vector rendering, no fonts embedded
//   diagrams/architecture.png          the image README embeds (2x, via Chromium)
//
// It exists because the previous diagram was hand-drawn once and then drifted
// for five releases: it showed three logs where five are searched, four lenses
// where eight ship, and no Codex at all. Regenerating from a spec keeps the
// picture a function of the code it describes; edit SPEC, then run:
//
//   node diagrams/build-architecture.mjs          # writes all three
//   node diagrams/build-architecture.mjs --svg    # skip the PNG (no Chromium)
//
// PNG rendering uses the root @playwright/test dependency and the Chromium it
// resolves; pass CARTO_CHROMIUM=/path/to/chromium to override the executable.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const W = 1400;
const H = 790;

// Palette. Neutral boxes for code, one warm box for the data layer, one cool
// box for the optional service — the reader should find "the shared thing" in
// under a second.
const INK = '#1e1e1e';
const MUTED = '#666666';
const LABEL = '#5b3ff0';
const BOX = '#f5f5f5';
const LOGS = '#fff3b0';
const OPTIONAL = '#e4f0ff';
const TRANSCRIPTS = '#ececec';

const SPEC = {
  title: 'Session Cartographer',
  subtitle: 'Hooks are the foundation. Everything else is a lens.',
  footer: 'Each lens is independent. Claude Code and Codex write and read the same history. '
    + 'Ranking answers what is relevant; facts answer what is true.',
  rows: [
    {
      id: 'agents', label: 'Agents', y: 128, h: 46, fontSize: 15,
      boxes: [
        { id: 'agents', x: 100, w: 1200, fill: BOX, group: 'agents',
          text: 'Claude Code  ·  Codex  ·  Cowork / desktop app  —  one provider-neutral history, either agent recalls the other\'s sessions' },
      ],
    },
    {
      id: 'hooks', label: 'Hooks', y: 218, h: 84, fontSize: 14,
      boxes: [
        { id: 'hook-research', x: 100, w: 224, fill: BOX, group: 'hooks',
          text: 'log-research.sh\nWebFetch · WebSearch\nMCP fetch / search tools' },
        { id: 'hook-tool-use', x: 344, w: 224, fill: BOX, group: 'hooks',
          text: 'log-tool-use.sh\nEdit · Write · apply_patch · Bash\ngit commits with diff shape' },
        { id: 'hook-milestones', x: 588, w: 224, fill: BOX, group: 'hooks',
          text: 'log-session-milestones.sh\nPreCompact · PostCompact\nStop · SessionEnd · SubagentStop' },
        { id: 'hook-catch-up', x: 832, w: 224, fill: BOX, group: 'hooks',
          text: 'start-transcript-catch-up.sh\nSessionStart, in the background\nreads transcripts → turns → index' },
        { id: 'hook-skills', x: 1076, w: 224, fill: BOX, group: 'hooks',
          text: '/wrapup · /investigate\nskill-written milestones\ndecisions · hypotheses · receipts' },
      ],
    },
    {
      id: 'data', label: 'Data', y: 396, h: 92, fontSize: 15,
      boxes: [
        { id: 'logs', x: 100, w: 760, fill: LOGS, group: 'data', stroke: 2,
          text: 'Five JSONL event logs — the shared data layer\nchangelog · research-log · session-milestones · tool-use-log · prompt-history\nevent_id + timestamp + single-line summary · append-only · gitignored' },
        { id: 'transcripts', x: 880, w: 200, fill: TRANSCRIPTS, group: 'data',
          text: 'Transcripts\nClaude · Codex sessions\nread on demand by lenses' },
        { id: 'qdrant', x: 1100, w: 200, fill: OPTIONAL, group: 'data',
          text: 'Qdrant · optional\nsemantic leg of every search\nturn-grouped, :6333 + :8890' },
      ],
    },
    {
      id: 'lenses', label: 'Lenses', y: 594, h: 92, fontSize: 13,
      boxes: [
        { id: 'lens-remember', x: 100, w: 185, fill: BOX, group: 'lenses',
          text: '/remember\nbash + awk BM25 + RRF\nzero dependencies' },
        { id: 'lens-focus', x: 303, w: 185, fill: BOX, group: 'lenses',
          text: '/focus\nproject orientation\nmilestones · commits · threads' },
        { id: 'lens-carto', x: 506, w: 185, fill: BOX, group: 'lenses',
          text: '/carto Explorer\ntimeline · search · transcripts\nmemory desk (very alpha)' },
        { id: 'lens-turbo', x: 709, w: 185, fill: BOX, group: 'lenses',
          text: '/turbo · opt-in, experimental\nwarm /api/recall + /api/facts\nranking beside counting' },
        { id: 'lens-trustmap', x: 912, w: 185, fill: BOX, group: 'lenses',
          text: '/trustmap · profile\nautoMode.environment\n.carto/profile.md, derived' },
        { id: 'lens-feed', x: 1115, w: 185, fill: BOX, group: 'lenses',
          text: 'cartographer-feed.sh\nbounded machine pulse\nfor other local agents' },
      ],
    },
  ],
  // [from, to, style]. Solid arrows are the write path into the logs and the
  // read path out of them; the one dashed arrow is the optional semantic index.
  // Qdrant's and the transcripts' consumers are named in their boxes rather
  // than drawn, because six dashed lines across the fan made the read path
  // unreadable without adding information.
  arrows: [
    ['agents', 'hook-research'], ['agents', 'hook-tool-use'], ['agents', 'hook-milestones'],
    ['agents', 'hook-catch-up'], ['agents', 'hook-skills'],
    ['hook-research', 'logs'], ['hook-tool-use', 'logs'], ['hook-milestones', 'logs'],
    ['hook-skills', 'logs'],
    ['hook-catch-up', 'qdrant', 'dashed'],
    ['logs', 'lens-remember'], ['logs', 'lens-focus'], ['logs', 'lens-carto'],
    ['logs', 'lens-turbo'], ['logs', 'lens-trustmap'], ['logs', 'lens-feed'],
  ],
};

// ---------------------------------------------------------------------------
// Geometry shared by every rendering.
// ---------------------------------------------------------------------------

const boxes = new Map();
for (const row of SPEC.rows) {
  for (const box of row.boxes) {
    boxes.set(box.id, { ...box, y: row.y, h: row.h, fontSize: row.fontSize, row: row.id });
  }
}

function anchor(from, to) {
  // Bottom edge of `from` toward top edge of `to`, each at the x nearest the
  // other box's centre so fan-outs read as fans rather than a bundle.
  const a = boxes.get(from);
  const b = boxes.get(to);
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  const bx = b.x + b.w / 2;
  const ax = a.x + a.w / 2;
  const sx = clamp(bx, a.x + 24, a.x + a.w - 24);
  const ex = clamp(ax, b.x + 24, b.x + b.w - 24);
  return { sx, sy: a.y + a.h, ex, ey: b.y };
}

// ---------------------------------------------------------------------------
// SVG
// ---------------------------------------------------------------------------

const esc = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif';

function svgText(box) {
  const lines = box.text.split('\n');
  const lh = box.fontSize * 1.32;
  const cx = box.x + box.w / 2;
  const top = box.y + box.h / 2 - ((lines.length - 1) * lh) / 2;
  return lines.map((line, i) => {
    const weight = i === 0 && lines.length > 1 ? ' font-weight="600"' : '';
    const fill = i === 0 ? INK : '#333333';
    return `<text x="${cx}" y="${(top + i * lh).toFixed(1)}" text-anchor="middle" dominant-baseline="middle"`
      + ` font-family="${FONT}" font-size="${box.fontSize}" fill="${fill}"${weight}>${esc(line)}</text>`;
  }).join('\n');
}

function renderSvg() {
  const out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  out.push('<defs><marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
    + `<path d="M 0 0 L 10 5 L 0 10 z" fill="${INK}"/></marker>`
    + '<marker id="arrow-muted" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse">'
    + `<path d="M 0 0 L 10 5 L 0 10 z" fill="${MUTED}"/></marker></defs>`);
  out.push(`<rect width="${W}" height="${H}" fill="#ffffff"/>`);
  out.push(`<text x="${W / 2}" y="52" text-anchor="middle" font-family="${FONT}" font-size="40" font-weight="600" fill="${INK}">${esc(SPEC.title)}</text>`);
  out.push(`<text x="${W / 2}" y="86" text-anchor="middle" font-family="${FONT}" font-size="19" fill="${MUTED}">${esc(SPEC.subtitle)}</text>`);

  for (const row of SPEC.rows) {
    out.push(`<text x="16" y="${row.y + row.h / 2}" dominant-baseline="middle" font-family="${FONT}" font-size="22" fill="${LABEL}">${esc(row.label)}</text>`);
  }
  for (const [from, to, style] of SPEC.arrows) {
    const { sx, sy, ex, ey } = anchor(from, to);
    const dashed = style === 'dashed';
    out.push(`<line x1="${sx.toFixed(1)}" y1="${sy + 3}" x2="${ex.toFixed(1)}" y2="${ey - 4}" stroke="${dashed ? MUTED : INK}" stroke-width="${dashed ? 1.5 : 2}"`
      + `${dashed ? ' stroke-dasharray="7 5"' : ''} marker-end="url(#${dashed ? 'arrow-muted' : 'arrow'})"/>`);
  }
  for (const box of boxes.values()) {
    out.push(`<rect x="${box.x}" y="${box.y}" width="${box.w}" height="${box.h}" fill="${box.fill}" stroke="${INK}" stroke-width="${box.stroke ?? 1.5}" rx="3"/>`);
    out.push(svgText(box));
  }
  out.push(`<text x="${W / 2}" y="${H - 34}" text-anchor="middle" font-family="${FONT}" font-size="17" fill="${MUTED}">${esc(SPEC.footer)}</text>`);
  out.push('</svg>');
  return out.join('\n');
}

// ---------------------------------------------------------------------------
// Excalidraw (version 2 file format; text is bound to its container so
// excalidraw re-measures and re-centres it on load).
// ---------------------------------------------------------------------------

let seed = 1000;
const base = (extra) => ({
  strokeColor: INK, backgroundColor: 'transparent', fillStyle: 'solid',
  strokeWidth: 1, strokeStyle: 'solid', roughness: 0, opacity: 100, angle: 0,
  groupIds: [], roundness: null, seed: seed++, version: 1, versionNonce: seed * 7,
  isDeleted: false, boundElements: null, updated: 1, link: null, locked: false,
  ...extra,
});
const textEl = (id, text, x, y, width, fontSize, extra = {}) => base({
  id, type: 'text', x, y, width, height: text.split('\n').length * fontSize * 1.25,
  text, originalText: text, fontSize, fontFamily: 2, textAlign: 'center',
  verticalAlign: 'middle', lineHeight: 1.25, containerId: null, autoResize: true, ...extra,
});

function renderExcalidraw() {
  const elements = [];
  elements.push(textEl('title', SPEC.title, W / 2 - 280, 24, 560, 40, { textAlign: 'center' }));
  elements.push(textEl('subtitle', SPEC.subtitle, W / 2 - 300, 74, 600, 19, { strokeColor: MUTED }));
  for (const row of SPEC.rows) {
    elements.push(textEl(`label-${row.id}`, row.label, 16, row.y + row.h / 2 - 14, 90, 22,
      { strokeColor: LABEL, textAlign: 'left' }));
  }
  const bound = new Map();
  for (const box of boxes.values()) {
    bound.set(box.id, [{ id: `${box.id}-text`, type: 'text' }]);
  }
  const arrows = [];
  SPEC.arrows.forEach(([from, to, style], i) => {
    const { sx, sy, ex, ey } = anchor(from, to);
    const id = `arrow-${from}-${to}`;
    bound.get(from).push({ id, type: 'arrow' });
    bound.get(to).push({ id, type: 'arrow' });
    arrows.push(base({
      id, type: 'arrow', x: sx, y: sy, width: ex - sx, height: ey - sy,
      points: [[0, 0], [ex - sx, ey - sy]], strokeWidth: style === 'dashed' ? 1 : 2,
      strokeStyle: style === 'dashed' ? 'dashed' : 'solid',
      strokeColor: style === 'dashed' ? MUTED : INK,
      roundness: { type: 2 }, startArrowhead: null, endArrowhead: 'arrow',
      startBinding: { elementId: from, focus: 0, gap: 4 },
      endBinding: { elementId: to, focus: 0, gap: 4 },
      elbowed: false,
    }));
    void i;
  });
  for (const box of boxes.values()) {
    elements.push(base({
      id: box.id, type: 'rectangle', x: box.x, y: box.y, width: box.w, height: box.h,
      backgroundColor: box.fill, strokeWidth: box.stroke ?? 1, groupIds: [box.group],
      roundness: { type: 3 }, boundElements: bound.get(box.id),
    }));
    elements.push(textEl(`${box.id}-text`, box.text, box.x + 8, box.y + 8, box.w - 16, box.fontSize,
      { containerId: box.id, groupIds: [box.group], autoResize: false }));
  }
  elements.push(...arrows);
  elements.push(textEl('footer', SPEC.footer, 80, H - 48, W - 160, 17, { strokeColor: MUTED }));
  return {
    type: 'excalidraw', version: 2, source: 'diagrams/build-architecture.mjs',
    elements, appState: { viewBackgroundColor: '#ffffff', theme: 'light', gridSize: null }, files: {},
  };
}

// ---------------------------------------------------------------------------
// PNG via headless Chromium at 2x, so README shows crisp text on dense displays.
// ---------------------------------------------------------------------------

async function renderPng(svg, target) {
  const { chromium } = await import('@playwright/test');
  const launch = {};
  if (process.env.CARTO_CHROMIUM) launch.executablePath = process.env.CARTO_CHROMIUM;
  const browser = await chromium.launch(launch);
  try {
    const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
    await page.setContent(`<!doctype html><html><body style="margin:0;background:#fff">${svg}</body></html>`);
    await page.screenshot({ path: target, clip: { x: 0, y: 0, width: W, height: H } });
  } finally {
    await browser.close();
  }
}

const svg = renderSvg();
fs.writeFileSync(path.join(HERE, 'architecture.svg'), `${svg}\n`);
fs.writeFileSync(path.join(HERE, 'architecture.excalidraw'), `${JSON.stringify(renderExcalidraw(), null, 2)}\n`);
if (!process.argv.includes('--svg')) {
  await renderPng(svg, path.join(HERE, 'architecture.png'));
}
console.log(`wrote diagrams/architecture.{svg,excalidraw${process.argv.includes('--svg') ? '' : ',png'}}`);
