import { execFileSync } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { PLOINKY_DIR, PLOINKY_WORKSPACE_ROOT } from './config.js';

const DEFAULT_CATALOG_REPO_URL = 'https://github.com/AssistOS-AI/local-llm-architectures.git';
const DEFAULT_CATALOG_REF = 'main';
const DEFAULT_CACHE_DIR = path.join(PLOINKY_DIR, 'llm-catalog-cache');
const ARCH_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const SHA_DIGEST_RE = /^sha256:[a-f0-9]{64}$/;
const ALLOWED_PLATFORMS = ['linux/amd64', 'linux/arm64'];
const ALLOWED_ACCELERATORS = ['cpu', 'nvidia-cuda', 'amd-rocm', 'vulkan', 'intel-openvino'];
const ALLOWED_ENGINES = ['llamacpp', 'vllm', 'sglang', 'trtllm', 'openvino'];
const ALLOWED_CONTAINER_RUNTIMES = ['docker', 'podman'];
const ALLOWED_DEVICE_TYPES = ['cdi', 'hostDevice'];
const ALLOWED_HOST_DEVICE_PREFIXES = ['/dev/kfd', '/dev/dri', '/dev/accel'];
const ALLOWED_SECURITY_OPT = new Set(['label=disable', 'seccomp=unconfined']);
const ALLOWED_IPC = new Set(['default', 'host']);
const HOST_DEVICE_PATH_PATTERN = '^/dev/(?:kfd|dri(?:/(?!\\.{1,2}(?:/|$))[A-Za-z0-9._-]+)*|accel(?:/(?!\\.{1,2}(?:/|$))[A-Za-z0-9._-]+)*)$';
const HOST_DEVICE_PATH_RE = new RegExp(HOST_DEVICE_PATH_PATTERN);
const ARCHITECTURE_PATH_RE = /^architectures\/[A-Za-z0-9._-]+\.json$/;
const IMAGE_PATH_RE = /^images\/[A-Za-z0-9._-]+\.json$/;
const SAFE_RELATIVE_PATH_RE = /^[A-Za-z0-9._/-]+$/;
const SIZE_RE = /^[0-9]+[bkmgtBKMGT]?$/;
const CPU_RE = /^[0-9]+(\.[0-9]+)?$/;
const GPUS_RE = /^all$|^device=[A-Za-z0-9._,-]+$/;
const CDI_DEVICE_RE = /^[A-Za-z0-9._/-]+=([A-Za-z0-9._,-]+|all)$/;
const MAX_PIDS_LIMIT = 1048576;
const CATALOG_VALIDATION_CONTRACT = Object.freeze({
    catalogKeys: Object.freeze(['schemaVersion', 'catalogId', 'updatedAt', 'defaultFallback', 'architectures', 'images']),
    catalogEntryKeys: Object.freeze(['id', 'path']),
    architectureKeys: Object.freeze(['id', 'status', 'platform', 'accelerator', 'match', 'image', 'runtimePolicy', 'engineDefaults', 'fallbackPriority']),
    architectureStatuses: Object.freeze(['stable', 'experimental']),
    platforms: Object.freeze(ALLOWED_PLATFORMS.slice()),
    acceleratorKeys: Object.freeze(['family', 'minimumComputeCapability']),
    acceleratorFamilies: Object.freeze(ALLOWED_ACCELERATORS.slice()),
    matchKeys: Object.freeze(['requiredProbes', 'containerRuntimes']),
    containerRuntimes: Object.freeze(ALLOWED_CONTAINER_RUNTIMES.slice()),
    runtimePolicyKeys: Object.freeze(['platform', 'resources', 'devices', 'securityOpt', 'ipc', 'gpus']),
    resourceKeys: Object.freeze(['memory', 'cpus', 'pidsLimit', 'shmSize', 'ulimits']),
    ulimitKeys: Object.freeze(['memlock']),
    memlockKeys: Object.freeze(['soft', 'hard']),
    deviceKeys: Object.freeze(['type', 'value', 'hostPath']),
    deviceTypes: Object.freeze(ALLOWED_DEVICE_TYPES.slice()),
    hostDevicePrefixes: Object.freeze(ALLOWED_HOST_DEVICE_PREFIXES.slice()),
    hostDevicePathPattern: HOST_DEVICE_PATH_PATTERN,
    securityOpt: Object.freeze(Array.from(ALLOWED_SECURITY_OPT)),
    ipc: Object.freeze(Array.from(ALLOWED_IPC)),
    imageKeys: Object.freeze(['id', 'ref', 'digest', 'platform', 'engines', 'build']),
    imageRequiredKeys: Object.freeze(['id', 'ref', 'platform', 'engines', 'build']),
    imageEngines: Object.freeze(ALLOWED_ENGINES.slice()),
    imageBuildKeys: Object.freeze(['context', 'dockerfile', 'workflow', 'engineVersionsLock']),
    imageBuildRequiredKeys: Object.freeze(['context', 'dockerfile', 'workflow', 'engineVersionsLock']),
    engineDefaultKeys: Object.freeze(['enginePort', 'runtimePort']),
});

