import { copyFile, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderArticleHtml } from './renderHtml.mjs';
import { validateSvgFile } from './svgValidation.mjs';
import { verifyCitationClaims } from './bibliography.mjs';
import { loadReferenceCatalog } from './referenceCatalog.mjs';

const skillSourcePath = fileURLToPath(import.meta.url);
const renderHtmlSourcePath = fileURLToPath(new URL('./renderHtml.mjs', import.meta.url));

function normalizeBuildOptions(options = {}) {
  const articleBuildOverrides = {
    ...(options.configOverrides?.articleBuild ?? {}),
    ...(options.manualOverrides?.articleBuild ?? {})
  };

  return {
    articleRoot: options.articleRoot ?? articleBuildOverrides.articleRoot ?? 'docs/article',
    baseDir: resolve(options.baseDir ?? articleBuildOverrides.baseDir ?? process.cwd()),
    incremental: options.incremental ?? articleBuildOverrides.incremental ?? true,
    skillName: options.skillName ?? articleBuildOverrides.skillName ?? 'article-build',
    allowBootstrapFallback: Boolean(options.allowBootstrapFallback ?? articleBuildOverrides.allowBootstrapFallback)
  };
}

function resolveArticlePaths(buildOptions) {
  const articleRoot = resolve(buildOptions.baseDir, buildOptions.articleRoot);
  const planDir = resolve(articleRoot, 'plan');

  return {
    articleRoot,
    planDir,
    mainPlanPath: resolve(planDir, 'plan.md'),
    bibliographyCatalogPath: resolve(planDir, 'bibliography.md'),
    bibliographyDir: resolve(planDir, 'bibliography'),
    chapterDir: resolve(planDir, 'chapters'),
    assetSpecPath: resolve(planDir, 'assets.json'),
    assetOutputDir: resolve(articleRoot, 'assets'),
    outputHtmlPath: resolve(articleRoot, 'index.html'),
    manifestPath: resolve(planDir, 'build-manifest.json')
  };
}

async function readText(filePath) {
  return readFile(filePath, 'utf8');
}

async function fileExists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function listFilesRecursively(dirPath) {
  if (!(await fileExists(dirPath))) {
    return [];
  }

  const entries = await readdir(dirPath, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const fullPath = resolve(dirPath, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await listFilesRecursively(fullPath)));
    } else {
      files.push(fullPath);
    }
  }

  return files;
}

async function getMtimeMs(filePath) {
  try {
    const fileStat = await stat(filePath);
    return fileStat.mtimeMs;
  } catch {
    return 0;
  }
}

async function needsRefresh(outputPath, dependencyPaths, force = false) {
  if (force || !(await fileExists(outputPath))) {
    return true;
  }

  const outputMtime = await getMtimeMs(outputPath);

  for (const dependencyPath of dependencyPaths) {
    if ((await getMtimeMs(dependencyPath)) > outputMtime) {
      return true;
    }
  }

  return false;
}

function parseFrontmatter(markdown) {
  if (!markdown.startsWith('---\n')) {
    return { metadata: {}, body: markdown };
  }

  const endIndex = markdown.indexOf('\n---\n', 4);

  if (endIndex === -1) {
    return { metadata: {}, body: markdown };
  }

  const rawFrontmatter = markdown.slice(4, endIndex).trim();
  const body = markdown.slice(endIndex + 5);
  const metadata = {};
  let currentListKey = null;

  for (const rawLine of rawFrontmatter.split('\n')) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      continue;
    }

    if (/^\s*-\s+/.test(rawLine) && currentListKey) {
      metadata[currentListKey].push(line.replace(/^\s*-\s*/, ''));
      continue;
    }

    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);

    if (!match) {
      continue;
    }

    const [, key, value] = match;

    if (value === '') {
      metadata[key] = [];
      currentListKey = key;
      continue;
    }

    metadata[key] = /^\d+$/.test(value) ? Number(value) : value;
    currentListKey = null;
  }

  return { metadata, body };
}

