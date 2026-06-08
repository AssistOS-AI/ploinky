import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { loadReferenceCatalog } from './referenceCatalog.mjs';

function normalizeWhitespace(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function normalizeClaimText(text) {
  return normalizeWhitespace(text.toLowerCase().replace(/\[[A-Z0-9-]+\]/g, '').replace(/[^a-z0-9\s-]/g, ' '));
}

function claimId(citationKey, claimText) {
  return createHash('sha1')
    .update(`${citationKey}:${normalizeClaimText(claimText)}`)
    .digest('hex');
}

function stripHtml(html) {
  return normalizeWhitespace(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&#39;/g, "'")
      .replace(/&quot;/g, '"')
  );
}

function splitClaimSentences(paragraph) {
  const rawSentences = paragraph
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim())
    .filter(Boolean);
  const mergedSentences = [];

  for (const sentence of rawSentences) {
    if (/^(?:\[[A-Z0-9-]+\]\s*)+\.?$/.test(sentence) && mergedSentences.length > 0) {
      mergedSentences[mergedSentences.length - 1] = `${mergedSentences[mergedSentences.length - 1]} ${sentence}`.trim();
      continue;
    }

    mergedSentences.push(sentence);
  }

  return mergedSentences;
}

function extractParagraphBlocks(markdown) {
  const lines = markdown.split('\n');
  const paragraphs = [];
  const buffer = [];
  let inTable = false;
  let inCodeBlock = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (trimmed.startsWith('```')) {
      if (buffer.length > 0) {
        paragraphs.push(buffer.join(' '));
        buffer.length = 0;
      }
      inCodeBlock = !inCodeBlock;
      inTable = false;
      continue;
    }

    if (inCodeBlock) {
      continue;
    }

    if (!trimmed) {
      if (buffer.length > 0) {
        paragraphs.push(buffer.join(' '));
        buffer.length = 0;
      }
      inTable = false;
      continue;
    }

    if (
      trimmed.startsWith('#') ||
      trimmed.startsWith('|') ||
      /^\d+\.\s+/.test(trimmed) ||
      trimmed.startsWith('![') ||
      /^\*Figure /.test(trimmed)
    ) {
      if (buffer.length > 0) {
        paragraphs.push(buffer.join(' '));
        buffer.length = 0;
      }
      inTable = trimmed.startsWith('|');
      continue;
    }

    if (inTable) {
      continue;
    }

    buffer.push(trimmed);
  }

  if (buffer.length > 0) {
    paragraphs.push(buffer.join(' '));
  }

  return paragraphs;
}

function extractCitationClaims(chapterFile, markdown) {
  const paragraphs = extractParagraphBlocks(markdown);
  const claims = [];

  for (const paragraph of paragraphs) {
    const sentences = splitClaimSentences(paragraph);

    for (const sentence of sentences) {
      const citations = [...sentence.matchAll(/\[([A-Z0-9-]+)\]/g)].map((match) => match[1]);

      for (const citationKey of citations) {
        claims.push({
          chapterFile,
          citationKey,
          sentence,
          normalizedClaim: normalizeClaimText(sentence)
        });
      }
    }
  }

  return claims;
}

function matchesSupportProfile(claimText, supportProfile) {
  const normalized = normalizeClaimText(claimText);

  return supportProfile.requiredAnyGroups.every((group) =>
    group.some((keyword) => normalized.includes(keyword.toLowerCase()))
  );
}

function locateSentences(sourceText) {
  const sentences = splitClaimSentences(sourceText);
  const located = [];
  let cursor = 0;

  for (const sentence of sentences) {
    const start = sourceText.indexOf(sentence, cursor);
    const safeStart = start >= 0 ? start : cursor;
    const end = safeStart + sentence.length;
    located.push({
      text: sentence,
      start: safeStart,
      end,
      normalized: normalizeClaimText(sentence)
    });
    cursor = end;
  }

  return located;
}

