// Shared fixtures for the hardware-availability store tests (not a test file).

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
    assertEdgeGenerationApplyLockCapability,
    resolveEdgeGenerationPaths,
    withEdgeGenerationApplyLock,
} from '../../cli/sandbox/edgeGeneration.js';
import { buildDirectRefusal } from '../../cli/sandbox/hardwareLimits/requestedLimits.mjs';
import { buildAvailabilityProjection } from '../../cli/server/hardwareAvailability.mjs';
import { commitHardwareAvailabilityPolicy } from '../../cli/sandbox/hardwareAvailabilityStore.mjs';

export const SCHEMA = 'ploinky.hardware-availability/v1';
export const DEAD_UUID = '00000000-0000-4000-8000-000000000000';

export function makeWorkspace(t, prefix = 'hwa-') {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    return { root, paths: resolveEdgeGenerationPaths({ workspaceRoot: root }) };
}

export function sha256(file) {
    return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

export function inode(target) {
    const stat = fs.lstatSync(target);
    return `${stat.dev}:${stat.ino}`;
}

// A pid that provably no longer exists (an exited child), for dead-owner names.
export function deadPid() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
        const child = spawnSync(process.execPath, ['-e', '0'], { stdio: 'ignore' });
        const pid = child.pid;
        try {
            process.kill(pid, 0);
        } catch (error) {
            if (error?.code === 'ESRCH') return pid;
        }
    }
    throw new Error('could not obtain a dead pid');
}

export function uuid() {
    return crypto.randomUUID();
}

export function refusalOutcome(key, { ref = 'fixtures/alpha', alias = null, reason = 'Hardware limits are off for this workspace.' } = {}) {
    return buildDirectRefusal({
        key,
        ref,
        alias,
        refusalParts: {
            reasonCode: 'gate_off',
            reason,
            fix: 'On the host run PLOINKY_BOX_HARDWARE_LIMITS=on ploinky restart, or remove the declared limit.',
            requested: [{ field: 'memory', value: '512m', source: 'manifest' }],
        },
        inputFingerprint: crypto.createHash('sha256').update(`${key}|${ref}`).digest('hex'),
    });
}

/** A valid committed entry for `routeKey` (container `ploinky_fixtures_<routeKey>`). */
export function entryFor(routeKey = 'alpha', {
    key = `ploinky_fixtures_${routeKey}`,
    runId = uuid(),
    runStartedAtMs = 1_700_000_000_000,
    finishedAtMs = 1_700_000_001_000,
    waveIndex = 0,
    instanceId = `${routeKey}-instance`,
    enableGeneration = `${routeKey}-generation`,
    reason,
    alias = null,
} = {}) {
    const outcome = refusalOutcome(key, { ref: `fixtures/${routeKey}`, alias, ...(reason === undefined ? {} : { reason }) });
    const projection = buildAvailabilityProjection({
        outcome,
        instanceId,
        enableGeneration,
        observedAt: new Date(finishedAtMs).toISOString(),
    });
    return {
        projection: JSON.parse(JSON.stringify(projection)),
        source: { kind: 'no-wait-terminal', runId, runStartedAtMs, waveIndex, statusFile: `${key}.${runId}.json`, finishedAtMs },
    };
}

export function slotFor(routeKey = 'alpha', {
    key = `ploinky_fixtures_${routeKey}`,
    instanceId = `${routeKey}-instance`,
    enableGeneration = `${routeKey}-generation`,
    runId = uuid(),
    runStartedAtMs = 1_700_000_000_000,
    waveIndex = 0,
    statusFile,
    startupGraceMs = 60000,
} = {}) {
    return {
        key, instanceId, enableGeneration, runId, runStartedAtMs, waveIndex,
        statusFile: statusFile === undefined ? `${key}.${runId}.json` : statusFile,
        startupGraceMs,
    };
}

export function lockAssertion(root, capability) {
    return () => assertEdgeGenerationApplyLockCapability({ workspaceRoot: root, applyLockCapability: capability });
}

/** Run `callback({ capability, assertApplyLock })` under the real edge apply lock. */
export function underApplyLock(root, callback) {
    return withEdgeGenerationApplyLock((capability) => (
        callback({ capability, assertApplyLock: lockAssertion(root, capability) })
    ), { workspaceRoot: root });
}

export function commit(root, paths, args) {
    return underApplyLock(root, ({ assertApplyLock }) => commitHardwareAvailabilityPolicy({ paths, assertApplyLock, ...args }));
}

/** An fs facade that records calls and lets a test replace single operations. */
export function spyFs(overrides = {}) {
    const calls = [];
    const paths = new Map();
    const record = (op, detail) => calls.push({ op, ...detail });
    const api = { ...fs, constants: fs.constants };
    api.openSync = (target, flags, mode) => {
        const descriptor = overrides.openSync ? overrides.openSync(target, flags, mode) : fs.openSync(target, flags, mode);
        paths.set(descriptor, String(target));
        record('open', { path: String(target), flags });
        return descriptor;
    };
    api.fsyncSync = (descriptor) => {
        record('fsync', { path: paths.get(descriptor) || null });
        if (overrides.fsyncSync) return overrides.fsyncSync(descriptor, paths.get(descriptor) || null);
        return fs.fsyncSync(descriptor);
    };
    api.renameSync = (from, to) => {
        record('rename', { from: String(from), to: String(to) });
        if (overrides.renameSync) return overrides.renameSync(from, to);
        return fs.renameSync(from, to);
    };
    api.writeFileSync = (target, data, options) => {
        record('write', { path: typeof target === 'number' ? paths.get(target) || null : String(target) });
        if (overrides.writeFileSync) return overrides.writeFileSync(target, data, options, typeof target === 'number' ? paths.get(target) : String(target));
        return fs.writeFileSync(target, data, options);
    };
    api.linkSync = (from, to) => {
        record('link', { from: String(from), to: String(to) });
        return fs.linkSync(from, to);
    };
    return { api, calls };
}

export function fsError(code, message = code) {
    const error = new Error(`${code}: ${message}`);
    error.code = code;
    return error;
}