function extractSection(markdown, title) {
  const pattern = new RegExp(`^##\\s+${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`, 'm');
  const match = markdown.match(pattern);

  if (!match) {
    return null;
  }

  const start = match.index + match[0].length;
  const rest = markdown.slice(start).replace(/^\n+/, '');

  if (title === 'Generated Chapter Template') {
    return rest.trim();
  }

  const nextHeadingMatch = rest.match(/^##\s+/m);

  return (nextHeadingMatch ? rest.slice(0, nextHeadingMatch.index) : rest).trim();
}

function extractRequiredSection(markdown, title, filePath) {
  const section = extractSection(markdown, title);

  if (!section) {
    throw new Error(`Required section "## ${title}" is missing from ${filePath}.`);
  }

  return section;
}

function splitByDelimiter(value, delimiter) {
  const segments = [];
  let buffer = '';
  let bracketDepth = 0;

  for (const character of value) {
    if (character === '[') {
      bracketDepth += 1;
    } else if (character === ']') {
      bracketDepth = Math.max(0, bracketDepth - 1);
    }

    if (character === delimiter && bracketDepth === 0) {
      segments.push(buffer);
      buffer = '';
      continue;
    }

    buffer += character;
  }

  if (buffer) {
    segments.push(buffer);
  }

  return segments.map((segment) => segment.trim()).filter(Boolean);
}

function coerceLiteral(value) {
  if (/^-?\d+(?:\.\d+)?$/.test(value)) {
    return Number(value);
  }

  if (value === 'true') {
    return true;
  }

  if (value === 'false') {
    return false;
  }

  return value;
}

function parseSelectorSegment(segment) {
  const filterMatch = segment.match(/^([A-Za-z0-9_-]+)\[([^\]]+)\]$/);

  if (filterMatch) {
    return {
      type: 'filter',
      key: filterMatch[1],
      filters: splitByDelimiter(filterMatch[2], ',').map((condition) => {
        const [field, rawValue] = condition.split('=').map((part) => part.trim());

        if (!field || rawValue === undefined) {
          throw new Error(`Invalid selector condition "${condition}".`);
        }

        return {
          field,
          value: coerceLiteral(rawValue)
        };
      })
    };
  }

  if (/^\d+$/.test(segment)) {
    return {
      type: 'index',
      index: Number(segment)
    };
  }

  return {
    type: 'property',
    key: segment
  };
}

function matchesFilterValue(actual, expected) {
  if (typeof actual === 'number' && typeof expected === 'number') {
    return actual === expected;
  }

  return String(actual) === String(expected);
}

function resolveSelector(data, selector) {
  const segments = splitByDelimiter(selector, '.');
  let cursor = data;

  for (const rawSegment of segments) {
    const segment = parseSelectorSegment(rawSegment);

    if (segment.type === 'property') {
      cursor = cursor?.[segment.key];
      continue;
    }

    if (segment.type === 'index') {
      cursor = cursor?.[segment.index];
      continue;
    }

    const collection = cursor?.[segment.key];

    if (!Array.isArray(collection)) {
      throw new Error(`Selector segment "${rawSegment}" expects an array.`);
    }

    cursor = collection.find((entry) =>
      segment.filters.every((filter) => matchesFilterValue(entry?.[filter.field], filter.value))
    );
  }

  if (cursor === undefined) {
    throw new Error(`Selector "${selector}" did not resolve to a value.`);
  }

  return cursor;
}

function formatScalar(value) {
  if (value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'object') {
    throw new Error('Template token resolved to an object; use a scalar selector or JSON table token instead.');
  }

  return String(value);
}

function renderMarkdownTable(rows, columns) {
  const header = `| ${columns.map((column) => column.header).join(' | ')} |`;
  const divider = `| ${columns.map(() => '---').join(' | ')} |`;
  const body = rows.map((row) =>
    `| ${columns
      .map((column) => formatScalar(row?.[column.field]).replace(/\|/g, '\\|'))
      .join(' | ')} |`
  );

  return [header, divider, ...body].join('\n');
}

function parseJsonSourceSpec(spec) {
  const hashIndex = spec.indexOf('#');

  if (hashIndex === -1) {
    throw new Error(`Invalid JSON token "${spec}". Expected "path#selector".`);
  }

  return {
    filePath: spec.slice(0, hashIndex).trim(),
    selector: spec.slice(hashIndex + 1).trim()
  };
}

