import fs from 'node:fs';
import path from 'node:path';

import {
    CloudflarePublicationError,
    normalizePublicHostname,
    redactCloudflareText,
} from './publicationPlan.mjs';

const PHASES = new Set([
    'local-only',
    'prepared',
    'previous-scope-cleared',
    'ingress-applied',
    'dns-reconciled',
    'remote-verified',
    'routes-committed',
    'connector-starting',
    'ready',
    'error',
]);
const JOURNAL_KEYS = Object.freeze([
    'mode',
    'configurationGeneration',
    'desiredDigest',
    'phase',
    'scope',
    'ingressDigest',
    'managedDnsRecords',
    'lastError',
    'updatedAt',
]);
const SCOPE_KEYS = Object.freeze(['accountId', 'zoneId', 'tunnelId']);
const DNS_RECORD_KEYS = Object.freeze(['hostname', 'recordId', 'zoneId', 'content']);
const ERROR_KEYS = Object.freeze(['code', 'operation', 'message', 'retryable']);
const SHA256_DIGEST = /^sha256:[a-f0-9]{64}$/;
const SCOPE_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const RECORD_IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_-]{0,255}$/;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

function fail(message, code = 'CLOUDFLARE_JOURNAL_CORRUPT') {
    throw new CloudflarePublicationError(message, {
        code,
        operation: 'journal',
    });
}
function isPlainObject(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
}

function hasExactKeys(value, keys) {
    return isPlainObject(value)
        && Object.keys(value).sort().join('\0') === [...keys].sort().join('\0');
}

function safeString(value, label, { maximum = 512, optional = false } = {}) {
    const text = String(value || '').trim();
    if (!text && optional) return '';
    if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
        fail(`Cloudflare reconciliation journal has invalid ${label}`);
    }
    return text;
}

function normalizeDigest(value, label) {
    const digest = safeString(value, label, { maximum: 71 });
    if (!SHA256_DIGEST.test(digest)) {
        fail(`Cloudflare reconciliation journal has invalid ${label}`);
    }
    return digest;
}

function normalizeTimestamp(value) {
    const timestamp = safeString(value, 'updated timestamp', { maximum: 24 });
    if (!CANONICAL_TIMESTAMP.test(timestamp)
        || !Number.isFinite(Date.parse(timestamp))
        || new Date(timestamp).toISOString() !== timestamp) {
        fail('Cloudflare reconciliation journal has invalid updated timestamp');
    }
    return timestamp;
}

function normalizeScope(value, { optional = false } = {}) {
    if ((value === undefined || value === null) && optional) return null;
    if (!hasExactKeys(value, SCOPE_KEYS)) fail('Cloudflare reconciliation journal has invalid scope');
    const scope = Object.fromEntries(SCOPE_KEYS.map((key) => [
        key,
        safeString(value[key], key, { maximum: 128 }),
    ]));
    if (Object.values(scope).some((identifier) => !SCOPE_IDENTIFIER.test(identifier))) {
        fail('Cloudflare reconciliation journal has invalid scope identifier');
    }
    return scope;
}

function normalizeManagedDnsRecords(value, scope) {
    if (!Array.isArray(value)) fail('Cloudflare reconciliation journal has invalid DNS records');
    const seen = new Set();
    return value.map((entry) => {
        if (!hasExactKeys(entry, DNS_RECORD_KEYS)) {
            fail('Cloudflare reconciliation journal has invalid DNS record');
        }
        const hostname = normalizePublicHostname(entry.hostname);
        if (seen.has(hostname)) fail('Cloudflare reconciliation journal contains duplicate DNS records');
        seen.add(hostname);
        const record = {
            hostname,
            recordId: safeString(entry.recordId, 'DNS record id', { maximum: 256 }),
            zoneId: safeString(entry.zoneId, 'DNS zone id', { maximum: 128 }),
            content: safeString(entry.content, 'DNS record content', { maximum: 384 }),
        };
        if (!RECORD_IDENTIFIER.test(record.recordId)
            || record.zoneId !== scope?.zoneId
            || record.content !== `${scope?.tunnelId}.cfargotunnel.com`) {
            fail('Cloudflare reconciliation journal has inconsistent DNS record ownership');
        }
        return record;
    }).sort((left, right) => left.hostname.localeCompare(right.hostname));
}

function normalizeError(value) {
    if (value === undefined || value === null) return null;
    if (!hasExactKeys(value, ERROR_KEYS) || typeof value.retryable !== 'boolean') {
        fail('Cloudflare reconciliation journal has invalid error state');
    }
    return {
        code: safeString(value.code, 'error code', { maximum: 128 }),
        operation: safeString(value.operation, 'error operation', { maximum: 128 }),
        message: redactCloudflareText(safeString(value.message, 'error message', { maximum: 1024 })),
        retryable: value.retryable === true,
    };
}

