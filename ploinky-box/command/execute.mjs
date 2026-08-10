import os from 'node:os';
import { spawn, spawnSync } from 'node:child_process';

import { buildEngineProcessEnvironment } from '../process.mjs';
import { parseHostPort } from '../ports.mjs';

function signalExitCode(signal) {
    const number = os.constants.signals[signal];
    return Number.isInteger(number) ? 128 + number : 1;
}

export function buildContainerExecArgs(containerId, commandArgv, {
    hostPort,
    mediaHostPort,
    interactive = false,
    inputIsTty = false,
    outputIsTty = false,
    shell = false,
    logStream = false,
    colorOutput = false,
} = {}) {
    const args = ['container', 'exec'];
    if (logStream) {
        args.push('--interactive');
    } else if (interactive && inputIsTty && outputIsTty) {
        args.push('--interactive', '--tty');
    }
    args.push(
        '--env', `PLOINKY_ROUTER_HOST_PORT=${parseHostPort(hostPort, {
            source: 'prepared Box host port',
        })}`,
        '--env', `PLOINKY_MEDIA_HOST_PORT=${parseHostPort(mediaHostPort, {
            source: 'prepared Box media host port',
        })}`,
        ...(logStream ? ['--env', 'PLOINKY_BOX_LOG_STREAM=1'] : []),
        ...(colorOutput === true ? ['--env', 'PLOINKY_COLOR=1'] : []),
        '--user', 'podman',
        '--workdir', '/workspace',
        containerId,
        shell ? '/bin/bash' : '/opt/ploinky/bin/ploinky-local',
        ...commandArgv,
    );
    return args;
}

export function executeProcess(command, args, {
    env = buildEngineProcessEnvironment(),
    spawnSyncImpl = spawnSync,
} = {}) {
    const result = spawnSyncImpl(command, args, {
        stdio: 'inherit',
        env,
    });
    if (Number.isInteger(result.status)) return result.status;
    if (result.signal) return signalExitCode(result.signal);
    return 1;
}

// Streaming routes cannot use the synchronous primitive: a `logs tail` child
// runs until the operator interrupts it, and `spawnSync` blocks the event loop
// so this process could neither observe nor forward that signal. This variant
// owns exactly one child, forwards SIGINT/SIGTERM to it, waits for its close so
// no in-Box follower is orphaned, and removes its handlers exactly once.
export function executeProcessStreaming(command, args, {
    env = buildEngineProcessEnvironment(),
    spawnImpl = spawn,
    processRef = process,
    forwardedSignals = ['SIGINT', 'SIGTERM'],
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    termTimeoutMs = 2_000,
    killTimeoutMs = 1_000,
} = {}) {
    return new Promise((resolve, reject) => {
        let child;
        try {
            child = spawnImpl(command, args, { stdio: ['pipe', 'inherit', 'inherit'], env });
        } catch (error) {
            reject(error);
            return;
        }

        let settled = false;
        let operatorSignal = '';
        let termTimer = null;
        let killTimer = null;
        let killSent = false;
        let onChildError = null;
        let onChildClose = null;
        let onStdinError = null;
        const handlers = new Map();
        const removeHandlers = () => {
            for (const [signal, handler] of handlers) {
                try { processRef.removeListener(signal, handler); } catch (_) {}
            }
            handlers.clear();
            if (termTimer !== null) clearTimeoutImpl(termTimer);
            if (killTimer !== null) clearTimeoutImpl(killTimer);
            termTimer = null;
            killTimer = null;
            if (onChildError) child.removeListener?.('error', onChildError);
            if (onChildClose) child.removeListener?.('close', onChildClose);
            if (onStdinError) child.stdin?.removeListener?.('error', onStdinError);
            onChildError = null;
            onChildClose = null;
            onStdinError = null;
        };
        const forceKill = () => {
            if (settled || killSent) return;
            killSent = true;
            try { child.kill('SIGKILL'); } catch (_) {}
            if (settled) return;
            killTimer = setTimeoutImpl(() => {
                if (settled) return;
                try { child.stdin?.destroy?.(); } catch (_) {}
                try { child.stdout?.destroy?.(); } catch (_) {}
                try { child.stderr?.destroy?.(); } catch (_) {}
                try { child.unref?.(); } catch (_) {}
                const error = new Error('Box log child did not exit after signal and SIGKILL');
                error.code = 'PLOINKY_BOX_STREAM_CLEANUP_FAILED';
                settle(reject, error);
            }, killTimeoutMs);
        };
        const settle = (finish, value) => {
            if (settled) return;
            settled = true;
            removeHandlers();
            finish(value);
        };

        for (const signal of forwardedSignals) {
            const handler = () => {
                // The operator's intent decides the exit code even when the
                // child then exits cleanly on its own cancellation path.
                if (operatorSignal) {
                    forceKill();
                    return;
                }
                operatorSignal = signal;
                try { child.stdin?.end?.(); } catch (_) {}
                try { child.kill(signal); } catch (_) {}
                if (!settled) termTimer = setTimeoutImpl(forceKill, termTimeoutMs);
            };
            handlers.set(signal, handler);
            processRef.on(signal, handler);
        }

        onChildError = (error) => {
            // Signal delivery can itself surface an error. After operator
            // cancellation begins, only close or the bounded TERM/KILL
            // cleanup deadline may settle the command; otherwise an early
            // rejection could leave the in-Box follower alive.
            if (operatorSignal) return;
            settle(reject, error);
        };
        onChildClose = (code, signal) => {
            if (operatorSignal) {
                settle(resolve, signalExitCode(operatorSignal));
                return;
            }
            if (Number.isInteger(code)) {
                settle(resolve, code);
                return;
            }
            settle(resolve, signal ? signalExitCode(signal) : 1);
        };
        // This stdin is a private cancellation pipe, not application input.
        // EPIPE after the in-Box command closes it is therefore non-terminal,
        // but it still needs a listener so it cannot become an uncaught error.
        onStdinError = () => {};
        child.stdin?.on?.('error', onStdinError);
        child.on('error', onChildError);
        child.once('close', onChildClose);
    });
}
