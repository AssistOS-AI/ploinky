import fs from 'node:fs';
import path from 'node:path';
import { CONTROLLER_STATE_DIR } from '../../utils/config.js';
import { hasSecretHandle } from '../../utils/security/secretVars.js';
import { loadActiveEdgeRoutingGeneration, withEdgeGenerationApplyLock } from '../../sandbox/edgeGeneration.js';
import { normalizePublicHostname } from '../../../ploinky-box/cloudflared/publicationPlan.mjs';
import { writeCacheJson } from './cacheSettingsStore.js';

export function exactCacheHost(host) {
    try {
        return typeof host === 'string' && normalizePublicHostname(host) === host;
    } catch {
        return false;
    }
}

export function cachePublishedHosts(generation) {
    if (generation?.publicationState !== 'ready') return [];
    return Object.keys(generation.compiled.hosts).filter(exactCacheHost).sort();
}

function validEntry(entry) {
    return typeof entry?.zoneId === 'string' && /^[0-9a-f]{32}$/i.test(entry.zoneId)
        && typeof entry.secretHandle === 'string' && entry.secretHandle.length <= 255
        && /^publication\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)*$/.test(entry.secretHandle)
        && !entry.secretHandle.split('/').some(part => part === '.' || part === '..');
}

function readConfig(dataDir) {
    try {
        const config = JSON.parse(fs.readFileSync(path.join(dataDir, 'cache-purge.json'), 'utf8'));
        if (config?.version !== 1 || !config.hosts || typeof config.hosts !== 'object'
            || Array.isArray(config.hosts) || !Object.entries(config.hosts).every(([host, entry]) =>
                exactCacheHost(host) && validEntry(entry))) throw new Error('cache_config_invalid');
        return config;
    } catch (error) {
        if (error.code === 'ENOENT') return { version: 1, hosts: {} };
        throw new Error('cache_config_unreadable');
    }
}

export function configuredCacheEntries(generation, { dataDir = CONTROLLER_STATE_DIR, requirePublication = false } = {}) {
    const config = readConfig(dataDir);
    if (requirePublication && generation.publicationState !== 'ready'
        && Object.keys(config.hosts).some(host => Object.hasOwn(generation.compiled.hosts, host))) {
        throw new Error('cache_publication_unavailable');
    }
    return Object.fromEntries(cachePublishedHosts(generation)
        .filter(host => Object.hasOwn(config.hosts, host))
        .map(host => [host, config.hosts[host]]));
}

export function configuredCacheHosts(generation, options) {
    return Object.keys(configuredCacheEntries(generation, options));
}

export function cacheHostPurgeEntry(host, generation, { dataDir = CONTROLLER_STATE_DIR } = {}) {
    if (!cachePublishedHosts(generation).includes(host)) return null;
    return readConfig(dataDir).hosts[host] ?? null;
}

export function configureCachePurge({ host, zoneId, secretHandle }, {
    dataDir = CONTROLLER_STATE_DIR, loadActive = loadActiveEdgeRoutingGeneration,
    hasHandle = hasSecretHandle, withLock = withEdgeGenerationApplyLock,
} = {}) {
    const entry = { zoneId, secretHandle };
    if (!exactCacheHost(host) || !validEntry(entry)) throw new Error('invalid_request');
    return withLock(() => {
        if (!cachePublishedHosts(loadActive().generation).includes(host)) throw new Error('unknown_host');
        if (!hasHandle(secretHandle)) throw new Error('unknown_secret_handle');
        const config = readConfig(dataDir);
        config.hosts[host] = entry;
        writeCacheJson(path.join(dataDir, 'cache-purge.json'), config);
    });
}