export function normalizeCloudflareJournal(value) {
    if (!hasExactKeys(value, JOURNAL_KEYS)) {
        fail('Cloudflare reconciliation journal has an invalid contract');
    }
    const mode = safeString(value.mode, 'mode', { maximum: 32 });
    if (!['local-only', 'cloudflare'].includes(mode)) fail('Cloudflare reconciliation journal has invalid mode');
    const phase = safeString(value.phase, 'phase', { maximum: 64 });
    if (!PHASES.has(phase)) fail('Cloudflare reconciliation journal has invalid phase');
    const scope = normalizeScope(value.scope, { optional: mode === 'local-only' });
    const normalized = {
        mode,
        configurationGeneration: normalizeDigest(value.configurationGeneration, 'configuration generation'),
        desiredDigest: normalizeDigest(value.desiredDigest, 'desired digest'),
        phase,
        scope,
        ingressDigest: mode === 'cloudflare'
            ? normalizeDigest(value.ingressDigest, 'ingress digest')
            : safeString(value.ingressDigest, 'ingress digest', { maximum: 71, optional: true }),
        managedDnsRecords: normalizeManagedDnsRecords(value.managedDnsRecords, scope),
        lastError: normalizeError(value.lastError),
        updatedAt: normalizeTimestamp(value.updatedAt),
    };
    if (mode === 'local-only') {
        if (value.scope !== null
            || normalized.phase !== 'local-only'
            || normalized.ingressDigest !== ''
            || normalized.managedDnsRecords.length !== 0
            || normalized.lastError !== null) {
            fail('Cloudflare reconciliation journal has inconsistent local-only state');
        }
    } else if (normalized.phase === 'local-only'
        || (normalized.phase === 'error') !== (normalized.lastError !== null)) {
        fail('Cloudflare reconciliation journal has inconsistent Cloudflare state');
    }
    return normalized;
}

function assertRegularFileOrMissing(file) {
    try {
        const stats = fs.lstatSync(file);
        if (!stats.isFile() || stats.isSymbolicLink()) fail('Cloudflare reconciliation journal is not a regular file');
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

function ensureRealDirectoryChain(anchor, directory) {
    const root = path.resolve(anchor);
    const target = path.resolve(directory);
    const relative = path.relative(root, target);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        fail('Cloudflare reconciliation journal escapes its workspace');
    }
    let current = root;
    const rootStats = fs.lstatSync(current);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        fail('Cloudflare reconciliation journal workspace is not a real directory');
    }
    for (const component of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        try {
            const stats = fs.lstatSync(current);
            if (!stats.isDirectory() || stats.isSymbolicLink()) {
                fail('Cloudflare reconciliation journal parent is not a real directory');
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            fs.mkdirSync(current, { mode: 0o700 });
            const created = fs.lstatSync(current);
            if (!created.isDirectory() || created.isSymbolicLink()) {
                fail('Cloudflare reconciliation journal parent is not a real directory');
            }
        }
    }
}

function atomicWrite(file, content, workspaceRoot) {
    const directory = path.dirname(file);
    ensureRealDirectoryChain(workspaceRoot, directory);
    assertRegularFileOrMissing(file);
    const temporary = path.join(directory, `.${path.basename(file)}.${process.pid}.${Date.now()}.tmp`);
    try {
        fs.writeFileSync(temporary, content, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
        fs.renameSync(temporary, file);
        fs.chmodSync(file, 0o600);
    } finally {
        try { fs.unlinkSync(temporary); } catch (_) {}
    }
}

export function resolveCloudflareJournalPath(workspaceRoot) {
    const root = path.resolve(String(workspaceRoot || process.env.PLOINKY_WORKSPACE_ROOT || process.cwd()));
    return path.join(root, '.ploinky', 'data', 'edge-publication', 'reconciliation.json');
}

export function createCloudflarePublicationJournal({ workspaceRoot, filePath } = {}) {
    const root = path.resolve(String(
        workspaceRoot || process.env.PLOINKY_WORKSPACE_ROOT || process.cwd(),
    ));
    const journalPath = path.resolve(String(filePath || resolveCloudflareJournalPath(root)));
    const relative = path.relative(root, journalPath);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
        fail('Cloudflare reconciliation journal escapes its workspace');
    }
    return Object.freeze({
        path: journalPath,
        read() {
            assertRegularFileOrMissing(journalPath);
            try {
                const raw = fs.readFileSync(journalPath, 'utf8');
                return normalizeCloudflareJournal(JSON.parse(raw));
            } catch (error) {
                if (error?.code === 'ENOENT') return null;
                if (error instanceof CloudflarePublicationError) throw error;
                fail(`Cloudflare reconciliation journal is unreadable or corrupt: ${redactCloudflareText(error?.message || error)}`);
            }
        },
        write(value) {
            const normalized = normalizeCloudflareJournal({
                ...value,
                updatedAt: value?.updatedAt || new Date().toISOString(),
            });
            atomicWrite(journalPath, `${JSON.stringify(normalized, null, 2)}\n`, root);
            return normalized;
        },
    });
}