function parseJsonTableSpec(spec) {
  const [sourceSpec, columnSpec] = spec.split('|').map((part) => part.trim());

  if (!sourceSpec || !columnSpec) {
    throw new Error(`Invalid JSON table token "${spec}".`);
  }

  const columns = splitByDelimiter(columnSpec, ';').map((entry) => {
    const [header, field] = entry.split('=').map((part) => part.trim());

    if (!header || !field) {
      throw new Error(`Invalid JSON table column "${entry}".`);
    }

    return { header, field };
  });

  return {
    ...parseJsonSourceSpec(sourceSpec),
    columns
  };
}

async function replaceAsync(input, regex, replacer) {
  let result = '';
  let lastIndex = 0;

  for (const match of input.matchAll(regex)) {
    result += input.slice(lastIndex, match.index);
    result += await replacer(match);
    lastIndex = match.index + match[0].length;
  }

  result += input.slice(lastIndex);
  return result;
}

async function resolveTemplate(markdown, planPath) {
  const planDir = dirname(planPath);
  const jsonCache = new Map();

  async function loadJson(relativePath) {
    const absolutePath = resolve(planDir, relativePath);

    if (!jsonCache.has(absolutePath)) {
      jsonCache.set(absolutePath, JSON.parse(await readText(absolutePath)));
    }

    return jsonCache.get(absolutePath);
  }

  let resolved = await replaceAsync(markdown, /\{\{FILE:([^}]+)\}\}/g, async (match) => {
    const absolutePath = resolve(planDir, match[1].trim());
    return (await readText(absolutePath)).trim();
  });

  resolved = await replaceAsync(resolved, /\{\{JSON_TABLE:([^}]+)\}\}/g, async (match) => {
    const spec = parseJsonTableSpec(match[1].trim());
    const data = await loadJson(spec.filePath);
    const rows = resolveSelector(data, spec.selector);

    if (!Array.isArray(rows)) {
      throw new Error(`JSON table token "${match[0]}" did not resolve to an array.`);
    }

    return renderMarkdownTable(rows, spec.columns);
  });

  resolved = await replaceAsync(resolved, /\{\{JSON:([^}]+)\}\}/g, async (match) => {
    const spec = parseJsonSourceSpec(match[1].trim());
    const data = await loadJson(spec.filePath);
    return formatScalar(resolveSelector(data, spec.selector));
  });

  return resolved;
}

function collectTemplateDependencyPaths(markdown, planPath) {
  const planDir = dirname(planPath);
  const dependencies = new Set();

  for (const match of markdown.matchAll(/\{\{FILE:([^}]+)\}\}/g)) {
    dependencies.add(resolve(planDir, match[1].trim()));
  }

  for (const match of markdown.matchAll(/\{\{JSON_TABLE:([^}]+)\}\}/g)) {
    const spec = parseJsonTableSpec(match[1].trim());
    dependencies.add(resolve(planDir, spec.filePath));
  }

  for (const match of markdown.matchAll(/\{\{JSON:([^}]+)\}\}/g)) {
    const spec = parseJsonSourceSpec(match[1].trim());
    dependencies.add(resolve(planDir, spec.filePath));
  }

  return [...dependencies];
}

async function assertExistingPaths(paths, context) {
  for (const candidatePath of paths) {
    if (!(await fileExists(candidatePath))) {
      throw new Error(`${context} declares dependency ${candidatePath}, but that file does not exist.`);
    }
  }
}

async function listChapterPlanPaths(planDir) {
  const entries = await readdir(planDir, { withFileTypes: true });

  return entries
    .filter((entry) => entry.isFile() && /^plan_ch\d+\.md$/.test(entry.name))
    .map((entry) => resolve(planDir, entry.name))
    .sort((left, right) => left.localeCompare(right, undefined, { numeric: true }));
}

