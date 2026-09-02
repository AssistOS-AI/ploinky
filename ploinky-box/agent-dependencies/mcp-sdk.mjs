import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isInsideBox } from '../lib/boxMarker.mjs';
import {
    MCP_SDK_BUNDLE_PATH,
    readMcpSdkRepositoryFromLock,
    validateMcpSdkBundle,
} from '../mcp-sdk-bundle.mjs';

const SDK_NAME = 'mcp-sdk';
const LOCK_PATH = fileURLToPath(new URL('../dependencies.lock.json', import.meta.url));
const DEPENDENCY_FIELDS = ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies'];
const INSTALL_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepublish', 'preprepare', 'prepare', 'postprepare'];
const PROVIDED_PACKAGES_DIR = '.ploinky-provided';

function sdkError(message) {
    const error = new Error(message);
    error.code = 'PLOINKY_BOX_MCP_SDK_CACHE_FAILED';
    return error;
}

/** Only the immutable image bundle supplies the SDK inside a Box. */
export function activeBoxMcpSdkBundle({
    insideBox = isInsideBox(),
    sourceRoot = MCP_SDK_BUNDLE_PATH,
    lockPath = LOCK_PATH,
} = {}) {
    if (!insideBox) return null;
    return validateMcpSdkBundle({
        sourceRoot,
        expectedRepository: readMcpSdkRepositoryFromLock({ lockPath }),
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

function isSdkReference(spec, bundle) {
    const declared = githubDependency(spec);
    return (declared && declared.repository === githubDependency(bundle.repository.url)?.repository)
        || /^npm:mcp-sdk(?:@|$)/.test(String(spec));
}

function assertCompatibleSdkDeclaration(spec, bundle, source, field) {
    const declared = githubDependency(spec);
    const selected = githubDependency(bundle.repository.url);
    // #main is the historical global/agent declaration. It now selects the
    // image's locked revision, never a fresh moving Git checkout.
    if (!declared || declared.repository !== selected?.repository
        || !['main', bundle.repository.commit].includes(declared.ref)) {
        throw sdkError(`${source} overrides '${SDK_NAME}' in ${field}; the Box image supplies its locked MCP SDK. Remove the conflicting entry.`);
    }
}

function assertNoSdkOverrides(overrides, bundle, source) {
    if (!overrides || typeof overrides !== 'object') return;
    for (const [name, value] of Object.entries(overrides)) {
        if (/^mcp-sdk(?:@|$)/.test(name)
            || value === '$mcp-sdk'
            || (typeof value === 'string' && isSdkReference(value, bundle))) {
            throw sdkError(`${source} overrides the Box-provided '${SDK_NAME}'; remove the override.`);
        }
        assertNoSdkOverrides(value, bundle, source);
    }
}

/**
 * The npm input excludes the Box-provided package. Validate the unmerged
 * agent manifest too: dev/optional/peer declarations or aliases must not
 * silently shadow the one SDK selected by the Box image.
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
                assertCompatibleSdkDeclaration(spec, bundle, source, field);
                delete dependencies[name];
            } else if (isSdkReference(spec, bundle)) {
                throw sdkError(`${source} aliases the Box-provided '${SDK_NAME}' as '${name}' in ${field}; remove the duplicate dependency.`);
            }
        }
        normalized[field] = dependencies;
    }
    assertNoSdkOverrides(pkg.overrides, bundle, source);
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

export function boxMcpSdkStampSection(bundle) {
    if (!bundle) return null;
    return {
        schema: bundle.schema,
        repository: { ...bundle.repository },
        contentSha256: bundle.contentSha256,
    };
}

function sameSdkIdentity(actual, expected) {
    return actual?.schema === expected.schema
        && actual?.repository?.url === expected.repository.url
        && actual?.repository?.commit === expected.repository.commit
        && actual?.contentSha256 === expected.contentSha256;
}

/** Read-only admission checks validate bytes, not just a marker directory. */
export function boxMcpSdkCacheProblem(cachePath, stamp, bundle) {
    if (!bundle) return '';
    if (!sameSdkIdentity(stamp?.mcpSdk, bundle)) return 'Box MCP SDK stamp identity is missing or changed';
    try {
        const installed = validateMcpSdkBundle({
            sourceRoot: path.join(cachePath, 'node_modules', SDK_NAME),
            expectedRepository: bundle.repository,
        });
        if (!sameSdkIdentity(installed, bundle)) return 'Box MCP SDK cache does not match the image bundle';
    } catch (error) {
        return `Box MCP SDK cache is invalid: ${error.message}`;
    }
    return '';
}

/** Restore the image package after npm has pruned unlisted node_modules. */
export function finalizeBoxMcpSdkCache(cachePath, bundle) {
    if (!bundle) return;
    const source = validateMcpSdkBundle({
        sourceRoot: bundle.sourceRoot,
        expectedRepository: bundle.repository,
    });
    if (!sameSdkIdentity(source, bundle)) throw sdkError('The MCP SDK image bundle changed during cache preparation');
    const expectedStamp = { mcpSdk: boxMcpSdkStampSection(bundle) };
    if (!boxMcpSdkCacheProblem(cachePath, expectedStamp, bundle)) return;

    const destination = path.join(cachePath, 'node_modules', SDK_NAME);
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    const staging = `${destination}.${crypto.randomUUID()}.tmp`;
    try {
        // GNU cp preserves readable copies on macOS Podman bind mounts, where
        // fs.cpSync is not reliable. The writable cache remains mounted read-
        // only by agents; the immutable source bundle is never changed.
        for (const [command, args] of [
            ['cp', ['-a', source.sourceRoot, staging]],
            ['chmod', ['-R', 'u+w', staging]],
        ]) {
            const result = spawnSync(command, args, { stdio: 'pipe', encoding: 'utf8' });
            if (result.error || result.status !== 0) {
                throw sdkError(`MCP SDK cache ${command} failed (${result.status ?? result.error?.code ?? 'unknown'})`);
            }
        }
        const copied = validateMcpSdkBundle({ sourceRoot: staging, expectedRepository: bundle.repository });
        if (!sameSdkIdentity(copied, bundle)) throw sdkError('Copied MCP SDK does not match the immutable image bundle');
        fs.rmSync(destination, { recursive: true, force: true });
        fs.renameSync(staging, destination);
        const problem = boxMcpSdkCacheProblem(cachePath, expectedStamp, bundle);
        if (problem) throw sdkError(problem);
    } finally {
        fs.rmSync(staging, { recursive: true, force: true });
    }
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
        const provided = validateMcpSdkBundle({ sourceRoot: providedSdk, expectedRepository: bundle.repository });
        if (!sameSdkIdentity(provided, bundle)) throw sdkError('npm changed the provided MCP SDK image copy');
        // Runtime caches must be self-contained; no link to a temporary npm
        // input may survive outside their mounted node_modules directory.
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
