// Process-specific runtime logs for Bubblewrap and Seatbelt sandboxes.
//
// The former producers wrote `<agentName>-bwrap.log` / `<agentName>-seatbelt.log`
// in append mode. Two aliases of one manifest shared a file, and so did two
// generations of one alias, so a reader could not tell whose output it was
// looking at. Worse, during staging a fresh identity tuple briefly coexists
// with the predecessor's pid, so a name derived from identity alone could point
// a new generation at an old process's log.
//
// Binding the file name to the canonical container key, the exact runtime
// identity tuple, and the finalized child pid removes all three problems: a
// file can only exist if that exact launch created it. That is also what lets
// the reader address a stopped post-cut sandbox without any new registry field
// or persisted index.
//
// This is a hard cut. Nothing here probes, migrates, or infers a legacy name.

import crypto from 'node:crypto';
import fsDefault from 'node:fs';
import pathDefault from 'node:path';
import { ensureVerifiedProducerDirectory } from '../utils/verifiedReadOnlyFile.js';
import { openVerifiedRegularFile } from '../utils/verifiedReadOnlyFile.js';
import { readLastLinesFromDescriptor } from '../commands/logUtils.js';

export const SANDBOX_LOG_DIR_NAME = 'agents';
export const SANDBOX_LOG_FILE_MODE = 0o600;
export const SANDBOX_LOG_DIR_MODE = 0o700;
export const SANDBOX_LOG_RUNTIMES = Object.freeze(['bwrap', 'seatbelt']);
export const SANDBOX_CRASH_LOG_BYTE_LIMIT = 64 * 1024;

const SAFE_CONTAINER_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function sandboxLogError(message, { restartRequired = false } = {}) {
    const error = new Error(message);
    error.code = restartRequired ? 'SANDBOX_LOG_RESTART_REQUIRED' : 'SANDBOX_LOG_UNAVAILABLE';
    return error;
}

export function assertSafeContainerName(containerName, subject = 'sandbox log') {
    const name = String(containerName || '');
    if (!SAFE_CONTAINER_NAME.test(name)) {
        throw sandboxLogError(`${subject} requires one safe canonical container name`);
    }
    return name;
}

export function exactSandboxRuntimeTuple(record, subject = 'sandbox log') {
    const instanceId = typeof record?.instanceId === 'string'
        && record.instanceId === record.instanceId.trim() ? record.instanceId : '';
    const enableGeneration = typeof record?.enableGeneration === 'string'
        && record.enableGeneration === record.enableGeneration.trim() ? record.enableGeneration : '';
    if (!instanceId || !enableGeneration) {
        throw sandboxLogError(`${subject} requires one exact runtime identity tuple`);
    }
    return { instanceId, enableGeneration };
}

export function exactSandboxPid(value, subject = 'sandbox log') {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
        throw sandboxLogError(`${subject} requires one positive finalized process id`);
    }
    return value;
}

// The pid participates so a staged record, which carries a fresh tuple next to
// the predecessor's pid, can never derive the new process's file name.
export function sandboxLogIdentityDigest({ instanceId, enableGeneration, pid }) {
    const tuple = exactSandboxRuntimeTuple({ instanceId, enableGeneration });
    const exactPid = exactSandboxPid(pid);
    return crypto.createHash('sha256')
        .update(`${tuple.instanceId}\0${tuple.enableGeneration}\0${exactPid}`)
        .digest('hex');
}

export function sandboxLogFileName(containerName, digest) {
    const name = assertSafeContainerName(containerName);
    if (!/^[0-9a-f]{64}$/.test(String(digest || ''))) {
        throw sandboxLogError('sandbox log requires one 64-hex identity digest');
    }
    return `${name}.${digest}.log`;
}

export function sandboxLogRelativeSegments(containerName, digest) {
    return [SANDBOX_LOG_DIR_NAME, sandboxLogFileName(containerName, digest)];
}

export function sandboxLogPath(containerName, digest, { logsDir } = {}) {
    return pathDefault.join(logsDir, ...sandboxLogRelativeSegments(containerName, digest));
}

