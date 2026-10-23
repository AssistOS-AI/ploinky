#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
    readBoundedJsonFile,
    readRepositoryState,
    validateAgentlibDeliveryMetadata,
    validateRootPackageInstaller,
} from './verifyCopilot421Bundle.mjs';

// Current Explorer release manifest. It binds an immutable Box image digest to a
// frozen, hash-pinned source inventory; it never selects or rewrites the legacy
// release schema. Completeness of the inventory is a reviewed operator
// prerequisite: this verifier proves every listed source, not that the list is
// complete.
export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_KIND = 'explorer-release-bundle';
export const INVENTORY_SCHEMA_VERSION = 1;
export const INVENTORY_KIND = 'explorer-source-inventory';
export const CORE_REPOSITORIES = Object.freeze(['achillesAgentLib', 'explorer', 'ploinky']);
export const REPOSITORY_ROLES = Object.freeze(['deployed-source', 'provenance-reference']);
export const ROBOTEAM_OWNER = Object.freeze({ repository: 'explorer', path: 'roboTeamAgent' });

const SHA_PATTERN = /^[0-9a-f]{40}$/;
const SHA256_PATTERN = /^[0-9a-f]{64}$/;
const IMAGE_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/;
const REPOSITORY_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const MAX_REPOSITORIES = 64;
const GIT_TIMEOUT_MS = 5_000;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const LEGACY_REJECTION_CODE = 'PLOINKY_COPILOT_421_BUNDLE_REJECTED';
const LEGACY_MESSAGE_PREFIX = 'Copilot 421 release bundle rejected: ';

function bundleError(message, cause) {
    const error = new Error(`Explorer release bundle rejected: ${message}`, { cause });
    error.code = 'PLOINKY_EXPLORER_RELEASE_BUNDLE_REJECTED';
    return error;
}

// The shared helpers throw the legacy error type; report them under this
// verifier's own identity so a failure always names the verifier that ran.
function viaSharedHelper(action) {
    try {
        return action();
    } catch (error) {
        if (error?.code !== LEGACY_REJECTION_CODE) throw error;
        const message = String(error.message).startsWith(LEGACY_MESSAGE_PREFIX)
            ? String(error.message).slice(LEGACY_MESSAGE_PREFIX.length)
            : String(error.message);
        throw bundleError(message, error);
    }
}

function assertPlainObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw bundleError(`${label} must be an object`);
    }
}

function assertExactKeys(value, expectedKeys, label) {
    assertPlainObject(value, label);
    const actual = Object.keys(value).sort();
    const expected = [...expectedKeys].sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
        throw bundleError(`${label} must contain exactly ${expected.join(', ')}`);
    }
}

function assertExactSha(value, label) {
    if (typeof value !== 'string' || !SHA_PATTERN.test(value)) {
        throw bundleError(`${label} must be an exact lowercase 40-hex commit`);
    }
    return value;
}

function assertSha256(value, label) {
    if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
        throw bundleError(`${label} must be a lowercase 64-hex SHA-256`);
    }
    return value;
}

function assertImageDigest(value, label) {
    if (typeof value !== 'string' || !IMAGE_DIGEST_PATTERN.test(value)) {
        throw bundleError(`${label} must be an immutable sha256:<64 lowercase hex> digest`);
    }
    return value;
}

function assertAbsoluteNormalizedPath(value, label) {
    if (typeof value !== 'string' || !path.isAbsolute(value) || path.resolve(value) !== value) {
        throw bundleError(`${label} must be an absolute, normalized path`);
    }
    return value;
}

