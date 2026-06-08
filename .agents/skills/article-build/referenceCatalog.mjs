import { readFile } from 'node:fs/promises';

function parseSupportProfile(expression) {
  const [profileIdPart, groupsPart] = expression.split(':');

  if (!profileIdPart || !groupsPart) {
    throw new Error(`Invalid support profile line: ${expression}`);
  }

  return {
    id: profileIdPart.trim(),
    requiredAnyGroups: groupsPart
      .split(';')
      .map((group) => group.trim())
      .filter(Boolean)
      .map((group) => group.split('|').map((keyword) => keyword.trim()).filter(Boolean))
  };
}

function parseReferenceSection(sectionMarkdown) {
  const lines = sectionMarkdown.split('\n').map((line) => line.trim()).filter(Boolean);
  const heading = lines.shift();
  const headingMatch = heading?.match(/^##\s+\[([A-Z0-9-]+)\]$/);

  if (!headingMatch) {
    throw new Error(`Invalid bibliography heading: ${heading ?? '<missing>'}`);
  }

  const citationKey = headingMatch[1];
  const reference = {
    supportProfiles: []
  };

  for (const line of lines) {
    const supportMatch = line.match(/^- Support profile `([^`]+)`: (.*)$/);

    if (supportMatch) {
      const profile = parseSupportProfile(`${supportMatch[1]}: ${supportMatch[2]}`);
      reference.supportProfiles.push(profile);
      continue;
    }

    const fieldMatch = line.match(/^- ([A-Za-z ]+): (.*)$/);

    if (!fieldMatch) {
      continue;
    }

    const [, rawField, value] = fieldMatch;
    const field = rawField.toLowerCase();

    if (field === 'authors') {
      reference.authors = value;
    } else if (field === 'title') {
      reference.title = value;
    } else if (field === 'year') {
      reference.year = value;
    } else if (field === 'url') {
      reference.url = value;
    } else if (field === 'bootstrap text') {
      reference.bootstrapText = value;
    } else if (field === 'verification mode') {
      reference.verificationMode = value;
    }
  }

  if (!reference.authors || !reference.title || !reference.year || !reference.url || !reference.bootstrapText) {
    throw new Error(`Bibliography entry ${citationKey} is missing one or more required fields.`);
  }

  if (reference.supportProfiles.length === 0) {
    throw new Error(`Bibliography entry ${citationKey} does not declare any support profiles.`);
  }

  reference.verificationMode = reference.verificationMode ?? 'source-backed';

  return [citationKey, reference];
}

async function loadReferenceCatalog(catalogPath) {
  const markdown = await readFile(catalogPath, 'utf8');
  const sections = markdown
    .split(/^##\s+\[[A-Z0-9-]+\]\s*$/m)
    .slice(1);
  const headings = [...markdown.matchAll(/^##\s+\[[A-Z0-9-]+\]\s*$/gm)].map((match) => match[0].trim());
  const entries = {};

  for (let index = 0; index < headings.length; index += 1) {
    const sectionMarkdown = `${headings[index]}\n${sections[index] ?? ''}`.trim();
    const [citationKey, reference] = parseReferenceSection(sectionMarkdown);
    entries[citationKey] = reference;
  }

  return entries;
}

export { loadReferenceCatalog };
