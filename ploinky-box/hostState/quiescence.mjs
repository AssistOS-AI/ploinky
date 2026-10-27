import { execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { BOX_LABELS } from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { createLockLiveness } from '../lockLiveness.mjs';

// Quiescence gate (plan D3). A transaction that adopts a workspace, creates or
// recreates its Box, or creates a Box data path first proves that no other
// Ploinky runtime of this workspace is still running and could write its
// `.ploinky-box` host state meanwhile. It runs under the workspace lock (D4),
// which host-runtime launches also take, so no host agent can start between
// this check and the writes that follow it.
//
// Only Ploinky's own evidence is consulted:
// - running containers labelled for this workspace: its Box, or a host agent
//   container of an older non-Box Ploinky;
// - the workspace's host-runtime launch records (`.ploinky/bwrap-pids`, used
//   by bwrap and seatbelt agents) whose process still runs with the start
//   identity the record holds.
// Other processes and containers of the host are not inspected: a desktop
// application that can see the workspace through a host-root mount (a snap,
// for example) is not a Ploinky runtime and does not block.
// A reported host process is cleared by stopping it or with
// `--allow-host-process PID`, which holds only for that exact process: its
// start time is read at the check and verified again before the gate passes.

// Host agent container labels (cli/sandbox/networkIdentity.js), kept here so
// the gate does not load the CLI's workspace configuration.
const AGENT_LABELS = Object.freeze({
    managed: 'io.assistos.ploinky.managed',
    workspace: 'io.assistos.ploinky.workspace',
});

function activeError(message, blockers) {
    return Object.assign(new PloinkyBoxError(message, { code: 'PLOINKY_BOX_HOST_RUNTIME_ACTIVE' }), {
        blockers: Object.freeze(blockers.map((blocker) => Object.freeze({ ...blocker }))),
    });
}

/**
 * The workspace hash of host agent container labels, computed as
 * `workspaceNetworkIdentity` does: the first 12 hex digits of SHA-256 of the
 * native real path (its canonical letter case on macOS).
 */
export function agentWorkspaceHash(workspaceRoot) {
    let canonical = path.resolve(workspaceRoot);
    try { canonical = fs.realpathSync.native(canonical); } catch (_) {}
    return crypto.createHash('sha256').update(canonical).digest('hex').slice(0, 12);
}

/** Running containers of this workspace: its Box, or a host agent container. */
export function containerBlockers(identity, view, { excludeContainerIds = [] } = {}) {
    const agentHash = agentWorkspaceHash(identity.workspaceRoot);
    const blockers = [];
    for (const container of view || []) {
        if (!container.running || excludeContainerIds.includes(container.id)) continue;
        const labels = container.labels || {};
        let reason = null;
        if (identity.pathHash && labels[BOX_LABELS.pathHash] === identity.pathHash) {
            reason = 'it is a Box of this workspace';
        } else if (labels[AGENT_LABELS.managed] === '1' && labels[AGENT_LABELS.workspace] === agentHash) {
            reason = 'it is a Ploinky agent container of this workspace';
        }
        if (reason) blockers.push({ kind: 'container', pid: null, id: container.id, name: container.name, reason });
    }
    return blockers;
}

// The start identity token bwrap and seatbelt launch records hold
// (cli/sandbox/bwrap/bwrapFleet.js): `linux-proc:<start ticks>` from
// /proc/<pid>/stat, else `ps-lstart:<start time>` from ps in the inherited
// locale, as the recording process wrote it. Null when unreadable.
function processIdentity(pid, fsApi, execFile) {
    try {
        const stat = String(fsApi.readFileSync(`/proc/${pid}/stat`, 'utf8'));
        const fields = stat.slice(stat.lastIndexOf(')') + 1).trim().split(/\s+/);
        if (fields[19]) return `linux-proc:${fields[19]}`;
    } catch (_) {}
    try {
        const output = String(execFile('ps', ['-p', String(pid), '-o', 'stat=', '-o', 'lstart='], {
            encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000,
        })).trim();
        const match = /^\S+\s+(.+)$/.exec(output);
        if (match) return `ps-lstart:${match[1].replace(/\s+/g, ' ')}`;
    } catch (_) {}
    return null;
}

function readLaunchRecords(workspaceRoot, fsApi) {
    const directory = path.join(workspaceRoot, '.ploinky', 'bwrap-pids');
    let names;
    try {
        names = fsApi.readdirSync(directory);
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        return [{ file: directory, error: error?.code || 'unreadable' }];
    }
    return names.filter((name) => name.endsWith('.pid')).map((name) => {
        const file = path.join(directory, name);
        try {
            const record = JSON.parse(fsApi.readFileSync(file, 'utf8'));
            if (!Number.isSafeInteger(record?.pid) || record.pid <= 0) return { file, error: 'invalid' };
            // Schema 3 records a launch with the host state mask; an older
            // record names an agent of older code that runs without it.
            const masked = record.schemaVersion === 3 && record.hostStateMasked === true;
            return {
                file, pid: record.pid, masked, schemaVersion: record.schemaVersion,
                identity: typeof record.processIdentity === 'string' ? record.processIdentity : '',
            };
        } catch (error) {
            return { file, error: error instanceof SyntaxError ? 'unparseable' : (error?.code || 'unreadable') };
        }
    });
}

/** Host-runtime agents of this workspace that still run, from its launch records. */
export function launchRecordBlockers(workspaceRoot, { fsApi = fs, execFile = execFileSync, kill = (pid, signal) => process.kill(pid, signal) } = {}) {
    const blockers = [];
    for (const record of readLaunchRecords(workspaceRoot, fsApi)) {
        if (record.error) {
            blockers.push({ kind: 'record', pid: null, reason: `the launch record ${record.file} is ${record.error}; inspect and remove it` });
            continue;
        }
        try {
            kill(record.pid, 0);
        } catch (error) {
            if (error?.code === 'ESRCH') continue;
        }
        // A PID that now belongs to another process is not the recorded agent:
        // `linux-proc` start ticks prove that, as does a token of the other
        // kind (the record of an agent inside the Box, read on a macOS host).
        // `ps-lstart` text depends on the locale and time zone of the process
        // that ran ps, so a mismatch there proves nothing and still blocks.
        // A start identity that cannot be read is taken as the agent.
        const current = processIdentity(record.pid, fsApi, execFile);
        if (record.identity && current && current !== record.identity) {
            const kind = (token) => token.slice(0, token.indexOf(':') + 1);
            if (kind(current) !== kind(record.identity) || current.startsWith('linux-proc:')) continue;
        }
        if (record.masked) {
            blockers.push({ kind: 'process', pid: record.pid, reason: `its launch record ${record.file} names a running agent` });
            continue;
        }
        // An agent that runs without the mask can write `.ploinky-box`; it is
        // never excused, only stopped.
        blockers.push({
            kind: 'process', pid: record.pid, excusable: false,
            reason: `its launch record ${record.file} (schema ${record.schemaVersion ?? 'unknown'}) names a running agent that an `
                + 'older Ploinky started without the host state mask; stop that agent (it cannot be excused)',
        });
    }
    return blockers;
}

function describe(blocker) {
    if (blocker.kind === 'container') return `container ${blocker.name || blocker.id.slice(0, 12)}: ${blocker.reason}`;
    if (blocker.pid === null) return blocker.reason;
    return `process ${blocker.pid}: ${blocker.reason}`;
}

/**
 * Builds the gate. `assert(identity, { view })` returns quietly or throws
 * PLOINKY_BOX_HOST_RUNTIME_ACTIVE listing every blocker.
 */
export function createQuiescenceGate({
    platform = process.platform,
    fsApi = fs,
    execFile = execFileSync,
    kill = (pid, signal) => process.kill(pid, signal),
    liveness = createLockLiveness({ platform }),
    allowHostProcesses = [],
} = {}) {
    const allowed = new Set(allowHostProcesses.map(Number));

    // `excludeContainerIds` serves the advisory check a replacement runs
    // before it stops the old Box: that Box is not counted. The full check
    // after the stop decides.
    function assert(identity, { view = [], excludeContainerIds = [] } = {}) {
        const found = [
            ...containerBlockers(identity, view, { excludeContainerIds }),
            ...launchRecordBlockers(identity.workspaceRoot, { fsApi, execFile, kill }),
        ];
        const blocking = [];
        const excused = [];
        for (const blocker of found) {
            if (blocker.kind === 'process' && blocker.excusable !== false && allowed.has(blocker.pid)) {
                const start = liveness.processStart(blocker.pid);
                if (start) {
                    excused.push({ ...blocker, start });
                    continue;
                }
            }
            blocking.push(blocker);
        }
        // An allowance holds only for the exact process seen by this check.
        for (const entry of excused) {
            if (liveness.processStart(entry.pid) !== entry.start) {
                blocking.push({ ...entry, reason: `${entry.reason}; its PID now belongs to another process` });
            }
        }
        if (!blocking.length) return Object.freeze({ excused: Object.freeze(excused.map((entry) => entry.pid)) });
        const pids = blocking.filter((blocker) => blocker.kind === 'process' && blocker.excusable !== false)
            .map((blocker) => blocker.pid);
        throw activeError(
            `Another Ploinky runtime of the workspace ${identity.workspaceRoot} is still running, so the Box cannot be `
            + `created, recreated or adopted now:\n${blocking.map((blocker) => `  - ${describe(blocker)}`).join('\n')}\n`
            + 'Stop those agents and containers (for a Box of this workspace, `ploinky stop`), then run the command again.'
            + (pids.length ? ` A process that is not that agent can be excused with \`--allow-host-process ${pids[0]}\`.` : ''),
            blocking,
        );
    }

    return Object.freeze({ assert });
}