function isInside(root, candidate) {
    return candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

function canonicalPath(value, label, { fsApi = fs } = {}) {
    let real;
    try {
        real = fsApi.realpathSync(value);
    } catch (error) {
        throw bundleError(`unable to resolve ${label}`, error);
    }
    if (real !== value) throw bundleError(`${label} must be its canonical real path`);
    return real;
}

// One bounded read supplies both the parsed value and the SHA-256, so the
// verified bytes are exactly the bytes that were parsed. The shared bounded
// reader performs every size, link, identity and stability check; this wrapper
// only records the bytes it reads.
export function readBoundedJsonWithDigest(filePath, { label = 'JSON file', fsApi = fs } = {}) {
    const chunks = [];
    const recording = {
        constants: fsApi.constants || fs.constants,
        lstatSync: (...args) => fsApi.lstatSync(...args),
        openSync: (...args) => fsApi.openSync(...args),
        fstatSync: (...args) => fsApi.fstatSync(...args),
        closeSync: (...args) => fsApi.closeSync(...args),
        readSync(descriptor, buffer, offset, length, position) {
            const count = fsApi.readSync(descriptor, buffer, offset, length, position);
            if (count > 0) chunks.push({ position, bytes: Buffer.from(buffer.subarray(offset, offset + count)) });
            return count;
        },
    };
    const parsed = viaSharedHelper(() => readBoundedJsonFile(filePath, { fsApi: recording, label }));
    let expectedPosition = 0;
    for (const chunk of chunks) {
        if (chunk.position !== expectedPosition) throw bundleError(`${label} read was not contiguous`);
        expectedPosition += chunk.bytes.length;
    }
    const body = Buffer.concat(chunks.map((chunk) => chunk.bytes));
    let reparsed;
    try {
        reparsed = JSON.parse(body.toString('utf8'));
    } catch (error) {
        throw bundleError(`${label} bytes could not be re-parsed`, error);
    }
    if (JSON.stringify(reparsed) !== JSON.stringify(parsed)) {
        throw bundleError(`${label} digest bytes differ from the parsed content`);
    }
    return Object.freeze({ value: parsed, sha256: crypto.createHash('sha256').update(body).digest('hex') });
}

function gitOutput(repositoryPath, args) {
    const result = spawnSync('git', ['-C', repositoryPath, ...args], {
        encoding: 'utf8',
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
    });
    if (result.error || result.status !== 0) {
        throw bundleError('unable to inspect the RoboTeam ownership in the Explorer repository', result.error);
    }
    return String(result.stdout || '').trim();
}

export function validateManifest(manifest) {
    assertPlainObject(manifest, 'release manifest');
    if (!Object.hasOwn(manifest, 'schemaVersion')) {
        throw bundleError('versionless legacy release manifests are not accepted; prepare a current '
            + `${MANIFEST_KIND} manifest with schemaVersion ${MANIFEST_SCHEMA_VERSION}`);
    }
    if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
        throw bundleError(`unsupported release manifest schemaVersion; only ${MANIFEST_SCHEMA_VERSION} is accepted`);
    }
    assertExactKeys(manifest, ['schemaVersion', 'kind', 'sourceInventory', 'images'], 'release manifest');
    if (manifest.kind !== MANIFEST_KIND) {
        throw bundleError(`release manifest kind must be ${MANIFEST_KIND}`);
    }
    assertExactKeys(manifest.sourceInventory, ['path', 'sha256'], 'release manifest sourceInventory');
    const inventoryPath = assertAbsoluteNormalizedPath(manifest.sourceInventory.path, 'source inventory path');
    const inventorySha256 = assertSha256(manifest.sourceInventory.sha256, 'source inventory sha256');
    assertExactKeys(manifest.images, ['ploinkyBox'], 'release manifest images');
    assertExactKeys(manifest.images.ploinkyBox, ['digest'], 'release manifest image ploinkyBox');
    const imageDigest = assertImageDigest(manifest.images.ploinkyBox.digest, 'ploinkyBox image digest');
    return Object.freeze({ inventoryPath, inventorySha256, imageDigest });
}

// A name that merely relabels another checkout as the retired AchillesCLI
// repository would let a stale consumer accept the wrong source.
function isRetiredCliAlias(name) {
    return name.toLowerCase().replace(/[^a-z0-9]/g, '') === 'achillescli';
}

