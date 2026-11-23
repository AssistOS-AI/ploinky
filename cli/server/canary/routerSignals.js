import { loadActiveEdgeRoutingGeneration } from '../../sandbox/edgeGeneration.js';
import { appendLog } from '../utils/logger.js';
import { registerProxyOutcomeSink } from './proxyOutcomes.js';
import { CanarySignals } from './signals.js';
import { rolloutThresholds } from './tripRules.js';

// Keep a route's baseline and rollout in the same engine so starting a rollout
// can seed its old-copy window. Evict the whole engine when its route retires.
const engines = new Map();
let publishedRoutes;
let awaitingInitialGeneration = true;

class RouterSignals {
    #probe;
    now = Date.now;
    log = appendLog;

    #route(key) {
        let signals = engines.get(key);
        if (!signals) {
            signals = new CanarySignals({ now: () => this.now(), log: (...args) => this.log(...args), probe: this.#probe });
            engines.set(key, signals);
        }
        return signals;
    }

    setProbe(probe) {
        if (probe != null && typeof probe !== 'function') throw new TypeError('expected canary probe function');
        this.#probe = probe;
        for (const signals of engines.values()) signals.setProbe(probe);
    }

    startRollout(config) {
        this.#route(config.routeKey).startRollout(config);
    }

    routerStarted(routes, { onlyMissing = false } = {}) {
        for (const [routeKey, route] of Object.entries(routes)) {
            const config = route?.canary;
            if (!config) continue;
            const signals = this.#route(routeKey);
            try {
                // An already-open rollout otherwise reuses its old settings
                // without checking the generation being restored.
                rolloutThresholds(config.thresholds);
                signals.routerStarted({ [routeKey]: route }, { onlyMissing });
            } catch (error) {
                this.log('canary_restore_error', { routeKey, rolloutId: config.rolloutId,
                    code: error?.code || 'invalid-rollout' });
                // Preserve the published identity, but require explicit resume.
                if (!routeKey || !config.rolloutId) continue;
                const [prior] = signals.status().rollouts;
                if (prior) signals.removeRollout(routeKey, prior.rolloutId);
                const share = Number.isFinite(config.share) && config.share >= 0 && config.share <= 100
                    ? config.share : 0;
                const fallback = { ...config, mode: 'split', share, thresholds: {} };
                try {
                    signals.routerStarted({ [routeKey]: { canary: fallback } });
                } catch (fallbackError) {
                    this.log('canary_restore_error', { routeKey, rolloutId: config.rolloutId,
                        code: fallbackError?.code || 'restore-failed' });
                }
            }
        }
    }

    recordOutcome(event) {
        if (!event.routeKey) return;
        const signals = engines.get(event.routeKey);
        if (signals) signals.recordOutcome(event);
        else if ((event.copy === undefined || event.copy === 'old') && event.rolloutId == null) {
            // A request can finish after its route retires. The first request
            // on a newly published route can also arrive before the next sweep.
            if (publishedRoutes && !Object.hasOwn(publishedRoutes, event.routeKey)) {
                const current = readGeneration();
                if (!current || !Object.hasOwn(current, event.routeKey)) return;
            }
            this.#route(event.routeKey).recordOutcome(event);
        }
    }

    removeRollout(key, id) { return engines.get(key)?.removeRollout(key, id) ?? false; }
    setShare(key, id, share) { return engines.get(key)?.setShare(key, id, share) ?? false; }
    settingsChanged(key, id) { return engines.get(key)?.settingsChanged(key, id) ?? false; }
    resume(key, id) { return engines.get(key)?.resume(key, id) ?? false; }
    recordProbe(key, id, result) { engines.get(key)?.recordProbe(key, id, result); }
    seal(key, id, version) { return engines.get(key)?.seal(key, id, version) ?? false; }
    acceptsSeal(key, id, version) { return engines.get(key)?.acceptsSeal(key, id, version) ?? false; }

    refresh() {
        for (const signals of engines.values()) signals.refresh();
    }

    status() {
        const rollouts = [];
        const baselines = [];
        for (const signals of engines.values()) {
            const status = signals.status();
            rollouts.push(...status.rollouts);
            baselines.push(...status.baselines);
        }
        return { rollouts, baselines };
    }
}

export const canarySignals = new RouterSignals();
registerProxyOutcomeSink(event => canarySignals.recordOutcome(event));

function observeRoutes(routes = {}) {
    publishedRoutes = routes;
    for (const [key, signals] of engines) {
        if (Object.hasOwn(routes, key)) continue;
        signals.setProbe(null);
        engines.delete(key);
    }
    if (awaitingInitialGeneration) {
        canarySignals.routerStarted(routes, { onlyMissing: true });
        awaitingInitialGeneration = false;
    }
}

function readGeneration() {
    try {
        const routes = loadActiveEdgeRoutingGeneration().generation.routing.routes;
        observeRoutes(routes);
        return routes;
    } catch (error) {
        // An inactive selector during preparation does not retire any route.
        if (error?.code !== 'EDGE_GENERATION_INACTIVE') {
            appendLog('canary_restore_error', { code: error?.code || 'invalid-rollout' });
        }
    }
}

readGeneration();
setInterval(() => {
    readGeneration();
    canarySignals.refresh();
}, 30_000).unref();

export function canaryStatus(routes) {
    observeRoutes(routes);
    return canarySignals.status();
}