// Producer side. The temporary file is created exclusively at 0600 before the
// spawn, handed to the child as its combined stdout/stderr, and published at
// its identity-derived name through a no-replace hard link as soon as the child
// pid is known. The child keeps its own descriptor, so publication never
// interrupts its output.
export function openSandboxLogHandle({
    containerName,
    logsDir,
    workspaceRoot,
    fsApi = fsDefault,
    pathApi = pathDefault,
    uniqueSuffix = () => crypto.randomBytes(12).toString('hex'),
} = {}) {
    const name = assertSafeContainerName(containerName);
    const producerRoot = workspaceRoot || pathApi.dirname(logsDir);
    const logsRelative = pathApi.relative(producerRoot, pathApi.resolve(logsDir));
    if (!logsRelative || logsRelative.startsWith('..') || pathApi.isAbsolute(logsRelative)) {
        throw sandboxLogError('sandbox log directory is outside its producer root');
    }
    const directory = ensureVerifiedProducerDirectory({
        trustedRoot: producerRoot,
        relativeSegments: [...logsRelative.split(pathApi.sep), SANDBOX_LOG_DIR_NAME],
        mode: SANDBOX_LOG_DIR_MODE,
        fsApi,
        pathApi,
    });

    const temporaryPath = pathApi.join(directory, `${name}.pending-${uniqueSuffix()}.log`);
    const noFollow = fsApi.constants?.O_NOFOLLOW ?? 0;
    const createExclusive = (fsApi.constants?.O_WRONLY ?? 0)
        | (fsApi.constants?.O_CREAT ?? 0)
        | (fsApi.constants?.O_EXCL ?? 0)
        | noFollow;
    let descriptor;
    let openedIdentity;
    try {
        descriptor = fsApi.openSync(temporaryPath, createExclusive, SANDBOX_LOG_FILE_MODE);
        openedIdentity = fsApi.fstatSync(descriptor);
        if (!openedIdentity.isFile()) {
            throw sandboxLogError('sandbox log producer did not open one regular file');
        }
    } catch (error) {
        if (descriptor !== undefined) {
            try { fsApi.closeSync(descriptor); } catch (_) {}
        }
        // Without a descriptor identity, deleting by name could remove a file
        // replaced by another process. Preserve an ambiguous pending path and
        // fail closed instead.
        if (openedIdentity) {
            try {
                const current = fsApi.lstatSync(temporaryPath);
                if (current.dev === openedIdentity.dev && current.ino === openedIdentity.ino) {
                    fsApi.unlinkSync(temporaryPath);
                }
            } catch (_) {}
        }
        throw error;
    }

    let closed = false;
    let finalPath = null;
    let committed = false;
    const closeParent = () => {
        if (closed) return;
        closed = true;
        try { fsApi.closeSync(descriptor); } catch (_) {}
    };

    const unlinkOwned = (target) => {
        if (!target) return;
        let stat;
        try { stat = fsApi.lstatSync(target); } catch (error) {
            if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return;
            throw error;
        }
        if (stat.dev !== openedIdentity.dev || stat.ino !== openedIdentity.ino) {
            throw sandboxLogError(`refusing to remove a replaced sandbox log '${target}'`);
        }
        fsApi.unlinkSync(target);
    };

    return {
        descriptor,
        temporaryPath,
        // One descriptor carries both streams so interleaved sandbox output
        // keeps a single append offset.
        stdio: ['ignore', descriptor, descriptor],
        finalize(pid, runtimeIdentity) {
            const digest = sandboxLogIdentityDigest({
                instanceId: runtimeIdentity?.instanceId,
                enableGeneration: runtimeIdentity?.enableGeneration,
                pid,
            });
            finalPath = pathApi.join(directory, sandboxLogFileName(name, digest));
            let linked = false;
            try {
                fsApi.linkSync(temporaryPath, finalPath);
                linked = true;
                fsApi.unlinkSync(temporaryPath);
                return finalPath;
            } catch (error) {
                if (linked) {
                    try { unlinkOwned(finalPath); } catch (_) {}
                }
                try { unlinkOwned(temporaryPath); } catch (_) {}
                throw error;
            } finally {
                closeParent();
            }
        },
        commit() {
            committed = true;
        },
        discard() {
            closeParent();
            try { unlinkOwned(temporaryPath); } catch (_) {}
            if (!committed) {
                try { unlinkOwned(finalPath); } catch (_) {}
            }
        },
    };
}

// Reader side. A derived file can only exist if that exact container, tuple,
// and finalized pid produced it, so its presence is the ownership proof. A
// pre-cut record derives a name that was never written and is reported as
// needing one operator restart instead of falling back to a legacy file.
export function proveSandboxLogSource(containerName, record, {
    logsDir,
    fsApi = fsDefault,
    pathApi = pathDefault,
} = {}) {
    const name = assertSafeContainerName(containerName, `sandbox logs for '${containerName}'`);
    const runtime = String(record?.runtime || '').trim();
    if (!SANDBOX_LOG_RUNTIMES.includes(runtime)) {
        throw sandboxLogError(`'${name}' does not record one supported sandbox runtime`);
    }
    const tuple = exactSandboxRuntimeTuple(record, `sandbox logs for '${name}'`);
    const pid = exactSandboxPid(record?.pid, `sandbox logs for '${name}'`);
    const digest = sandboxLogIdentityDigest({ ...tuple, pid });
    const relativeSegments = sandboxLogRelativeSegments(name, digest);
    const filePath = pathApi.join(logsDir, ...relativeSegments);

    let stat = null;
    try {
        stat = fsApi.lstatSync(filePath);
    } catch (error) {
        if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') {
            throw sandboxLogError(`sandbox log for '${name}' is unreadable: ${error?.message || error}`);
        }
    }
    if (!stat) {
        throw sandboxLogError(
            `'${name}' has no process-specific sandbox log for its recorded identity; `
            + 'restart the agent to produce one',
            { restartRequired: true },
        );
    }
    if (!stat.isFile()) {
        throw sandboxLogError(`sandbox log for '${name}' is not one regular file`);
    }

    return Object.freeze({
        runtime,
        pid,
        path: filePath,
        fileSpec: { trustedRoot: logsDir, relativeSegments },
    });
}

export function readSandboxCrashLog(containerName, record, {
    logsDir,
    fsApi = fsDefault,
    pathApi = pathDefault,
} = {}) {
    const source = proveSandboxLogSource(containerName, record, { logsDir, fsApi, pathApi });
    const opened = openVerifiedRegularFile({ ...source.fileSpec, fsApi, pathApi });
    if (!opened) return '';
    try {
        return readLastLinesFromDescriptor(opened.descriptor, {
            lineCount: 12,
            byteLimit: SANDBOX_CRASH_LOG_BYTE_LIMIT,
            fsApi,
        }).toString('utf8').trim();
    } finally {
        try { fsApi.closeSync(opened.descriptor); } catch (_) {}
    }
}