function buildSupportPassages(sourceText) {
  const sentences = locateSentences(sourceText);
  const passages = [];

  for (let index = 0; index < sentences.length; index += 1) {
    const first = sentences[index];
    passages.push(first);

    if (index + 1 < sentences.length) {
      const second = sentences[index + 1];
      passages.push({
        text: `${first.text} ${second.text}`,
        start: first.start,
        end: second.end,
        normalized: normalizeClaimText(`${first.text} ${second.text}`)
      });
    }
  }

  return passages.sort((left, right) => left.text.length - right.text.length);
}

function findSupportingSnippet(sourceText, supportProfile) {
  const passages = buildSupportPassages(sourceText);

  for (const passage of passages) {
    const matchedKeywords = [];
    const supported = supportProfile.requiredAnyGroups.every((group) => {
      const keyword = group.find((entry) => passage.normalized.includes(entry.toLowerCase()));

      if (keyword) {
        matchedKeywords.push(keyword);
        return true;
      }

      return false;
    });

    if (supported) {
      return {
        text: passage.text,
        span: `${passage.start}-${Math.max(passage.start, passage.end - 1)}`,
        matchedKeywords
      };
    }
  }

  return null;
}

async function ensureDir(path) {
  await mkdir(path, { recursive: true });
}

async function loadJson(filePath, fallback) {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function fileExists(filePath) {
  try {
    await readFile(filePath, 'utf8');
    return true;
  } catch {
    return false;
  }
}

async function fetchReferenceSource(reference) {
  const response = await fetch(reference.url, {
    headers: {
      'user-agent': 'article-build-skill/1.0'
    }
  });

  if (!response.ok) {
    throw new Error(`HTTP ${response.status} while fetching ${reference.url}`);
  }

  const html = await response.text();

  return {
    html,
    text: stripHtml(html)
  };
}

async function ensureReferenceCache(baseDir, references, citationKey, force = false, { allowBootstrapFallback = false } = {}) {
  const reference = references[citationKey];

  if (!reference) {
    throw new Error(`Unknown reference "${citationKey}".`);
  }

  const referenceDir = resolve(baseDir, citationKey);
  const metadataPath = resolve(referenceDir, 'metadata.json');
  const sourceHtmlPath = resolve(referenceDir, 'source.html');
  const sourceTextPath = resolve(referenceDir, 'source.txt');
  const existingMetadata = await loadJson(metadataPath, null);
  const hasCachedSource = (await fileExists(sourceHtmlPath)) && (await fileExists(sourceTextPath));

  await ensureDir(referenceDir);

  if (reference.verificationMode === 'manual-waived') {
    if (!force && existingMetadata && hasCachedSource) {
      return {
        citationKey,
        reference,
        referenceDir,
        metadataPath,
        sourceHtmlPath,
        sourceTextPath,
        checksPath: resolve(referenceDir, 'checks.json')
      };
    }

    const text = reference.bootstrapText;
    const html = `<!-- manual waiver cache for ${citationKey} -->`;
    const sourceDigest = createHash('sha1').update(text).digest('hex');
    const metadata = {
      citationKey,
      url: reference.url,
      title: reference.title,
      fetchedAt: new Date().toISOString(),
      fetchStatus: 'manual-waived',
      bootstrapOnly: false,
      verificationMode: reference.verificationMode,
      sourceDigest
    };

    await writeFile(sourceHtmlPath, html);
    await writeFile(sourceTextPath, `${text.trim()}\n`);
    await writeFile(metadataPath, JSON.stringify(metadata, null, 2));

    return {
      citationKey,
      reference,
      referenceDir,
      metadataPath,
      sourceHtmlPath,
      sourceTextPath,
      checksPath: resolve(referenceDir, 'checks.json')
    };
  }

  if (!force && existingMetadata && hasCachedSource) {
    return {
      citationKey,
      reference,
      referenceDir,
      metadataPath,
      sourceHtmlPath,
      sourceTextPath,
      checksPath: resolve(referenceDir, 'checks.json')
    };
  }

  let html;
  let text;
  let fetchStatus = 'bootstrap';

  try {
    const fetched = await fetchReferenceSource(reference);
    html = fetched.html;
    text = fetched.text;
    fetchStatus = 'fetched';
  } catch (error) {
    if (hasCachedSource) {
      html = await readFile(sourceHtmlPath, 'utf8');
      text = await readFile(sourceTextPath, 'utf8');
      fetchStatus = 'cached';
    } else if (allowBootstrapFallback) {
      html = `<!-- bootstrap fallback for ${citationKey} -->`;
      text = reference.bootstrapText;
      fetchStatus = 'bootstrap';
    } else {
      throw new Error(
        `Could not refresh source cache for ${citationKey} from ${reference.url}: ${error.message}. ` +
          'A cached source file or an explicit bootstrap override is required.'
      );
    }
  }

  const sourceDigest = createHash('sha1').update(text).digest('hex');
  const metadata = {
    citationKey,
    url: reference.url,
    title: reference.title,
    fetchedAt: new Date().toISOString(),
    fetchStatus,
    bootstrapOnly: fetchStatus === 'bootstrap',
    verificationMode: reference.verificationMode ?? 'source-backed',
    sourceDigest
  };

  await writeFile(sourceHtmlPath, html);
  await writeFile(sourceTextPath, `${text.trim()}\n`);
  await writeFile(metadataPath, JSON.stringify(metadata, null, 2));

  return {
    citationKey,
    reference,
    referenceDir,
    metadataPath,
    sourceHtmlPath,
    sourceTextPath,
    checksPath: resolve(referenceDir, 'checks.json')
  };
}

async function verifyCitationClaims({
  chapters,
  bibliographyDir,
  bibliographyCatalogPath,
  references: preloadedReferences,
  force = false,
  allowBootstrapFallback = false
}) {
  const references = preloadedReferences ?? (await loadReferenceCatalog(bibliographyCatalogPath));
  const allClaims = chapters.flatMap((chapter) => extractCitationClaims(basename(chapter.filePath), chapter.markdown));
  const usedKeys = [...new Set(allClaims.map((claim) => claim.citationKey))];
  const results = [];
  const referenceSummaries = [];

  for (const citationKey of usedKeys) {
    const cache = await ensureReferenceCache(bibliographyDir, references, citationKey, force, {
      allowBootstrapFallback
    });
    const metadata = await loadJson(cache.metadataPath, null);
    const sourceText = await readFile(cache.sourceTextPath, 'utf8');
    const checks = await loadJson(cache.checksPath, {
      citationKey,
      sourceDigest: metadata?.sourceDigest ?? null,
      checkedClaims: []
    });
    const checksFileExists = await fileExists(cache.checksPath);
    let checksChanged = !checksFileExists;
    const relevantClaims = allClaims.filter((claim) => claim.citationKey === citationKey);

    if (metadata?.fetchStatus === 'bootstrap' && !allowBootstrapFallback) {
      throw new Error(
        `Citation ${citationKey} only has bootstrap text in ${cache.referenceDir}. Refresh the cached source or explicitly allow bootstrap fallback before publication builds.`
      );
    }

    for (const claim of relevantClaims) {
      const id = claimId(citationKey, claim.sentence);
      const existing = checks.checkedClaims.find(
        (entry) =>
          entry.id === id &&
          entry.sourceDigest === metadata?.sourceDigest &&
          entry.status === 'supported' &&
          entry.supportSnippet &&
          entry.supportSpan
      );

      if (existing && !force) {
        results.push({
          citationKey,
          claimText: claim.sentence,
          status: existing.supportStatus ?? 'cached-source-supported',
          profileId: existing.profileId,
          chapterFile: claim.chapterFile,
          supportSnippet: existing.supportSnippet,
          supportSpan: existing.supportSpan
        });
        continue;
      }

      const profile = cache.reference.supportProfiles.find((candidate) =>
        matchesSupportProfile(claim.sentence, candidate)
      );

      if (!profile) {
        throw new Error(
          `Citation verification failed for ${citationKey} in ${claim.chapterFile}: "${claim.sentence}". Add a supported claim profile or revise the claim.`
        );
      }

      const supportingSnippet = findSupportingSnippet(sourceText, profile);
      const previousSupport = checks.checkedClaims.find((entry) => entry.id === id && entry.status === 'supported');

      if (!supportingSnippet) {
        const degradedMessage =
          previousSupport && previousSupport.sourceDigest && previousSupport.sourceDigest !== metadata?.sourceDigest
            ? ` The claim was previously supported against source digest ${previousSupport.sourceDigest} but the refreshed source no longer matches profile ${profile.id}.`
            : '';
        throw new Error(
          `Citation verification failed for ${citationKey} in ${claim.chapterFile}: no supporting passage was found in the cached source for "${claim.sentence}".${degradedMessage}`
        );
      }

      const supportStatus =
        metadata?.fetchStatus === 'manual-waived'
          ? 'manual-waived'
          : metadata?.fetchStatus === 'bootstrap'
            ? 'bootstrap-supported'
            : 'cached-source-supported';

      const record = {
        id,
        claimText: claim.sentence,
        normalizedClaim: claim.normalizedClaim,
        chapterFile: claim.chapterFile,
        status: 'supported',
        supportStatus,
        profileId: profile.id,
        note:
          supportStatus === 'manual-waived'
            ? 'Verified against a manually waived bootstrap source because automated source extraction is not yet reliable for this reference.'
            : supportStatus === 'bootstrap-supported'
              ? 'Verified against bootstrap text; refresh the cached source before final publication.'
              : null,
        checkedAt: new Date().toISOString(),
        sourceDigest: metadata?.sourceDigest ?? null,
        sourceStatus: metadata?.fetchStatus ?? 'unknown',
        supportSnippet: supportingSnippet.text,
        supportSpan: supportingSnippet.span,
        matchedKeywords: supportingSnippet.matchedKeywords
      };
      const existingIndex = checks.checkedClaims.findIndex((entry) => entry.id === id);

      if (existingIndex >= 0) {
        checks.checkedClaims[existingIndex] = record;
      } else {
        checks.checkedClaims.push(record);
      }

      checksChanged = true;

      results.push({
        citationKey,
        claimText: claim.sentence,
        status: supportStatus,
        profileId: record.profileId,
        chapterFile: claim.chapterFile,
        supportSnippet: record.supportSnippet,
        supportSpan: record.supportSpan
      });
    }

    if (checks.sourceDigest !== (metadata?.sourceDigest ?? null)) {
      checks.sourceDigest = metadata?.sourceDigest ?? null;
      checksChanged = true;
    }

    if (checksChanged) {
      checks.lastValidatedAt = new Date().toISOString();
      await writeFile(cache.checksPath, JSON.stringify(checks, null, 2));
    }

    referenceSummaries.push({
      citationKey,
      fetchStatus: metadata?.fetchStatus ?? 'unknown',
      bootstrapOnly: metadata?.bootstrapOnly ?? false,
      verificationMode: metadata?.verificationMode ?? cache.reference.verificationMode ?? 'source-backed',
      claimCount: relevantClaims.length
    });
  }

  return {
    bibliographyDir,
    bibliographyCatalogPath,
    references: usedKeys,
    claims: results,
    referenceSummaries,
    bootstrapReferences: referenceSummaries.filter((entry) => entry.bootstrapOnly).map((entry) => entry.citationKey),
    manualWaivedReferences: referenceSummaries
      .filter((entry) => entry.verificationMode === 'manual-waived')
      .map((entry) => entry.citationKey)
  };
}

export { verifyCitationClaims };
