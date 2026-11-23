import { appendLog } from '../utils/logger.js';
import { routeAdmitted } from './routeAdmission.mjs';
import { selectRouteRuntime } from './selection.mjs';

export function selectFanoutRuntimes(snapshot, req, signals) {
    const selections = [];
    for (const [routeKey, route] of Object.entries(snapshot?.routing?.routes || {})) {
        if (!routeAdmitted(route, routeKey, snapshot, signals)) continue;
        try {
            selections.push(selectRouteRuntime({ routeKey, route, snapshot, req, signals }));
        } catch (error) {
            appendLog('fanout_route_unavailable', { routeKey, code: error.code || 'ROUTE_SELECTION_FAILED' });
        }
    }
    return selections;
}