class CatalogValidationError extends Error {
    constructor(message, details = {}) {
        super(message);
        this.name = 'CatalogValidationError';
        this.code = 'PLOINKY_LLM_CATALOG_INVALID';
        Object.assign(this, details);
    }
}

function ensureObject(value, label) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new CatalogValidationError(`${label}: expected JSON object`);
    }
}

function ensureArray(value, label, { minItems = 0 } = {}) {
    if (!Array.isArray(value)) {
        throw new CatalogValidationError(`${label}: expected array`);
    }
    if (value.length < minItems) {
        throw new CatalogValidationError(`${label}: requires at least ${minItems} item(s)`);
    }
}

function rejectUnknownKeys(value, allowed, label) {
    for (const key of Object.keys(value || {})) {
        if (!allowed.has(key)) {
            throw new CatalogValidationError(`${label}: unknown field '${key}'`);
        }
    }
}

function ensureStringPattern(value, regex, label) {
    if (typeof value !== 'string' || !regex.test(value)) {
        throw new CatalogValidationError(`${label}: invalid value`);
    }
}

function ensureSafeRelativePath(value, label) {
    if (
        typeof value !== 'string'
        || value.length < 1
        || value.length > 256
        || path.isAbsolute(value)
        || value.includes('${')
        || value.split('/').some((segment) => segment.length === 0 || segment === '..')
        || !SAFE_RELATIVE_PATH_RE.test(value)
    ) {
        throw new CatalogValidationError(`${label}: invalid`);
    }
}

function ensureHostDevicePath(value, label) {
    if (typeof value !== 'string' || !value.startsWith('/dev/')) {
        throw new CatalogValidationError(`${label}: invalid host device path`);
    }
    const normalized = path.posix.normalize(value);
    if (normalized !== value || !HOST_DEVICE_PATH_RE.test(normalized)) {
        throw new CatalogValidationError(`${label}: invalid host device path`);
    }
}

function readJsonFile(filePath, label) {
    let raw;
    try {
        raw = fs.readFileSync(filePath, 'utf8');
    } catch (err) {
        throw new CatalogValidationError(`${label}: cannot read ${filePath}: ${err.message}`);
    }
    try {
        return JSON.parse(raw);
    } catch (err) {
        throw new CatalogValidationError(`${label}: invalid JSON in ${filePath}: ${err.message}`);
    }
}

function ensurePathInsideRoot(candidatePath, root, label) {
    const resolvedRoot = path.resolve(root);
    const resolvedCandidate = path.resolve(root, candidatePath);
    const relative = path.relative(resolvedRoot, resolvedCandidate);
    if (relative.startsWith('..') || path.isAbsolute(relative) || relative === '') {
        throw new CatalogValidationError(`${label}: path '${candidatePath}' escapes catalog root`);
    }
    return resolvedCandidate;
}