export function validateInventory(inventory) {
    assertExactKeys(inventory, ['schemaVersion', 'kind', 'roboTeam', 'repositories'], 'source inventory');
    if (inventory.schemaVersion !== INVENTORY_SCHEMA_VERSION) {
        throw bundleError(`unsupported source inventory schemaVersion; only ${INVENTORY_SCHEMA_VERSION} is accepted`);
    }
    if (inventory.kind !== INVENTORY_KIND) {
        throw bundleError(`source inventory kind must be ${INVENTORY_KIND}`);
    }
    assertExactKeys(inventory.roboTeam, ['repository', 'path'], 'source inventory roboTeam');
    if (inventory.roboTeam.repository !== ROBOTEAM_OWNER.repository
        || inventory.roboTeam.path !== ROBOTEAM_OWNER.path) {
        throw bundleError(`RoboTeam is owned by ${ROBOTEAM_OWNER.repository}/${ROBOTEAM_OWNER.path}`);
    }
    assertPlainObject(inventory.repositories, 'source inventory repositories');
    const names = Object.keys(inventory.repositories).sort();
    if (names.length > MAX_REPOSITORIES) {
        throw bundleError(`source inventory exceeds ${MAX_REPOSITORIES} repositories`);
    }
    for (const required of CORE_REPOSITORIES) {
        if (!names.includes(required)) {
            throw bundleError(`source inventory must include the core repository ${required}`);
        }
    }
    const roots = new Set();
    const entries = [];
    for (const name of names) {
        if (!REPOSITORY_NAME_PATTERN.test(name)) {
            throw bundleError(`source inventory repository name ${JSON.stringify(name)} is not a valid identity`);
        }
        if (isRetiredCliAlias(name)) {
            throw bundleError('source inventory must not name an AchillesCLI repository; RoboTeam is owned by '
                + `${ROBOTEAM_OWNER.repository}/${ROBOTEAM_OWNER.path}`);
        }
        const entry = inventory.repositories[name];
        assertExactKeys(entry, ['root', 'commit', 'role'], `source inventory repository ${name}`);
        const root = assertAbsoluteNormalizedPath(entry.root, `${name} root`);
        const commit = assertExactSha(entry.commit, `${name} commit`);
        if (!REPOSITORY_ROLES.includes(entry.role)) {
            throw bundleError(`${name} role must be one of ${REPOSITORY_ROLES.join(', ')}`);
        }
        if (['ploinky', 'explorer'].includes(name) && entry.role !== 'deployed-source') {
            throw bundleError(`${name} must be a deployed-source`);
        }
        if (roots.has(root)) throw bundleError(`source inventory repeats the root of ${name}`);
        roots.add(root);
        entries.push(Object.freeze({ name, root, commit, role: entry.role }));
    }
    return Object.freeze(entries);
}

