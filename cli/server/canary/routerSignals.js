import { loadActiveEdgeRoutingGeneration } from '../../sandbox/edgeGeneration.js';
import { appendLog } from '../utils/logger.js';
import { registerProxyOutcomeSink } from './proxyOutcomes.js';
import { CanarySignals } from './signals.js';

export const canarySignals = new CanarySignals({ log: appendLog });
registerProxyOutcomeSink(event => canarySignals.recordOutcome(event));
setInterval(() => canarySignals.refresh(), 30_000).unref();

let awaitingInitialGeneration = true;
try {
    const { generation } = loadActiveEdgeRoutingGeneration();
    canarySignals.routerStarted(generation.routing.routes);
    awaitingInitialGeneration = false;
} catch (error) {
    // A fresh workspace may have no active generation when the Router boots.
    if (error?.code !== 'EDGE_GENERATION_INACTIVE') {
        appendLog('canary_restore_error', { code: error?.code || 'invalid-rollout' });
    }
}

// On cold startup the verified generation may only become readable after
// module initialization. Recover it at the first committed operator read.
export function canaryStatus(routes) {
    if (awaitingInitialGeneration) {
        canarySignals.routerStarted(routes, { onlyMissing: true });
        awaitingInitialGeneration = false;
    }
    return canarySignals.status();
}
