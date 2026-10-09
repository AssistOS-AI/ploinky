import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { readBoxWorkspaceRoot } from '../../../ploinky-box/contract/workspace-root.mjs';
import {
    assertNoRetiredControllerSecrets,
    readWorkspaceMasterKey,
    workspaceMasterKeyPath,
} from '../../../ploinky-box/entrypoint/initialize-workspace.mjs';
import { isInsideBox } from '../../../ploinky-box/lib/boxMarker.mjs';

const MASTER_KEY_VAR = 'PLOINKY_MASTER_KEY';
const GENERATED_MASTER_KEY_FILE = 'master-key';

let generatedFallbackWarningEmitted = false;
// The Box marker is image content and never disappears at runtime, so a
// positive result is kept for the process. A negative result is re-checked,
// which keeps resolution outside the Box exactly as it was.
let boxMarkerObserved = false;

function parseKeyValueText(raw = '') {
    const result = {};
    const lines = String(raw || '').split(/\r?\n/);
    for (const line of lines) {
        let trimmed = String(line || '').trim();
        if (!trimmed || trimmed.startsWith('#')) {
            continue;
        }
        if (trimmed.startsWith('export ')) {
            trimmed = trimmed.slice('export '.length).trim();
        }
        const eqIndex = trimmed.indexOf('=');
        let key = '';
        let value = '';
        if (eqIndex >= 0) {
            key = trimmed.slice(0, eqIndex).trim();
            value = trimmed.slice(eqIndex + 1).trim();
        } else {
            const spaceMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s+(.*)$/);
            if (!spaceMatch) {
                continue;
            }
            key = spaceMatch[1];
            value = spaceMatch[2].trim();
        }
        if ((value.startsWith('"') && value.endsWith('"'))
            || (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        if (key) {
            result[key] = value;
        }
    }
    return result;
}

function parseKeyValueFile(filePath) {
    try {
        return parseKeyValueText(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
        return {};
    }
}

function findEnvFile(startDir = process.cwd()) {
    let current = path.resolve(startDir);
    const { root } = path.parse(current);
    while (true) {
        const candidate = path.join(current, '.env');
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        if (current === root) {
            return null;
        }
        current = path.dirname(current);
    }
}

function loadEnvFile(startDir = process.cwd()) {
    const envPath = findEnvFile(startDir);
    return envPath ? parseKeyValueFile(envPath) : {};
}

function resolveGeneratedMasterKeyRoot(startDir = process.cwd()) {
    const explicitRoot = String(process.env.PLOINKY_WORKSPACE_ROOT || '').trim();
    if (explicitRoot) {
        const normalizedExplicit = path.resolve(explicitRoot);
        try {
            if (fs.statSync(normalizedExplicit).isDirectory()) {
                return normalizedExplicit;
            }
        } catch (_) { }
    }

    let current = path.resolve(startDir);
    while (true) {
        try {
            if (fs.statSync(path.join(current, '.ploinky')).isDirectory()) {
                return current;
            }
        } catch (_) { }

        const parent = path.dirname(current);
        if (parent === current) {
            return path.resolve(startDir);
        }
        current = parent;
    }
}

// Inside the agent-masked controller-state root, like the managed Box key.
function resolveGeneratedMasterKeyPath(startDir = process.cwd()) {
    return path.join(resolveGeneratedMasterKeyRoot(startDir), '.ploinky', 'data', GENERATED_MASTER_KEY_FILE);
}

function readGeneratedMasterKeySeed(filePath) {
    try {
        const raw = String(fs.readFileSync(filePath, 'utf8') || '').trim();
        return raw || '';
    } catch (_) {
        return '';
    }
}

function writeGeneratedMasterKeySeed(filePath) {
    const generated = crypto.randomBytes(32).toString('hex');
    fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
    try {
        fs.writeFileSync(filePath, `${generated}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        try { fs.chmodSync(filePath, 0o600); } catch (_) { }
        return generated;
    } catch (error) {
        if (error?.code === 'EEXIST') {
            for (let attempt = 0; attempt < 50; attempt += 1) {
                const existing = readGeneratedMasterKeySeed(filePath);
                if (existing) {
                    return existing;
                }
                const waitBuffer = new SharedArrayBuffer(4);
                Atomics.wait(new Int32Array(waitBuffer), 0, 0, 10);
            }
            throw new Error(`Generated master key file exists but is empty: ${filePath}`);
        }
        throw error;
    }
}

function resolveGeneratedMasterKeySeed(startDir = process.cwd()) {
    const filePath = resolveGeneratedMasterKeyPath(startDir);
    const existing = readGeneratedMasterKeySeed(filePath);
    if (existing) {
        return { seed: existing, filePath, source: 'existing generated fallback' };
    }
    try {
        return {
            seed: writeGeneratedMasterKeySeed(filePath),
            filePath,
            source: 'generated fallback',
        };
    } catch (error) {
        throw new Error(
            `Unable to persist generated workspace master key at ${filePath}: ${error?.message || String(error)}`,
            { cause: error },
        );
    }
}

function warnGeneratedFallback({ purpose, source, filePath }) {
    if (generatedFallbackWarningEmitted) {
        return;
    }
    generatedFallbackWarningEmitted = true;
    console.error(
        `[ploinky] ${MASTER_KEY_VAR} is not set for ${purpose}; using ${source} at ${filePath}.`
        + ` Set ${MASTER_KEY_VAR} in the process environment or a walked-up .env for an operator-managed key.`
    );
}

function insideBoxForProcess() {
    if (boxMarkerObserved) return true;
    const inside = isInsideBox();
    if (inside === true) boxMarkerObserved = true;
    return inside;
}

function usesManagedWorkspaceMasterKey(managedBox) {
    return managedBox === undefined ? insideBoxForProcess() : Boolean(managedBox);
}

function sanitizeManagedMasterKeyEnvironment(environment, { managedBox } = {}) {
    const resolved = { ...environment };
    if (usesManagedWorkspaceMasterKey(managedBox)) delete resolved[MASTER_KEY_VAR];
    return resolved;
}

function resolveMasterKeySeed({
    purpose = 'Ploinky encrypted storage',
    startDir = process.cwd(),
    managedBox,
    workspaceRoot,
} = {}) {
    if (usesManagedWorkspaceMasterKey(managedBox)) {
        // The managed Box owns one host-selected workspace mount. Never walk
        // from cwd: a nested application directory must not shadow this key.
        return readWorkspaceMasterKey({ workspaceRoot: workspaceRoot || readBoxWorkspaceRoot(process.env) }).key;
    }
    assertNoRetiredControllerSecrets(resolveGeneratedMasterKeyRoot(startDir));
    let raw = String(process.env[MASTER_KEY_VAR] || '').trim();
    if (!raw) {
        // Walk up from cwd looking for a .env that defines the master key.
        // Operators frequently keep a single .env in a parent directory that
        // shadows multiple workspaces, so this matches that workflow.
        raw = String(loadEnvFile(startDir)[MASTER_KEY_VAR] || '').trim();
    }
    if (!raw) {
        const fallback = resolveGeneratedMasterKeySeed(startDir);
        raw = fallback.seed;
        warnGeneratedFallback({ purpose, ...fallback });
    }
    return raw;
}

function resolveMasterKey({
    purpose = 'Ploinky encrypted storage',
    startDir = process.cwd(),
    managedBox,
    workspaceRoot,
} = {}) {
    const raw = resolveMasterKeySeed({ purpose, startDir, managedBox, workspaceRoot });
    return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

// HKDF-SHA256 subkey derivation. Every per-purpose secret in Ploinky must be
// derived from the master key via this function rather than using master bytes
// directly. Domain separation is carried in the `info` parameter so that
// rotating one purpose (by bumping its version segment) cannot collide with
// another. Empty salt is fine because the master key is already a
// SHA-256 digest of the resolved workspace seed.
//
// Inside the Box the master key file is read through every check of
// readWorkspaceMasterKey only when the cache misses or the key's stamp
// changes. The stamp covers the workspace root, the key file's lstat and the
// three state directories readWorkspaceMasterKey fingerprints, and it is
// re-checked at most once per revalidateMs. The master key itself is never
// retained: the IKM exists only while a missing subkey is computed and is
// zero-filled afterwards. Outside the Box nothing is cached, because the
// environment and .env seeds may change between calls.
function directoryStamp(target, fsApi, { physical = false } = {}) {
    const stat = physical ? fsApi.lstatSync(target) : fsApi.statSync(target);
    return `${stat.dev}:${stat.ino}:${stat.mode}`;
}

function managedMasterKeyStamp(workspaceRoot, fsApi) {
    const keyPath = workspaceMasterKeyPath(workspaceRoot);
    const controllerStateDirectory = path.dirname(keyPath);
    const stateDirectory = path.dirname(controllerStateDirectory);
    // Same inspection as readWorkspaceMasterKey: stat for the workspace root
    // and .ploinky, lstat for the controller-state directory and the key.
    const parts = [
        workspaceRoot,
        directoryStamp(workspaceRoot, fsApi),
        directoryStamp(stateDirectory, fsApi),
        directoryStamp(controllerStateDirectory, fsApi, { physical: true }),
    ];
    const key = fsApi.lstatSync(keyPath);
    parts.push([key.dev, key.ino, key.size, key.mode, key.mtimeMs, key.ctimeMs].join(':'));
    // readWorkspaceMasterKey refuses retired secrets next to the key on every
    // read; keep refusing them while subkeys are served from the cache.
    assertNoRetiredControllerSecrets(workspaceRoot, fsApi);
    return JSON.stringify(parts);
}

function createSubkeyDeriver({
    isManaged,
    workspaceRoot,
    fsApi = fs,
    revalidateMs = 1000,
    maxEntries = 256,
    now = Date.now,
} = {}) {
    const cache = new Map();
    let stamp = null;
    let checkedAt = 0;

    function clear() {
        for (const subkey of cache.values()) subkey.fill(0);
        cache.clear();
        stamp = null;
    }

    function managed() {
        if (typeof isManaged === 'function') return Boolean(isManaged());
        return usesManagedWorkspaceMasterKey(isManaged);
    }

    function currentStamp() {
        const root = workspaceRoot || readBoxWorkspaceRoot(process.env);
        try {
            return { root, value: managedMasterKeyStamp(root, fsApi) };
        } catch (error) {
            // Fail with the error a fresh read reports (its result is discarded).
            readWorkspaceMasterKey({ workspaceRoot: root, fsApi });
            throw error;
        }
    }

    function adopt(next) {
        if (next.value !== stamp) {
            clear();
            stamp = next.value;
        }
        checkedAt = now();
    }

    function revalidateIfDue() {
        const current = now();
        if (stamp !== null && current >= checkedAt && current - checkedAt < revalidateMs) return;
        try {
            adopt(currentStamp());
        } catch (error) {
            clear();
            throw error;
        }
    }

    function remember(cacheKey, subkey) {
        while (cache.size >= Math.max(1, maxEntries)) {
            const [oldestKey, oldest] = cache.entries().next().value;
            oldest.fill(0);
            cache.delete(oldestKey);
        }
        cache.set(cacheKey, Buffer.from(subkey));
    }

    function deriveManaged(trimmedPurpose, length, info) {
        revalidateIfDue();
        const cacheable = Number.isSafeInteger(length);
        const cacheKey = `${trimmedPurpose}|${length}`;
        const cached = cacheable ? cache.get(cacheKey) : undefined;
        if (cached) {
            cache.delete(cacheKey);
            cache.set(cacheKey, cached);
            return Buffer.from(cached);
        }

        let ikm;
        let stable = false;
        try {
            const before = currentStamp();
            adopt(before);
            const seed = readWorkspaceMasterKey({ workspaceRoot: before.root, fsApi }).key;
            ikm = crypto.createHash('sha256').update(seed, 'utf8').digest();
            stable = currentStamp().value === before.value;
            // A key replaced while it was read: serve this result once, cache nothing.
            if (!stable) clear();
        } catch (error) {
            ikm?.fill(0);
            clear();
            throw error;
        }
        try {
            const subkey = Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, length));
            if (cacheable && stable) remember(cacheKey, subkey);
            return subkey;
        } finally {
            ikm.fill(0);
        }
    }

    function derive(purpose, length = 32) {
        const trimmedPurpose = String(purpose || '').trim();
        if (!trimmedPurpose) {
            throw new Error('deriveSubkey: purpose is required');
        }
        const info = Buffer.from(`ploinky/${trimmedPurpose}/v1`, 'utf8');
        if (managed()) {
            return deriveManaged(trimmedPurpose, length, info);
        }
        const ikm = resolveMasterKey({ purpose: `subkey:${trimmedPurpose}`, managedBox: false });
        const salt = Buffer.alloc(0);
        return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
    }

    return Object.freeze({
        derive,
        clear,
        cacheSize: () => cache.size,
    });
}

const defaultSubkeyDeriver = createSubkeyDeriver();

// The subkey deriveSubkey() returns for `purpose` when the master seed is
// `seed`: the same IKM (SHA-256 of the seed), empty salt and info. Callers that
// resolved the seed themselves (for example to key a memo on its identity)
// derive from exactly that seed instead of resolving it a second time.
function deriveSubkeyFromSeed(seed, purpose, length = 32) {
    const trimmedPurpose = String(purpose || '').trim();
    if (!trimmedPurpose) {
        throw new Error('deriveSubkeyFromSeed: purpose is required');
    }
    const ikm = crypto.createHash('sha256').update(seed, 'utf8').digest();
    try {
        const info = Buffer.from(`ploinky/${trimmedPurpose}/v1`, 'utf8');
        return Buffer.from(crypto.hkdfSync('sha256', ikm, Buffer.alloc(0), info, length));
    } finally {
        ikm.fill(0);
    }
}

function deriveSubkey(purpose, length = 32) {
    return defaultSubkeyDeriver.derive(purpose, length);
}

function normalizeDerivationPart(value, fallback = 'default') {
    const normalized = String(value || '').trim().replace(/[^A-Za-z0-9_.:/-]/g, '_');
    return normalized || fallback;
}

function deriveDerivedMasterKey() {
    return deriveSubkey('derived-master');
}

// Per-agent request-signing secret. Router-only: the router/launcher derives
// this for each enabled agent and injects ONLY that agent's own value as
// PLOINKY_AGENT_SECRET. The domain separation is the canonical agent id
// (`agent:<repo>/<agent>`), so no two agents share a signing key and one agent
// reading its own environment cannot forge tokens for another agent. This is
// the replacement for the shared `derived-master` invocation key (DS015):
//   PLOINKY_AGENT_SECRET = HKDF_SHA256(master, salt="", info="ploinky/agent-secret/<agentId>/v1", 32)
// Reuses deriveSubkey so the whole workspace keeps one derivation story; the
// master key itself never leaves the router.
function deriveAgentRequestSecret(agentId, { encoding = 'hex' } = {}) {
    const id = String(agentId || '').trim();
    if (!id) {
        throw new Error('deriveAgentRequestSecret: agentId is required');
    }
    const raw = deriveSubkey(`agent-secret/${id}`, 32);
    if (encoding === 'buffer') {
        return raw;
    }
    if (encoding === 'base64') {
        return raw.toString('base64');
    }
    if (encoding === 'base64url') {
        return raw.toString('base64url');
    }
    return raw.toString('hex');
}

function derivePrivateAgentRequestSecret(agentId, instanceId, enableGeneration, { encoding = 'hex' } = {}) {
    const id = String(agentId || '').trim();
    const instance = String(instanceId || '').trim();
    const generation = String(enableGeneration || '').trim();
    if (!id || !instance || !generation) {
        throw new Error('derivePrivateAgentRequestSecret: agentId, instanceId, and enableGeneration are required');
    }
    const raw = deriveSubkey(`private-agent-secret/${id}/${instance}/${generation}`, 32);
    if (encoding === 'buffer') return raw;
    if (encoding === 'base64') return raw.toString('base64');
    if (encoding === 'base64url') return raw.toString('base64url');
    return raw.toString('hex');
}

function deriveAgentSecret({
    repoName = 'unknown',
    agentName = 'unknown',
    name,
    purpose,
    length = 32,
    encoding = 'hex',
} = {}) {
    const secretName = normalizeDerivationPart(name || purpose, '');
    if (!secretName) {
        throw new Error('deriveAgentSecret: name is required');
    }
    const byteLength = Number.isFinite(Number(length)) && Number(length) > 0
        ? Math.floor(Number(length))
        : 32;
    const derivedMasterSecret = deriveDerivedMasterKey();
    const info = Buffer.from([
        'ploinky/agent-secret',
        normalizeDerivationPart(repoName, 'unknown-repo'),
        normalizeDerivationPart(agentName, 'unknown-agent'),
        secretName,
        'v1',
    ].join('/'), 'utf8');
    const raw = Buffer.from(crypto.hkdfSync('sha256', derivedMasterSecret, Buffer.alloc(0), info, byteLength));
    if (encoding === 'base64') {
        return raw.toString('base64');
    }
    if (encoding === 'base64url') {
        return raw.toString('base64url');
    }
    return raw.toString('hex');
}

// `derivedMasterSecret` lets a caller that resolved the master seed itself
// pass deriveSubkeyFromSeed(seed, 'derived-master'); by default the current
// derived master key is used.
function deriveWorkspaceSecret({
    name,
    purpose,
    length = 32,
    encoding = 'hex',
    derivedMasterSecret: suppliedDerivedMasterSecret,
} = {}) {
    const secretName = normalizeDerivationPart(name || purpose, '');
    if (!secretName) {
        throw new Error('deriveWorkspaceSecret: name is required');
    }
    const byteLength = Number.isFinite(Number(length)) && Number(length) > 0
        ? Math.floor(Number(length))
        : 32;
    const derivedMasterSecret = suppliedDerivedMasterSecret || deriveDerivedMasterKey();
    const info = Buffer.from([
        'ploinky/workspace-secret',
        secretName,
        'v1',
    ].join('/'), 'utf8');
    const raw = Buffer.from(crypto.hkdfSync('sha256', derivedMasterSecret, Buffer.alloc(0), info, byteLength));
    if (encoding === 'base64') {
        return raw.toString('base64');
    }
    if (encoding === 'base64url') {
        return raw.toString('base64url');
    }
    return raw.toString('hex');
}

export {
    createSubkeyDeriver,
    deriveAgentRequestSecret,
    derivePrivateAgentRequestSecret,
    deriveAgentSecret,
    deriveSubkey,
    deriveSubkeyFromSeed,
    deriveDerivedMasterKey,
    deriveWorkspaceSecret,
    findEnvFile,
    loadEnvFile,
    MASTER_KEY_VAR,
    parseKeyValueFile,
    parseKeyValueText,
    resolveMasterKey,
    resolveMasterKeySeed,
    sanitizeManagedMasterKeyEnvironment,
    usesManagedWorkspaceMasterKey,
};
