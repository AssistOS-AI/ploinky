import fs from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { isDeepStrictEqual } from 'node:util';
import { createCloudflarePublicationApi } from '../../../ploinky-box/cloudflared/cloudflareApi.mjs';
import { CONTROLLER_STATE_DIR } from '../../utils/config.js';
import { readSecretsFile } from '../../utils/security/encryptedSecretsFile.js';
import { cacheHostPurgeEntry, cachePublishedHosts, exactCacheHost } from './cachePurgeConfig.js';
import { writeCacheJson } from './cacheSettingsStore.js';

const cooldowns = new Map();
const cooldownMs = 15000;
const outcomes = new Set(['accepted', 'failed', 'cooldown', 'unconfigured']);

function resultPath(dataDir, host) {
    if (!exactCacheHost(host)) throw new Error('unknown_host');
    return path.join(dataDir, 'cache-purge-results', host + '.json');
}

export function readLastPurge(host, { dataDir = CONTROLLER_STATE_DIR } = {}) {
    const file = resultPath(dataDir, host);
    try {
        const { at, by, outcome } = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (typeof at === 'string' && Number.isFinite(Date.parse(at)) && typeof by === 'string'
            && outcomes.has(outcome)) return { at, by, outcome };
    } catch (error) {
        if (error.code === 'ENOENT') return null;
    }
    throw new Error('cache_purge_result_unreadable');
}

// Both operator and browser requests enter here in the same Router process.
export async function purgeCacheHost({ host, by, generation, assertCurrent, expectedEntry }, {
    dataDir = CONTROLLER_STATE_DIR, api = createCloudflarePublicationApi(),
    readToken = handle => readSecretsFile()[handle], now = () => performance.now(),
    reservations = cooldowns, warn = code => console.warn(code),
} = {}) {
    assertCurrent();
    const file = resultPath(dataDir, host);
    if (!cachePublishedHosts(generation).includes(host)) throw new Error('unknown_host');
    const entry = cacheHostPurgeEntry(host, generation, { dataDir });
    if (expectedEntry && !isDeepStrictEqual(entry, expectedEntry)) {
        throw new Error('cache_purge_configuration_changed');
    }
    const result = { host, outcome: 'unconfigured' };
    if (entry) {
        const start = now();
        for (const [key, until] of reservations) {
            if (until <= start) reservations.delete(key);
        }
        if (reservations.has(host)) {
            result.outcome = 'cooldown';
            result.retryAfterSeconds = Math.ceil((reservations.get(host) - start) / 1000);
        } else {
            // Reserve synchronously before yielding to Cloudflare.
            reservations.set(host, start + cooldownMs);
            try {
                const apiToken = readToken(entry.secretHandle);
                if (typeof apiToken !== 'string' || !apiToken.trim()) throw new Error('missing_purge_token');
                await api.purgeHosts({ apiToken, zoneId: entry.zoneId, hosts: [host] });
                result.outcome = 'accepted';
            } catch (error) {
                result.outcome = 'failed';
                warn(error?.code === 'CLOUDFLARE_PURGE_RATE_LIMITED'
                    ? 'CLOUDFLARE_PURGE_RATE_LIMITED' : 'CLOUDFLARE_PURGE_FAILED');
            }
        }
    }
    // Keep the outcome of an already issued purge even if its lease expired in flight.
    writeCacheJson(file, { at: new Date().toISOString(), by, outcome: result.outcome });
    assertCurrent();
    return result;
}
