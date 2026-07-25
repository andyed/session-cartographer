#!/usr/bin/env node
/**
 * prompt-intent-report.js — Corpus measurement for the prompt-intent classifier.
 *
 * Walks every Claude Code transcript, classifies each human-prompt turn with
 * classify-prompt-intent.js, and prints the intent distribution. Pass a bucket
 * key to also dump a stratified, de-duplicated sample of that bucket — the
 * primary tool for spotting misroutes when retuning the classifier predicates.
 *
 * Turn extraction mirrors backfill-prompt-intents.js: a turn is opened by each
 * `user` message that carries content; only the human's own text is kept
 * (tool_result blocks leave it empty and the turn is dropped). Pasted-image
 * markers survive into the text — the classifier strips them itself.
 *
 * Usage:
 *   node scripts/prompt-intent-report.js                    # distribution only
 *   node scripts/prompt-intent-report.js feedback-context   # + sample that bucket
 *   node scripts/prompt-intent-report.js research 120       # + 120-line sample
 *
 * Environment:
 *   CARTOGRAPHER_TRANSCRIPTS_DIR — default: ~/.claude/projects
 */
import fs from 'fs';
import path from 'path';
import readline from 'readline';
import { classifyPromptIntent, promptIntentCategories } from './classify-prompt-intent.js';

const TRANSCRIPTS_DIR = process.env.CARTOGRAPHER_TRANSCRIPTS_DIR
  || path.join(process.env.HOME, '.claude/projects');

const args = process.argv.slice(2);
const SHOW = args.find((a) => !/^\d+$/.test(a)) || null;
const SAMPLE_N = parseInt(args.find((a) => /^\d+$/.test(a)) || '90', 10);

const validKeys = new Set(Object.values(promptIntentCategories).map((c) => c.key));
if (SHOW && !validKeys.has(SHOW)) {
  console.error(`Unknown bucket "${SHOW}".`);
  console.error(`Valid keys: ${[...validKeys].join(', ')}`);
  process.exit(1);
}

// Collect every human-prompt turn's text from one transcript.
function collectPrompts(filePath, out) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: fs.createReadStream(filePath),
      crlfDelay: Infinity,
    });
    rl.on('line', (line) => {
      if (!line.trim()) return;
      let entry;
      try { entry = JSON.parse(line); } catch { return; }
      if (entry.type !== 'user' || !entry.message || !entry.message.content) return;
      const content = entry.message.content;
      let txt = '';
      if (typeof content === 'string') {
        txt = content;
      } else if (Array.isArray(content)) {
        txt = content.filter((b) => b.type === 'text' && b.text).map((b) => b.text).join(' ');
      }
      txt = txt.trim();
      if (txt) out.push(txt);
    });
    rl.on('close', resolve);
  });
}

async function run() {
  if (!fs.existsSync(TRANSCRIPTS_DIR)) {
    console.error(`Transcripts dir not found: ${TRANSCRIPTS_DIR}`);
    process.exit(1);
  }

  const prompts = [];
  let fileCount = 0;
  for (const proj of fs.readdirSync(TRANSCRIPTS_DIR)) {
    const projPath = path.join(TRANSCRIPTS_DIR, proj);
    let stat;
    try { stat = fs.statSync(projPath); } catch { continue; }
    if (!stat.isDirectory()) continue;
    for (const file of fs.readdirSync(projPath)) {
      if (!file.endsWith('.jsonl')) continue;
      fileCount++;
      await collectPrompts(path.join(projPath, file), prompts);
    }
  }

  const dist = {};
  const byCat = {};
  for (const p of prompts) {
    const k = classifyPromptIntent(p).key;
    dist[k] = (dist[k] || 0) + 1;
    (byCat[k] = byCat[k] || []).push(p);
  }

  console.log(`${prompts.length} human-prompt turns across ${fileCount} transcripts\n`);
  for (const [k, v] of Object.entries(dist).sort((a, b) => b[1] - a[1])) {
    const pct = (100 * v / prompts.length).toFixed(1);
    console.log(`  ${k.padEnd(22)} ${String(v).padStart(7)}  (${pct}%)`);
  }

  if (!SHOW) {
    console.log('\nPass a bucket key to sample its prompts, e.g.:');
    console.log('  node scripts/prompt-intent-report.js feedback-context');
    return;
  }

  // Stratified, de-duplicated sample — duplicates are collapsed with an (xN)
  // count so high-frequency prompts are visible without flooding the output.
  const pool = byCat[SHOW] || [];
  const counts = new Map();
  for (const p of pool) counts.set(p, (counts.get(p) || 0) + 1);
  const uniq = [...counts.keys()];
  console.log(`\n=== sample of "${SHOW}" — ${pool.length} turns, ${uniq.length} unique ===`);
  const step = Math.max(1, Math.floor(uniq.length / SAMPLE_N));
  for (let i = 0; i < uniq.length; i += step) {
    let s = uniq[i].replace(/\s+/gu, ' ');
    if (s.length > 200) s = s.slice(0, 200) + '…';
    const c = counts.get(uniq[i]);
    console.log(`  ${c > 1 ? `(x${c}) ` : ''}${s}`);
  }
}

run();