async function loadChapterPlanEntries(planDir) {
  const planPaths = await listChapterPlanPaths(planDir);
  const entries = [];

  for (const planPath of planPaths) {
    const fullMarkdown = await readText(planPath);
    const { metadata, body } = parseFrontmatter(fullMarkdown);

    if (metadata.chapter === undefined || !metadata.target) {
      throw new Error(`Chapter plan ${planPath} must declare "chapter" and "target" in frontmatter.`);
    }

    entries.push({
      planPath,
      metadata,
      body,
      targetPath: resolve(dirname(planPath), metadata.target)
    });
  }

  return entries.sort((left, right) => Number(left.metadata.chapter) - Number(right.metadata.chapter));
}

async function loadAssetSpecs(paths) {
  const assetSpec = JSON.parse(await readText(paths.assetSpecPath));

  if (!Array.isArray(assetSpec.assets) || assetSpec.assets.length === 0) {
    throw new Error(`Asset spec file ${paths.assetSpecPath} must define a non-empty "assets" array.`);
  }

  return assetSpec.assets.map((asset) => {
    if (!asset.output || !asset.source) {
      throw new Error(`Every asset spec in ${paths.assetSpecPath} must define "output" and "source".`);
    }

    return {
      id: asset.id ?? asset.output,
      output: resolve(paths.articleRoot, asset.output),
      source: resolve(dirname(paths.assetSpecPath), asset.source),
      validation: asset.validation ?? { type: 'generic' }
    };
  });
}

async function refreshArticleAssets({ force = false, paths }) {
  const specs = await loadAssetSpecs(paths);
  const outputs = [];

  await mkdir(paths.assetOutputDir, { recursive: true });

  for (const spec of specs) {
    const shouldWrite = await needsRefresh(spec.output, [paths.assetSpecPath, spec.source], force);

    if (!shouldWrite) {
      outputs.push({
        id: spec.id,
        output: spec.output,
        source: spec.source,
        validation: spec.validation,
        refreshed: false
      });
      continue;
    }

    await mkdir(dirname(spec.output), { recursive: true });
    await copyFile(spec.source, spec.output);

    outputs.push({
      id: spec.id,
      output: spec.output,
      source: spec.source,
      validation: spec.validation,
      refreshed: true
    });
  }

  return outputs;
}

async function validateArticleAssets(assetResults) {
  const validations = [];

  for (const asset of assetResults) {
    try {
      const validation = await validateSvgFile(asset.output, asset.validation);
      validations.push({
        ...validation,
        assetId: asset.id,
        refreshed: asset.refreshed
      });
    } catch (error) {
      throw new Error(
        `SVG validation failed for ${asset.output}. Repair the source asset or its validation rule before regenerating the article. ${error.message}`
      );
    }
  }

  return validations;
}

async function refreshChapterDrafts({ force = false, paths }) {
  const chapterEntries = await loadChapterPlanEntries(paths.planDir);
  const outputs = [];

  await mkdir(paths.chapterDir, { recursive: true });

  for (const entry of chapterEntries) {
    const template = extractSection(entry.body, 'Generated Chapter Template');

    if (!template) {
      throw new Error(`Plan file ${entry.planPath} is missing a "## Generated Chapter Template" section.`);
    }
    const declaredDependencies = (entry.metadata.dependsOn ?? []).map((relativePath) =>
      resolve(dirname(entry.planPath), relativePath)
    );
    const templateDependencies = collectTemplateDependencyPaths(template, entry.planPath);
    const dependencyPaths = [
      entry.planPath,
      ...declaredDependencies,
      ...templateDependencies,
      skillSourcePath
    ];
    await assertExistingPaths(declaredDependencies, `Chapter plan ${entry.planPath}`);
    await assertExistingPaths(templateDependencies, `Generated chapter template in ${entry.planPath}`);
    const shouldWrite = await needsRefresh(entry.targetPath, dependencyPaths, force);

    if (!shouldWrite) {
      outputs.push({
        chapter: entry.metadata.chapter,
        targetPath: entry.targetPath,
        refreshed: false
      });
      continue;
    }

    const resolvedDraft = await resolveTemplate(template, entry.planPath);

    await mkdir(dirname(entry.targetPath), { recursive: true });
    await writeFile(entry.targetPath, `${resolvedDraft.trim()}\n`);

    outputs.push({
      chapter: entry.metadata.chapter,
      targetPath: entry.targetPath,
      refreshed: true
    });
  }

  return outputs;
}

