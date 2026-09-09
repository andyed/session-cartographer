#!/usr/bin/env node
/**
 * project-registry.js — JS half of the single project-registry resolver.
 *
 * scripts/project-registry.sh carries the full rationale; this file must
 * resolve to the SAME path for the same environment. It exists only because
 * build-profile.js is a Node program in a hot enough path that shelling out to
 * bash+jq per run buys nothing, and because a JS consumer that re-derived the
 * order inline is exactly the divergence CLAUDE.md's sentinel rule forbids.
 * tests/unit/project-registry-resolution.test.js asserts the two agree — if you
 * change one, change both and that test will tell you if you missed a case.
 *
 * Resolution order (first hit wins, no merging):
 *   1. $CARTOGRAPHER_PROJECT_REGISTRY (explicit; set-but-missing is an error)
 *   2. <config dir>/project-registry.json, config dir per turboConfigPath()
 *   3. <this file>/../project-registry.json (the maintainer's shipped default)
 *
 * A present-but-malformed registry throws. Falling back to the shipped file
 * would answer an adopter's query with the maintainer's aliases, which is the
 * silent wrong answer this module was written to remove.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/** The shipped default: sibling of this script's parent, in repo and plugin mirror alike. */
export const SHIPPED_REGISTRY = path.join(HERE, '..', 'project-registry.json');

export class ProjectRegistryError extends Error {}

/**
 * User configuration directory. Mirrors turboConfigPath() in turbo-common.js
 * rather than inventing a second location — an adopter who configured Turbo
 * should not have to discover a different directory for the registry.
 */
export function registryConfigDir(env = process.env) {
  if (env.CARTOGRAPHER_CONFIG) return path.dirname(path.resolve(env.CARTOGRAPHER_CONFIG));
  const configRoot = env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
  return path.join(configRoot, 'session-cartographer');
}

/** Where a user-level registry lives (whether or not it exists) — bootstrap's target. */
export function userRegistryPath(env = process.env) {
  if (env.CARTOGRAPHER_PROJECT_REGISTRY) return path.resolve(env.CARTOGRAPHER_PROJECT_REGISTRY);
  return path.join(registryConfigDir(env), 'project-registry.json');
}

/** Parse and shape-check one candidate. Throws with the offending path named. */
export function parseRegistry(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (error) {
    throw new ProjectRegistryError(`project-registry: cannot read ${file}: ${error.message}`);
  }
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ProjectRegistryError(`project-registry: ${file} is not valid JSON: ${error.message}`);
  }
  const aliases = parsed && typeof parsed === 'object' ? parsed.aliases : undefined;
  if (!aliases || typeof aliases !== 'object' || Array.isArray(aliases)) {
    throw new ProjectRegistryError(
      `project-registry: ${file} is not a valid registry (expected a JSON object with an "aliases" object)`,
    );
  }
  return parsed;
}

/**
 * The resolved registry path, or null when none exists at all (a checkout with
 * the shipped file deleted). Throws when the selected layer is unusable.
 */
export function resolveProjectRegistryPath(env = process.env) {
  if (env.CARTOGRAPHER_PROJECT_REGISTRY) {
    const explicit = path.resolve(env.CARTOGRAPHER_PROJECT_REGISTRY);
    if (!fs.existsSync(explicit)) {
      throw new ProjectRegistryError(
        `project-registry: CARTOGRAPHER_PROJECT_REGISTRY=${explicit} does not exist`,
      );
    }
    parseRegistry(explicit);
    return explicit;
  }
  const user = path.join(registryConfigDir(env), 'project-registry.json');
  if (fs.existsSync(user)) {
    parseRegistry(user);
    return user;
  }
  return fs.existsSync(SHIPPED_REGISTRY) ? SHIPPED_REGISTRY : null;
}

/** `{ file, aliases }` for the resolved registry; empty aliases when there is none. */
export function loadProjectRegistry(env = process.env) {
  const file = resolveProjectRegistryPath(env);
  if (!file) return { file: null, aliases: {} };
  return { file, aliases: parseRegistry(file).aliases };
}

/** Alias members for `name`, or `[name]` when it is not an alias. */
export function expandProjectAlias(name, env = process.env) {
  const key = String(name ?? '').trim();
  if (!key) return [];
  const { aliases } = loadProjectRegistry(env);
  const members = aliases[key];
  return Array.isArray(members) ? members.slice() : [key];
}

/** project name -> family alias, for consumers that label rather than expand. */
export function familyLookup(env = process.env) {
  const map = new Map();
  let aliases = {};
  try { ({ aliases } = loadProjectRegistry(env)); } catch { /* caller-visible via resolve */ }
  for (const [family, members] of Object.entries(aliases)) {
    if (!Array.isArray(members)) continue;
    for (const member of members) map.set(member, family);
  }
  return (project) => map.get(project) || '';
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [flag = '--path', value] = process.argv.slice(2);
  try {
    if (flag === '--path') process.stdout.write(`${resolveProjectRegistryPath() || ''}\n`);
    else if (flag === '--user-path') process.stdout.write(`${userRegistryPath()}\n`);
    else if (flag === '--aliases') {
      process.stdout.write(`${Object.keys(loadProjectRegistry().aliases).sort().join('\n')}\n`);
    } else if (flag === '--expand') {
      process.stdout.write(`${expandProjectAlias(value).join('\n')}\n`);
    } else {
      process.stderr.write('Usage: project-registry.js [--path|--user-path|--aliases|--expand NAME]\n');
      process.exit(2);
    }
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exit(3);
  }
}
