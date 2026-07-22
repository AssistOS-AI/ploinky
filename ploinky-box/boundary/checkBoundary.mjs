import fs from 'node:fs';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { BoundaryViolationError } from '../errors.mjs';
import {
    fingerprintPath,
    fingerprintsEqual,
    sha256,
} from './fingerprint.mjs';
import {
    readChangedPaths,
    readDirtyEntries,
    runGit,
} from './gitState.mjs';

function fail(message) {
    throw new BoundaryViolationError(message);
}

function readManifest(manifestPath) {
    let manifest;
    try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    } catch (error) {
        throw new BoundaryViolationError(`Unable to read baseline manifest ${manifestPath}`, {
            cause: error,
        });
    }
    if (manifest?.schema !== 1) {
        fail('Baseline manifest schema must be exactly 1');
    }
    if (!Array.isArray(manifest.allowlist) || !Array.isArray(manifest.dirtyFiles)) {
        fail('Baseline manifest is missing its allowlist or dirty-file inventory');
    }
    return manifest;
}

function assertManifestAuthority(repositoryRoot, baseSha, allowlist, manifest) {
    let canonicalRoot;
    try {
        canonicalRoot = fs.realpathSync(repositoryRoot);
    } catch (error) {
        throw new BoundaryViolationError(`Unable to resolve repository root ${repositoryRoot}`, {
            cause: error,
        });
    }
    if (canonicalRoot !== manifest.repositoryRoot) {
        fail(`Repository root does not match the baseline manifest: ${canonicalRoot}`);
    }
    if (baseSha !== manifest.baseSha) {
        fail(`Base SHA does not match the baseline manifest: ${baseSha}`);
    }
    if (!isDeepStrictEqual(allowlist, manifest.allowlist)) {
        fail('Explicit allowlist does not match the baseline manifest');
    }

    try {
        runGit(canonicalRoot, ['cat-file', '-e', `${baseSha}^{commit}`]);
    } catch (error) {
        throw new BoundaryViolationError(
            `Base SHA ${baseSha} is not a commit in ${canonicalRoot}`,
            { cause: error },
        );
    }
    return canonicalRoot;
}

function dirtyEntryMap(repositoryRoot) {
    const entries = readDirtyEntries(repositoryRoot);
    return new Map(entries.map((entry) => [entry.path, entry]));
}

function assertProtectedDirtyFile(repositoryRoot, captured, currentEntries) {
    const current = currentEntries.get(captured.path);
    if (!current || current.status !== captured.status) {
        fail(`Protected dirty status changed: ${captured.path}`);
    }
    if (captured.originalPath !== current.originalPath) {
        fail(`Protected rename/copy source changed: ${captured.path}`);
    }
    if (!fingerprintsEqual(fingerprintPath(repositoryRoot, captured.path), captured)) {
        fail(`Protected dirty content or mode changed: ${captured.path}`);
    }
    if (captured.originalPath
        && !fingerprintsEqual(
            fingerprintPath(repositoryRoot, captured.originalPath),
            captured.original,
        )) {
        fail(`Protected rename/copy source content changed: ${captured.originalPath}`);
    }
}

function countOccurrences(haystack, needle) {
    let count = 0;
    let offset = 0;
    while (offset <= haystack.length - needle.length) {
        const index = haystack.indexOf(needle, offset);
        if (index < 0) {
            break;
        }
        count += 1;
        offset = index + needle.length;
    }
    return count;
}

function findInsertions(baseline, current) {
    if (current.length < baseline.length) {
        return [];
    }

    let commonPrefixLength = 0;
    while (commonPrefixLength < baseline.length
        && baseline[commonPrefixLength] === current[commonPrefixLength]) {
        commonPrefixLength += 1;
    }

    let commonSuffixLength = 0;
    while (commonSuffixLength < baseline.length
        && baseline[baseline.length - commonSuffixLength - 1]
            === current[current.length - commonSuffixLength - 1]) {
        commonSuffixLength += 1;
    }

    const insertionLength = current.length - baseline.length;
    const minimumOffset = baseline.length - commonSuffixLength;
    const maximumOffset = commonPrefixLength;
    const insertions = [];
    for (let offset = minimumOffset; offset <= maximumOffset; offset += 1) {
        insertions.push({
            bytes: current.subarray(offset, offset + insertionLength),
            offset,
        });
    }
    return insertions;
}

function runtimeSectionRange(baseline) {
    const heading = Buffer.from('<h2>Runtime Backends and Mount Policy</h2>');
    const headingOffset = baseline.indexOf(heading);
    if (headingOffset < 0) {
        fail('Runtime baseline is missing the protected section heading');
    }
    const sectionStart = baseline.lastIndexOf(Buffer.from('<section'), headingOffset);
    const close = Buffer.from('</section>');
    const sectionClose = baseline.indexOf(close, headingOffset);
    if (sectionStart < 0 || sectionClose < 0) {
        fail('Runtime baseline has an incomplete protected section');
    }
    return {
        start: sectionStart,
        end: sectionClose + close.length,
    };
}

