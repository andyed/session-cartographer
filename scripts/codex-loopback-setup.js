#!/usr/bin/env node

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const LOOPBACK_DOMAINS = ['localhost', '127.0.0.1'];
const PROFILE_NAME = 'session-cartographer';

class SetupError extends Error {
  constructor(message, code = 'unsupported_config') {
    super(message);
    this.name = 'SetupError';
    this.code = code;
  }
}

function sectionName(line) {
  const match = line.match(/^\s*\[([^\]]+)]\s*(?:#.*)?$/);
  return match?.[1]?.trim() ?? null;
}

function assignmentMatch(line, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return line.match(new RegExp(`^\\s*${escaped}\\s*=\\s*(.*?)\\s*(?:#.*)?$`));
}

function quotedKeyMatch(line, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return line.match(new RegExp(`^\\s*["']${escaped}["']\\s*=\\s*(.*?)\\s*(?:#.*)?$`));
}

function ranges(lines) {
  const result = [];
  for (let index = 0; index < lines.length; index += 1) {
    const name = sectionName(lines[index]);
    if (name) result.push({ name, start: index, end: lines.length });
  }
  for (let index = 0; index < result.length - 1; index += 1) {
    result[index].end = result[index + 1].start;
  }
  return result;
}

function findSection(lines, name) {
  return ranges(lines).find((entry) => entry.name === name) ?? null;
}

function rootEnd(lines) {
  const first = lines.findIndex((line) => sectionName(line));
  return first === -1 ? lines.length : first;
}

function findAssignment(lines, section, key, quoted = false) {
  const range = section === null
    ? { start: -1, end: rootEnd(lines) }
    : findSection(lines, section);
  if (!range) return null;
  for (let index = range.start + 1; index < range.end; index += 1) {
    const match = quoted ? quotedKeyMatch(lines[index], key) : assignmentMatch(lines[index], key);
    if (match) return { index, value: match[1] };
  }
  return null;
}

function normalizedText(lines) {
  while (lines.length > 0 && lines.at(-1) === '') lines.pop();
  return `${lines.join('\n')}\n`;
}

function setAssignment(text, section, key, value, changes, { quoted = false } = {}) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const existing = findAssignment(lines, section, key, quoted);
  const renderedKey = quoted ? JSON.stringify(key) : key;
  const rendered = `${renderedKey} = ${value}`;
  if (existing) {
    if (lines[existing.index].trim() !== rendered) {
      lines[existing.index] = rendered;
      changes.push(`${section ?? 'root'}.${key}`);
    }
    return normalizedText(lines);
  }

  if (section === null) {
    const insertAt = rootEnd(lines);
    lines.splice(insertAt, 0, rendered);
    if (insertAt < lines.length - 1 && lines[insertAt + 1] !== '') lines.splice(insertAt + 1, 0, '');
  } else {
    const range = findSection(lines, section);
    if (range) {
      let insertAt = range.end;
      while (insertAt > range.start + 1 && lines[insertAt - 1] === '') insertAt -= 1;
      lines.splice(insertAt, 0, rendered);
    } else {
      if (lines.length > 0 && lines.at(-1) !== '') lines.push('');
      lines.push(`[${section}]`, rendered);
    }
  }
  changes.push(`${section ?? 'root'}.${key}`);
  return normalizedText(lines);
}

function removeAssignment(text, section, key, changes) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  if (lines.at(-1) === '') lines.pop();
  const existing = findAssignment(lines, section, key);
  if (!existing) return normalizedText(lines);
  lines.splice(existing.index, 1);
  changes.push(`${section ?? 'root'}.${key}`);
  return normalizedText(lines);
}

function parseString(value, label) {
  const match = value.trim().match(/^(?:"([^"\\]*)"|'([^']*)')$/);
  if (!match) throw new SetupError(`${label} must be a simple quoted string before it can be updated safely.`);
  return match[1] ?? match[2];
}

function parseBoolean(value, label) {
  if (value.trim() === 'true') return true;
  if (value.trim() === 'false') return false;
  throw new SetupError(`${label} must be true or false before it can be updated safely.`);
}

