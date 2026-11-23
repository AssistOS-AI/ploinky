import { createHash } from 'node:crypto';
import path from 'node:path';
import { parseCanaryTaskId } from '../../../Agent/server/TaskQueue.mjs';
import { readReceipt } from '../../sandbox/canary/receipt.mjs';
import { PLOINKY_WORKSPACE_ROOT } from '../../utils/config.js';
import { effectiveCanaryMode, routingSignals } from './routeAdmission.mjs';

function unavailable(status, code, message) {
    return Object.assign(new Error(message), { status, statusCode: status, code });
}

function actorId(req) {
    const user = req?.delegatedAgentVerified
        ? req.delegatedAgentVerified.userDelegation?.user
        : req?.user;
    if (!user) return req?.delegatedAgentVerified ? null : req?.canaryPublicUserId;
    if (req?.authMode === 'guest' || user.roles?.some?.(role => String(role).trim().toLowerCase() === 'guest')
        || user.id?.startsWith?.('guest:')) return null;
    return user.id;
}

function splitSelectsCanary(config, userId) {
    if (typeof userId !== 'string' || !userId) return false;
    if (config.testAccounts.includes(userId)) return true;
    if (config.share === 0) return false;
    const hash = createHash('sha256').update(config.salt + ':' + userId).digest();
    return hash.readUInt32BE(0) % 10_000 < config.share * 100;
}

function currentVersion(config, state) {
    return config ? JSON.stringify([config.rolloutId, config.mode, state?.state, state?.exposureVersion, state?.running]) : '';
}

function taskCopy(taskId, routeKey, route, workspaceRoot) {
    const marker = parseCanaryTaskId(taskId);
    const config = route.canary;
    if (marker && marker !== config?.rolloutId) {
        if (!config && readReceipt(routeKey, { workspaceRoot })?.rolloutId === marker) {
            throw unavailable(410, 'CANARY_TASK_REMOVED', 'new copy removed');
        }
        throw unavailable(404, 'CANARY_TASK_NOT_FOUND', 'task not found');
    }
    if (marker && config.mode === 'withdrawn') throw unavailable(410, 'CANARY_TASK_REMOVED', 'new copy removed');
    if (marker) return 'canary';
    return 'old';
}

function oldTaskPort(route, record, routeKey, workspaceRoot) {
    const receipt = readReceipt(routeKey, { workspaceRoot });
    const bound = receipt?.rolloutId === route.canary.rolloutId;
    if (bound && (Number(receipt.lastCompletedStep ?? receipt.promotionStep ?? receipt.step) >= 2
        || (receipt.oldLaunchId && record?.launchId && receipt.oldLaunchId !== record.launchId))) {
        throw unavailable(410, 'CANARY_TASK_STOPPED', 'old copy stopped');
    }
    if (route.hostPort) return route.hostPort;
    // Withdrawal can precede SIGTERM. Only a receipt-bound physical endpoint
    // can still answer a task when the logical route has lost its port.
    if (bound && receipt.oldContainerId && receipt.oldContainerId === record?.containerId
        && receipt.oldLaunchId && receipt.oldLaunchId === record.launchId
        && !route.hardwareAvailability && record.hostPort) return record.hostPort;
    throw unavailable(503, 'CANARY_OLD_TASK_UNAVAILABLE', 'old task runtime unavailable');
}

// The lease pins the route and both records. The separate version fences
// in-memory incidents that do not change that lease.
export function selectRouteRuntime({ routeKey, route, snapshot, req, taskId, signals = routingSignals(),
    workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT || PLOINKY_WORKSPACE_ROOT }) {
    const config = route?.canary;
    const state = config && signals?.routingState(routeKey, config.rolloutId);
    const mode = config && effectiveCanaryMode(config, state);
    const copy = taskId != null ? taskCopy(taskId, routeKey, route, workspaceRoot)
        : mode === 'all' || (mode === 'split' && splitSelectsCanary(config, actorId(req))) ? 'canary' : 'old';
    const container = copy === 'canary' ? config.container : route?.container;
    const targetRecord = snapshot?.agents?.[container];
    let physical = route;
    const oldQueue = config?.mode === 'all' && copy === 'old' && taskId != null;
    if (oldQueue) {
        const port = oldTaskPort(route, targetRecord, routeKey, workspaceRoot);
        if (port !== route.hostPort) physical = Object.freeze({ ...route, hostPort: port });
    }
    if (copy === 'canary') {
        if (targetRecord?.canaryOf !== routeKey || state?.running === false) {
            throw unavailable(503, 'CANARY_TARGET_UNAVAILABLE', 'canary runtime unavailable');
        }
        // The published route's relay and hardware fields belong to its
        // primary. Build the peer's endpoints only from the selected record.
        const { owner, relay, hardwareAvailability, serviceTargets, ...logical } = route;
        physical = Object.freeze({ ...logical, container, hostPort: targetRecord.hostPort,
            hostPath: path.resolve(workspaceRoot, config.codePath), draining: false,
            ...(targetRecord.serviceTargets && { serviceTargets: targetRecord.serviceTargets }),
            ...(targetRecord.hardwareAvailability && { hardwareAvailability: targetRecord.hardwareAvailability }) });
    }
    const version = currentVersion(config, state);
    const runtimeKey = JSON.stringify([routeKey, container, targetRecord?.containerId, targetRecord?.launchId, physical?.hostPort]);
    const isCurrent = () => {
        if (!config) return true;
        if (version !== currentVersion(config, signals?.routingState(routeKey, config.rolloutId))) return false;
        return !oldQueue || physical.hostPort === oldTaskPort(route, targetRecord, routeKey, workspaceRoot);
    };
    return Object.freeze({ routeKey, route: physical, targetRecord, copy, rolloutId: config?.rolloutId, version, runtimeKey,
        isCurrent, track: close => signals?.trackConnection(routeKey, config?.rolloutId, copy, close, isCurrent()) });
}

export function assertSelectionCurrent(selection) {
    if (selection && !selection.isCurrent()) {
        throw unavailable(503, 'CANARY_SELECTION_CHANGED', 'canary selection changed before dispatch');
    }
    return true;
}

export function trackCanaryConnection(selection, close) {
    if (typeof selection?.track === 'function') return selection.track(close) || (() => {});
    return routingSignals()?.trackConnection(selection?.routeKey, undefined, 'old', close) || (() => {});
}
