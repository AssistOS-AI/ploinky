import fs from 'node:fs';
import path from 'node:path';

import {
    CloudflarePublicationError,
    normalizePublicHostname,
    redactCloudflareText,
} from './cloudflarePublicationPlan.js';

export const CLOUDFLARE_JOURNAL_SCHEMA_VERSION = 1;

const PHASES = new Set([
    'local-only',
    'prepared',
    'previous-scope-cleared',
    'ingress-applied',
    'dns-reconciled',
    'remote-verified',
    'routes-committed',
    'connector-starting',
    'cloudflare-ready',
    'publication-error',
]);

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

function safeString(value, label, { maximum = 512, optional = false } = {}) {
    const text = String(value || '').trim();
    if (!text && optional) return '';
    if (!text || text.length > maximum || /[\u0000-\u001f\u007f]/.test(text)) {
        fail(`Cloudflare reconciliation journal has invalid ${label}`);
    }
    return text;
}

function normalizeScope(value, { optional = false } = {}) {
    if ((value === undefined || value === null) && optional) return null;
    if (!isPlainObject(value)) fail('Cloudflare reconciliation journal has invalid scope');
    return {
        accountId: safeString(value.accountId, 'accountId', { maximum: 128 }),
        zoneId: safeString(value.zoneId, 'zoneId', { maximum: 128 }),
        tunnelId: safeString(value.tunnelId, 'tunnelId', { maximum: 128 }),
    };
}

function normalizeManagedDnsRecords(value) {
    if (value === undefined) return [];
    if (!Array.isArray(value)) fail('Cloudflare reconciliation journal has invalid DNS records');
    const seen = new Set();
    return value.map((entry) => {
        if (!isPlainObject(entry)) fail('Cloudflare reconciliation journal has invalid DNS record');
        const hostname = normalizePublicHostname(entry.hostname);
        if (seen.has(hostname)) fail('Cloudflare reconciliation journal contains duplicate DNS records');
        seen.add(hostname);
        return {
            hostname,
            recordId: safeString(entry.recordId, 'DNS record id', { maximum: 256 }),
            zoneId: safeString(entry.zoneId, 'DNS zone id', { maximum: 128 }),
            content: safeString(entry.content, 'DNS record content', { maximum: 384 }),
        };
    }).sort((left, right) => left.hostname.localeCompare(right.hostname));
}

function normalizeError(value) {
    if (value === undefined || value === null) return null;
    if (!isPlainObject(value)) fail('Cloudflare reconciliation journal has invalid error state');
    return {
        code: safeString(value.code, 'error code', { maximum: 128 }),
        operation: safeString(value.operation, 'error operation', { maximum: 128 }),
        message: redactCloudflareText(safeString(value.message, 'error message', { maximum: 1024 })),
        retryable: value.retryable === true,
    };
}

export function normalizeCloudflareJournal(value) {
    if (!isPlainObject(value) || value.schemaVersion !== CLOUDFLARE_JOURNAL_SCHEMA_VERSION) {
        fail('Cloudflare reconciliation journal has an unsupported schema');
    }
    const mode = safeString(value.mode, 'mode', { maximum: 32 });
    if (!['local-only', 'cloudflare'].includes(mode)) fail('Cloudflare reconciliation journal has invalid mode');
    const phase = safeString(value.phase, 'phase', { maximum: 64 });
    if (!PHASES.has(phase)) fail('Cloudflare reconciliation journal has invalid phase');
    const normalized = {
        schemaVersion: CLOUDFLARE_JOURNAL_SCHEMA_VERSION,
        mode,
        configurationGeneration: safeString(value.configurationGeneration, 'configuration generation', { maximum: 96 }),
        desiredDigest: safeString(value.desiredDigest, 'desired digest', { maximum: 96 }),
        phase,
        scope: normalizeScope(value.scope, { optional: mode === 'local-only' }),
        ingressDigest: safeString(value.ingressDigest, 'ingress digest', { maximum: 96, optional: true }),
        managedDnsRecords: normalizeManagedDnsRecords(value.managedDnsRecords),
        lastError: normalizeError(value.lastError),
        updatedAt: safeString(value.updatedAt, 'updated timestamp', { maximum: 64 }),
    };
    if (mode === 'local-only') {
        normalized.scope = null;
        normalized.managedDnsRecords = [];
        normalized.ingressDigest = '';
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

function atomicWrite(file, content) {
    const directory = path.dirname(file);
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
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
    const journalPath = path.resolve(String(filePath || resolveCloudflareJournalPath(workspaceRoot)));
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
                schemaVersion: CLOUDFLARE_JOURNAL_SCHEMA_VERSION,
                updatedAt: value?.updatedAt || new Date().toISOString(),
            });
            atomicWrite(journalPath, `${JSON.stringify(normalized, null, 2)}\n`);
            return normalized;
        },
    });
}
