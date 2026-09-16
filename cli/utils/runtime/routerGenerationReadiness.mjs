import http from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';

// This is a reader/writer capability, not a Box or deployment version. A
// running Router reports the format its loaded code understands; reading the
// checkout on disk would incorrectly describe a daemon predating an update.
export const ROUTER_GENERATION_SOURCE_FORMAT = 'router-public-hosts-v1';

const MAX_HEALTH_BYTES = 64 * 1024;

function readinessError(message, cause) {
    return Object.assign(new Error(message, cause ? { cause } : undefined), {
        code: 'PLOINKY_ROUTER_GENERATION_NOT_READY',
    });
}

export function readRouterGenerationHealth({ socketPath, timeoutMs = 1_000 } = {}) {
    return new Promise((resolve, reject) => {
        let request;
        let settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (error) reject(error);
            else resolve(value);
        };
        const timer = setTimeout(() => {
            finish(readinessError('Router generation health probe timed out'));
            request?.destroy();
        }, timeoutMs);
        try {
            request = http.get({ socketPath, path: '/health', agent: false }, (response) => {
                let size = 0;
                const chunks = [];
                response.on('data', (chunk) => {
                    size += chunk.length;
                    if (size > MAX_HEALTH_BYTES) {
                        finish(readinessError('Router generation health response is too large'));
                        response.destroy();
                        return;
                    }
                    chunks.push(chunk);
                });
                response.on('error', (error) => finish(readinessError('Router generation health response failed', error)));
                response.on('aborted', () => finish(readinessError('Router generation health response was aborted')));
                response.on('end', () => {
                    try {
                        if (response.statusCode !== 200) throw new Error('health response was not successful');
                        const health = JSON.parse(Buffer.concat(chunks).toString('utf8'));
                        if (!health || typeof health !== 'object' || Array.isArray(health)
                            || health.status !== 'healthy' || !Number.isSafeInteger(health.pid) || health.pid < 1) {
                            throw new Error('health response has no Router identity');
                        }
                        finish(null, health);
                    } catch (error) {
                        finish(readinessError('Router generation health response is invalid', error));
                    }
                });
            });
            request.on('error', (error) => finish(readinessError('Router generation health probe failed', error)));
        } catch (error) {
            finish(readinessError('Router generation health probe failed', error));
        }
    });
}

function compatible(health) {
    return health?.status === 'healthy'
        && Number.isSafeInteger(health.pid) && health.pid > 0
        && health.generationSourceFormat === ROUTER_GENERATION_SOURCE_FORMAT;
}

/**
 * Under the workspace/network start locks and inactive selector, establish a
 * Router that can read the generation format about to be prepared. A TCP
 * listener alone cannot prove that an in-place source update reached the
 * running daemon. Never return before replacement is confirmed compatible.
 *
 * waitForListener(child, timeoutMs) rejects while the public listener is down.
 * spawnRouter owns the existing Watchdog launch/PID-file lifecycle.
 */
export async function ensureRouterGenerationReady({
    waitForListener,
    readHealth,
    stopRouter,
    spawnRouter,
    onReload = () => {},
    timeoutMs = 15_000,
} = {}) {
    let listening = false;
    try {
        await waitForListener(null, 300);
        listening = true;
    } catch (_) {}
    if (listening) {
        try {
            if (compatible(await readHealth())) return { reused: true, child: null };
        } catch (_) {
            // Missing health support is an old or unhealthy daemon, never
            // permission to write a generation it may be unable to read.
        }
        if (typeof stopRouter !== 'function') {
            throw readinessError('The running Router must be restarted before preparing this routing format; run ploinky restart');
        }
        onReload();
        await stopRouter();
        const deadline = Date.now() + timeoutMs;
        let stopped = false;
        while (Date.now() < deadline) {
            try {
                await waitForListener(null, 100);
            } catch (_) {
                stopped = true;
                break;
            }
            await delay(50);
        }
        if (!stopped) {
            throw readinessError('The old Router is still listening; no new routing generation was prepared');
        }
    } else if (typeof stopRouter === 'function') {
        // A Watchdog can still be alive between Router restarts. Retain the
        // existing cold-start cleanup before creating a second supervisor.
        await stopRouter();
    }

    const child = await spawnRouter();
    await waitForListener(child, timeoutMs);
    const deadline = Date.now() + timeoutMs;
    let lastError;
    while (Date.now() < deadline) {
        if (child?.exitCode !== null && child?.exitCode !== undefined) {
            throw readinessError(`Router exited before its generation format was verified (exit ${child.exitCode})`);
        }
        try {
            if (compatible(await readHealth())) return { reused: false, child };
        } catch (error) {
            lastError = error;
        }
        await delay(50);
    }
    throw readinessError('The started Router does not report the required routing format; no new routing generation was prepared', lastError);
}