function validateRuntimePolicy(policy, label) {
    if (policy === undefined || policy === null) return null;
    ensureObject(policy, `${label}.runtimePolicy`);
    rejectUnknownKeys(policy, new Set(CATALOG_VALIDATION_CONTRACT.runtimePolicyKeys), `${label}.runtimePolicy`);

    if (policy.platform !== undefined && !ALLOWED_PLATFORMS.includes(policy.platform)) {
        throw new CatalogValidationError(`${label}.runtimePolicy.platform: unsupported`);
    }
    if (policy.resources !== undefined) {
        ensureObject(policy.resources, `${label}.runtimePolicy.resources`);
        rejectUnknownKeys(policy.resources, new Set(CATALOG_VALIDATION_CONTRACT.resourceKeys), `${label}.runtimePolicy.resources`);
        if (policy.resources.memory !== undefined) ensureStringPattern(policy.resources.memory, SIZE_RE, `${label}.runtimePolicy.resources.memory`);
        if (policy.resources.cpus !== undefined) ensureStringPattern(policy.resources.cpus, CPU_RE, `${label}.runtimePolicy.resources.cpus`);
        if (policy.resources.shmSize !== undefined) ensureStringPattern(policy.resources.shmSize, SIZE_RE, `${label}.runtimePolicy.resources.shmSize`);
        if (policy.resources.pidsLimit !== undefined) {
            if (!Number.isInteger(policy.resources.pidsLimit) || policy.resources.pidsLimit < 1 || policy.resources.pidsLimit > MAX_PIDS_LIMIT) {
                throw new CatalogValidationError(`${label}.runtimePolicy.resources.pidsLimit: invalid`);
            }
        }
        if (policy.resources.ulimits !== undefined) {
            ensureObject(policy.resources.ulimits, `${label}.runtimePolicy.resources.ulimits`);
            rejectUnknownKeys(policy.resources.ulimits, new Set(CATALOG_VALIDATION_CONTRACT.ulimitKeys), `${label}.runtimePolicy.resources.ulimits`);
            if (policy.resources.ulimits.memlock !== undefined) {
                const memlock = policy.resources.ulimits.memlock;
                ensureObject(memlock, `${label}.runtimePolicy.resources.ulimits.memlock`);
                rejectUnknownKeys(memlock, new Set(CATALOG_VALIDATION_CONTRACT.memlockKeys), `${label}.runtimePolicy.resources.ulimits.memlock`);
                if (!Number.isInteger(memlock.soft) || memlock.soft < -1) {
                    throw new CatalogValidationError(`${label}.runtimePolicy.resources.ulimits.memlock.soft: invalid`);
                }
                if (!Number.isInteger(memlock.hard) || memlock.hard < -1) {
                    throw new CatalogValidationError(`${label}.runtimePolicy.resources.ulimits.memlock.hard: invalid`);
                }
            }
        }
    }
    if (policy.devices !== undefined) {
        ensureArray(policy.devices, `${label}.runtimePolicy.devices`);
        for (const [idx, dev] of policy.devices.entries()) {
            const devLabel = `${label}.runtimePolicy.devices[${idx}]`;
            ensureObject(dev, devLabel);
            rejectUnknownKeys(dev, new Set(CATALOG_VALIDATION_CONTRACT.deviceKeys), devLabel);
            if (!ALLOWED_DEVICE_TYPES.includes(dev.type)) {
                throw new CatalogValidationError(`${devLabel}.type: unsupported`);
            }
            if (dev.type === 'cdi') {
                if (typeof dev.value !== 'string' || dev.value.length < 1 || dev.value.length > 200 || !CDI_DEVICE_RE.test(dev.value)) {
                    throw new CatalogValidationError(`${devLabel}.value: invalid CDI device`);
                }
            }
            if (dev.type === 'hostDevice') {
                ensureHostDevicePath(dev.hostPath, `${devLabel}.hostPath`);
            }
        }
    }
    if (policy.securityOpt !== undefined) {
        ensureArray(policy.securityOpt, `${label}.runtimePolicy.securityOpt`);
        for (const opt of policy.securityOpt) {
            if (!ALLOWED_SECURITY_OPT.has(opt)) {
                throw new CatalogValidationError(`${label}.runtimePolicy.securityOpt: unsupported value '${opt}'`);
            }
        }
    }
    if (policy.ipc !== undefined && !ALLOWED_IPC.has(policy.ipc)) {
        throw new CatalogValidationError(`${label}.runtimePolicy.ipc: unsupported`);
    }
    if (policy.gpus !== undefined) {
        if (typeof policy.gpus !== 'string' || !GPUS_RE.test(policy.gpus)) {
            throw new CatalogValidationError(`${label}.runtimePolicy.gpus: invalid`);
        }
    }
    return policy;
}