function extractFirstHeading(markdown) {
  const match = markdown.match(/^#\s+(.*)$/m);

  return match ? match[1].trim() : 'Untitled chapter';
}

async function buildHtml({ force = false, paths, references, chapters, assetResults }) {
  const planMarkdown = await readText(paths.mainPlanPath);
  const dependencyPaths = [
    paths.mainPlanPath,
    paths.assetSpecPath,
    paths.bibliographyCatalogPath,
    ...chapters.map((chapter) => chapter.filePath),
    ...assetResults.map((asset) => asset.output),
    ...(await listFilesRecursively(paths.bibliographyDir)),
    skillSourcePath,
    renderHtmlSourcePath
  ];
  const shouldWrite = await needsRefresh(paths.outputHtmlPath, dependencyPaths, force);

  if (!shouldWrite) {
    return {
      outputPath: paths.outputHtmlPath,
      refreshed: false
    };
  }

  const html = renderArticleHtml({
    title: extractRequiredSection(planMarkdown, 'Title', paths.mainPlanPath),
    abstract: extractSection(planMarkdown, 'Abstract') ?? '',
    chapters: chapters.map((chapter, index) => ({
      number: chapter.number ?? index + 1,
      title: chapter.title,
      markdown: chapter.markdown
    })),
    references,
    provenance: {
      generator: 'article-build skill v1.0',
      generatedAt: new Date().toISOString(),
      articleRoot: paths.articleRoot,
      planDir: paths.planDir
    }
  });

  await mkdir(paths.articleRoot, { recursive: true });
  await writeFile(paths.outputHtmlPath, html);

  return {
    outputPath: paths.outputHtmlPath,
    refreshed: true
  };
}

async function writeManifest(manifestPath, manifest) {
  await mkdir(dirname(manifestPath), { recursive: true });
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

async function loadBuiltChapters(chapterResults) {
  return Promise.all(
    chapterResults.map(async (entry) => {
      const markdown = await readText(entry.targetPath);

      return {
        number: entry.chapter,
        title: extractFirstHeading(markdown).replace(/^\d+\.\s*/, ''),
        filePath: entry.targetPath,
        markdown
      };
    })
  );
}

async function runArticleBuildSkill(options = {}) {
  const buildOptions = normalizeBuildOptions(options);
  const force = Boolean(options.force) || buildOptions.incremental === false;
  const paths = resolveArticlePaths(buildOptions);
  const references = await loadReferenceCatalog(paths.bibliographyCatalogPath);
  const assetResults = await refreshArticleAssets({ force, paths });
  const assetValidation = await validateArticleAssets(assetResults);
  const chapterResults = await refreshChapterDrafts({ force, paths });
  const chapters = await loadBuiltChapters(chapterResults);
  const bibliography = await verifyCitationClaims({
    chapters,
    bibliographyDir: paths.bibliographyDir,
    bibliographyCatalogPath: paths.bibliographyCatalogPath,
    references,
    force,
    allowBootstrapFallback: buildOptions.allowBootstrapFallback
  });
  const html = await buildHtml({
    force,
    paths,
    references,
    chapters,
    assetResults
  });
  const manifest = {
    skill: buildOptions.skillName,
    articleRoot: buildOptions.articleRoot,
    articleRootPath: paths.articleRoot,
    baseDir: buildOptions.baseDir,
    force,
    generatedAt: new Date().toISOString(),
    chapters: chapterResults.map((entry) => ({
      chapter: entry.chapter,
      target: entry.targetPath,
      refreshed: entry.refreshed
    })),
    assets: assetResults.map((entry) => ({
      id: entry.id,
      source: entry.source,
      output: entry.output,
      refreshed: entry.refreshed
    })),
    assetValidation,
    bibliography,
    html
  };

  await writeManifest(paths.manifestPath, manifest);

  return manifest;
}

export { runArticleBuildSkill };
