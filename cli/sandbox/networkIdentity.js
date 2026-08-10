// Pure workspace/network identity contract shared by mutating lifecycle code
// and read-only ownership inspection. Keeping these values out of
// networkLifecycle.js prevents an observational logs import from loading the
// network create/remove implementation.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { PLOINKY_WORKSPACE_ROOT } from '../utils/config.js';

export const NETWORK_LABELS = Object.freeze({
    managed: 'io.assistos.ploinky.managed',
    resource: 'io.assistos.ploinky.resource',
    schema: 'io.assistos.ploinky.network-schema',
    workspace: 'io.assistos.ploinky.workspace',
    logical: 'io.assistos.ploinky.logical',
    contract: 'io.assistos.ploinky.network-contract',
    instanceId: 'io.assistos.ploinky.instance-id',
    enableGeneration: 'io.assistos.ploinky.enable-generation',
});

function hash12(value) {
    return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 12);
}

export function workspaceNetworkIdentity(workspaceRoot = PLOINKY_WORKSPACE_ROOT) {
    let canonical = path.resolve(workspaceRoot);
    try { canonical = fs.realpathSync.native(canonical); } catch (_) {}
    return { canonical, hash: hash12(canonical) };
}

export function physicalNetworkName(workspaceHash, logicalName) {
    return `ploinky-nw-${workspaceHash}-${hash12(logicalName)}`;
}
