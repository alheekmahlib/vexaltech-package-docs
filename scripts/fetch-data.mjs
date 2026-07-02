#!/usr/bin/env node
/**
 * Fetch README.md for each library, split into sections by ## headings,
 * and generate per-package data files for Astro to consume at build time.
 *
 * The script sets process.env.PACKAGE_ID so Astro knows which package to render.
 * Astro's getStaticPaths generates one page per section.
 *
 * Usage:
 *   node scripts/fetch-data.mjs <package-id>
 */

import { writeFileSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = join(__dirname, '..');

const packages = JSON.parse(readFileSync(join(PROJECT_ROOT, 'packages.config.json'), 'utf-8'));
const pkgId = process.argv[2];

if (!pkgId) {
  console.error('Usage: node scripts/fetch-data.mjs <package-id>');
  process.exit(1);
}

const pkg = packages.find(p => p.id === pkgId);
if (!pkg) {
  console.error(`Package "${pkgId}" not found in packages.config.json`);
  process.exit(1);
}

console.log(`📦 Fetching data for ${pkgId}...`);

// Fetch README.md
async function fetchReadme() {
  const url = `https://raw.githubusercontent.com/${pkg.repo}/${pkg.branch}/README.md`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.text();
  } catch (err) {
    console.warn(`  ⚠ Could not fetch README: ${err.message}`);
    return null;
  }
}

// Fetch pubspec.yaml
async function fetchPubspec() {
  const url = `https://raw.githubusercontent.com/${pkg.repo}/${pkg.branch}/pubspec.yaml`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const text = await res.text();
    const get = (key) => {
      const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, 'm'));
      return m ? m[1].trim().replace(/^['"]|['"]$/g, '') : null;
    };
    return {
      version: get('version')?.replace(/^(.+)\+\d+$/, '$1') || '1.0.0',
      description: get('description') || '',
      homepage: get('homepage') || `https://github.com/${pkg.repo}`,
    };
  } catch {
    return { version: '1.0.0', description: '', homepage: `https://github.com/${pkg.repo}` };
  }
}

// Split README into sections by ## headings
function splitReadme(readme) {
  const sections = [];

  // Pre-section content (title, badges, intro before first ##)
  const firstHeading = readme.indexOf('\n## ');
  let intro = '';
  let body = readme;

  if (firstHeading > 0) {
    intro = readme.substring(0, firstHeading).trim();
    body = readme.substring(firstHeading);
  }

  // Overview section from intro
  if (intro) {
    // Extract title from first line
    const titleMatch = intro.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : pkg.name;

    // Remove the # title line and HTML tags for overview content
    const overviewContent = intro
      .replace(/^#\s+.+$/m, '')
      .replace(/<img[^>]*>/gi, '')
      .replace(/<a[^>]*>[\s\S]*?<\/a>/gis, '')
      .replace(/<p[^>]*>/gi, '')
      .replace(/<\/p>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/^\s*$/gm, '')
      .trim();

    if (overviewContent) {
      sections.push({
        slug: 'overview',
        title: 'Overview',
        content: overviewContent,
      });
    }
  }

  // Split body by ## headings
  const parts = body.split(/\n(?=##\s+)/);

  for (const part of parts) {
    const match = part.match(/^##\s+(.+?)(?:\n([\s\S]*))?$/);
    if (!match) continue;

    const rawTitle = match[1].trim();
    const content = (match[2] || '').trim();
    if (!content && !part.includes('```')) continue;

    // Skip TOC sections and non-content
    if (/^table of contents$/i.test(rawTitle)) continue;

    const slug = rawTitle
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();

    sections.push({
      slug,
      title: rawTitle.replace(/[^\w\s.-]/g, '').trim(),
      content: part, // Keep the ## heading in content for rendering
    });
  }

  return sections;
}

// Main
async function main() {
  const [readme, pubspec] = await Promise.all([fetchReadme(), fetchPubspec()]);

  if (!readme) {
    console.error(`  ❌ No README found for ${pkgId}. Using fallback.`);
    process.exit(0);
  }

  const sections = splitReadme(readme);

  const data = {
    id: pkg.id,
    name: pkg.name,
    repo: pkg.repo,
    branch: pkg.branch,
    org: pkg.org,
    accent: pkg.accent,
    version: pubspec.version,
    description: pubspec.description,
    homepage: pubspec.homepage,
    pubdevUrl: `https://pub.dev/packages/${pkg.id}`,
    githubUrl: `https://github.com/${pkg.repo}`,
    readmeRaw: readme,
    sections,
  };

  // Write to src/data/<package-id>.json
  const dataDir = join(PROJECT_ROOT, 'src/data');
  mkdirSync(dataDir, { recursive: true });
  const outPath = join(dataDir, `${pkg.id}.json`);
  writeFileSync(outPath, JSON.stringify(data, null, 2), 'utf-8');

  console.log(`  ✅ ${sections.length} sections extracted`);
  console.log(`  ✅ Written to src/data/${pkg.id}.json`);
  sections.forEach(s => console.log(`     - ${s.title} (/${s.slug})`));
}

main().catch(err => {
  console.error('❌ Fetch failed:', err.message);
  process.exit(0);
});