function verifyRoboTeamOwnership(explorerRoot, { fsApi = fs, git = gitOutput } = {}) {
    const directory = path.join(explorerRoot, ROBOTEAM_OWNER.path);
    let stat;
    try {
        stat = fsApi.lstatSync(directory);
    } catch (error) {
        throw bundleError(`Explorer does not contain ${ROBOTEAM_OWNER.path}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw bundleError(`Explorer ${ROBOTEAM_OWNER.path} must be a real directory`);
    }
    if (fsApi.realpathSync(directory) !== path.join(explorerRoot, ROBOTEAM_OWNER.path)) {
        throw bundleError(`Explorer ${ROBOTEAM_OWNER.path} must resolve inside the verified Explorer checkout`);
    }
    if (git(explorerRoot, ['cat-file', '-t', `HEAD:${ROBOTEAM_OWNER.path}`]) !== 'tree') {
        throw bundleError(`Explorer ${ROBOTEAM_OWNER.path} must be tracked at the verified commit`);
    }
}

function verifyInventoryRepositories(entries, {
    inspectRepository = readRepositoryState, fsApi = fs, git = gitOutput,
} = {}) {
    const realRoots = new Map();
    const repositories = {};
    for (const entry of entries) {
        const real = canonicalPath(entry.root, `${entry.name} root`, { fsApi });
        const owner = realRoots.get(real);
        if (owner) throw bundleError(`${entry.name} and ${owner} resolve to the same repository`);
        realRoots.set(real, entry.name);
        const state = viaSharedHelper(() => inspectRepository(real, { name: entry.name }));
        assertPlainObject(state, `${entry.name} repository state`);
        if (assertExactSha(state.head, `${entry.name} repository HEAD`) !== entry.commit) {
            throw bundleError(`${entry.name} installed HEAD does not match the source inventory`);
        }
        if (state.clean !== true) {
            throw bundleError(`${entry.name} repository has uncommitted or untracked content`);
        }
        repositories[entry.name] = Object.freeze({
            name: entry.name,
            repositoryPath: real,
            commit: entry.commit,
            role: entry.role,
        });
    }
    verifyRoboTeamOwnership(repositories.explorer.repositoryPath, { fsApi, git });
    return Object.freeze(repositories);
}

function verifyPloinkyDelivery(repositories, { readJson = readBoundedJsonFile } = {}) {
    const root = repositories.ploinky.repositoryPath;
    const rootPackage = viaSharedHelper(() => readJson(path.join(root, 'package.json'), { label: 'root package' }));
    const globalPackage = viaSharedHelper(() => readJson(
        path.join(root, 'globalDeps', 'package.json'),
        { label: 'globalDeps package' },
    ));
    viaSharedHelper(() => validateRootPackageInstaller({ rootPackage }));
    viaSharedHelper(() => validateAgentlibDeliveryMetadata({
        globalPackage,
        expectedCommit: repositories.achillesAgentLib.commit,
    }));
}

export function verifySourceInventory(inventoryPath, expectedSha256, options = {}) {
    const fsApi = options.fsApi || fs;
    assertAbsoluteNormalizedPath(inventoryPath, 'source inventory path');
    assertSha256(expectedSha256, 'expected source inventory sha256');
    canonicalPath(inventoryPath, 'source inventory path', { fsApi });
    const read = readBoundedJsonWithDigest(inventoryPath, { label: 'source inventory', fsApi });
    if (read.sha256 !== expectedSha256) {
        throw bundleError('source inventory SHA-256 does not match the reviewed hash');
    }
    const entries = validateInventory(read.value);
    const repositories = verifyInventoryRepositories(entries, options);
    for (const repository of Object.values(repositories)) {
        if (isInside(repository.repositoryPath, inventoryPath)) {
            throw bundleError(`source inventory must be stored outside the ${repository.name} source checkout`);
        }
    }
    verifyPloinkyDelivery(repositories, options);
    return Object.freeze({ sourceInventorySha256: read.sha256, repositories });
}

export function verifyReleaseBundle(manifest, options = {}) {
    const validated = validateManifest(manifest);
    const inventory = verifySourceInventory(validated.inventoryPath, validated.inventorySha256, options);
    return Object.freeze({
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        kind: MANIFEST_KIND,
        sourceInventorySha256: inventory.sourceInventorySha256,
        repositories: inventory.repositories,
        imageDigest: validated.imageDigest,
    });
}

export function verifyManifestFile(manifestPath, options = {}) {
    assertAbsoluteNormalizedPath(manifestPath, 'release manifest path');
    const manifest = readBoundedJsonWithDigest(manifestPath, {
        label: 'release manifest', fsApi: options.fsApi || fs,
    }).value;
    return verifyReleaseBundle(manifest, options);
}

export function writeManifestFile(input, options = {}) {
    const fsApi = options.fsApi || fs;
    assertExactKeys(input, ['inventoryPath', 'expectedInventorySha256', 'imageDigest', 'outputPath'], 'manifest writer input');
    const { inventoryPath, expectedInventorySha256, imageDigest, outputPath } = input;
    assertAbsoluteNormalizedPath(outputPath, 'manifest output path');
    assertImageDigest(imageDigest, 'ploinkyBox image digest');
    const manifest = {
        schemaVersion: MANIFEST_SCHEMA_VERSION,
        kind: MANIFEST_KIND,
        sourceInventory: { path: inventoryPath, sha256: expectedInventorySha256 },
        images: { ploinkyBox: { digest: imageDigest } },
    };
    // Validate everything first; a writer never repairs, filters or fetches sources.
    const verified = verifyReleaseBundle(manifest, options);
    let outputParent;
    try {
        outputParent = fsApi.realpathSync(path.dirname(outputPath));
    } catch (error) {
        throw bundleError('manifest output directory must exist', error);
    }
    for (const repository of Object.values(verified.repositories)) {
        if (isInside(repository.repositoryPath, outputParent)) {
            throw bundleError(`manifest output must be stored outside the ${repository.name} source checkout`);
        }
    }
    const constants = fsApi.constants || fs.constants;
    let descriptor;
    try {
        descriptor = fsApi.openSync(
            outputPath,
            constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0),
            0o600,
        );
    } catch (error) {
        throw bundleError(error?.code === 'EEXIST'
            ? 'manifest output already exists; the writer never overwrites'
            : 'unable to create the manifest output', error);
    }
    try {
        fsApi.fchmodSync(descriptor, 0o600);
        const body = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
        let offset = 0;
        while (offset < body.length) {
            offset += fsApi.writeSync(descriptor, body, offset, body.length - offset);
        }
        fsApi.fsyncSync(descriptor);
    } catch (error) {
        try { fsApi.unlinkSync(outputPath); } catch (_) {}
        throw bundleError('unable to write the manifest output', error);
    } finally {
        try { fsApi.closeSync(descriptor); } catch (_) {}
    }
    return Object.freeze({ outputPath, manifest, verified });
}

export function parseCommandLine(argv) {
    const [command, ...rest] = argv;
    const optionNames = {
        verify: { '--manifest': 'manifestPath' },
        write: {
            '--inventory': 'inventoryPath',
            '--inventory-sha256': 'expectedInventorySha256',
            '--image-digest': 'imageDigest',
            '--output': 'outputPath',
        },
    }[command];
    if (!optionNames) throw bundleError('usage: verify --manifest <abs> | write --inventory <abs> --inventory-sha256 <hex> --image-digest <sha256:hex> --output <abs>');
    const options = {};
    for (let index = 0; index < rest.length; index += 2) {
        const name = rest[index];
        const key = optionNames[name];
        const value = rest[index + 1];
        if (!key) throw bundleError(`unknown argument ${name}`);
        if (value === undefined || value.startsWith('--')) throw bundleError(`${name} requires a value`);
        if (Object.hasOwn(options, key)) throw bundleError(`${name} may be given only once`);
        options[key] = value;
    }
    const missing = Object.values(optionNames).filter((key) => !Object.hasOwn(options, key));
    if (missing.length) throw bundleError(`missing required options: ${missing.join(', ')}`);
    return Object.freeze({ command, ...options });
}

function describe(verified) {
    const identities = Object.values(verified.repositories)
        .map((repository) => `${repository.name}=${repository.commit} (${repository.role})`)
        .join(', ');
    return `Explorer release bundle verified (${verified.imageDigest}); source inventory sha256 ${verified.sourceInventorySha256}; ${identities}\n`;
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        const options = parseCommandLine(process.argv.slice(2));
        if (options.command === 'write') {
            const written = writeManifestFile({
                inventoryPath: options.inventoryPath,
                expectedInventorySha256: options.expectedInventorySha256,
                imageDigest: options.imageDigest,
                outputPath: options.outputPath,
            });
            process.stdout.write(`Wrote ${written.outputPath} (mode 0600). ${describe(written.verified)}`);
        } else {
            process.stdout.write(describe(verifyManifestFile(options.manifestPath)));
        }
    } catch (error) {
        process.stderr.write(`${error.message}\n`);
        process.exitCode = 1;
    }
}
