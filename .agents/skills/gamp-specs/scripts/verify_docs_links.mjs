import { readdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../../..');
const docsDir = resolve(repoRoot, 'docs');

function isExternal(target) {
  return /^(?:[a-z]+:)?\/\//i.test(target) || target.startsWith('mailto:') || target.startsWith('tel:') || target.startsWith('data:');
}

async function listHtmlFiles(dirPath) {
  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = resolve(dirPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await listHtmlFiles(fullPath)));
      continue;
    }

    if (entry.isFile() && entry.name.endsWith('.html')) {
      files.push(fullPath);
    }
  }

  return files;
}

function collectTargets(html) {
  const sanitizedHtml = html.replace(/<script[\s\S]*?<\/script>/gi, '');
  return [
    ...sanitizedHtml.matchAll(/\shref="([^"]+)"/g),
    ...sanitizedHtml.matchAll(/\ssrc="([^"]+)"/g),
    ...sanitizedHtml.matchAll(/\sdata-include="([^"]+)"/g)
  ].map((match) => match[1]);
}

function stripHashAndQuery(target) {
  const [withoutHash] = target.split('#');
  return withoutHash;
}

async function fileExists(targetPath) {
  try {
    await readFile(targetPath, 'utf8');
    return true;
  } catch {
    return false;
  }
}

function extractIds(html) {
  return new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((match) => match[1]));
}

async function verifyHtmlFile(filePath) {
  const html = await readFile(filePath, 'utf8');
  const issues = [];
  const ids = extractIds(html);
  const resolutionBase = filePath.includes(`${resolve(docsDir, 'partials')}`) ? docsDir : dirname(filePath);

  for (const target of collectTargets(html)) {
    if (!target || isExternal(target) || target === '#') {
      continue;
    }

    if (target.startsWith('#')) {
      const anchorId = target.slice(1);
      if (anchorId && !ids.has(anchorId)) {
        issues.push(`${filePath}: anchor ${target} does not exist.`);
      }
      continue;
    }

    const [rawPath, rawQuery = ''] = stripHashAndQuery(target).split('?');
    const query = new URLSearchParams(rawQuery);
    const resolvedPath = rawPath
      ? resolve(resolutionBase, rawPath.startsWith('/') ? rawPath.slice(1) : rawPath)
      : filePath;

    if (rawPath && !(await fileExists(resolvedPath))) {
      issues.push(`${filePath}: target ${target} resolves to missing file ${resolvedPath}.`);
      continue;
    }

    if ((rawPath === 'specsLoader.html' || rawPath === '/specsLoader.html' || target.startsWith('specsLoader.html?')) && query.has('spec')) {
      const specTarget = resolve(docsDir, 'specs', query.get('spec'));
      if (!(await fileExists(specTarget))) {
        issues.push(`${filePath}: target ${target} references missing spec ${specTarget}.`);
      }
    }
  }

  return issues;
}

const MERMAID_PATTERN = /mermaid.*?\.esm\.min\.mjs/;

function checkMermaidInclude(filePath, html) {
  const partialsDir = resolve(docsDir, 'partials');
  if (filePath.startsWith(partialsDir)) {
    return [];
  }
  if (!MERMAID_PATTERN.test(html)) {
    return [`${filePath}: missing Mermaid ESM module script in <head>.`];
  }
  return [];
}

async function main() {
  const htmlFiles = await listHtmlFiles(docsDir);
  const allIssues = [];

  for (const htmlFile of htmlFiles) {
    allIssues.push(...(await verifyHtmlFile(htmlFile)));
    const html = await readFile(htmlFile, 'utf8');
    allIssues.push(...checkMermaidInclude(htmlFile, html));
  }

  if (allIssues.length > 0) {
    for (const issue of allIssues) {
      console.error(issue);
    }
    process.exit(1);
  }

  console.log(`Verified ${htmlFiles.length} HTML files under ${docsDir}`);
}

main().catch((error) => {
  console.error(error.message || String(error));
  process.exit(1);
});