function validateArchitectureRecord(record, label) {
    ensureObject(record, label);
    rejectUnknownKeys(record, new Set(CATALOG_VALIDATION_CONTRACT.architectureKeys), label);

    ensureStringPattern(record.id, ARCH_ID_RE, `${label}.id`);
    if (!CATALOG_VALIDATION_CONTRACT.architectureStatuses.includes(record.status)) {
        throw new CatalogValidationError(`${label}.status: must be stable|experimental`);
    }
    if (!ALLOWED_PLATFORMS.includes(record.platform)) {
        throw new CatalogValidationError(`${label}.platform: unsupported`);
    }
    ensureObject(record.accelerator, `${label}.accelerator`);
    rejectUnknownKeys(record.accelerator, new Set(CATALOG_VALIDATION_CONTRACT.acceleratorKeys), `${label}.accelerator`);
    if (!ALLOWED_ACCELERATORS.includes(record.accelerator.family)) {
        throw new CatalogValidationError(`${label}.accelerator.family: unsupported`);
    }
    if (record.accelerator.minimumComputeCapability !== undefined) {
        if (typeof record.accelerator.minimumComputeCapability !== 'string' || record.accelerator.minimumComputeCapability.length > 16) {
            throw new CatalogValidationError(`${label}.accelerator.minimumComputeCapability: invalid`);
        }
    }
    if (record.match !== undefined) {
        ensureObject(record.match, `${label}.match`);
        rejectUnknownKeys(record.match, new Set(CATALOG_VALIDATION_CONTRACT.matchKeys), `${label}.match`);
        if (record.match.requiredProbes !== undefined) {
            ensureArray(record.match.requiredProbes, `${label}.match.requiredProbes`);
            for (const probe of record.match.requiredProbes) {
                if (typeof probe !== 'string' || !/^[a-z][a-zA-Z0-9_.-]{0,63}$/.test(probe)) {
                    throw new CatalogValidationError(`${label}.match.requiredProbes: invalid probe '${probe}'`);
                }
            }
        }
        if (record.match.containerRuntimes !== undefined) {
            ensureArray(record.match.containerRuntimes, `${label}.match.containerRuntimes`, { minItems: 1 });
            for (const runtime of record.match.containerRuntimes) {
                if (!ALLOWED_CONTAINER_RUNTIMES.includes(runtime)) {
                    throw new CatalogValidationError(`${label}.match.containerRuntimes: unsupported runtime '${runtime}'`);
                }
            }
        }
    }
    ensureStringPattern(record.image, ARCH_ID_RE, `${label}.image`);
    validateRuntimePolicy(record.runtimePolicy, label);
    if (record.engineDefaults !== undefined) {
        ensureObject(record.engineDefaults, `${label}.engineDefaults`);
        rejectUnknownKeys(record.engineDefaults, new Set(CATALOG_VALIDATION_CONTRACT.engineDefaultKeys), `${label}.engineDefaults`);
        for (const portField of ['enginePort', 'runtimePort']) {
            if (record.engineDefaults[portField] !== undefined) {
                const port = record.engineDefaults[portField];
                if (!Number.isInteger(port) || port < 1 || port > 65535) {
                    throw new CatalogValidationError(`${label}.engineDefaults.${portField}: invalid`);
                }
            }
        }
    }
    if (record.fallbackPriority !== undefined) {
        if (!Number.isInteger(record.fallbackPriority) || record.fallbackPriority < 0 || record.fallbackPriority > 1000) {
            throw new CatalogValidationError(`${label}.fallbackPriority: invalid`);
        }
    }
    return record;
}

