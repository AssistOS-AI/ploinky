#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { PloinkyBoxError } from '../errors.mjs';
import { createProcessRunner } from '../process.mjs';

function stopError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_CORE_STOP_FAILED' });
}

function readRegularFile(target, fsApi) {
    const stat = fsApi.lstatSync(target);
    if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
        throw stopError(`Refusing non-regular runtime state file: ${target}`);
    }
    return fsApi.readFileSync(target);
}

function readOptionalJson(target, fsApi, warnings) {
    try {
        const parsed = JSON.parse(readRegularFile(target, fsApi).toString('utf8'));
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
            throw new Error('expected an object');
        }
        return parsed;
    } catch (error) {
        if (error.code === 'ENOENT') return null;
        warnings.push(`${path.basename(target)}: ${error.message}`);
        return null;
    }
}

function validateWatchdogPid(pid, {
    procRoot,
    uid,
    fsApi,
}) {
    if (!Number.isSafeInteger(pid) || pid <= 1) return false;
    try {
        const status = readRegularFile(path.join(procRoot, String(pid), 'status'), fsApi).toString('utf8');
        const uidLine = status.split(/\r?\n/).find((line) => line.startsWith('Uid:'));
        const processUid = Number(uidLine?.trim().split(/\s+/)[1]);
        if (!Number.isSafeInteger(processUid) || processUid !== uid) return false;
        const argv = readRegularFile(path.join(procRoot, String(pid), 'cmdline'), fsApi)
            .toString('utf8').split('\0').filter(Boolean);
        return argv.some((value) => value === '/opt/ploinky/cli/server/Watchdog.js');
    } catch {
        return false;
    }
}

function inspectNestedContainer(recordedName, containerId, runner) {
    const result = runner.query('podman', ['container', 'inspect', containerId]);
    if (!result.ok) {
        throw stopError(`Unable to re-inspect nested container ID ${containerId}`);
    }
    let records;
    try { records = JSON.parse(result.stdout); } catch {
        throw stopError(`Nested container inspection was malformed for ${containerId}`);
    }
    const record = Array.isArray(records) && records.length === 1 ? records[0] : null;
    const observedId = String(record?.Id ?? record?.ID ?? '').toLowerCase();
    const observedName = String(record?.Name ?? '').replace(/^\//, '');
    if (observedId !== containerId || observedName !== recordedName) {
        throw stopError(`Nested container identity changed for ${recordedName}`);
    }
}

export function stopCoreWithoutBootstrap({
    workspaceRoot = '/workspace',
    procRoot = '/proc',
    uid = typeof process.getuid === 'function' ? process.getuid() : 0,
    fsApi = fs,
    runner = createProcessRunner(),
    kill = (pid, signal) => process.kill(pid, signal),
} = {}) {
    const ploinkyRoot = path.join(path.resolve(workspaceRoot), '.ploinky');
    const warnings = [];
    readOptionalJson(path.join(ploinkyRoot, 'routing.json'), fsApi, warnings);
    const agents = readOptionalJson(path.join(ploinkyRoot, 'agents.json'), fsApi, warnings) || {};
    let watchdogStopped = false;
    try {
        const pidText = readRegularFile(path.join(ploinkyRoot, 'running', 'router.pid'), fsApi)
            .toString('utf8').trim();
        const pid = /^[0-9]+$/.test(pidText) ? Number(pidText) : 0;
        if (!validateWatchdogPid(pid, { procRoot, uid, fsApi })) {
            warnings.push('router.pid did not identify the expected same-uid Watchdog process');
        } else {
            kill(pid, 'SIGTERM');
            watchdogStopped = true;
        }
    } catch (error) {
        if (error.code !== 'ENOENT') warnings.push(`router.pid: ${error.message}`);
    }

    const stoppedContainers = [];
    for (const [recordedName, record] of Object.entries(agents)) {
        if (!record || !['agent', 'agentCore'].includes(record.type) || record.runtime !== 'podman') {
            continue;
        }
        const containerId = String(record.containerId || '').trim().toLowerCase();
        if (!/^[a-f0-9]{64}$/.test(containerId)) {
            warnings.push(`${recordedName}: incomplete legacy immutable container identity`);
            continue;
        }
        try {
            inspectNestedContainer(recordedName, containerId, runner);
            runner.run('podman', ['container', 'stop', '--time', '10', containerId]);
            stoppedContainers.push(containerId);
        } catch (error) {
            warnings.push(`${recordedName}: ${error.message}`);
        }
    }
    return Object.freeze({
        watchdogStopped,
        stoppedContainers: Object.freeze(stoppedContainers),
        warnings: Object.freeze(warnings),
    });
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    const result = stopCoreWithoutBootstrap();
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.warnings.length > 0) process.exitCode = 1;
}
