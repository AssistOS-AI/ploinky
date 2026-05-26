import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const MASTER_KEY_VAR = 'PLOINKY_MASTER_KEY';

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

function resolveMasterKey({ purpose = 'Ploinky encrypted storage' } = {}) {
    let raw = String(process.env[MASTER_KEY_VAR] || '').trim();
    if (!raw) {
        // Walk up from cwd looking for a .env that defines the master key.
        // Operators frequently keep a single .env in a parent directory that
        // shadows multiple workspaces, so this matches that workflow.
        raw = String(loadEnvFile()[MASTER_KEY_VAR] || '').trim();
    }
    if (!raw) {
        const message = `${MASTER_KEY_VAR} is required for ${purpose}. Set it in the process environment or define it in a .env walked upward from the current directory.`;
        console.error(`[ploinky] ${message}`);
        throw new Error(message);
    }
    return crypto.createHash('sha256').update(raw, 'utf8').digest();
}

// HKDF-SHA256 subkey derivation. Every per-purpose secret in Ploinky must be
// derived from the master key via this function rather than using master bytes
// directly. Domain separation is carried in the `info` parameter so that
// rotating one purpose (by bumping its version segment) cannot collide with
// another. Empty salt is fine because the master key is already a
// SHA-256 digest of the operator-supplied seed.
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
};
