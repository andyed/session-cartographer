#!/usr/bin/env node

import { accessSync, constants, readFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

function readable(path, errors, label) {
  try {
    accessSync(path, constants.R_OK);
    return true;
  } catch (error) {
    errors.push(`${label} is not readable: ${path} (${error.code || 'access failed'})`);
    return false;
  }
}

export function checkExplorerPreflight(root) {
  const explorer = join(resolve(root), 'explorer');
  const errors = [];
  const manifestPath = join(explorer, 'package.json');

  for (const [file, label] of [
    [manifestPath, 'Explorer package manifest'],
    [join(explorer, 'package-lock.json'), 'Explorer package lock'],
    [join(explorer, 'index.html'), 'Explorer entry page'],
  ]) readable(file, errors, label);

  let manifest = null;
  if (!errors.some(error => error.includes(manifestPath))) {
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    } catch (error) {
      errors.push(`Explorer package manifest is invalid JSON: ${manifestPath} (${error.message})`);
    }
  }

  const packages = Object.keys({
    ...(manifest?.dependencies || {}),
    ...(manifest?.devDependencies || {}),
  });
  const missingPackages = packages.filter(name => {
    try {
      accessSync(join(explorer, 'node_modules', name, 'package.json'), constants.R_OK);
      return false;
    } catch {
      return true;
    }
  });
  if (missingPackages.length) {
    errors.push(`Explorer dependencies are missing: ${missingPackages.join(', ')}`);
  }

  const vite = join(explorer, 'node_modules', '.bin', 'vite');
  try {
    accessSync(vite, constants.R_OK | constants.X_OK);
  } catch (error) {
    errors.push(`Vite launcher is not executable: ${vite} (${error.code || 'access failed'})`);
  }

  return { ok: errors.length === 0, explorer, errors, packageCount: packages.length };
}

function run() {
  const root = process.argv[2] || resolve(fileURLToPath(import.meta.url), '..', '..');
  const result = checkExplorerPreflight(root);
  if (result.ok) {
    console.log(`Explorer preflight OK: ${result.packageCount} packages and required entry files are readable.`);
    return;
  }

  console.error('Explorer preflight failed:');
  for (const error of result.errors) console.error(`- ${error}`);
  console.error(`Install missing packages with: npm ci --prefix ${JSON.stringify(result.explorer)} --no-audit --no-fund`);
  process.exitCode = 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
