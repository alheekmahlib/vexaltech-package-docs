#!/usr/bin/env node
/**
 * Build all packages — fetches README + builds each package's site.
 * Each package gets its own dist/<package-id>/ directory.
 *
 * Usage:
 *   node scripts/build-all.mjs          # build all
 *   node scripts/build-all.mjs <id>     # build one
 */

import { execSync } from 'child_process';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const packages = JSON.parse(readFileSync(join(ROOT, 'packages.config.json'), 'utf-8'));
const targetId = process.argv[2];

const toBuild = targetId
  ? packages.filter(p => p.id === targetId)
  : packages;

if (toBuild.length === 0) {
  console.error(`No packages to build. Check the package ID: ${targetId}`);
  process.exit(1);
}

console.log(`\n🏗  Building ${toBuild.length} package(s)...\n`);

for (const pkg of toBuild) {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  📦 ${pkg.id} (accent: ${pkg.accent})`);
  console.log(`${'═'.repeat(60)}\n`);

  // Step 1: Fetch README data
  console.log('  Step 1: Fetching README...');
  execSync(`node scripts/fetch-data.mjs ${pkg.id}`, { stdio: 'inherit', cwd: ROOT });

  // Step 2: Build with Astro — set PACKAGE_ID env var
  console.log(`\n  Step 2: Building Astro site...`);
  const outDir = `dist/${pkg.id}`;
  execSync(`PACKAGE_ID=${pkg.id} npx astro build`, {
    stdio: 'inherit',
    cwd: ROOT,
    env: { ...process.env, PACKAGE_ID: pkg.id },
  });
}

console.log(`\n✅ All packages built!\n`);