function parseInlineDomains(value, label) {
  const match = value.trim().match(/^\{(.*)}$/);
  if (!match) throw new SetupError(`${label} uses an unsupported form; move it to a TOML domains table first.`);
  const entries = new Map();
  const body = match[1].trim();
  if (!body) return entries;
  for (const part of body.split(',')) {
    const entry = part.trim().match(/^["']([^"']+)["']\s*=\s*["'](allow|deny)["']$/);
    if (!entry) throw new SetupError(`${label} contains an entry that cannot be preserved safely.`);
    entries.set(entry[1], entry[2]);
  }
  return entries;
}

function renderInlineDomains(entries) {
  return `{ ${[...entries].map(([domain, policy]) => `${JSON.stringify(domain)} = ${JSON.stringify(policy)}`).join(', ')} }`;
}

function hasSectionPrefix(lines, prefix) {
  return ranges(lines).some(({ name }) => name === prefix || name.startsWith(`${prefix}.`));
}

function legacyPlan(original) {
  let text = original;
  const changes = [];
  let lines = text.replace(/\r\n/g, '\n').split('\n');

  const sandbox = findAssignment(lines, null, 'sandbox_mode');
  if (sandbox && parseString(sandbox.value, 'sandbox_mode') !== 'workspace-write') {
    throw new SetupError('Session Cartographer only updates the legacy workspace-write sandbox; the selected sandbox_mode is different.');
  }
  text = setAssignment(text, null, 'sandbox_mode', '"workspace-write"', changes);

  lines = text.split('\n');
  const access = findAssignment(lines, 'sandbox_workspace_write', 'network_access');
  if (access) parseBoolean(access.value, 'sandbox_workspace_write.network_access');
  text = setAssignment(text, 'sandbox_workspace_write', 'network_access', 'true', changes);

  lines = text.split('\n');
  if (findSection(lines, 'features.network_proxy.domains')) {
    throw new SetupError('Legacy network proxy domains must use the inline domains table so older Codex clients can enforce them.');
  }

  const shorthand = findAssignment(lines, 'features', 'network_proxy');
  if (shorthand) {
    parseBoolean(shorthand.value, 'features.network_proxy');
    text = removeAssignment(text, 'features', 'network_proxy', changes);
  }

  lines = text.split('\n');
  const enabled = findAssignment(lines, 'features.network_proxy', 'enabled');
  if (enabled) parseBoolean(enabled.value, 'features.network_proxy.enabled');
  text = setAssignment(text, 'features.network_proxy', 'enabled', 'true', changes);

  lines = text.split('\n');
  const domainsAssignment = findAssignment(lines, 'features.network_proxy', 'domains');
  const domains = domainsAssignment
    ? parseInlineDomains(domainsAssignment.value, 'features.network_proxy.domains')
    : new Map();
  for (const domain of LOOPBACK_DOMAINS) domains.set(domain, 'allow');
  text = setAssignment(text, 'features.network_proxy', 'domains', renderInlineDomains(domains), changes);

  return { mode: 'legacy', text, changes: [...new Set(changes)] };
}

function profilePlan(original) {
  let text = original;
  const changes = [];
  let lines = text.replace(/\r\n/g, '\n').split('\n');
  const selected = findAssignment(lines, null, 'default_permissions');
  let profile = selected ? parseString(selected.value, 'default_permissions') : PROFILE_NAME;

  if (profile.startsWith(':')) {
    if (profile !== ':workspace') {
      throw new SetupError('Session Cartographer will not broaden a built-in read-only or full-access permission profile. Select a workspace-derived profile first.');
    }
    profile = PROFILE_NAME;
    text = setAssignment(text, null, 'default_permissions', JSON.stringify(profile), changes);
    text = setAssignment(text, `permissions.${profile}`, 'extends', '":workspace"', changes);
  } else if (!/^[A-Za-z0-9_-]+$/.test(profile)) {
    throw new SetupError('The selected permission profile name cannot be updated safely by Session Cartographer.');
  }

  if (!selected) {
    text = setAssignment(text, null, 'default_permissions', JSON.stringify(profile), changes);
    text = setAssignment(text, `permissions.${profile}`, 'extends', '":workspace"', changes);
  }

  lines = text.split('\n');
  if (!hasSectionPrefix(lines, `permissions.${profile}`)) {
    throw new SetupError(`The selected permission profile ${profile} is not defined in this config file; it may be managed by another layer.`);
  }
  if (findSection(lines, 'features.network_proxy') || findSection(lines, 'features.network_proxy.domains')) {
    throw new SetupError('This permission-profile config also contains a legacy network_proxy table; normalize it to [features] network_proxy = true first.');
  }

  const feature = findAssignment(lines, 'features', 'network_proxy');
  if (feature) parseBoolean(feature.value, 'features.network_proxy');
  text = setAssignment(text, 'features', 'network_proxy', 'true', changes);

  lines = text.split('\n');
  const enabled = findAssignment(lines, `permissions.${profile}.network`, 'enabled');
  if (enabled) parseBoolean(enabled.value, `permissions.${profile}.network.enabled`);
  text = setAssignment(text, `permissions.${profile}.network`, 'enabled', 'true', changes);
  for (const domain of LOOPBACK_DOMAINS) {
    text = setAssignment(text, `permissions.${profile}.network.domains`, domain, '"allow"', changes, { quoted: true });
  }

  return { mode: 'profile', profile, text, changes: [...new Set(changes)] };
}

export function planConfig(original = '') {
  const normalized = original.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const hasLegacy = Boolean(
    findAssignment(lines, null, 'sandbox_mode')
    || findSection(lines, 'sandbox_workspace_write')
  );
  const hasProfiles = Boolean(
    findAssignment(lines, null, 'default_permissions')
    || hasSectionPrefix(lines, 'permissions')
  );
  if (hasLegacy && hasProfiles) {
    throw new SetupError('Codex config mixes legacy sandbox settings with permission profiles; Session Cartographer will not choose which model to keep.');
  }
  return hasProfiles ? profilePlan(normalized) : legacyPlan(normalized);
}

function sandboxNetworkDisabled(env = process.env) {
  return /^(?:1|true|yes)$/i.test(env.CODEX_SANDBOX_NETWORK_DISABLED ?? '');
}

function requestHealth(urlString, timeoutMs = 1200, env = process.env) {
  const curl = spawnSync('curl', [
    '--silent',
    '--show-error',
    '--output', '/dev/null',
    '--write-out', '%{http_code}',
    '--max-time', String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    urlString,
  ], { encoding: 'utf8', timeout: timeoutMs + 500, env });
  if (!curl.error || curl.error.code !== 'ENOENT') {
    const httpStatus = Number(curl.stdout);
    if (curl.status === 0 && httpStatus >= 200 && httpStatus < 300) {
      return Promise.resolve({ status: 'healthy', http_status: httpStatus });
    }
    if (Number.isInteger(httpStatus) && httpStatus > 0) {
      return Promise.resolve({ status: 'http_error', http_status: httpStatus });
    }
    return Promise.resolve({ status: 'unreachable' });
  }

  // curl is the real indexing transport and respects Codex's injected proxy
  // environment. This dependency-free fallback is only for hosts without it.
  return new Promise((resolve) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch {
      resolve({ status: 'invalid_url' });
      return;
    }
    const client = parsed.protocol === 'https:' ? https : http;
    const request = client.get(parsed, { timeout: timeoutMs }, (response) => {
      response.resume();
      resolve({
        status: response.statusCode >= 200 && response.statusCode < 300 ? 'healthy' : 'http_error',
        http_status: response.statusCode,
      });
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => resolve({ status: 'unreachable' }));
  });
}

function healthUrl(base, endpoint) {
  return `${base.replace(/\/$/, '')}${endpoint}`;
}

async function probeServices(env = process.env) {
  if (sandboxNetworkDisabled(env)) {
    return {
      qdrant: { status: 'sandbox_network_denied' },
      embedder: { status: 'sandbox_network_denied' },
    };
  }
  const qdrant = healthUrl(env.CARTOGRAPHER_QDRANT_URL ?? 'http://localhost:6333', '/healthz');
  const embedBase = (env.CARTOGRAPHER_EMBED_URL ?? 'http://localhost:8890/v1/embeddings').replace(/\/v1\/embeddings\/?$/, '');
  return {
    qdrant: await requestHealth(qdrant, 1200, env),
    embedder: await requestHealth(healthUrl(embedBase, '/health'), 1200, env),
  };
}

function defaultConfigPath(env = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  return path.join(home, 'config.toml');
}

function parseArgs(argv) {
  const args = { command: 'doctor', config: null, json: false, probe: true };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === 'doctor' || value === 'apply') args.command = value;
    else if (value === '--config') args.config = argv[++index];
    else if (value === '--json') args.json = true;
    else if (value === '--no-probe') args.probe = false;
    else throw new SetupError(`Unknown argument: ${value}`, 'usage_error');
  }
  if (args.config === undefined) throw new SetupError('--config requires a path.', 'usage_error');
  return args;
}

