import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { isInsideBox } from '../lib/boxMarker.mjs';
import { BOX_IMAGE_ID_ENV } from '../../agentlib/contract.mjs';
import {
    MCP_SDK_BUNDLE_PATH,
    MCP_SDK_REPOSITORY_URL,
    assertMcpSdkTree,
    mcpSdkIdentity,
    readMcpSdkPackage,
    readMcpSdkProvenance,
} from '../mcp-sdk-bundle.mjs';

const SDK_NAME = 'mcp-sdk';
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];
const PROVIDED_PACKAGES_DIR = '.ploinky-provided';

/**
 * Runtime-owned completion record of a prepared cache: which supplied library
 * copies it holds, written only after a copy was staged and validated. It sits
 * at the cache root, outside the package the image produced.
 */
export const PROVIDED_LIBRARIES_RECORD_NAME = '.ploinky-provided-libraries.json';
export const PROVIDED_LIBRARIES_SCHEMA = 'ploinky.provided-libraries/v1';

function sdkError(message) {
    const error = new Error(message);
    error.code = 'PLOINKY_BOX_MCP_SDK_CACHE_FAILED';
    return error;
}

/**
 * Only the Box image supplies the SDK inside a Box. It is identified by the
 * outer Box image ID every process in the Box inherits; the package is checked,
 * never hashed, and no revision is compared.
 */
export function activeBoxMcpSdkBundle({
    insideBox = isInsideBox(),
    sourceRoot = MCP_SDK_BUNDLE_PATH,
    env = process.env,
    fsApi = fs,
} = {}) {
    if (!insideBox) return null;
    const identity = mcpSdkIdentity(env?.[BOX_IMAGE_ID_ENV]);
    const pkg = readMcpSdkPackage({ sourceRoot, fsApi });
    return Object.freeze({
        ...pkg,
        identity,
        provenance: readMcpSdkProvenance({ sourceRoot, fsApi }),
    });
}

