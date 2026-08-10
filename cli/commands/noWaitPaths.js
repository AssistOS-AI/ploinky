// The no-wait run identity and the file names derived from it.
//
// The producer in `workspaceUtil.js` and the read-only observer in
// `logCommands.js` must agree byte for byte on these names, and the observer
// must not import the whole start pipeline to learn them. Keeping the contract
// here is what lets a marker, a run-scoped status, and a run-scoped log prove
// they describe the same run without any persisted index.

import path from 'node:path';

import { LOGS_DIR, RUNNING_DIR } from '../utils/config.js';
import { NO_WAIT_RUN_ID_PATTERN } from './noWaitIdentity.js';

export const NO_WAIT_DIR_NAME = 'no-wait';
export { NO_WAIT_RUN_ID_PATTERN } from './noWaitIdentity.js';

export function assertExactNoWaitRunIdentity(containerName, runId, subject) {
    if (!containerName || path.basename(containerName) !== containerName
        || !NO_WAIT_RUN_ID_PATTERN.test(String(runId || ''))) {
        throw new Error(`${subject} requires an exact container name and run id`);
    }
}

export function assertExactNoWaitContainerName(containerName, subject) {
    if (!containerName || path.basename(containerName) !== containerName) {
        throw new Error(`${subject} requires an exact container name`);
    }
}

export function noWaitRunScopedLogName(containerName, runId) {
    assertExactNoWaitRunIdentity(containerName, runId, 'no-wait run-scoped log');
    return `${containerName}.${runId}.log`;
}

export function noWaitRunScopedStatusName(containerName, runId) {
    assertExactNoWaitRunIdentity(containerName, runId, 'no-wait coordination status');
    return `${containerName}.${runId}.json`;
}

export function noWaitRunScopedLogPath(containerName, runId, { logsDir = LOGS_DIR } = {}) {
    return path.join(logsDir, NO_WAIT_DIR_NAME, noWaitRunScopedLogName(containerName, runId));
}

export function noWaitRunScopedStatusPath(containerName, runId, { runningDir = RUNNING_DIR } = {}) {
    return path.join(runningDir, NO_WAIT_DIR_NAME, noWaitRunScopedStatusName(containerName, runId));
}

export function noWaitCurrentMarkerPath(containerName, { runningDir = RUNNING_DIR } = {}) {
    assertExactNoWaitContainerName(containerName, 'no-wait run marker');
    return path.join(runningDir, NO_WAIT_DIR_NAME, `${containerName}.current.json`);
}
