// Read-only view of `.ploinky/agents.json` for observational commands.
//
// `loadAgents()` in `utils/workspace.js` creates `.ploinky` before reading, so
// it cannot serve a command that must never touch workspace state. This module
// reads the same registry through verified descriptors and never creates,
// repairs, or rewrites anything: `ENOENT` is an empty registry and every other
// containment, type, or JSON problem fails closed.

import fsDefault from 'node:fs';
import pathDefault from 'node:path';

import { PLOINKY_WORKSPACE_ROOT } from './config.js';
import { readVerifiedJsonObject } from './verifiedReadOnlyFile.js';

const PLOINKY_DIR_NAME = '.ploinky';
const AGENTS_FILE_NAME = 'agents.json';
export const AGENT_REGISTRY_BYTE_LIMIT = 4 * 1024 * 1024;

export const EMPTY_AGENT_REGISTRY = Object.freeze({});

export function agentRegistrySnapshotError(message) {
    const error = new Error(message);
    error.code = 'AGENT_REGISTRY_SNAPSHOT_INVALID';
    return error;
}

export function readAgentRegistrySnapshot({
    workspaceRoot = PLOINKY_WORKSPACE_ROOT,
    fsApi = fsDefault,
    pathApi = pathDefault,
} = {}) {
    const root = String(workspaceRoot || '').trim();
    if (!root) throw agentRegistrySnapshotError('agents registry requires one exact workspace root');
    const ploinkyDir = pathApi.join(pathApi.resolve(root), PLOINKY_DIR_NAME);
    try {
        return readVerifiedJsonObject({
            trustedRoot: ploinkyDir,
            relativeSegments: [AGENTS_FILE_NAME],
            byteLimit: AGENT_REGISTRY_BYTE_LIMIT,
            absent: EMPTY_AGENT_REGISTRY,
            fsApi,
            pathApi,
        });
    } catch (error) {
        throw agentRegistrySnapshotError(`agents registry is invalid: ${error?.message || 'verification failed'}`);
    }
}
