import fs from 'node:fs';
import path from 'node:path';

import { normalizePublicHostname } from './publicationPlan.mjs';

const DIGEST = /^sha256:[a-f0-9]{64}$/;
const SAFE_ERROR_CODE = /^(?:CLOUDFLARE|CLOUDFLARED|EDGE|PLOINKY)_[A-Z0-9_]{1,96}$/;
const PUBLICATION_STATES = new Set([
    'unstarted',
    'local-only',
    'reconciling',
    'ready',
    'error',
    'stopped',
]);
const CONNECTOR_STATES = new Set([
    'absent',
    'stopped',
    'starting',
    'running',
]);
const MANAGEMENT_MODES = new Set([
    'connector-only',
    'api-managed',
]);
const ERROR_OPERATIONS = new Set([
    'publication',
    'validate',
    'resolve-secrets',
    'reconcile',
    'retry',
    'transition-management',
    'verify-api-token',
    'read-existing-tunnel',
    'read-tunnel-connections',
    'read-tunnel-ingress',
    'read-zone',
    'update-tunnel-ingress',
    'list-dns-records',
    'create-dns-record',
    'update-dns-record',
    'delete-dns-record',
    'cloudflare-api',
    'reconcile-dns',
    'remove-dns-record',
    'verify-remote',
    'clear-final-host',
    'clear-previous-scope',
    'connector-start',
    'connector-process',
    'probe-connector',
    'probe-hostname',
    'journal',
    'runtime-start',
]);

function safeDigest(value) {
    const text = String(value || '');
    return DIGEST.test(text) ? text : '';
}

function safeHostnames(value) {
    if (!Array.isArray(value)) return [];
    const hostnames = [];
    for (const entry of value) {
        try { hostnames.push(normalizePublicHostname(entry)); } catch (_) {}
    }
    return [...new Set(hostnames)].sort();
}

export function serializeCloudflarePublicationStatus(value = {}) {
    const mode = value?.mode === 'cloudflare' ? 'cloudflare' : 'local-only';
    const management = mode === 'cloudflare' && MANAGEMENT_MODES.has(value?.management)
        ? value.management
        : null;
    const state = PUBLICATION_STATES.has(value?.state)
        ? value.state
        : mode === 'local-only' ? 'unstarted' : 'error';
    const connectorState = CONNECTOR_STATES.has(value?.connectorState)
        ? value.connectorState
        : mode === 'local-only' ? 'absent' : 'stopped';
    const error = value?.error && typeof value.error === 'object' && !Array.isArray(value.error)
        ? {
            code: SAFE_ERROR_CODE.test(String(value.error.code || ''))
                ? String(value.error.code)
                : 'CLOUDFLARE_PUBLICATION_ERROR',
            operation: ERROR_OPERATIONS.has(value.error.operation)
                ? value.error.operation
                : 'publication',
            retryable: value.error.retryable === true,
        }
        : null;
    return Object.freeze({
        mode,
        management,
        state,
        connectorState,
        configurationGeneration: safeDigest(value?.configurationGeneration),
        desiredDigest: safeDigest(value?.desiredDigest || value?.reconciliation?.desiredDigest),
        hostnames: Object.freeze(safeHostnames(value?.hostnames)),
        ...(error ? { error: Object.freeze(error) } : {}),
    });
}

function assertRegularFileOrMissing(filePath, fsApi) {
    try {
        const stats = fsApi.lstatSync(filePath);
        if (!stats.isFile() || stats.isSymbolicLink()) {
            throw Object.assign(
                new Error('Cloudflare status path is not a regular file'),
                { code: 'CLOUDFLARE_STATUS_PATH_INVALID' },
            );
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
    }
}

function ensureRealDirectoryChain(anchor, directory, fsApi) {
    if (typeof anchor !== 'string' || !anchor.trim()) {
        throw Object.assign(
            new Error('Cloudflare status requires a trusted workspace root'),
            { code: 'CLOUDFLARE_STATUS_DIRECTORY_INVALID' },
        );
    }
    const root = path.resolve(anchor);
    const target = path.resolve(directory);
    const relative = path.relative(root, target);
    if (relative === '..'
        || relative.startsWith(`..${path.sep}`)
        || path.isAbsolute(relative)) {
        throw Object.assign(
            new Error('Cloudflare status path escapes its trusted workspace'),
            { code: 'CLOUDFLARE_STATUS_DIRECTORY_INVALID' },
        );
    }
    const rootStats = fsApi.lstatSync(root);
    if (!rootStats.isDirectory() || rootStats.isSymbolicLink()) {
        throw Object.assign(
            new Error('Cloudflare status workspace is not a real directory'),
            { code: 'CLOUDFLARE_STATUS_DIRECTORY_INVALID' },
        );
    }
    let current = root;
    for (const component of relative.split(path.sep).filter(Boolean)) {
        current = path.join(current, component);
        try {
            const stats = fsApi.lstatSync(current);
            if (!stats.isDirectory() || stats.isSymbolicLink()) {
                throw Object.assign(
                    new Error('Cloudflare status parent is not a real directory'),
                    { code: 'CLOUDFLARE_STATUS_DIRECTORY_INVALID' },
                );
            }
        } catch (error) {
            if (error?.code !== 'ENOENT') throw error;
            fsApi.mkdirSync(current, { mode: 0o700 });
            const created = fsApi.lstatSync(current);
            if (!created.isDirectory() || created.isSymbolicLink()) {
                throw Object.assign(
                    new Error('Cloudflare status parent is not a real directory'),
                    { code: 'CLOUDFLARE_STATUS_DIRECTORY_INVALID' },
                );
            }
        }
    }
}

export function writeCloudflarePublicationStatus(filePath, value, {
    fsApi = fs,
    now = () => Date.now(),
    pid = process.pid,
    trustedRoot,
} = {}) {
    const absolutePath = path.resolve(String(filePath || ''));
    const directory = path.dirname(absolutePath);
    ensureRealDirectoryChain(trustedRoot, directory, fsApi);
    fsApi.chmodSync(directory, 0o700);
    assertRegularFileOrMissing(absolutePath, fsApi);
    const serialized = serializeCloudflarePublicationStatus(value);
    const temporary = path.join(
        directory,
        `.${path.basename(absolutePath)}.${pid}.${now()}.tmp`,
    );
    try {
        fsApi.writeFileSync(temporary, `${JSON.stringify(serialized, null, 2)}\n`, {
            encoding: 'utf8',
            mode: 0o600,
            flag: 'wx',
        });
        fsApi.renameSync(temporary, absolutePath);
        fsApi.chmodSync(absolutePath, 0o600);
    } finally {
        try { fsApi.unlinkSync(temporary); } catch (_) {}
    }
    return serialized;
}