function validateImageRecord(record, label) {
    ensureObject(record, label);
    rejectUnknownKeys(record, new Set(CATALOG_VALIDATION_CONTRACT.imageKeys), label);
    ensureStringPattern(record.id, ARCH_ID_RE, `${label}.id`);
    if (
        typeof record.ref !== 'string'
        || record.ref.length < 1
        || record.ref.length > 512
        || record.ref.includes('${')
    ) {
        throw new CatalogValidationError(`${label}.ref: invalid`);
    }
    if (record.digest !== undefined) {
        if (typeof record.digest !== 'string' || !SHA_DIGEST_RE.test(record.digest)) {
            throw new CatalogValidationError(`${label}.digest: must be sha256:<64 hex>`);
        }
    }
    if (!ALLOWED_PLATFORMS.includes(record.platform)) {
        throw new CatalogValidationError(`${label}.platform: unsupported`);
    }
    ensureArray(record.engines, `${label}.engines`, { minItems: 1 });
    const seenEngines = new Set();
    for (const engine of record.engines) {
        if (!ALLOWED_ENGINES.includes(engine)) {
            throw new CatalogValidationError(`${label}.engines: unsupported engine '${engine}'`);
        }
        if (seenEngines.has(engine)) {
            throw new CatalogValidationError(`${label}.engines: duplicate engine '${engine}'`);
        }
        seenEngines.add(engine);
    }
    ensureObject(record.build, `${label}.build`);
    rejectUnknownKeys(record.build, new Set(CATALOG_VALIDATION_CONTRACT.imageBuildKeys), `${label}.build`);
    for (const field of CATALOG_VALIDATION_CONTRACT.imageBuildKeys) {
        if (record.build[field] === undefined) {
            throw new CatalogValidationError(`${label}.build.${field}: required`);
        }
        ensureSafeRelativePath(record.build[field], `${label}.build.${field}`);
    }
    return record;
}

function validateCatalogRoot(catalog) {
    ensureObject(catalog, 'catalog.json');
    rejectUnknownKeys(catalog, new Set(CATALOG_VALIDATION_CONTRACT.catalogKeys), 'catalog.json');

    if (catalog.schemaVersion !== 1) {
        throw new CatalogValidationError('catalog.json.schemaVersion: must be 1');
    }
    if (typeof catalog.catalogId !== 'string' || catalog.catalogId.length < 1 || catalog.catalogId.length > 200) {
        throw new CatalogValidationError('catalog.json.catalogId: invalid');
    }
    if (catalog.updatedAt !== undefined) {
        if (typeof catalog.updatedAt !== 'string' || catalog.updatedAt.length > 64) {
            throw new CatalogValidationError('catalog.json.updatedAt: invalid');
        }
    }
    ensureArray(catalog.architectures, 'catalog.json.architectures', { minItems: 1 });
    ensureArray(catalog.images, 'catalog.json.images', { minItems: 1 });
    if (catalog.defaultFallback !== undefined) {
        ensureStringPattern(catalog.defaultFallback, ARCH_ID_RE, 'catalog.json.defaultFallback');
    }
    return catalog;
}

