import { loadActiveEdgeRoutingGeneration } from '../../sandbox/edgeGeneration.js';
import { readReceipt } from '../../sandbox/canary/receipt.mjs';
import { PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';
import { probeCanaryContainer } from '../../sandbox/canary/probe.mjs';
import { appendLog } from '../utils/logger.js';
import { registerProxyOutcomeSink } from './proxyOutcomes.js';
import { setRoutingSignals } from './routeAdmission.mjs';
import { CanarySignals } from './signals.js';

export function exactContainerProbe(probe = probeCanaryContainer) {
    return (target, { signal }) => probe({
        runtime: target.runtime, containerName: target.container, containerId: target.containerId,
        ...target.probe, timeoutMs: 5000, signal,
    });
}
export const canarySignals = new CanarySignals({ log: appendLog, probe: exactContainerProbe() });
setRoutingSignals(canarySignals);
registerProxyOutcomeSink(event => canarySignals.recordOutcome(event));
// Existing streams alone may outlive a publication. Observe the current
// generation even while no new request is entering the Router.
setInterval(() => {
    try { observeCanarySnapshot(loadActiveEdgeRoutingGeneration().generation); }
    catch { /* A preparation may temporarily leave no active generation. */ }
    canarySignals.refresh();
}, 30_000).unref();

let observedSnapshot;
let observed;
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

export function observeCanarySnapshot(snapshot) {
    if (!snapshot || snapshot === observedSnapshot) return;
    const routes = snapshot.routing?.routes || {};
    const entry = Object.entries(routes).find(([, route]) => route.canary);
    const [routeKey, route] = entry || [];
    const config = route?.canary;
    const record = config && snapshot.agents?.[config.container];
    if (observed && (observed.key !== routeKey || observed.field.rolloutId !== config?.rolloutId)) {
        canarySignals.removeRollout(observed.key, observed.field.rolloutId);
        observed = null;
    }
    if (config) {
        if (!observed) {
            // The registry's errorRate/windowSeconds are not S4 override keys.
            // Keep the Router's defined sliding-window rules.
            const { thresholds, ...fields } = config;
            const enriched = { ...fields, routeKey, containerId: record?.containerId, runtime: record?.runtime };
            if (cold || config.mode === 'all') {
                canarySignals.routerStarted({ [routeKey]: { canary: enriched } });
                if (config.mode === 'all' && alreadyPrepared(routeKey, config.rolloutId)) {
                    canarySignals.publishedMode(routeKey, config.rolloutId, 'all');
                }
            } else {
                canarySignals.startRollout(enriched);
                if (config.mode !== 'split') canarySignals.publishedMode(routeKey, config.rolloutId, config.mode);
            }
        } else {
            const last = observed.field;
            const state = canarySignals.routingState(routeKey, config.rolloutId);
            if (last.splitStartedAt !== config.splitStartedAt && config.mode === 'split'
                && ['paused', 'tripped'].includes(state?.state)) {
                const change = matchingReceipt(routeKey, config.rolloutId)?.settingsChange;
                if (change?.action === 'resume' && change.splitStartedAt === config.splitStartedAt
                    && change.exposureVersion === state.exposureVersion) canarySignals.resume(routeKey, config.rolloutId);
            }
            if (last.share !== config.share) canarySignals.setShare(routeKey, config.rolloutId, config.share);
            else if (last.salt !== config.salt || last.splitStartedAt !== config.splitStartedAt
                || JSON.stringify(last.testAccounts) !== JSON.stringify(config.testAccounts)) {
                canarySignals.settingsChanged(routeKey, config.rolloutId);
            }
            if (last.mode !== config.mode) {
                let next = config.mode;
                if (next === 'all' && last.mode === 'split'
                    && !canarySignals.acceptsSeal(routeKey, config.rolloutId, state?.exposureVersion)) next = 'prepare-rejected';
                if (next === 'split' && state?.state === 'prepare-rejected') next = 'paused';
                canarySignals.publishedMode(routeKey, config.rolloutId, next);
            }
        }
        const recordId = record?.containerId;
        if (observed?.recordId && recordId && observed.recordId !== recordId) {
            canarySignals.replaceProbeTarget(routeKey, config.rolloutId, { runtime: record.runtime, containerId: recordId });
        }
        observed = { key: routeKey, field: config, recordId };
    }
    cold = false;
    observedSnapshot = snapshot;
}

try {
    observeCanarySnapshot(loadActiveEdgeRoutingGeneration().generation);
} catch (error) {
    if (error?.code !== 'EDGE_GENERATION_INACTIVE') {
        appendLog('canary_restore_error', { code: error?.code || 'invalid-rollout' });
    }
}

export function canaryStatus(routes) {
    if (cold) observeCanarySnapshot({ routing: { routes } });
    return canarySignals.status();
}
