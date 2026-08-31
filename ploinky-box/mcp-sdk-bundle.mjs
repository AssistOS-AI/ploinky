#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const MCP_SDK_BUNDLE_SCHEMA = 'ploinky.box.mcp-sdk/v1';
export const MCP_SDK_BUNDLE_PATH = '/usr/local/lib/ploinky/mcp-sdk';
export const MCP_SDK_BUNDLE_METADATA_NAME = '.ploinky-box-mcp-sdk.json';
export const MCP_SDK_PACKAGE_NAME = '@modelcontextprotocol/sdk';

const PIN_PATTERN = /^[a-f0-9]{40}$/;
const HASH_PATTERN = /^[a-f0-9]{64}$/;

function bundleError(message, cause) {
    const error = new Error(message, cause ? { cause } : undefined);
    error.code = 'PLOINKY_BOX_MCP_SDK_BUNDLE_FAILED';
    return error;
}

function exactKeys(value, expected) {
    return value
        && typeof value === 'object'
        && !Array.isArray(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());
}

function assertRepository(repository) {
    if (!exactKeys(repository, ['commit', 'url'])
        || typeof repository.url !== 'string'
        || !repository.url.startsWith('https://github.com/')
        || !PIN_PATTERN.test(repository.commit)) {
        throw bundleError('MCP SDK bundle repository metadata is invalid');
    }
    return repository;
}

function assertRealDirectory(directory, fsApi) {
    let stat;
    try {
        stat = fsApi.lstatSync(directory);
    } catch (error) {
        throw bundleError(`MCP SDK bundle directory is missing: ${directory}`, error);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw bundleError(`MCP SDK bundle path is not a real directory: ${directory}`);
    }
}

function readJsonFile(filename, fsApi, description) {
    try {
        const stat = fsApi.lstatSync(filename);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
            throw bundleError(`${description} is not a regular file: ${filename}`);
        }
        return JSON.parse(fsApi.readFileSync(filename, 'utf8'));
    } catch (error) {
        if (error?.code === 'PLOINKY_BOX_MCP_SDK_BUNDLE_FAILED') throw error;
        throw bundleError(`Unable to read ${description}: ${filename}`, error);
    }
}

function readPackage(sourceRoot, fsApi) {
    const pkg = readJsonFile(path.join(sourceRoot, 'package.json'), fsApi, 'MCP SDK package.json');
    if (pkg?.name !== MCP_SDK_PACKAGE_NAME
        || typeof pkg.version !== 'string'
        || !pkg.version.trim()) {
        throw bundleError(`MCP SDK bundle must contain ${MCP_SDK_PACKAGE_NAME}`);
    }
    return pkg;
}

function assertNoRuntimeDependencies(pkg) {
    for (const field of ['dependencies', 'optionalDependencies', 'peerDependencies']) {
        const declared = pkg[field];
        if (declared !== undefined
            && (!declared || typeof declared !== 'object' || Array.isArray(declared)
                || Object.keys(declared).length > 0)) {
            throw bundleError(
                `Pinned MCP SDK declares ${field}; its image bundle contract must be extended first`,
            );
        }
    }
}

export function readMcpSdkRepositoryFromLock({ lockPath, fsApi = fs } = {}) {
    const lock = readJsonFile(lockPath, fsApi, 'Ploinky Box dependency lock');
    if (!exactKeys(lock, ['repositories'])
        || !exactKeys(lock.repositories, ['achillesAgentLib', 'mcp-sdk'])) {
        throw bundleError('Ploinky Box dependency lock has an unexpected repository set');
    }
    return Object.freeze({ ...assertRepository(lock.repositories['mcp-sdk']) });
}

export function fingerprintMcpSdkBundle(sourceRoot, fsApi = fs) {
    const root = path.resolve(sourceRoot);
    assertRealDirectory(root, fsApi);
    const hash = crypto.createHash('sha256');

    const visit = (directory, relativeDirectory = '') => {
        const names = fsApi.readdirSync(directory).sort();
        for (const name of names) {
            if (!relativeDirectory && name === MCP_SDK_BUNDLE_METADATA_NAME) continue;
            if (!relativeDirectory && name === '.git') {
                throw bundleError('MCP SDK image bundle must not contain Git metadata');
            }
            const absolute = path.join(directory, name);
            const relative = path.posix.join(relativeDirectory, name);
            const stat = fsApi.lstatSync(absolute);
            if (stat.isSymbolicLink()) {
                throw bundleError(`MCP SDK image bundle must not contain symlinks: ${relative}`);
            }
            if (stat.isDirectory()) {
                hash.update(`directory\0${relative}\0`);
                visit(absolute, relative);
                continue;
            }
            if (!stat.isFile() || stat.nlink !== 1) {
                throw bundleError(`MCP SDK image bundle contains a non-regular file: ${relative}`);
            }
            const bytes = fsApi.readFileSync(absolute);
            hash.update(`file\0${relative}\0${bytes.length}\0`);
            hash.update(bytes);
        }
    };

    visit(root);
    return hash.digest('hex');
}

export function createMcpSdkBundleMetadata({ sourceRoot, repository, fsApi = fs }) {
    const selectedRepository = assertRepository(repository);
    const pkg = readPackage(sourceRoot, fsApi);
    assertNoRuntimeDependencies(pkg);
    return Object.freeze({
        schema: MCP_SDK_BUNDLE_SCHEMA,
        repository: Object.freeze({ ...selectedRepository }),
        package: Object.freeze({ name: pkg.name, version: pkg.version }),
        contentSha256: fingerprintMcpSdkBundle(sourceRoot, fsApi),
    });
}