function writeConfig(configPath, text) {
  const directory = path.dirname(configPath);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const existed = fs.existsSync(configPath);
  const mode = existed ? fs.statSync(configPath).mode & 0o777 : 0o600;
  let backup = null;
  if (existed) {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    backup = `${configPath}.session-cartographer-backup-${stamp}`;
    fs.copyFileSync(configPath, backup, fs.constants.COPYFILE_EXCL);
    fs.chmodSync(backup, mode);
  }
  const temporary = path.join(directory, `.${path.basename(configPath)}.session-cartographer-${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, text, { encoding: 'utf8', mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, configPath);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
  return backup;
}

function renderHuman(report) {
  const lines = [
    `Codex loopback setup: ${report.config_status}`,
    `Config: ${report.config_path}`,
  ];
  if (report.mode) lines.push(`Permission model: ${report.mode}`);
  if (report.changes?.length) lines.push(`Required keys: ${report.changes.join(', ')}`);
  if (report.backup_path) lines.push(`Backup: ${report.backup_path}`);
  lines.push(`Current task network: ${report.current_task_network}`);
  if (report.services) {
    lines.push(`Qdrant: ${report.services.qdrant.status}`);
    lines.push(`Embedder: ${report.services.embedder.status}`);
  }
  if (report.restart_required) lines.push('Restart Codex and start a fresh task before verifying; permissions are fixed when a task starts.');
  if (report.error) lines.push(`Cannot update safely: ${report.error}`);
  return `${lines.join('\n')}\n`;
}

export async function run(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv);
  const configPath = path.resolve(args.config ?? defaultConfigPath(env));
  const original = fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '';
  let plan;
  try {
    plan = planConfig(original);
  } catch (error) {
    if (!(error instanceof SetupError)) throw error;
    return {
      exitCode: 2,
      report: {
        config_status: 'manual_review_required',
        config_path: configPath,
        current_task_network: sandboxNetworkDisabled(env) ? 'disabled' : 'not_reported_disabled',
        error: error.message,
      },
      json: args.json,
    };
  }

  const report = {
    config_status: plan.changes.length ? 'changes_required' : 'ready',
    config_path: configPath,
    mode: plan.mode,
    changes: plan.changes,
    current_task_network: sandboxNetworkDisabled(env) ? 'disabled' : 'not_reported_disabled',
  };
  if (args.command === 'apply' && plan.changes.length) {
    report.backup_path = writeConfig(configPath, plan.text);
    report.config_status = 'updated';
    report.restart_required = true;
  }
  if (args.probe && args.command === 'doctor') report.services = await probeServices(env);
  return { exitCode: 0, report, json: args.json };
}

async function main() {
  try {
    const result = await run();
    process.stdout.write(result.json ? `${JSON.stringify(result.report)}\n` : renderHuman(result.report));
    process.exitCode = result.exitCode;
  } catch (error) {
    const report = {
      config_status: 'error',
      error: error instanceof Error ? error.message : String(error),
    };
    process.stderr.write(`${JSON.stringify(report)}\n`);
    process.exitCode = error instanceof SetupError && error.code === 'usage_error' ? 64 : 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
