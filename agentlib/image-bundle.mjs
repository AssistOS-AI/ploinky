// Runtime checks for the achillesAgentLib copy the Box image supplies.
//
// The image build owns selecting, packaging and describing that copy. Ploinky
// only checks that it is a usable, protected package. The check reads package
// metadata and file types and ownership; it never hashes library bytes and it
// never compares the copy with a revision Ploinky expects.

import fs from 'node:fs';
import path from 'node:path';
import {
    AGENTLIB_ERROR_CODES,
    AGENTLIB_IMAGE_METADATA_PATH,
    AGENTLIB_LIBRARY_NAME,
    AGENTLIB_STABLE_MOUNT_PATH,
    agentLibError,
    normalizeLibraryProvenance,
} from './contract.mjs';
import { collectSourceEntries } from './fingerprint.mjs';
import { validateAgentLibSource } from './source.mjs';

export const IMAGE_LIBRARY_METADATA_SCHEMA = 'ploinky.box.library/v1';

/**
 * Build-generated provenance of the image copy, or all-null when the record is
 * absent or not in the current format. Provenance is diagnostic information: a
 * missing or unreadable record never blocks an otherwise usable package.
 */
export function readImageProvenance({ metadataPath = AGENTLIB_IMAGE_METADATA_PATH, fsApi = fs } = {}) {
    try {
        if (!fsApi.lstatSync(metadataPath).isFile()) return normalizeLibraryProvenance(null);
        const metadata = JSON.parse(fsApi.readFileSync(metadataPath, 'utf8'));
        if (metadata?.schema !== IMAGE_LIBRARY_METADATA_SCHEMA || metadata?.library !== AGENTLIB_LIBRARY_NAME) {
            return normalizeLibraryProvenance(null);
        }
        return normalizeLibraryProvenance(metadata);
    } catch (_) {
        return normalizeLibraryProvenance(null);
    }
}

function assertRootOwned(filePath, fsApi) {
    const stat = fsApi.lstatSync(filePath);
    if (stat.uid !== 0 || (!stat.isSymbolicLink() && (stat.mode & 0o022))) {
        throw agentLibError(AGENTLIB_ERROR_CODES.imageInvalid,
            `Image AgentLib path must be owned by root and not writable by the runtime user: ${filePath}.`);
    }
}

function assertProtectedParents(filePath, fsApi) {
    let current = path.resolve(filePath);
    while (true) {
        assertRootOwned(current, fsApi);
        if (fsApi.lstatSync(current).isSymbolicLink()) {
            throw agentLibError(AGENTLIB_ERROR_CODES.imageInvalid,
                `Image AgentLib protected path must not be a symlink: ${current}.`);
        }
        const parent = path.dirname(current);
        if (parent === current) return;
        current = parent;
    }
}

/**
 * Check the image copy as a package and as protected files, without invoking
 * Git or reading the tree's bytes for a digest.
 *
 * @returns {{ packageName: string, packageVersion: string|null, provenance: object }}
 */
export function verifyImageAgentLibPackage({ sourceDir = AGENTLIB_STABLE_MOUNT_PATH,
    metadataPath = AGENTLIB_IMAGE_METADATA_PATH, fsApi = fs, requireImmutable = true } = {}) {
    let source;
    try {
        source = validateAgentLibSource(sourceDir, { fsApi });
    } catch (error) {
        throw agentLibError(AGENTLIB_ERROR_CODES.imageInvalid,
            `The Box image achillesAgentLib copy at ${sourceDir} is not a usable package: ${error.message}`,
            { cause: error });
    }
    if (requireImmutable) {
        assertProtectedParents(source.sourceDir, fsApi);
        for (const entry of collectSourceEntries(source.sourceDir, fsApi)) {
            assertRootOwned(path.join(source.sourceDir, entry.relativePath), fsApi);
        }
    }
    return {
        packageName: source.packageName,
        packageVersion: source.packageVersion,
        provenance: readImageProvenance({ metadataPath, fsApi }),
    };
}
