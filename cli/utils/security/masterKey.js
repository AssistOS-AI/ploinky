import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const MASTER_KEY_VAR = 'PLOINKY_MASTER_KEY';
const GENERATED_MASTER_KEY_FILE = 'master-key';
const BUILT_IN_FALLBACK_MASTER_KEY_SEED = 'ploinky-default-master-key-v1';

let generatedFallbackWarningEmitted = false;

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

function resolveGeneratedMasterKeyPath(startDir = process.cwd()) {
    return path.join(resolveGeneratedMasterKeyRoot(startDir), '.ploinky', GENERATED_MASTER_KEY_FILE);
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
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
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
        return {
            seed: BUILT_IN_FALLBACK_MASTER_KEY_SEED,
            filePath,
            source: 'built-in fallback',
            error,
        };
    }
}

function warnGeneratedFallback({ purpose, source, filePath, error }) {
    if (generatedFallbackWarningEmitted) {
        return;
    }
    generatedFallbackWarningEmitted = true;
    const using = source === 'built-in fallback'
        ? `using insecure built-in fallback seed because generated fallback could not be persisted at ${filePath}.`
        : `using ${source} at ${filePath}.`;
    const detail = error ? ` Could not persist ${filePath}: ${error?.message || String(error)}.` : '';
    console.error(
        `[ploinky] ${MASTER_KEY_VAR} is not set for ${purpose}; ${using}`
        + `${detail} Set ${MASTER_KEY_VAR} in the process environment or a walked-up .env for an operator-managed key.`
    );
}

function resolveMasterKeySeed({ purpose = 'Ploinky encrypted storage', startDir = process.cwd() } = {}) {
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

function resolveMasterKey({ purpose = 'Ploinky encrypted storage', startDir = process.cwd() } = {}) {
    const raw = resolveMasterKeySeed({ purpose, startDir });
    return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

// HKDF-SHA256 subkey derivation. Every per-purpose secret in Ploinky must be
// derived from the master key via this function rather than using master bytes
// directly. Domain separation is carried in the `info` parameter so that
// rotating one purpose (by bumping its version segment) cannot collide with
// another. Empty salt is fine because the master key is already a
// SHA-256 digest of the resolved workspace seed.
function deriveSubkey(purpose, length = 32) {
    const trimmedPurpose = String(purpose || '').trim();
    if (!trimmedPurpose) {
        throw new Error('deriveSubkey: purpose is required');
    }
    const ikm = resolveMasterKey({ purpose: `subkey:${trimmedPurpose}` });
    const salt = Buffer.alloc(0);
    const info = Buffer.from(`ploinky/${trimmedPurpose}/v1`, 'utf8');
    return Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));
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
// the replacement for the shared `derived-master` invocation key (DS013):
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

function deriveWorkspaceSecret({
    name,
    purpose,
    length = 32,
    encoding = 'hex',
} = {}) {
    const secretName = normalizeDerivationPart(name || purpose, '');
    if (!secretName) {
        throw new Error('deriveWorkspaceSecret: name is required');
    }
    const byteLength = Number.isFinite(Number(length)) && Number(length) > 0
        ? Math.floor(Number(length))
        : 32;
    const derivedMasterSecret = deriveDerivedMasterKey();
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
    deriveAgentRequestSecret,
    derivePrivateAgentRequestSecret,
    deriveAgentSecret,
    deriveSubkey,
    deriveDerivedMasterKey,
    deriveWorkspaceSecret,
    findEnvFile,
    loadEnvFile,
    MASTER_KEY_VAR,
    parseKeyValueFile,
    parseKeyValueText,
    resolveMasterKey,
    resolveMasterKeySeed,
};
