import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
    readEdgeRoutingPreparationOwner,
    retireAbandonedActiveBoundPreparation,
} from '../sandbox/edgeGeneration.js';
import { mergeRoutingConfig, readRoutingConfig } from '../server/routingFile.js';

/**
 * The precondition for returning a workspace to a Ploinky revision without
 * scoped edge availability (RF-I4). That revision refuses a withdrawn
 * preparation lease as corrupt and blocks every automatic restart of a
 * draining route, so before its checkout is restored and the workspace is
 * stopped and started:
 *
 * 1. an additive or withdrawn preparation whose owner stopped is retired; a
 *    live owner or any other outstanding preparation refuses the rollback;
 * 2. every automatic drain (a route carrying `drainOwner`) is lifted, leaving
 *    the route without a target until the restart recreates its runtime.
 *
 * Operator drains (no owner) are left alone. Returns what was changed.
 */
export async function prepareEdgeScopedRollback({
    retirePreparation = retireAbandonedActiveBoundPreparation,
    readPreparationOwner = readEdgeRoutingPreparationOwner,
    readRouting = readRoutingConfig,
    mergeRouting = mergeRoutingConfig,
} = {}) {
    const preparation = retirePreparation();
    const owner = readPreparationOwner();
    if (owner) {
        const error = new Error(`an edge lifecycle preparation (${owner.mode}, pid ${owner.pid}) is still outstanding`);
        error.code = 'EDGE_PREPARATION_BUSY';
        throw error;
    }
    const drained = Object.entries(readRouting()?.routes || {})
        .filter(([, route]) => route?.drainOwner)
        .map(([routeKey]) => routeKey);
    const reopened = [];
    if (drained.length > 0) {
        await mergeRouting((routing) => {
            for (const [routeKey, route] of Object.entries(routing.routes || {})) {
                if (!route?.drainOwner) continue;
                delete route.drainOwner;
                delete route.draining;
                delete route.hostPort;
                delete route.serviceTargets;
                reopened.push(routeKey);
            }
            return routing;
        }, { reason: 'edge-scoped-rollback-precondition' });
    }
    return { preparation, reopenedRoutes: reopened.sort() };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    prepareEdgeScopedRollback().then((result) => {
        console.log(JSON.stringify({ ok: true, ...result }));
    }).catch((error) => {
        console.error(JSON.stringify({ ok: false, code: error?.code || null, error: String(error?.message || error) }));
        process.exit(1);
    });
}
