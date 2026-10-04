// Child-process driver for noWaitLateOutcomeActivation.test.mjs (not a test file).
// Usage: node noWaitLateOutcomeActivationDriver.mjs '<json options>'
//
// Writes one terminal `failed` status through the real writeNoWaitWorkerStatus
// of cli/commands/noWaitWorker.js and blocks synchronously at options.pauseAt so
// the parent can SIGKILL it at exactly that point:
//
//   beforeCanonicalRename   the canonical temp is written and fsynced, nothing is renamed
//   betweenRenames          the canonical file is renamed and durable; the run-scoped temp is not yet created
//   beforeRunScopedRename   the run-scoped temp is written and fsynced, strictly before its renameSync
//
// A pause writes <signalDir>/paused.<name> first. It prints one JSON line when it completes.

import fs from 'node:fs';
import path from 'node:path';

const options = JSON.parse(process.argv[2]);
const { containerName, runId, runningDir, signalDir, pauseAt, identity, payload } = options;
const statusDir = path.join(runningDir, 'no-wait');
const canonical = path.join(statusDir, `${containerName}.json`);
const runScoped = path.join(statusDir, `${containerName}.${runId}.json`);

function pause(name) {
    fs.writeFileSync(path.join(signalDir, `paused.${name}`), String(process.pid));
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
}

const descriptors = new Map();
const fsApi = {
    ...fs,
    constants: fs.constants,
    openSync(target, flags, mode) {
        const text = String(target);
        if (pauseAt === 'betweenRenames' && text.startsWith(`${runScoped}.`) && text.endsWith('.tmp')) pause('betweenRenames');
        const descriptor = fs.openSync(target, flags, mode);
        descriptors.set(descriptor, text);
        return descriptor;
    },
    fsyncSync(descriptor) {
        fs.fsyncSync(descriptor);
        const text = descriptors.get(descriptor) || '';
        if (pauseAt === 'beforeCanonicalRename' && text.startsWith(`${canonical}.`)) pause('beforeCanonicalRename');
        if (pauseAt === 'beforeRunScopedRename' && text.startsWith(`${runScoped}.`)) pause('beforeRunScopedRename');
    },
    renameSync(from, to) {
        return fs.renameSync(from, to);
    },
};

const { writeNoWaitWorkerStatus } = await import(new URL('../../cli/commands/noWaitWorker.js', import.meta.url).href);
try {
    const result = writeNoWaitWorkerStatus(containerName, payload, {
        identity,
        runId,
        runStartedAtMs: identity.runStartedAtMs,
        waveIndex: identity.waveIndex,
        statusFile: runScoped,
        runningDir,
        fsApi,
    });
    process.stdout.write(`${JSON.stringify({ ok: true, result })}\n`);
} catch (error) {
    process.stdout.write(`${JSON.stringify({ ok: false, code: error?.code ?? null, message: String(error?.message || error) })}\n`);
    process.exitCode = 1;
}
