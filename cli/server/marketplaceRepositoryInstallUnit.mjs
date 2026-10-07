import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const INSTALL_PROCESS = fileURLToPath(new URL('./marketplaceRepositoryInstallProcess.mjs', import.meta.url));
export const INSTALL_BWRAP = '/usr/bin/bwrap';
export const INSTALL_FRAME_BYTES = 8 * 1024 * 1024;
export const installUnitError = (predicate = 'install-protocol') => Object.assign(new Error('Repository installation unit is unproven.'), {
    code: 'PLOINKY_MARKETPLACE_REPOSITORY_RECOVERY_REQUIRED', recoveryRequired: true,
    diagnostic: { predicate },
});

export function installBootstrapEnvironment(operationId) {
    if (!/^[a-f0-9-]{36}$/.test(operationId || '')) throw installUnitError();
    return { PATH: '/usr/local/bin:/usr/bin:/bin', LANG: 'C.UTF-8',
        PLOINKY_MARKETPLACE_REPOSITORY_OPERATION: operationId };
}

export function installUnitArguments({ workspaceRoot, cwd, executable = process.execPath }) {
    if (typeof workspaceRoot !== 'string' || workspaceRoot === '/' || !path.isAbsolute(workspaceRoot)
        || path.normalize(workspaceRoot) !== workspaceRoot || typeof cwd !== 'string' || !path.isAbsolute(cwd)
        || typeof executable !== 'string' || !path.isAbsolute(executable)) throw installUnitError();
    return ['--unshare-user', '--unshare-pid', '--ro-bind', '/', '/', '--proc', '/proc', '--dev', '/dev',
        '--tmpfs', '/tmp', '--bind', workspaceRoot, workspaceRoot, '--chdir', cwd,
        '--info-fd', '3', '--block-fd', '4', '--sync-fd', '5', '--', executable, INSTALL_PROCESS];
}

// Exactly one bounded frame may be buffered. Parsing never retains exception text.
export function readInstallFrames(stream, onFrame, onFailure, limit = INSTALL_FRAME_BYTES, onEnd = () => {}) {
    let bytes = Buffer.alloc(0);
    let failed = false;
    const fail = () => { if (!failed) { failed = true; onFailure(installUnitError()); } };
    stream.on('data', chunk => {
        if (failed) return;
        if (bytes.length + chunk.length > limit) { fail(); return; }
        bytes = Buffer.concat([bytes, chunk]);
        let end;
        while (!failed && (end = bytes.indexOf(10)) !== -1) {
            const line = bytes.subarray(0, end);
            bytes = bytes.subarray(end + 1);
            try {
                if (!line.length || !Buffer.from(line.toString('utf8')).equals(line)) throw installUnitError();
                const frame = JSON.parse(line.toString('utf8'));
                if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw installUnitError();
                onFrame(frame);
            } catch (_) { fail(); }
        }
    });
    stream.on('error', fail);
    stream.on('end', () => {
        if (bytes.length) fail();
        else if (!failed) {
            try { onEnd(); } catch (_) { fail(); }
        }
    });
    return () => { failed = true; bytes = Buffer.alloc(0); };
}

export function writeInstallFrame(stream, frame) {
    const data = Buffer.from(`${JSON.stringify(frame)}\n`);
    if (data.length > INSTALL_FRAME_BYTES || !stream?.writable || stream.destroyed) throw installUnitError();
    stream.write(data);
}

function deferred() {
    let resolve;
    let reject;
    const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
    promise.catch(() => {});
    return { promise, resolve, reject };
}

export function createRepositoryInstallUnit({ operationId, workspaceRoot, cwd, spawnProcess = spawn,
    executable = process.execPath, onFailure = () => {} } = {}) {
    const ready = deferred();
    const outcome = deferred();
    const ended = deferred();
    let state = 'starting';
    let info;
    let helperReady = false;
    let monitorClosed = false;
    let syncClosed = false;
    let protocolClosed = false;
    let released = false;
    const child = spawnProcess(INSTALL_BWRAP, installUnitArguments({ workspaceRoot, cwd, executable }), {
        cwd, shell: false, env: installBootstrapEnvironment(operationId),
        stdio: ['pipe', 'pipe', 'pipe', 'pipe', 'pipe', 'pipe'],
    });
    const fail = () => {
        if (state === 'failed' || state === 'closed') return;
        state = 'failed';
        const error = installUnitError();
        ready.reject(error); outcome.reject(error); ended.reject(error);
        try { onFailure(error); } catch (_) { /* Failure notification has no cleanup authority. */ }
    };
    const prepared = () => {
        if (state === 'starting' && info && helperReady) {
            state = 'ready';
            ready.resolve(Object.freeze({ launcherPid: child.pid, initPid: info }));
        }
    };
    const complete = () => {
        if (state !== 'failed' && released && monitorClosed && syncClosed && protocolClosed) {
            state = 'closed'; ended.resolve();
        }
    };
    let information = '';
    child.stdio[3].on('data', chunk => {
        if (information.length + chunk.length > 4096) { fail(); return; }
        information += chunk.toString('utf8');
    });
    child.stdio[3].on('end', () => {
        try {
            const value = JSON.parse(information);
            if (!Number.isSafeInteger(value['child-pid']) || value['child-pid'] <= 0 || value['child-pid'] > 2147483647) throw installUnitError();
            info = value['child-pid'];
            prepared();
        } catch (_) { fail(); }
    });
    child.stdio[3].on('error', fail);
    const stopFrames = readInstallFrames(child.stdout, frame => {
        if (frame.operationId !== operationId) throw installUnitError();
        if (frame.type === 'ready' && state === 'starting' && !helperReady && Object.keys(frame).length === 2) {
            helperReady = true; prepared();
        } else if (frame.type === 'barrier' && state === 'running' && Object.keys(frame).length === 3
            && frame.outcome && typeof frame.outcome.ok === 'boolean') {
            state = 'barrier'; outcome.resolve(frame.outcome);
        } else throw installUnitError();
    }, fail, INSTALL_FRAME_BYTES, () => {
        if (!released) { fail(); return; }
        protocolClosed = true; complete();
    });
    child.stdout.on('close', () => { if (!protocolClosed) fail(); });
    child.stdin.on('error', fail);
    child.stderr.resume();
    child.stdio[5].on('data', fail);
    child.stdio[5].on('end', () => { syncClosed = true; if (!released) fail(); else complete(); });
    child.stdio[5].on('error', fail);
    child.once('error', fail);
    child.once('exit', (code, signal) => {
        if (!released || code !== 0 || signal) { fail(); return; }
        monitorClosed = true; complete();
    });
    child.stdio[4].on('error', fail);
    child.stdio[4].end('1');
    return {
        ready: ready.promise,
        run(operation, environment) {
            if (state !== 'ready') throw installUnitError();
            state = 'running';
            writeInstallFrame(child.stdin, { type: 'run', operationId, operation, environment, workspaceRoot });
            return outcome.promise;
        },
        release() {
            if (!['ready', 'barrier'].includes(state) || released) throw installUnitError();
            released = true; state = 'releasing';
            writeInstallFrame(child.stdin, { type: 'release', operationId });
            return ended.promise;
        },
        close() {
            stopFrames();
            for (const stream of child.stdio) stream?.destroy();
        },
    };
}