function validateCatalogEntry(entry, label, pathRegex) {
    ensureObject(entry, label);
    rejectUnknownKeys(entry, new Set(CATALOG_VALIDATION_CONTRACT.catalogEntryKeys), label);
    ensureStringPattern(entry.id, ARCH_ID_RE, `${label}.id`);
    ensureStringPattern(entry.path, pathRegex, `${label}.path`);
    return entry;
}

function readDirHashSnapshot(rootPath) {
    const entries = [];
    function walk(currentPath) {
        let dirEntries;
        try {
            dirEntries = fs.readdirSync(currentPath, { withFileTypes: true });
        } catch (_) {
            return;
        }
        for (const entry of dirEntries.sort((a, b) => a.name.localeCompare(b.name))) {
            const childPath = path.join(currentPath, entry.name);
            const relPath = path.relative(rootPath, childPath);
            if (entry.isDirectory()) {
                walk(childPath);
            } else if (entry.isFile()) {
                try {
                    const stat = fs.statSync(childPath);
                    entries.push(`${relPath}:${stat.size}:${Math.floor(stat.mtimeMs)}`);
                } catch (_) {
                    entries.push(`${relPath}:0:0`);
                }
            }
        }
    }
    walk(rootPath);
    return crypto.createHash('sha256').update(entries.join('\n')).digest('hex').slice(0, 16);
}

function readGitRef(catalogPath) {
    try {
        const head = execFileSync('git', ['-C', catalogPath, 'rev-parse', 'HEAD'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'ignore'],
        }).trim();
        if (/^[a-f0-9]{40}$/.test(head)) return head;
    } catch (_) {}
    return null;
}

function validateCatalogRepoUrl(repoUrl, label = 'PLOINKY_LLM_ARCHITECTURES_REPO') {
    if (!/^(https?:\/\/|git@|ssh:\/\/|file:\/\/)/.test(repoUrl)) {
        throw new CatalogValidationError(`${label}: unsupported URL scheme`);
    }
}

function catalogCacheKey(repoUrl, ref) {
    return crypto.createHash('sha256')
        .update(`${repoUrl}#${ref || DEFAULT_CATALOG_REF}`)
        .digest('hex')
        .slice(0, 16);
}

function runGit(args, label) {
    try {
        return execFileSync('git', args, {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        }).trim();
    } catch (err) {
        const stderr = err?.stderr ? String(err.stderr).trim() : '';
        const message = stderr || err.message || 'git command failed';
        throw new CatalogValidationError(`${label}: ${message}`, { cause: err });
    }
}

function hasGitCheckout(target) {
    return fs.existsSync(path.join(target, '.git'));
}

function remoteFetchFailureMessage(repoUrl, ref, cacheDir) {
    return [
        `Unable to fetch LLM architecture catalog from ${repoUrl}#${ref}.`,
        `Set PLOINKY_LLM_ARCHITECTURES_PATH to use a local catalog checkout,`,
        `or set PLOINKY_LLM_ARCHITECTURES_REPO/PLOINKY_LLM_ARCHITECTURES_REF to a reachable remote.`,
        `Cache directory: ${cacheDir}`,
    ].join(' ');
}

function initializeRemoteCheckout(target, repoUrl, ref) {
    fs.mkdirSync(target, { recursive: true });
    runGit(['-C', target, 'init', '--quiet'], `git init catalog cache`);
    runGit(['-C', target, 'remote', 'add', 'origin', repoUrl], `git remote add catalog origin`);
    runGit(['-C', target, 'fetch', '--quiet', '--depth', '1', 'origin', ref], `git fetch catalog ${ref}`);
    runGit(['-C', target, 'checkout', '--quiet', 'FETCH_HEAD'], `git checkout catalog ${ref}`);
}

function updateRemoteCheckout(target, repoUrl, ref) {
    runGit(['-C', target, 'remote', 'set-url', 'origin', repoUrl], `git remote set-url catalog origin`);
    runGit(['-C', target, 'fetch', '--quiet', '--depth', '1', 'origin', ref], `git fetch catalog ${ref}`);
    runGit(['-C', target, 'checkout', '--quiet', 'FETCH_HEAD'], `git checkout catalog ${ref}`);
}

