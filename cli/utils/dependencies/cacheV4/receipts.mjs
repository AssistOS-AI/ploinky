// Writer and reader identities, and quiescence proofs, for cache receipts.
//
// A receipt names who may still be writing or reading an object. TTLs are
// diagnostic only: a receipt is removable only with positive proof that its
// writer/consumer tree is quiescent. PID absence is proof only inside the same
// boot and PID namespace; container installers and consumers need the engine
// to positively report the container absent. Anything unproven is retained.

import fs from 'node:fs';
import os from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';

import { readProcessStartIdentity } from '../../../sandbox/processIdentity.js';

export function readBootScope({ platform = process.platform, fsApi = fs, execFileSyncImpl = execFileSync } = {}) {
    try {
        if (platform === 'linux') {
            const bootId = fsApi.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
            const pidNamespace = fsApi.readlinkSync('/proc/self/ns/pid');
            if (bootId && pidNamespace) return JSON.stringify(['linux', bootId, pidNamespace]);
        } else if (platform === 'darwin') {
            const bootTime = execFileSyncImpl('/usr/sbin/sysctl', ['-n', 'kern.boottime'], {
                encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1_000,
            }).trim();
            if (bootTime) return JSON.stringify(['darwin', os.hostname(), bootTime]);
        }
    } catch { /* unknown scope */ }
    return '';
}

export function currentWriterIdentity({ pid = process.pid } = {}) {
    return { pid, processStart: readProcessStartIdentity(pid), bootScope: readBootScope() };
}

function processAlive(pid) {
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; }
    catch (error) { return error?.code === 'EPERM'; }
}

/** Positive proof that a recorded process identity has ended in this scope. */
export function processIdentityEnded(identity, {
    bootScope = readBootScope(),
    isAlive = processAlive,
    startIdentity = (pid) => readProcessStartIdentity(pid),
} = {}) {
    if (!identity || !Number.isSafeInteger(identity.pid)) return { ended: false, reason: 'no process identity recorded' };
    if (!identity.bootScope || !bootScope || identity.bootScope !== bootScope) {
        return { ended: false, reason: 'different or unknown boot/PID namespace scope' };
    }
    if (!isAlive(identity.pid)) return { ended: true, reason: 'process absent in the same scope' };
    const current = startIdentity(identity.pid);
    if (identity.processStart && current && identity.processStart !== current) {
        return { ended: true, reason: 'PID reused by a different process' };
    }
    return { ended: false, reason: 'process alive' };
}

export function defaultInspectContainer({ engine, name }) {
    if (!engine || !name) return 'unknown';
    const result = spawnSync(engine, ['container', 'inspect', '--format', '{{.Id}}', name], {
        encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 15_000,
    });
    if (result.error) return 'unknown';
    if (result.status === 0) return 'present';
    return /no such (container|object)|does not exist/i.test(String(result.stderr || '')) ? 'absent' : 'unknown';
}

/**
 * Quiescence of a build receipt: the builder process ended in this scope and
 * every installer it launched is provably stopped. Host npm descendants are
 * not tracked by the synchronous adapter, so a host build that reached its
 * installer stays unproven unless a caller-provided proof says otherwise.
 */
export function defaultProveBuildQuiescent(receipt, {
    inspectContainer = defaultInspectContainer,
    proveHostInstaller = null,
    ...identityOptions
} = {}) {
    const writer = processIdentityEnded(receipt?.writer, identityOptions);
    if (!writer.ended) return { quiescent: false, reason: `writer: ${writer.reason}` };
    const installer = receipt?.installer || null;
    if (!installer || !receipt.installerStarted) return { quiescent: true, reason: 'writer ended before any installer started' };
    if (installer.kind === 'container-npm') {
        const state = inspectContainer({ engine: installer.engine, name: installer.containerName });
        return state === 'absent'
            ? { quiescent: true, reason: 'writer ended and installer container absent' }
            : { quiescent: false, reason: `installer container ${state}` };
    }
    if (typeof proveHostInstaller === 'function') {
        const proof = proveHostInstaller(receipt);
        return proof?.quiescent ? { quiescent: true, reason: proof.reason || 'host installer proven stopped' }
            : { quiescent: false, reason: proof?.reason || 'host installer not proven stopped' };
    }
    return { quiescent: false, reason: `${installer.kind} descendants cannot be proven stopped` };
}

/** Quiescence of a reader receipt's consumer. */
export function defaultProveReaderQuiescent(receipt, {
    inspectContainer = defaultInspectContainer,
    ...identityOptions
} = {}) {
    const consumer = receipt?.consumer || {};
    // Absence of the future container is expected before creation, not proof
    // that the launcher (or a surviving engine client) will never create it.
    // Only lifecycle settlement may retire this reservation. Writer PID death
    // alone does not prove its descendants quiescent.
    if (consumer.engine && !consumer.containerId && ['preparing', 'creating'].includes(consumer.phase)) {
        return { quiescent: false, reason: 'consumer creation has not settled' };
    }
    // Only engine consumers are containers; host sandboxes also carry their
    // registration's container name but are proven through their process.
    if (consumer.engine && (consumer.containerName || consumer.containerId)) {
        const state = inspectContainer({ engine: consumer.engine, name: consumer.containerId || consumer.containerName });
        return state === 'absent'
            ? { quiescent: true, reason: 'consumer container absent' }
            : { quiescent: false, reason: `consumer container ${state}` };
    }
    if (consumer.process) {
        const ended = processIdentityEnded(consumer.process, identityOptions);
        return ended.ended ? { quiescent: true, reason: ended.reason } : { quiescent: false, reason: `consumer: ${ended.reason}` };
    }
    return { quiescent: false, reason: 'consumer identity is not provable' };
}
