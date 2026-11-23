import { loadActiveEdgeRoutingGeneration } from '../../sandbox/edgeGeneration.js';
import { readReceipt } from '../../sandbox/canary/receipt.mjs';
import { PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';
import { probeCanaryContainer } from '../../sandbox/canary/probe.mjs';
import { appendLog } from '../utils/logger.js';
import { registerProxyOutcomeSink } from './proxyOutcomes.js';
import { setRoutingSignals } from './routeAdmission.mjs';
import { CanarySignals } from './signals.js';
import { rolloutThresholds } from './tripRules.js';

// Keep a route's baseline and rollout in the same engine so starting a rollout
// can seed its old-copy window. Evict the whole engine when its route retires.
const engines = new Map();
let publishedRoutes;
// Leased route objects outlive publication. A removed and reintroduced key
// gets a fresh identity even when no rollout existed on either generation.
const routeEpochs = new WeakMap();

class RouterSignals {
    #probe = exactContainerProbe();
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

    restoreInvalidRoute(routeKey, config, error) {
        this.log('canary_restore_error', { routeKey, rolloutId: config.rolloutId,
            code: error?.code || 'invalid-rollout' });
        if (!routeKey || !config.rolloutId) return;
        const signals = this.#route(routeKey);
        const [prior] = signals.status().rollouts;
        if (prior && prior.rolloutId !== config.rolloutId) signals.removeRollout(routeKey, prior.rolloutId);
        const share = Number.isFinite(config.share) && config.share >= 0 && config.share <= 100 ? config.share : 0;
        signals.routerStarted({ [routeKey]: { canary: { ...config, mode: 'split', share, thresholds: {} } } });
        signals.setThresholds(routeKey, config.rolloutId, {});
    }

    restoreRoute(routeKey, config, options) {
        try {
            rolloutThresholds(config.thresholds);
            this.#route(routeKey).routerStarted({ [routeKey]: { canary: config } }, options);
        } catch (error) {
            this.restoreInvalidRoute(routeKey, config, error);
        }
    }

    routerStarted(routes, options) {
        for (const [routeKey, route] of Object.entries(routes)) {
            if (route?.canary) this.restoreRoute(routeKey, route.canary, options);
        }
    }

    routeEpoch(route) { return routeEpochs.get(route); }

    recordOutcome(event) {
        const key = event.routeKey;
        if (!key) return;
        if (!engines.has(key) && publishedRoutes && !Object.hasOwn(publishedRoutes, key)) {
            readGeneration();
            if (!Object.hasOwn(publishedRoutes, key)) return;
        }
        const engine = engines.get(key);
        if (engine) engine.recordOutcome(event);
        else if ((event.copy ?? 'old') === 'old' && event.rolloutId == null) this.#route(key).recordOutcome(event);
    }

    routingState(key, id) { return engines.get(key)?.routingState(key, id) ?? null; }
    publishedMode(key, id, mode) { engines.get(key)?.publishedMode(key, id, mode); }
    replaceProbeTarget(key, id, target) { engines.get(key)?.replaceProbeTarget(key, id, target); }
    trackConnection(key, id, copy, close, current) {
        return this.#route(key).trackConnection(key, id, copy, close, current);
    }
    removeRollout(key, id) { return engines.get(key)?.removeRollout(key, id) ?? false; }
    setShare(key, id, share) { return engines.get(key)?.setShare(key, id, share) ?? false; }
    setThresholds(key, id, thresholds) { engines.get(key)?.setThresholds(key, id, thresholds); }
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
setRoutingSignals(canarySignals);
registerProxyOutcomeSink((event, epoch) => {
    if (epoch && epoch === routeEpochs.get(publishedRoutes?.[event.routeKey])) canarySignals.recordOutcome(event);
});

export function exactContainerProbe(probe = probeCanaryContainer) {
    return (target, { signal }) => probe({
        runtime: target.runtime, containerName: target.container, containerId: target.containerId,
        ...(target.registryRecord && { registryRecord: target.registryRecord }),
        ...target.probe, timeoutMs: 5000, signal,
    });
}
const observed = new Map();
let observedSnapshot;
let cold = true;

function matchingReceipt(key, id) {
    try {
        const receipt = readReceipt(key, { workspaceRoot: process.env.PLOINKY_WORKSPACE_ROOT || PLOINKY_WORKSPACE_ROOT });
        return receipt?.rolloutId === id && !receipt.terminal ? receipt : null;
    } catch {
        appendLog('canary_receipt_unavailable', { routeKey: key, rolloutId: id });
        return null;
    }
}

function alreadyPrepared(key, id) {
    const r = matchingReceipt(key, id);
    return r && Number(r.lastCompletedStep ?? r.promotionStep ?? r.step) >= 1;
}

function updateRollout(routeKey, config, record, last) {
    const id = config.rolloutId;
    const recordId = record?.containerId;
    const target = { runtime: record?.runtime, containerId: recordId, registryRecord: record, startedAt: record?.startedAt };
    const enriched = { ...config, routeKey, ...target };
    if (last && last.recordId !== recordId) canarySignals.replaceProbeTarget(routeKey, id, target);
    const thresholdsChanged = !last || JSON.stringify(last.field.thresholds) !== JSON.stringify(config.thresholds);
    if (thresholdsChanged) {
        try {
            rolloutThresholds(config.thresholds);
        } catch (error) {
            canarySignals.restoreInvalidRoute(routeKey, enriched, error);
            return { field: config, recordId, invalid: true };
        }
    } else if (last.invalid) {
        return { ...last, field: config, recordId };
    }
    if (!last) {
        if (cold || config.mode === 'all') {
            canarySignals.routerStarted({ [routeKey]: { canary: enriched } });
            if (config.mode === 'all' && alreadyPrepared(routeKey, id)) canarySignals.publishedMode(routeKey, id, 'all');
        } else {
            canarySignals.startRollout(enriched);
            if (config.mode !== 'split') canarySignals.publishedMode(routeKey, id, config.mode);
        }
    } else {
        if (thresholdsChanged) canarySignals.setThresholds(routeKey, id, config.thresholds);
        const previous = last.field;
        const state = canarySignals.routingState(routeKey, config.rolloutId);
        if (previous.splitStartedAt !== config.splitStartedAt && config.mode === 'split'
            && ['paused', 'tripped'].includes(state?.state)) {
            const change = matchingReceipt(routeKey, config.rolloutId)?.settingsChange;
            if (change?.action === 'resume' && change.splitStartedAt === config.splitStartedAt
                && change.exposureVersion === state.exposureVersion) canarySignals.resume(routeKey, config.rolloutId);
        }
        if (previous.share !== config.share) canarySignals.setShare(routeKey, config.rolloutId, config.share);
        else if (previous.salt !== config.salt || previous.splitStartedAt !== config.splitStartedAt
            || JSON.stringify(previous.testAccounts) !== JSON.stringify(config.testAccounts)) {
            canarySignals.settingsChanged(routeKey, config.rolloutId);
        }
        if (previous.mode !== config.mode) {
            let next = config.mode;
            const current = canarySignals.routingState(routeKey, id);
            if (next === 'all' && !canarySignals.acceptsSeal(routeKey, id, current?.exposureVersion)) next = 'prepare-rejected';
            if (next === 'split' && ['paused', 'prepare-rejected', 'tripped'].includes(current?.state)) {
                next = current.state === 'tripped' ? 'tripped' : 'paused';
            }
            canarySignals.publishedMode(routeKey, config.rolloutId, next);
        }
    }
    return { field: config, recordId };
}

function observeRoutes(routes) {
    if (routes === publishedRoutes) return;
    for (const [key, last] of observed) {
        if (last.field.rolloutId !== routes[key]?.canary?.rolloutId) {
            canarySignals.removeRollout(key, last.field.rolloutId);
            observed.delete(key);
        }
    }
    for (const [key, signals] of engines) {
        if (Object.hasOwn(routes, key)) continue;
        signals.setProbe(null);
        engines.delete(key);
    }
    for (const [key, route] of Object.entries(routes)) {
        const prior = publishedRoutes?.[key];
        const same = prior && prior.container === route.container && prior.canary?.rolloutId === route.canary?.rolloutId;
        routeEpochs.set(route, same ? routeEpochs.get(prior) : Symbol());
    }
    publishedRoutes = routes;
}

export function observeCanarySnapshot(snapshot) {
    if (!snapshot || snapshot === observedSnapshot) return;
    const routes = snapshot.routing?.routes ?? {};
    observeRoutes(routes);
    for (const [routeKey, route] of Object.entries(routes)) {
        if (!route.canary) continue;
        const config = route.canary;
        const record = snapshot.agents?.[config.container];
        observed.set(routeKey, updateRollout(routeKey, config, record, observed.get(routeKey)));
    }
    cold = false;
    observedSnapshot = snapshot;
}

function readGeneration() {
    try {
        observeCanarySnapshot(loadActiveEdgeRoutingGeneration().generation);
    } catch (error) {
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

export function canaryStatus(routes = {}) {
    if (cold) observeCanarySnapshot({ routing: { routes } });
    else observeRoutes(routes);
    return canarySignals.status();
}