function githubDependency(spec) {
    if (typeof spec !== 'string') return null;
    let normalized = spec.replace(/^git\+/, '');
    normalized = normalized.replace(/^github:/, 'https://github.com/');
    normalized = normalized.replace(/^(?:ssh:\/\/git@github\.com\/|git@github\.com:)/, 'https://github.com/');
    if (/^[\w.-]+\/[\w.-]+(?:#|$)/.test(normalized)) normalized = `https://github.com/${normalized}`;
    try {
        const url = new URL(normalized);
        if (url.protocol !== 'https:' || url.hostname !== 'github.com' || url.username || url.password || url.search) return null;
        return {
            repository: url.pathname.replace(/\.git$/, '').toLowerCase(),
            ref: url.hash.slice(1),
        };
    } catch {
        return null;
    }
}

const SDK_REPOSITORY = githubDependency(MCP_SDK_REPOSITORY_URL)?.repository;

// A spec that would make the `mcp-sdk` import resolve to another source: the
// MCPSDK repository itself or an `npm:mcp-sdk` alias. The upstream registry
// package `@modelcontextprotocol/sdk` is a different package and is unaffected.
function isSdkReference(spec) {
    const declared = githubDependency(spec);
    return (declared && declared.repository === SDK_REPOSITORY)
        || /^npm:mcp-sdk(?:@|$)/.test(String(spec));
}

function assertNoSdkOverrides(overrides, source) {
    if (!overrides || typeof overrides !== 'object') return;
    for (const [name, value] of Object.entries(overrides)) {
        if (/^mcp-sdk(?:@|$)/.test(name)
            || value === '$mcp-sdk'
            || (typeof value === 'string' && isSdkReference(value))) {
            throw sdkError(`${source} overrides the Box-provided '${SDK_NAME}'; remove the override.`);
        }
        assertNoSdkOverrides(value, source);
    }
}

/**
 * The npm input excludes the Box-provided package. A direct `mcp-sdk`
 * declaration is removed whatever ref it names: the package name selects the
 * image's copy, and no competing SDK is fetched. Validate the unmerged agent
 * manifest too: dev/optional/peer declarations, aliases and overrides must not
 * silently shadow the one SDK the Box image supplies.
 */
export function withoutBoxMcpSdk(pkg, {
    bundle = activeBoxMcpSdkBundle(),
    source = 'package.json',
} = {}) {
    if (!bundle || !pkg) return pkg;
    const normalized = { ...pkg };
    for (const field of DEPENDENCY_FIELDS) {
        if (!pkg[field]) continue;
        const dependencies = { ...pkg[field] };
        for (const [name, spec] of Object.entries(dependencies)) {
            if (name === SDK_NAME) {
                delete dependencies[name];
            } else if (isSdkReference(spec)) {
                throw sdkError(`${source} aliases the Box-provided '${SDK_NAME}' as '${name}' in ${field}; remove the duplicate dependency.`);
            }
        }
        normalized[field] = dependencies;
    }
    assertNoSdkOverrides(pkg.overrides, source);
    for (const field of ['bundledDependencies', 'bundleDependencies']) {
        if (Array.isArray(pkg[field]) && pkg[field].includes(SDK_NAME)) {
            normalized[field] = pkg[field].filter((name) => name !== SDK_NAME);
        }
    }
    if (pkg.peerDependenciesMeta && Object.hasOwn(pkg.peerDependenciesMeta, SDK_NAME)) {
        normalized.peerDependenciesMeta = { ...pkg.peerDependenciesMeta };
        delete normalized.peerDependenciesMeta[SDK_NAME];
    }
    return normalized;
}

export function needsNpmInstall(pkg) {
    return DEPENDENCY_FIELDS.some((field) => Object.keys(pkg?.[field] || {}).length > 0)
        || INSTALL_SCRIPTS.some((name) => typeof pkg?.scripts?.[name] === 'string');
}

/** The SDK provider identity of a dependency plan: the supplying image and the library. */
export function boxMcpSdkStampSection(bundle) {
    if (!bundle) return null;
    return { ...bundle.identity };
}

function completionRecordFor(bundle) {
    return { schema: PROVIDED_LIBRARIES_SCHEMA, providedLibraries: { [SDK_NAME]: { ...bundle.identity } } };
}

function readCompletionRecord(cachePath) {
    const file = path.join(cachePath, PROVIDED_LIBRARIES_RECORD_NAME);
    try {
        const stat = fs.lstatSync(file);
        if (stat.isSymbolicLink() || !stat.isFile()) return null;
        return JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
        return null;
    }
}

/**
 * Carry a seed's completion record next to the SDK copy that was copied with
 * it. The record is a claim, not proof: admission still requires it to name the
 * supplying image the contract names, and the copy to be a usable package.
 */
export function carryBoxMcpSdkRecord(fromCacheRoot, toCacheRoot) {
    const source = path.join(fromCacheRoot, PROVIDED_LIBRARIES_RECORD_NAME);
    try {
        const stat = fs.lstatSync(source);
        if (stat.isSymbolicLink() || !stat.isFile()) return false;
        fs.copyFileSync(source, path.join(toCacheRoot, PROVIDED_LIBRARIES_RECORD_NAME));
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}

function sameCompletion(actual, bundle) {
    return JSON.stringify(canonicalRecord(actual)) === JSON.stringify(canonicalRecord(completionRecordFor(bundle)));
}

function canonicalRecord(record) {
    if (!record || typeof record !== 'object') return null;
    const sdk = record.providedLibraries?.[SDK_NAME];
    return {
        schema: record.schema,
        providedLibraries: { [SDK_NAME]: sdk && typeof sdk === 'object'
            ? { kind: sdk.kind, library: sdk.library, supplyingImageId: sdk.supplyingImageId }
            : null },
    };
}

/**
 * Read-only admission check of a prepared cache: its completion record names
 * this supplying image, and the copy is a usable package with a plain file
 * tree (no symlinks, Git metadata, hard links or special files). The record
 * proves a copy finished; it is not a digest and no bytes are compared.
 */
export function boxMcpSdkCacheProblem(cachePath, bundle) {
    if (!bundle) return '';
    if (!sameCompletion(readCompletionRecord(cachePath), bundle)) {
        return 'Box MCP SDK completion record is missing or names another supplying image';
    }
    try {
        const installed = path.join(cachePath, 'node_modules', SDK_NAME);
        readMcpSdkPackage({ sourceRoot: installed });
        assertMcpSdkTree(installed);
    } catch (error) {
        return `Box MCP SDK cache is invalid: ${error.message}`;
    }
    return '';
}

function writeCompletionRecord(cachePath, bundle) {
    const file = path.join(cachePath, PROVIDED_LIBRARIES_RECORD_NAME);
    const staging = `${file}.${crypto.randomUUID()}.tmp`;
    try {
        fs.writeFileSync(staging, `${JSON.stringify(completionRecordFor(bundle))}\n`, { flag: 'wx', mode: 0o644 });
        fs.renameSync(staging, file);
    } finally {
        fs.rmSync(staging, { force: true });
    }
}

/**
 * Restore the image package after npm has pruned unlisted node_modules. A copy
 * is fresh when its completion record names this supplying image; anything else
 * is recopied through owned staging, and the record is written last.
 */
export function finalizeBoxMcpSdkCache(cachePath, bundle) {
    if (!bundle) return;
    let source;
    try {
        source = readMcpSdkPackage({ sourceRoot: bundle.sourceRoot });
    } catch (error) {
        throw sdkError(`The MCP SDK supplied by the Box image is unusable: ${error.message}`);
    }
    if (!boxMcpSdkCacheProblem(cachePath, bundle)) return;

    const destination = path.join(cachePath, 'node_modules', SDK_NAME);
    const recordPath = path.join(cachePath, PROVIDED_LIBRARIES_RECORD_NAME);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const token = crypto.randomUUID();
    const staging = `${destination}.${token}.tmp`;
    const backup = `${destination}.${token}.bak`;
    let backedUp = false;
    let priorRecord = null;
    let swapped = false;
    try {
        // GNU cp preserves readable copies on macOS Podman bind mounts, where
        // fs.cpSync is not reliable. The writable cache remains mounted read-
        // only by agents; the immutable source package is never changed.
        for (const [command, args] of [
            ['cp', ['-a', source.sourceRoot, staging]],
            ['chmod', ['-R', 'u+w', staging]],
        ]) {
            const result = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf8' });
            if (result.error || result.status !== 0) {
                throw sdkError(`MCP SDK cache ${command} failed (${result.status ?? result.error?.code ?? 'unknown'})`);
            }
        }
        try {
            readMcpSdkPackage({ sourceRoot: staging });
            assertMcpSdkTree(staging);
        } catch (error) {
            throw sdkError(`Copied MCP SDK is not a usable package: ${error.message}`);
        }
        // The prior state stays available until the new copy is complete. A
        // copy in progress must never read as complete, so the record goes
        // first, and it is written back only after the swap succeeded.
        try { priorRecord = fs.readFileSync(recordPath); } catch { priorRecord = null; }
        if (fs.existsSync(destination) || isLink(destination)) {
            fs.renameSync(destination, backup);
            backedUp = true;
        }
        fs.rmSync(recordPath, { force: true });
        fs.renameSync(staging, destination);
        swapped = true;
        writeCompletionRecord(cachePath, bundle);
        const problem = boxMcpSdkCacheProblem(cachePath, bundle);
        if (problem) throw sdkError(problem);
    } catch (error) {
        // Bounded rollback: put back the previous copy and its record.
        if (swapped || backedUp) {
            try {
                if (swapped) fs.rmSync(destination, { recursive: true, force: true });
                if (backedUp) fs.renameSync(backup, destination);
                backedUp = false;
                if (priorRecord !== null) fs.writeFileSync(recordPath, priorRecord);
                else fs.rmSync(recordPath, { force: true });
            } catch { /* the next call sees a miss and recopies */ }
        }
        throw error;
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
        if (backedUp) fs.rmSync(backup, { recursive: true, force: true });
    }
}

function isLink(target) {
    try { return fs.lstatSync(target).isSymbolicLink(); } catch { return false; }
}

/**
 * npm prunes extraneous packages before running lifecycle scripts. During an
 * install, let npm link the prepared image package locally so those scripts
 * can import it. The reserved override also redirects transitive SDK requests
 * to that same local source. No SDK registry/Git resolution is involved.
 */
export function installWithBoxMcpSdk(cachePath, pkg, bundle, install) {
    if (!bundle) return install(cachePath);
    const providedRoot = path.join(cachePath, PROVIDED_PACKAGES_DIR);
    const providedSdk = path.join(providedRoot, 'node_modules', SDK_NAME);
    const packagePath = path.join(cachePath, 'package.json');
    const localPackage = {
        ...pkg,
        dependencies: {
            ...pkg.dependencies,
            [SDK_NAME]: `file:${PROVIDED_PACKAGES_DIR}/node_modules/${SDK_NAME}`,
        },
        overrides: { ...pkg.overrides, [SDK_NAME]: `$${SDK_NAME}` },
    };
    try {
        finalizeBoxMcpSdkCache(providedRoot, bundle);
        fs.writeFileSync(packagePath, JSON.stringify(localPackage, null, 2));
        install(cachePath, { linkBoxMcpSdk: true });
        try {
            readMcpSdkPackage({ sourceRoot: providedSdk });
        } catch (error) {
            throw sdkError(`npm removed or damaged the provided MCP SDK copy: ${error.message}`);
        }
        // Runtime caches must be self-contained; no link to a temporary npm
        // input may survive outside their mounted node_modules directory. This
        // preparation wrote no completion record at the cache root, so one found
        // there came from npm or a lifecycle script: it never lets the copy that
        // is published skip the fresh copy from the image.
        fs.rmSync(path.join(cachePath, PROVIDED_LIBRARIES_RECORD_NAME), { force: true });
        finalizeBoxMcpSdkCache(cachePath, bundle);
        assertNoProvidedSdkLinks(path.join(cachePath, 'node_modules'), providedRoot);
    } finally {
        fs.writeFileSync(packagePath, JSON.stringify(pkg, null, 2));
        fs.rmSync(providedRoot, { recursive: true, force: true });
    }
}

function assertNoProvidedSdkLinks(directory, providedRoot) {
    for (const name of fs.readdirSync(directory)) {
        const entry = path.join(directory, name);
        const stat = fs.lstatSync(entry);
        if (stat.isSymbolicLink()) {
            const target = path.resolve(directory, fs.readlinkSync(entry));
            if (target === providedRoot || target.startsWith(`${providedRoot}${path.sep}`)) {
                throw sdkError(`npm left a duplicate link to the temporary MCP SDK source at ${entry}`);
            }
        } else if (stat.isDirectory()) {
            assertNoProvidedSdkLinks(entry, providedRoot);
        }
    }
}
