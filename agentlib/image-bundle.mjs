// Build and verify the immutable AgentLib copy shipped inside the Box image.
// This module and its relative imports are copied into the image independently
// of the host Ploinky bind mount. Verification never needs Git or the network.

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    AGENTLIB_ERROR_CODES,
    AGENTLIB_IMAGE_METADATA_PATH,
    AGENTLIB_STABLE_MOUNT_PATH,
    agentLibError,
    validateImageBundleMetadata,
} from './contract.mjs';
import { collectSourceEntries, fingerprintSource } from './fingerprint.mjs';
import { validateAgentLibSource } from './source.mjs';

export { imageSourceId, validateImageBundleMetadata } from './contract.mjs';

function assertSeparateMetadata(sourceDir, metadataPath) {
    const relative = path.relative(path.resolve(sourceDir), path.resolve(metadataPath));
    if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
        throw agentLibError(AGENTLIB_ERROR_CODES.imageInvalid,
            'AgentLib bundle metadata must be outside the fingerprinted source tree.');
    }
}

/** Record evidence only for a clean checkout at the exact immutable build pin. */
export function prepareImageBundle({ sourceDir = AGENTLIB_STABLE_MOUNT_PATH,
    metadataPath = AGENTLIB_IMAGE_METADATA_PATH, commit, fsApi = fs, spawn = spawnSync } = {}) {
    if (!/^[0-9a-f]{40}$/.test(commit || '')) {
        throw agentLibError(AGENTLIB_ERROR_CODES.imageInvalid, 'Bundle preparation requires a 40-hex pinned commit.');
    }
    assertSeparateMetadata(sourceDir, metadataPath);
    const source = validateAgentLibSource(sourceDir, { fsApi });
    const pkg = JSON.parse(fsApi.readFileSync(path.join(source.sourceDir, 'package.json'), 'utf8'));
    if (Object.keys(pkg.dependencies || {}).length || Object.keys(pkg.optionalDependencies || {}).length
        || Object.keys(pkg.peerDependencies || {}).length) {
        throw agentLibError(AGENTLIB_ERROR_CODES.imageInvalid,
            'The AgentLib image bundle requires a dependency-free pin; declared runtime dependencies need an explicit image build policy.');
    }
    const git = (args) => {
        const result = spawn('git', ['-C', source.sourceDir, ...args], {
            encoding: 'utf8', timeout: 30_000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
        });
        if (result.status !== 0 || result.error) {
            throw agentLibError(AGENTLIB_ERROR_CODES.imageInvalid,
                'Unable to verify the AgentLib build checkout with Git; provide a clean pinned checkout.');
        }
        return String(result.stdout || '').trim();
    };
    if (git(['rev-parse', 'HEAD']) !== commit
        || git(['status', '--porcelain', '--untracked-files=all', '--ignored=matching'])) {
        throw agentLibError(AGENTLIB_ERROR_CODES.imageInvalid,
            `The AgentLib image build source must be clean and checked out at ${commit}.`);
    }
    const { fingerprint } = fingerprintSource(source.sourceDir, { fsApi, expectedSourceId: source.sourceId });
    const metadata = { schemaVersion: 1, commit, fingerprint };
    fsApi.mkdirSync(path.dirname(metadataPath), { recursive: true });
    fsApi.writeFileSync(metadataPath, `${JSON.stringify(metadata, null, 2)}\n`, { mode: 0o644 });
    return metadata;
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

/** Verify actual runtime bytes and immutable ownership, without invoking Git. */
export function verifyImageBundle({ sourceDir = AGENTLIB_STABLE_MOUNT_PATH,
    metadataPath = AGENTLIB_IMAGE_METADATA_PATH, expectedCommit = null, fsApi = fs,
    requireImmutable = true } = {}) {
    assertSeparateMetadata(sourceDir, metadataPath);
    let metadata;
    try {
        if (!fsApi.lstatSync(metadataPath).isFile()) throw new Error('metadata is not a regular file');
        metadata = validateImageBundleMetadata(JSON.parse(fsApi.readFileSync(metadataPath, 'utf8')), { expectedCommit });
    } catch (error) {
        if (error?.code === AGENTLIB_ERROR_CODES.imagePinMismatch) throw error;
        throw agentLibError(AGENTLIB_ERROR_CODES.imageInvalid,
            `The Box image has no valid AgentLib bundle metadata at ${metadataPath}; rebuild the Box image.`,
            { cause: error });
    }
    const source = validateAgentLibSource(sourceDir, { fsApi });
    if (requireImmutable) {
        assertProtectedParents(source.sourceDir, fsApi);
        assertProtectedParents(metadataPath, fsApi);
        for (const entry of collectSourceEntries(source.sourceDir, fsApi)) {
            assertRootOwned(path.join(source.sourceDir, entry.relativePath), fsApi);
        }
    }
    const actual = fingerprintSource(source.sourceDir, { fsApi, expectedSourceId: source.sourceId }).fingerprint;
    if (actual !== metadata.fingerprint) {
        throw agentLibError(AGENTLIB_ERROR_CODES.imageInvalid,
            'The image-bundled achillesAgentLib content does not match its build fingerprint; rebuild the Box image.');
    }
    return metadata;
}

function runCli(args) {
    const [command, ...rest] = args;
    if (!['prepare', 'verify'].includes(command)) throw new Error('Expected prepare or verify.');
    const options = {};
    const flags = { '--source': 'sourceDir', '--metadata': 'metadataPath',
        '--commit': 'commit', '--expected-commit': 'expectedCommit' };
    for (let index = 0; index < rest.length; index += 2) {
        const key = flags[rest[index]];
        const value = rest[index + 1];
        if (!key || !value || value.startsWith('--') || options[key]) throw new Error('Invalid image bundle arguments.');
        options[key] = value;
    }
    if (command === 'prepare' && options.expectedCommit) throw new Error('prepare uses --commit.');
    if (command === 'verify' && options.commit) throw new Error('verify uses --expected-commit.');
    return command === 'prepare' ? prepareImageBundle(options) : verifyImageBundle(options);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    try {
        process.stdout.write(`${JSON.stringify(runCli(process.argv.slice(2)))}\n`);
    } catch (error) {
        process.stderr.write(`${error.code ? `${error.code}: ` : ''}${error.message}\n`);
        process.exitCode = 1;
    }
}