function assertBoxSectionInsertion(baseline, current) {
    if (current.equals(baseline)) {
        return;
    }

    const insertions = findInsertions(baseline, current);
    if (insertions.length === 0 || insertions[0].bytes.length === 0) {
        fail('docs/runtime.html must differ from its snapshot by one insertion only');
    }

    const protectedRange = runtimeSectionRange(baseline);
    const sectionInsertions = insertions.filter((insertion) => {
        const addedText = insertion.bytes.toString('utf8').trim();
        return addedText.startsWith('<section')
            && addedText.endsWith('</section>')
            && (addedText.match(/<section(?:\s|>)/g) ?? []).length === 1
            && (addedText.match(/<\/section>/g) ?? []).length === 1
            && /<h2[^>]*>[^<]*Ploinky Box[^<]*<\/h2>/.test(addedText);
    });
    if (sectionInsertions.length === 0) {
        fail('The docs/runtime.html insertion must be one complete Ploinky Box section');
    }
    if (!sectionInsertions.some((insertion) => (
        insertion.offset <= protectedRange.start || insertion.offset >= protectedRange.end
    ))) {
        fail('The Ploinky Box section cannot be inserted inside Runtime Backends and Mount Policy');
    }
}

function assertEditableBaseline(repositoryRoot, manifestPath, manifest, captured) {
    const editable = manifest.editableBaseline;
    if (!editable || editable.path !== captured.path) {
        fail(`Missing editable baseline metadata for ${captured.path}`);
    }
    if (path.dirname(path.resolve(editable.snapshotPath))
        !== path.dirname(path.resolve(manifestPath))) {
        fail('The editable documentation snapshot must be beside its manifest');
    }

    const snapshotFingerprint = fingerprintPath(
        path.dirname(editable.snapshotPath),
        path.basename(editable.snapshotPath),
    );
    if (snapshotFingerprint.kind !== 'file'
        || snapshotFingerprint.mode !== editable.snapshotMode
        || snapshotFingerprint.sha256 !== editable.snapshotSha256) {
        fail('The editable documentation snapshot content or mode changed');
    }

    const currentFingerprint = fingerprintPath(repositoryRoot, captured.path);
    if (currentFingerprint.kind !== 'file' || currentFingerprint.mode !== captured.mode) {
        fail(`Editable baseline path content type or mode changed: ${captured.path}`);
    }

    const baseline = fs.readFileSync(editable.snapshotPath);
    const current = fs.readFileSync(path.join(repositoryRoot, captured.path));
    const paragraph = Buffer.from(editable.protectedParagraphBase64, 'base64');
    if (sha256(paragraph) !== editable.protectedParagraphSha256
        || countOccurrences(baseline, paragraph) !== 1
        || countOccurrences(current, paragraph) !== 1) {
        fail('The protected rootless-Podman paragraph changed, moved, or was duplicated');
    }
    assertBoxSectionInsertion(baseline, current);
}

function assertOriginalPlan(repositoryRoot, manifest) {
    if (!manifest.originalPlan) {
        return;
    }
    const current = fingerprintPath(repositoryRoot, manifest.originalPlan.path);
    if (!fingerprintsEqual(current, manifest.originalPlan)) {
        fail('The original Ploinky Box plan content or mode changed');
    }
    const blobHash = runGit(repositoryRoot, [
        'hash-object',
        manifest.originalPlan.path,
    ], { encoding: 'utf8' }).trim();
    if (blobHash !== manifest.originalPlan.gitBlobHash) {
        fail('The original Ploinky Box plan Git blob hash changed');
    }
}

function escapeRegularExpression(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function matchesAllowlist(relativePath, pattern) {
    if (pattern.endsWith('/**')) {
        const prefix = pattern.slice(0, -2);
        return relativePath.startsWith(prefix) && relativePath.length > prefix.length;
    }
    if (!pattern.includes('*')) {
        return relativePath === pattern;
    }

    const expression = pattern
        .split('*')
        .map(escapeRegularExpression)
        .join('[^/]*');
    return new RegExp(`^${expression}$`, 'u').test(relativePath);
}

function isAllowed(relativePath, allowlist) {
    return allowlist.some((pattern) => matchesAllowlist(relativePath, pattern));
}

export function checkBoundary(repositoryRoot, baseSha, allowlist, manifestPath) {
    if (arguments.length !== 4) {
        throw new TypeError('checkBoundary requires exactly four inputs');
    }
    if (!Array.isArray(allowlist) || allowlist.some((entry) => typeof entry !== 'string')) {
        throw new TypeError('Boundary allowlist must be an array of strings');
    }

    const manifest = readManifest(manifestPath);
    const canonicalRoot = assertManifestAuthority(
        repositoryRoot,
        baseSha,
        allowlist,
        manifest,
    );
    const changedPaths = readChangedPaths(canonicalRoot, baseSha);
    const currentEntries = dirtyEntryMap(canonicalRoot);
    const protectedPaths = [];
    const editablePaths = [];

    for (const captured of manifest.dirtyFiles) {
        if (captured.classification === 'protected') {
            assertProtectedDirtyFile(canonicalRoot, captured, currentEntries);
            protectedPaths.push(captured.path);
        } else if (captured.classification === 'editable-with-protected-baseline') {
            assertEditableBaseline(canonicalRoot, manifestPath, manifest, captured);
            editablePaths.push(captured.path);
        } else {
            fail(`Unknown dirty-file classification for ${captured.path}`);
        }
        changedPaths.delete(captured.path);
        if (captured.originalPath) {
            changedPaths.delete(captured.originalPath);
        }
    }

    assertOriginalPlan(canonicalRoot, manifest);

    const rejectedPaths = [...changedPaths]
        .filter((relativePath) => !isAllowed(relativePath, allowlist))
        .sort();
    if (rejectedPaths.length > 0) {
        fail(`Paths outside the implementation boundary changed: ${rejectedPaths.join(', ')}`);
    }

    return {
        repositoryRoot: canonicalRoot,
        baseSha,
        implementationPaths: [...changedPaths].sort(),
        protectedPaths: protectedPaths.sort(),
        editablePaths: editablePaths.sort(),
    };
}
