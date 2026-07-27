import fs from 'fs';
import path from 'path';

import { ROUTING_FILE } from '../utils/config.js';
import {
    inactivateEdgeRoutingGeneration,
    withEdgeGenerationApplyLock,
} from '../sandbox/edgeGeneration.js';
import { applyEdgeRoutingGeneration } from '../sandbox/coordinatedEdgeApply.js';

const ROUTING_LOCK_FILE = `${ROUTING_FILE}.lock`;

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function acquireRoutingLock({ timeoutMs = 10000, intervalMs = 50 } = {}) {
    const start = Date.now();
    while (true) {
        try {
            fs.mkdirSync(path.dirname(ROUTING_LOCK_FILE), { recursive: true });
            const fd = fs.openSync(ROUTING_LOCK_FILE, 'wx');
            fs.writeFileSync(fd, JSON.stringify({
                pid: process.pid,
                createdAt: new Date().toISOString()
            }));
            return () => {
                try { fs.closeSync(fd); } catch (_) {}
                try { fs.unlinkSync(ROUTING_LOCK_FILE); } catch (_) {}
            };
        } catch (error) {
            if (error?.code !== 'EEXIST') {
                throw error;
            }
            if (Date.now() - start > timeoutMs) {
                throw new Error(`Timed out waiting for routing file lock: ${ROUTING_LOCK_FILE}`);
            }
            await sleep(intervalMs);
        }
    }
}

function readRoutingConfig() {
    try {
        const parsed = JSON.parse(fs.readFileSync(ROUTING_FILE, 'utf8'));
        if (parsed && typeof parsed === 'object') {
            parsed.routes = parsed.routes && typeof parsed.routes === 'object' ? parsed.routes : {};
            return parsed;
        }
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            const wrapped = new Error(`routing.json is invalid; refusing mutation: ${error?.message || error}`);
            wrapped.code = 'ROUTING_STATE_INVALID';
            throw wrapped;
        }
    }
    return { routes: {} };
}

function writeRoutingConfig(config, {
    coordinate = true,
    reason = 'routing-write',
    preparationLease,
} = {}) {
    const target = config && typeof config === 'object' ? config : {};
    target.routes = target.routes && typeof target.routes === 'object' ? target.routes : {};
    const write = () => {
        fs.mkdirSync(path.dirname(ROUTING_FILE), { recursive: true });
        const tempFile = `${ROUTING_FILE}.${process.pid}.${Date.now()}.tmp`;
        fs.writeFileSync(tempFile, JSON.stringify(target, null, 2));
        fs.renameSync(tempFile, ROUTING_FILE);
        return target;
    };
    if (!coordinate) return write();
    return withEdgeGenerationApplyLock((applyLockCapability) => {
        // A lifecycle preparation lease is bound to one exact inactive
        // selector. Re-inactivating here would rotate that selector before the
        // prepared apply can validate it. The preparation phase has already
        // installed the fail-closed selector; ordinary unprepared writes still
        // have to inactivate before mutating candidate bytes.
        if (!preparationLease) {
            inactivateEdgeRoutingGeneration(reason, { applyLockCapability });
        }
        write();
        applyEdgeRoutingGeneration({ reason, preparationLease, applyLockCapability });
        return target;
    }, { preparationLease });
}

async function mergeRoutingConfig(mutator, {
    coordinate = true,
    reason = 'routing-merge',
    preparationLease,
} = {}) {
    const release = await acquireRoutingLock();
    try {
        const mutate = async (applyLockCapability = undefined) => {
            if (coordinate && !preparationLease) {
                inactivateEdgeRoutingGeneration(reason, { applyLockCapability });
            }
            const current = readRoutingConfig();
            const next = await mutator(current) || current;
            writeRoutingConfig(next, { coordinate: false });
            if (coordinate) {
                applyEdgeRoutingGeneration({
                    reason,
                    preparationLease,
                    applyLockCapability,
                });
            }
            return next;
        };
        return coordinate
            ? await withEdgeGenerationApplyLock(mutate, { preparationLease })
            : await mutate();
    } finally {
        release();
    }
}

function mergeRuntimeRoute(existingRoute, route, {
    hostPort = null,
} = {}) {
    const next = { ...(existingRoute || {}), ...(route || {}) };
    delete next.serviceTargets;
    if (hostPort) next.hostPort = hostPort;
    else delete next.hostPort;
    return next;
}

export {
    mergeRoutingConfig,
    mergeRuntimeRoute,
    readRoutingConfig,
    writeRoutingConfig,
};
