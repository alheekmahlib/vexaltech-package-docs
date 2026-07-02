#!/usr/bin/env node
/**
 * Fetch README.md for each library, split into sections by ## and ### headings,
 * and generate per-package data files for Astro to consume at build time.
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

// Fix relative image URLs to absolute GitHub URLs
function fixImageUrls(content, repo, branch) {
  // Match ![alt](path) — fix relative paths
  return content.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (match, alt, url) => {
    // Skip badge URLs (shields.io, etc.)
    if (url.includes('shields.io') || url.includes('badge') || url.startsWith('http')) {
      return match;
    }
    // Fix relative paths → absolute GitHub raw URLs
    if (url.startsWith('./') || url.startsWith('/')) {
      const cleanPath = url.replace(/^\.\//, '').replace(/^\//, '');
      return `![${alt}](https://raw.githubusercontent.com/${repo}/${branch}/${cleanPath})`;
    }
    return match;
  });
}

// Fix HTML <img> tags with relative src
function fixImgTags(content, repo, branch) {
  return content.replace(/<img[^>]*src=["']([^"']+)["'][^>]*>/gi, (match, src) => {
    if (src.includes('shields.io') || src.includes('badge') || src.startsWith('http')) {
      return match;
    }
    if (src.startsWith('./') || src.startsWith('/')) {
      const cleanPath = src.replace(/^\.\//, '').replace(/^\//, '');
      return match.replace(src, `https://raw.githubusercontent.com/${repo}/${branch}/${cleanPath}`);
    }
    return match;
  });
}

// Split README into sections — supports both ## and ### headings
function splitReadme(readme) {
  const sections = [];

  // Fix image URLs first
  const fixedReadme = fixImageUrls(readme, pkg.repo, pkg.branch);
  const readmeContent = fixImgTags(fixedReadme, pkg.repo, pkg.branch);

  // Find first heading (## or ###)
  const firstHeadingMatch = readmeContent.match(/\n#{2,3}\s+/);
  const firstHeading = firstHeadingMatch ? firstHeadingMatch.index : -1;

  let intro = '';
  let body = readmeContent;

  if (firstHeading > 0) {
    intro = readmeContent.substring(0, firstHeading).trim();
    body = readmeContent.substring(firstHeading);
  }

  // Overview section from intro (before first ##)
  if (intro) {
    const titleMatch = intro.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : pkg.name;

    // Keep badges, images, and description — just remove the # title line
    let overviewContent = intro
      .replace(/^#\s+.+$/m, '') // Remove title
      .replace(/<!--[\\s\\S]*?-->/g, '') // Remove HTML comments
      .replace(/^\\s*$/gm, '') // Remove empty lines
      .trim();

    if (overviewContent) {
      sections.push({
        slug: 'overview',
        title: 'Overview',
        content: overviewContent,
      });
    }
  }

  // Split body by ## or ### headings
  // Match lines starting with ## or ###
  const parts = body.split(/\n(?=#{2,3}\s+)/);

  for (const part of parts) {
    const match = part.match(/^(#{2,3})\s+([^\n]+)(?:\n([\s\S]*))?$/);
    if (!match) continue;

    const rawTitle = match[2].trim();
    let content = (match[3] || '').trim();

    // Skip TOC sections
    if (/table of contents/i.test(rawTitle)) continue;

    // Skip sections that are empty (no real content)
    const plainContent = content.replace(/!\[.*?\]\(.*?\)/g, '').replace(/<[^>]*>/g, '').trim();
    if (!plainContent && !content.includes('```') && !content.includes('http')) continue;

    // Clean title for display and slug
    const displayTitle = rawTitle.replace(/[^\w\s.-]/g, '').trim();
    if (!displayTitle) continue;
    const slug = displayTitle
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();

    if (!slug) continue;

    // Build section content with ## heading
    const sectionContent = `## ${displayTitle}\n${content}`;

    sections.push({
      slug,
      title: displayTitle,
      content: sectionContent,
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