import { readFile, readdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDir = dirname(fileURLToPath(import.meta.url));
const defaultRepoRoot = resolve(moduleDir, '../../..');
const requiredSkillFiles = ['SKILL.md', 'DS.md', 'skill.json'];

function parseFrontmatter(markdown) {
  if (!markdown.startsWith('---\n')) {
    return {};
  }

  const endIndex = markdown.indexOf('\n---\n', 4);
  if (endIndex === -1) {
    return {};
  }

  const values = {};
  for (const line of markdown.slice(4, endIndex).trim().split('\n')) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) {
      values[match[1]] = match[2];
    }
  }

  return values;
}

async function readSkillDefinition(repoRoot, skillId) {
  const skillDir = resolve(repoRoot, 'skills', skillId);
  const [descriptor, designSpec, rawMetadata] = await Promise.all([
    readFile(resolve(skillDir, 'SKILL.md'), 'utf8'),
    readFile(resolve(skillDir, 'DS.md'), 'utf8'),
    readFile(resolve(skillDir, 'skill.json'), 'utf8')
  ]);
  const metadata = JSON.parse(rawMetadata);
  const frontmatter = parseFrontmatter(descriptor);

  return {
    id: skillId,
    directory: `skills/${skillId}`,
    descriptorPath: `skills/${skillId}/SKILL.md`,
    designSpecPath: `skills/${skillId}/DS.md`,
    descriptor,
    designSpec,
    title: metadata.title,
    family: metadata.family,
    summary: frontmatter.description ?? metadata.summary,
    aliases: [...new Set([skillId, ...(metadata.aliases ?? []), frontmatter.name].filter(Boolean))],
    dependsOn: metadata.dependsOn ?? [],
    outputs: metadata.outputs ?? [],
    entrypoints: metadata.entrypoints ?? [],
    selfContained: metadata.selfContained !== false
  };
}

async function readSkillCatalog(repoRoot = defaultRepoRoot) {
  const skillEntries = await readdir(resolve(repoRoot, 'skills'), { withFileTypes: true });
  const skillIds = skillEntries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((left, right) => left.localeCompare(right));

  return Promise.all(skillIds.map((skillId) => readSkillDefinition(repoRoot, skillId)));
}

function validateSkillCatalog(skillCatalog) {
  const knownIds = new Set(skillCatalog.map((skill) => skill.id));
  const issues = [];

  for (const skill of skillCatalog) {
    for (const dependency of skill.dependsOn) {
      if (!knownIds.has(dependency)) {
        issues.push(`${skill.id} depends on unknown skill ${dependency}.`);
      }
    }

    if (!skill.selfContained) {
      issues.push(`${skill.id} must remain self-contained.`);
    }

    for (const requiredFile of requiredSkillFiles) {
      const pathKey =
        requiredFile === 'SKILL.md'
          ? skill.descriptorPath
          : requiredFile === 'DS.md'
            ? skill.designSpecPath
            : `skills/${skill.id}/skill.json`;

      if (!pathKey) {
        issues.push(`${skill.id} is missing ${requiredFile}.`);
      }
    }
  }

  return issues;
}

export { defaultRepoRoot, parseFrontmatter, readSkillCatalog, readSkillDefinition, validateSkillCatalog };