function ensureRemoteCatalog({ repoUrl, ref, cacheDir, source }) {
    validateCatalogRepoUrl(repoUrl);
    const requestedRef = String(ref || DEFAULT_CATALOG_REF).trim() || DEFAULT_CATALOG_REF;
    fs.mkdirSync(cacheDir, { recursive: true });
    const target = path.join(cacheDir, catalogCacheKey(repoUrl, requestedRef));
    const hadCache = hasGitCheckout(target);
    const tmpTarget = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    try {
        if (hadCache) {
            updateRemoteCheckout(target, repoUrl, requestedRef);
        } else {
            fs.rmSync(tmpTarget, { recursive: true, force: true });
            initializeRemoteCheckout(tmpTarget, repoUrl, requestedRef);
            fs.rmSync(target, { recursive: true, force: true });
            fs.renameSync(tmpTarget, target);
        }
    } catch (err) {
        fs.rmSync(tmpTarget, { recursive: true, force: true });
        if (hadCache && hasGitCheckout(target)) {
            return {
                rootPath: target,
                source,
                repoUrl,
                requestedRef,
                cacheDir,
                fetchStatus: 'cached-after-fetch-failure',
            };
        }
        throw new CatalogValidationError(
            remoteFetchFailureMessage(repoUrl, requestedRef, cacheDir),
            { repoUrl, requestedRef, cacheDir, cause: err }
        );
    }

    return {
        rootPath: target,
        source,
        repoUrl,
        requestedRef,
        cacheDir,
        fetchStatus: 'updated',
    };
}

function resolveCatalogRootFromEnv(env, options = {}) {
    const explicitPath = String(env.PLOINKY_LLM_ARCHITECTURES_PATH || '').trim();
    const repoUrl = String(env.PLOINKY_LLM_ARCHITECTURES_REPO || '').trim();
    const requestedRef = String(env.PLOINKY_LLM_ARCHITECTURES_REF || '').trim()
        || String(options.defaultRef || DEFAULT_CATALOG_REF).trim()
        || DEFAULT_CATALOG_REF;
    const cacheDir = String(env.PLOINKY_LLM_CATALOG_CACHE_DIR || '').trim() || DEFAULT_CACHE_DIR;

    if (explicitPath) {
        const resolved = path.isAbsolute(explicitPath)
            ? explicitPath
            : path.resolve(PLOINKY_WORKSPACE_ROOT, explicitPath);
        return {
            rootPath: resolved,
            source: 'path',
            repoUrl: null,
            requestedRef: null,
            cacheDir,
            fetchStatus: 'not-needed',
        };
    }

    if (repoUrl) {
        return ensureRemoteCatalog({
            repoUrl,
            ref: requestedRef,
            cacheDir,
            source: 'git',
        });
    }

    const defaultRepoUrl = String(options.defaultRepoUrl || DEFAULT_CATALOG_REPO_URL).trim();
    return ensureRemoteCatalog({
        repoUrl: defaultRepoUrl,
        ref: requestedRef,
        cacheDir,
        source: 'default-remote',
    });
}