export function validateMcpSdkBundle({
    sourceRoot = MCP_SDK_BUNDLE_PATH,
    expectedRepository,
    fsApi = fs,
} = {}) {
    const root = path.resolve(sourceRoot);
    assertRealDirectory(root, fsApi);
    const metadata = readJsonFile(
        path.join(root, MCP_SDK_BUNDLE_METADATA_NAME),
        fsApi,
        'MCP SDK bundle metadata',
    );
    if (!exactKeys(metadata, ['contentSha256', 'package', 'repository', 'schema'])
        || metadata.schema !== MCP_SDK_BUNDLE_SCHEMA
        || !exactKeys(metadata.package, ['name', 'version'])
        || metadata.package.name !== MCP_SDK_PACKAGE_NAME
        || typeof metadata.package.version !== 'string'
        || !HASH_PATTERN.test(metadata.contentSha256)) {
        throw bundleError('MCP SDK bundle metadata has an invalid contract');
    }
    const repository = assertRepository(metadata.repository);
    if (expectedRepository
        && (repository.url !== expectedRepository.url
            || repository.commit !== expectedRepository.commit)) {
        throw bundleError('MCP SDK image bundle does not match the Ploinky dependency lock');
    }
    const pkg = readPackage(root, fsApi);
    assertNoRuntimeDependencies(pkg);
    if (pkg.name !== metadata.package.name || pkg.version !== metadata.package.version) {
        throw bundleError('MCP SDK bundle package metadata does not match its contract');
    }
    const observedFingerprint = fingerprintMcpSdkBundle(root, fsApi);
    if (observedFingerprint !== metadata.contentSha256) {
        throw bundleError('MCP SDK bundle content fingerprint does not match its contract');
    }
    return Object.freeze({
        schema: metadata.schema,
        repository: Object.freeze({ ...repository }),
        package: Object.freeze({ ...metadata.package }),
        contentSha256: metadata.contentSha256,
        sourceRoot: root,
    });
}

function defaultGit(args, { cwd, env = process.env } = {}) {
    const result = spawnSync('git', args, {
        cwd,
        env,
        encoding: 'utf8',
        maxBuffer: 1024 * 1024,
    });
    if (result.error || result.status !== 0) {
        const detail = String(result.stderr || result.stdout || result.error?.message || '').trim();
        throw bundleError(`git ${args[0]} failed while preparing the MCP SDK bundle${detail ? `: ${detail}` : ''}`);
    }
    return String(result.stdout || '').trim();
}

export function prepareMcpSdkBundle({
    sourceRoot,
    lockPath,
    fsApi = fs,
    git = defaultGit,
} = {}) {
    const root = path.resolve(sourceRoot);
    assertRealDirectory(root, fsApi);
    const repository = readMcpSdkRepositoryFromLock({ lockPath, fsApi });
    const toolEnvironment = {
        PATH: String(process.env.PATH || '/usr/local/bin:/usr/bin:/bin'),
        HOME: '/tmp/ploinky-mcp-sdk-build-home',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: '/dev/null',
    };
    const head = git(['-C', root, 'rev-parse', 'HEAD'], { cwd: root, env: toolEnvironment });
    if (head !== repository.commit) {
        throw bundleError(`MCP SDK checkout ${head || 'has no HEAD'}; expected ${repository.commit}`);
    }
    const dirty = git(['-C', root, 'status', '--porcelain=v1'], { cwd: root, env: toolEnvironment });
    if (dirty) throw bundleError('MCP SDK checkout is not clean');
    // Reject an unsupported package shape before changing the checked-out
    // source. Builder inputs remain inspectable when preparation fails.
    assertNoRuntimeDependencies(readPackage(root, fsApi));
    fsApi.rmSync(path.join(root, '.git'), { recursive: true, force: true });
    const metadata = createMcpSdkBundleMetadata({ sourceRoot: root, repository, fsApi });
    fsApi.writeFileSync(
        path.join(root, MCP_SDK_BUNDLE_METADATA_NAME),
        `${JSON.stringify(metadata)}\n`,
        { flag: 'wx', mode: 0o644 },
    );
    return validateMcpSdkBundle({ sourceRoot: root, expectedRepository: repository, fsApi });
}

function parseCli(argv) {
    const [operation, ...rest] = argv;
    const options = {};
    for (let index = 0; index < rest.length; index += 2) {
        const key = rest[index];
        const value = rest[index + 1];
        if (!key?.startsWith('--') || value === undefined) {
            throw bundleError('MCP SDK bundle command arguments are invalid');
        }
        options[key.slice(2)] = value;
    }
    if (!['prepare', 'verify'].includes(operation) || !options.source) {
        throw bundleError('Usage: mcp-sdk-bundle.mjs <prepare|verify> --source <path> [--lock <path>]');
    }
    if (operation === 'prepare' && !options.lock) {
        throw bundleError('MCP SDK bundle preparation requires --lock');
    }
    return { operation, options };
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        const { operation, options } = parseCli(process.argv.slice(2));
        const result = operation === 'prepare'
            ? prepareMcpSdkBundle({ sourceRoot: options.source, lockPath: options.lock })
            : validateMcpSdkBundle({ sourceRoot: options.source });
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        process.stderr.write(`ploinky-box MCP SDK bundle failed: ${error.message}\n`);
        process.exitCode = 1;
    }
}
