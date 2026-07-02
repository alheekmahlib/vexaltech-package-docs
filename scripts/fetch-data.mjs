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

// Convert HTML <h2 id="slug">Title</h2> to ## Title before splitting
function normalizeHtmlHeadings(readme) {
  return readme.replace(/<h[23][^>]*>(.+?)<\/h[23]>/gis, (match, title) => {
    const cleanTitle = title.replace(/<[^>]*>/g, '').trim();
    return `\n## ${cleanTitle}\n`;
  });
}

// Split README into sections — supports ## headings (including HTML-h2 normalized)
function splitReadme(readme) {
  const sections = [];

  // Normalize HTML headings to markdown
  const normalized = normalizeHtmlHeadings(readme);

  // Fix image URLs first
  const readmeContent = fixImageUrls(normalized, pkg.repo, pkg.branch);
  const fixedContent = fixImgTags(readmeContent, pkg.repo, pkg.branch);

  // Find first heading (## or ###)
  // Pre-section content (title, badges, intro before first heading)
  const firstHeadingMatch = fixedContent.match(/\n#{2,3}\s+/);
  const firstHeading = firstHeadingMatch ? firstHeadingMatch.index : -1;

  let intro = '';
  let body = fixedContent;

  if (firstHeading > 0) {
    intro = fixedContent.substring(0, firstHeading).trim();
    body = fixedContent.substring(firstHeading);
  }

  // Overview section from intro
  if (intro) {
    const titleMatch = intro.match(/^#\s+(.+)$/m);
    const title = titleMatch ? titleMatch[1].trim() : pkg.name;

    let overviewContent = intro
      .replace(/^#\s+.+$/m, '')
      .replace(/<!--[\\s\\S]*?-->/g, '')
      .replace(/^\\s*$/gm, '')
      .trim();

    if (overviewContent) {
      sections.push({
        slug: 'overview',
        title: 'Overview',
        content: overviewContent,
      });
    }
  }

  // Split body by headings — use ## if available, otherwise fall back to ###
  const hasH2 = /\n##\s+/.test(body);
  const headingPattern = hasH2 ? /\n(?=##\s+)/ : /\n(?=##\s+)/;
  const parts = body.split(headingPattern);

  // If no ## sections found, try ### as top-level
  if (!hasH2) {
    const h3Parts = body.split(/\n(?=###\s+)/);
    if (h3Parts.length > 1) {
      for (const part of h3Parts) {
        const m = part.match(/^###\s+([^\n]+)(?:\n([\s\S]*))?$/);
        if (!m) continue;
        const rawTitle = m[1].trim();
        let content = (m[2] || '').trim();
        const displayTitle = rawTitle.replace(/[^\w\s.-]/g, '').trim();
        if (!displayTitle) continue;
        const slug = displayTitle.toLowerCase().replace(/[^\w\s-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').trim();
        if (/table of contents/i.test(rawTitle)) continue;
        if (sections.some(s => s.slug === slug)) continue;
        if (content.length < 20 && !content.includes('```') && !content.includes('http')) continue;
        if (!slug) continue;
        sections.push({ slug, title: displayTitle, content: `## ${displayTitle}\n${content}` });
      }
    }
  } else {

  for (const part of parts) {
    const match = part.match(/^##\s+([^\n]+)(?:\n([\s\S]*))?$/);
    if (!match) continue;

    const rawTitle = match[1].trim();
    let content = (match[2] || '').trim();

    // Clean title for display and slug
    const displayTitle = rawTitle.replace(/[^\w\s.-]/g, '').trim();
    if (!displayTitle) continue;
    const slug = displayTitle
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .trim();

    // Skip TOC, duplicates, and subtitle lines
    if (/table of contents/i.test(rawTitle)) continue;
    if (sections.some(s => s.slug === slug)) continue;
    if (content.length < 20 && !content.includes('```') && !content.includes('http')) continue;
    if (!slug) continue;

    // Build section content with ## heading
    const sectionContent = `## ${displayTitle}\n${content}`;

    sections.push({
      slug,
      title: displayTitle,
      content: sectionContent,
    });
  }
  } // end else

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