function loadCatalog(options = {}) {
    const env = options.env || process.env;
    const resolved = resolveCatalogRootFromEnv(env, {
        defaultRepoUrl: options.defaultRepoUrl || DEFAULT_CATALOG_REPO_URL,
        defaultRef: options.defaultRef || DEFAULT_CATALOG_REF,
    });
    const { rootPath, source, repoUrl, requestedRef, cacheDir, fetchStatus } = resolved;
    const resolvedRoot = path.resolve(rootPath);
    if (!fs.existsSync(resolvedRoot)) {
        throw new CatalogValidationError(`catalog path does not exist: ${resolvedRoot}`);
    }
    const catalogFile = path.join(resolvedRoot, 'catalog.json');
    const catalogRaw = readJsonFile(catalogFile, 'catalog.json');
    const catalog = validateCatalogRoot(catalogRaw);

    const architectures = new Map();
    for (const [idx, rawEntry] of catalog.architectures.entries()) {
        const entry = validateCatalogEntry(rawEntry, `catalog.json.architectures[${idx}]`, ARCHITECTURE_PATH_RE);
        const archPath = ensurePathInsideRoot(entry.path, resolvedRoot, `catalog.json.architectures[${entry.id}]`);
        const archRaw = readJsonFile(archPath, `architectures/${entry.id}`);
        const archRecord = validateArchitectureRecord(archRaw, `architectures/${entry.id}`);
        if (archRecord.id !== entry.id) {
            throw new CatalogValidationError(
                `architectures/${entry.id}: id field '${archRecord.id}' does not match catalog reference`
            );
        }
        if (architectures.has(archRecord.id)) {
            throw new CatalogValidationError(`architectures: duplicate id '${archRecord.id}'`);
        }
        architectures.set(archRecord.id, { ...archRecord, _sourcePath: archPath });
    }

    const images = new Map();
    for (const [idx, rawEntry] of catalog.images.entries()) {
        const entry = validateCatalogEntry(rawEntry, `catalog.json.images[${idx}]`, IMAGE_PATH_RE);
        const imgPath = ensurePathInsideRoot(entry.path, resolvedRoot, `catalog.json.images[${entry.id}]`);
        const imgRaw = readJsonFile(imgPath, `images/${entry.id}`);
        const imgRecord = validateImageRecord(imgRaw, `images/${entry.id}`);
        if (imgRecord.id !== entry.id) {
            throw new CatalogValidationError(
                `images/${entry.id}: id field '${imgRecord.id}' does not match catalog reference`
            );
        }
        if (images.has(imgRecord.id)) {
            throw new CatalogValidationError(`images: duplicate id '${imgRecord.id}'`);
        }
        images.set(imgRecord.id, { ...imgRecord, _sourcePath: imgPath });
    }

    for (const [archId, arch] of architectures) {
        const image = images.get(arch.image);
        if (!image) {
            throw new CatalogValidationError(`architectures/${archId}: references unknown image '${arch.image}'`);
        }
        if (image.platform && image.platform !== arch.platform) {
            throw new CatalogValidationError(
                `architectures/${archId}: image '${arch.image}' platform '${image.platform}' does not match architecture platform '${arch.platform}'`
            );
        }
        if (arch.runtimePolicy?.platform && arch.runtimePolicy.platform !== arch.platform) {
            throw new CatalogValidationError(
                `architectures/${archId}: runtimePolicy.platform '${arch.runtimePolicy.platform}' does not match architecture platform '${arch.platform}'`
            );
        }
    }
    if (catalog.defaultFallback && !architectures.has(catalog.defaultFallback)) {
        throw new CatalogValidationError(`catalog.json.defaultFallback: references unknown architecture '${catalog.defaultFallback}'`);
    }

    const gitRef = readGitRef(resolvedRoot);
    const snapshotHash = readDirHashSnapshot(resolvedRoot);
    const catalogRef = gitRef || requestedRef || `local:${snapshotHash}`;

    return {
        catalogId: catalog.catalogId,
        catalogRef,
        catalogRoot: resolvedRoot,
        source,
        repoUrl,
        requestedRef,
        cacheDir,
        fetchStatus,
        defaultFallback: catalog.defaultFallback || null,
        updatedAt: catalog.updatedAt || null,
        architectures,
        images,
    };
}

export {
    CATALOG_VALIDATION_CONTRACT,
    CatalogValidationError,
    DEFAULT_CATALOG_REF,
    DEFAULT_CATALOG_REPO_URL,
    loadCatalog,
    resolveCatalogRootFromEnv,
    validateArchitectureRecord,
    validateCatalogRoot,
    validateCatalogEntry,
    validateImageRecord,
    validateRuntimePolicy,
};
