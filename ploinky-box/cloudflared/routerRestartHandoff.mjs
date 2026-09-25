import fs from 'node:fs';
import path from 'node:path';

import { isRouterSupervisorId } from '../../cli/server/routerSupervisorIdentity.js';
import { writeTrustedCloudflareRuntimeFile } from './status.mjs';

// A Router stop withdraws the exact generation it served. This record lets
// only a later Router of the same Watchdog supervision lifetime restore it;
// the first Router of any other lifetime (after a shutdown) discards it.
export const ROUTER_RESTART_HANDOFF_SCHEMA_VERSION = 1;
const HANDOFF_KIND = 'cloudflare-router-restart-handoff';
const MAX_HANDOFF_BYTES = 4096;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const ACTIVATION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESTORE_PUBLICATION_STATES = new Set(['ready', 'reconciling']);
const HANDOFF_KEYS = Object.freeze([
    'generation',
    'inactiveActivationId',
    'inactiveSelectorDigest',
    'kind',
    'restorePublicationState',
    'routerSupervisorId',
    'schemaVersion',
    'stoppedAt',
]);

function handoffError(message) {
    return Object.assign(new Error(message), { code: 'CLOUDFLARE_ROUTER_RESTART_HANDOFF_INVALID' });
}

export function routerRestartHandoffFile(workspaceRoot) {
    return path.join(
        path.resolve(String(workspaceRoot || '')),
        '.ploinky',
        'run',
        'cloudflare-router-restart-handoff.json',
    );
}

export function normalizeRouterRestartHandoff(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw handoffError('Router restart handoff must be an object');
    }
    const keys = Object.keys(value).sort();
    if (keys.length !== HANDOFF_KEYS.length || keys.some((key, index) => key !== HANDOFF_KEYS[index])) {
        throw handoffError('Router restart handoff has unexpected fields');
    }
    if (value.schemaVersion !== ROUTER_RESTART_HANDOFF_SCHEMA_VERSION || value.kind !== HANDOFF_KIND) {
        throw handoffError('Router restart handoff schema is unsupported');
    }
    if (!isRouterSupervisorId(value.routerSupervisorId)
        || !ACTIVATION_ID.test(String(value.inactiveActivationId || ''))
        || !DIGEST.test(String(value.generation || ''))
        || !DIGEST.test(String(value.inactiveSelectorDigest || ''))
        || !RESTORE_PUBLICATION_STATES.has(value.restorePublicationState)
        || typeof value.stoppedAt !== 'string'
        || !Number.isFinite(Date.parse(value.stoppedAt))) {
        throw handoffError('Router restart handoff identity is invalid');
    }
    return Object.freeze({
        schemaVersion: value.schemaVersion,
        kind: value.kind,
        routerSupervisorId: value.routerSupervisorId,
        generation: value.generation,
        restorePublicationState: value.restorePublicationState,
        inactiveActivationId: value.inactiveActivationId,
        inactiveSelectorDigest: value.inactiveSelectorDigest,
        stoppedAt: value.stoppedAt,
    });
}

export function readRouterRestartHandoff(file, { fsApi = fs } = {}) {
    let stats;
    try {
        stats = fsApi.lstatSync(file);
    } catch (error) {
        if (error?.code === 'ENOENT') return null;
        throw error;
    }
    if (!stats.isFile() || stats.isSymbolicLink() || stats.size > MAX_HANDOFF_BYTES) {
        throw handoffError('Router restart handoff is not one bounded regular file');
    }
    let parsed;
    try {
        parsed = JSON.parse(fsApi.readFileSync(file, 'utf8'));
    } catch (_) {
        throw handoffError('Router restart handoff is not valid JSON');
    }
    return normalizeRouterRestartHandoff(parsed);
}

export function writeRouterRestartHandoff(file, value, { trustedRoot, fsApi = fs } = {}) {
    const normalized = normalizeRouterRestartHandoff({
        ...value,
        schemaVersion: ROUTER_RESTART_HANDOFF_SCHEMA_VERSION,
        kind: HANDOFF_KIND,
    });
    writeTrustedCloudflareRuntimeFile(file, normalized, { trustedRoot, fsApi });
    return normalized;
}

export function removeRouterRestartHandoff(file, { fsApi = fs } = {}) {
    try {
        const stats = fsApi.lstatSync(file);
        if (stats.isDirectory()) return false;
        fsApi.unlinkSync(file);
        return true;
    } catch (error) {
        if (error?.code === 'ENOENT') return false;
        throw error;
    }
}
