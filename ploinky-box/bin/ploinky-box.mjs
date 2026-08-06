#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { parseOuterArguments } from '../command/parse.mjs';
import { routeOuterCommand } from '../command/route.mjs';
import { executeProcess } from '../command/execute.mjs';
import { BOX_LABELS } from '../constants.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { createBoxSupervisor, formatBoxStatus } from '../supervisor.mjs';
import { isInsideBox } from '../lib/boxMarker.mjs';

const TERMINAL_DIMENSION_LIMIT = 65_535;
const INTERACTIVE_SIGNAL_CODES = Object.freeze({
    SIGHUP: 129,
    SIGINT: 130,
    SIGTERM: 143,
});
const INTERACTIVE_SIGNALS = Object.freeze(Object.keys(INTERACTIVE_SIGNAL_CODES));
const DEFAULT_DETACH_KEYS = 'ctrl-p,ctrl-q';

function terminalError(message, code = 'PLOINKY_BOX_TERMINAL_UNAVAILABLE', cause) {
    return new PloinkyBoxError(message, { code, cause });
}

function terminalDimension(value, label) {
    if (!Number.isSafeInteger(value) || value < 1 || value > TERMINAL_DIMENSION_LIMIT) {
        throw terminalError(
            `Interactive outer Box ${label} must be in range 1..${TERMINAL_DIMENSION_LIMIT}`,
        );
    }
    return value;
}

export function admitInteractiveTerminal(input, output, errorOutput) {
    if (input?.isTTY !== true || output?.isTTY !== true
        || typeof input.setRawMode !== 'function'
        || typeof input.on !== 'function'
        || typeof output.write !== 'function'
        || typeof errorOutput?.write !== 'function') {
        throw terminalError(
            'Interactive outer Box commands require TTY stdin/stdout with raw-mode support; no host CLI fallback is permitted',
        );
    }
    return Object.freeze({
        rows: terminalDimension(output.rows, 'terminal row count'),
        columns: terminalDimension(output.columns, 'terminal column count'),
    });
}

function addSignalListener(source, event, listener) {
    if (!source || typeof source.on !== 'function') {
        throw terminalError('Interactive outer Box signal handling is unavailable');
    }
    source.on(event, listener);
    return () => {
        if (typeof source.off === 'function') source.off(event, listener);
        else source.removeListener?.(event, listener);
    };
}

async function runInteractiveSession({
    supervisor,
    prepared,
    argv,
    shell,
    input,
    output,
    errorOutput,
    terminal,
    signalSource,
    callerSignal,
    resizeDebounceMs,
    timeoutMs,
    inactivityTimeoutMs,
}) {
    if (!Number.isSafeInteger(resizeDebounceMs)
        || resizeDebounceMs < 0 || resizeDebounceMs > 5_000) {
        throw terminalError('Interactive terminal resize debounce must be in range 0..5000ms');
    }
    if (callerSignal !== null && callerSignal !== undefined
        && typeof callerSignal.addEventListener !== 'function') {
        throw terminalError(
            'Interactive outer Box caller cancellation requires an AbortSignal',
            'PLOINKY_BOX_HOST_CONTROL_INVALID',
        );
    }
    if (callerSignal?.aborted) {
        throw terminalError(
            'Interactive outer Box session was cancelled before streaming',
            'PLOINKY_BOX_INTERACTIVE_CANCELLED',
            callerSignal.reason,
        );
    }

    const cancellation = new AbortController();
    const removers = [];
    const previousRawMode = input.isRaw === true;
    let rawModeAttempted = false;
    let resizeTimer = null;
    let resizeController = null;
    let resizeFailure = null;
    let receivedSignal = null;
    let callerCancellation = null;
    let latestSize = terminal;
    let sessionInitialSize = null;
    const resizeOperations = new Set();

    const abortWith = (error) => {
        if (!cancellation.signal.aborted) cancellation.abort(error);
    };
    const scheduleResize = () => {
        if (resizeTimer !== null) clearTimeout(resizeTimer);
        resizeTimer = setTimeout(() => {
            resizeTimer = null;
            if (!resizeController || cancellation.signal.aborted) return;
            const operation = Promise.resolve()
                .then(() => resizeController.resize(latestSize.rows, latestSize.columns))
                .catch((error) => {
                    resizeFailure = terminalError(
                        `Interactive outer Box resize failed: ${error.message}`,
                        'PLOINKY_BOX_INTERACTIVE_RESIZE_FAILED',
                        error,
                    );
                    abortWith(resizeFailure);
                })
                .finally(() => resizeOperations.delete(operation));
            resizeOperations.add(operation);
        }, resizeDebounceMs);
    };
    const onResize = () => {
        try {
            latestSize = Object.freeze({
                rows: terminalDimension(output.rows, 'terminal row count'),
                columns: terminalDimension(output.columns, 'terminal column count'),
            });
        } catch (error) {
            resizeFailure = error;
            abortWith(error);
            return;
        }
        scheduleResize();
    };
    const onSession = (controller) => {
        if (!controller || typeof controller !== 'object'
            || typeof controller.resize !== 'function') {
            throw terminalError(
                'Interactive Podman exec did not expose its exact-session resize controller',
                'PLOINKY_BOX_INTERACTIVE_SESSION_INVALID',
            );
        }
        resizeController = controller;
        if (sessionInitialSize
            && (latestSize.rows !== sessionInitialSize.rows
                || latestSize.columns !== sessionInitialSize.columns)) {
            scheduleResize();
        }
    };

    try {
        removers.push(addSignalListener(signalSource, 'SIGWINCH', onResize));
        for (const name of INTERACTIVE_SIGNALS) {
            removers.push(addSignalListener(signalSource, name, () => {
                if (receivedSignal === null) receivedSignal = name;
                abortWith(terminalError(
                    `Interactive outer Box session cancelled by local ${name}`,
                    'PLOINKY_BOX_INTERACTIVE_SIGNAL',
                ));
            }));
        }
        if (callerSignal) {
            const onCallerAbort = () => {
                callerCancellation = callerSignal.reason || terminalError(
                    'Interactive outer Box session cancelled by its caller',
                    'PLOINKY_BOX_INTERACTIVE_CANCELLED',
                );
                abortWith(callerCancellation);
            };
            callerSignal.addEventListener('abort', onCallerAbort, { once: true });
            removers.push(() => callerSignal.removeEventListener('abort', onCallerAbort));
            if (callerSignal.aborted) onCallerAbort();
        }

        latestSize = Object.freeze({
            rows: terminalDimension(output.rows, 'terminal row count'),
            columns: terminalDimension(output.columns, 'terminal column count'),
        });
        sessionInitialSize = latestSize;
        rawModeAttempted = true;
        input.setRawMode(true);
        const result = await supervisor.executeInteractiveCommand(prepared, argv, {
            interactive: true,
            shell,
            tty: true,
            stdin: input,
            stdout: output,
            stderr: errorOutput,
            rows: latestSize.rows,
            columns: latestSize.columns,
            detachKeys: DEFAULT_DETACH_KEYS,
            signal: cancellation.signal,
            timeoutMs,
            inactivityTimeoutMs,
            onSession,
        });
        if (resizeOperations.size > 0) {
            await Promise.allSettled([...resizeOperations]);
        }
        if (receivedSignal !== null) return INTERACTIVE_SIGNAL_CODES[receivedSignal];
        if (resizeFailure) throw resizeFailure;
        if (callerCancellation) throw callerCancellation;
        if (!result || typeof result !== 'object'
            || !Number.isSafeInteger(result.exitCode)
            || typeof result.detached !== 'boolean') {
            throw terminalError(
                'Interactive outer Box execution returned an invalid settlement',
                'PLOINKY_BOX_INTERACTIVE_SESSION_INVALID',
            );
        }
        if (result.detached) {
            errorOutput.write(
                'ploinky: detached from the Box session; the remote process exit status is not available.\n',
            );
            return 0;
        }
        return result.exitCode;
    } catch (error) {
        if (receivedSignal !== null) return INTERACTIVE_SIGNAL_CODES[receivedSignal];
        if (resizeFailure) throw resizeFailure;
        if (callerCancellation) throw callerCancellation;
        throw error;
    } finally {
        if (resizeTimer !== null) clearTimeout(resizeTimer);
        if (resizeOperations.size > 0) {
            await Promise.allSettled([...resizeOperations]);
        }
        for (const remove of removers.reverse()) remove();
        if (rawModeAttempted) {
            try {
                input.setRawMode(previousRawMode);
            } catch (error) {
                throw terminalError(
                    `Interactive terminal raw mode could not be restored: ${error.message}`,
                    'PLOINKY_BOX_TERMINAL_RESTORE_FAILED',
                    error,
                );
            }
        }
    }
}

export function publicUsageText() {
    return `ploinky - run Ploinky through its managed outer Box

Usage: ploinky [--debug] [--dry-run] [--port PORT]
               [--local-release-descriptor JSON]
               [--] COMMAND [ARGS]

Commands:
  ploinky                         Prepare the Box and open the Ploinky REPL
  ploinky start AGENT [PORT]      Start the graph; the host port defaults to 8080
  ploinky status                  Inspect Box and core state without mutation
  ploinky stop                    Stop core services and the outer Box
  ploinky destroy                 Remove the outer Box after confirmation; retain data volumes
  ploinky destroy --delete-volumes
                                  Remove the outer Box and its data volumes without prompting
  ploinky cli                     Open Bash in the Box
  ploinky cli AGENT --workdir PATH -- [PROVIDER_ARGS]
                                  Run an agent CLI in an existing non-root workspace directory
  ploinky help                    Show this help without engine discovery

Public image, engine, instance-name, and master-key overrides are intentionally unsupported.
The local release descriptor admits one exact Box/Node/AgentLib generation without
pulling, building, retagging, or falling back, and owns both host publications.
If .ploinky/edge-desired.json exists, start stages it as the host-owned routing/security authority.
`;
}

async function defaultConfirmDestroy(instance, { input, output }) {
    const terminal = createInterface({ input, output });
    try {
        const answer = await terminal.question(`Destroy outer Box ${instance} and retain its named volumes? [y/N] `);
        return /^y(?:es)?$/i.test(answer.trim());
    } finally {
        terminal.close();
    }
}

function outerDebug(parsed, route, stdout) {
    if (!parsed.debug.enabled) return;
    if (['help', 'status', 'stop', 'destroy', 'bash', 'dry-run'].includes(route.kind)) {
        stdout.write('[INFO] Debug mode enabled.\n');
    }
}

export async function runOuterCli(argv, {
    env = process.env,
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
    supervisor,
    execute = executeProcess,
    confirmDestroy = defaultConfirmDestroy,
    detectInsideBox = isInsideBox,
    signalSource = process,
    callerSignal = null,
    resizeDebounceMs = 75,
    interactiveTimeoutMs = 1_800_000,
    interactiveInactivityTimeoutMs = 300_000,
} = {}) {
    if (detectInsideBox()) {
        return execute('/opt/ploinky/bin/ploinky-local', [...argv], { env });
    }
    const selectedSupervisor = supervisor || createBoxSupervisor();
    const parsed = parseOuterArguments(argv);
    const route = routeOuterCommand(parsed);
    outerDebug(parsed, route, output);

    if (route.kind === 'help') {
        output.write(publicUsageText());
        return 0;
    }
    if (route.kind === 'status') {
        const status = await selectedSupervisor.inspectBoxStatus();
        const container = status.ownership?.handles?.container;
        if (status.state === 'running-initialized' && container) {
            const coreStatus = await selectedSupervisor.executeCommand({
                containerId: container.id,
                engine: status.ownership.engine,
                ownership: status.ownership,
                journal: status.ownership.journal,
                hostClient: status.ownership.hostClient,
                hostPort: Number(container.labels?.[BOX_LABELS.routerHostPort]),
            }, ['/opt/ploinky/bin/ploinky-local', 'status']);
            if (coreStatus === 0) return 0;
            output.write(formatBoxStatus(status));
            return coreStatus;
        }
        output.write(formatBoxStatus(status));
        return ['foreign', 'incompatible', 'unknown', 'unsupported'].includes(status.state) ? 1 : 0;
    }
    if (route.kind === 'stop') {
        await selectedSupervisor.runStopTransaction();
        return 0;
    }
    if (route.kind === 'destroy') {
        const status = await selectedSupervisor.inspectBoxStatus();
        const container = status.ownership?.handles?.container;
        const volumes = status.ownership?.handles?.volumes;
        if (!container && !(route.deleteVolumes && volumes)) {
            output.write(formatBoxStatus(status));
            return ['foreign', 'incompatible', 'unknown', 'unsupported'].includes(status.state) ? 1 : 0;
        }
        if (!route.deleteVolumes) {
            const confirmed = await confirmDestroy(status.identity.instance, { input, output });
            if (!confirmed) {
                output.write('Destroy cancelled; no resources changed.\n');
                return 0;
            }
        }
        await selectedSupervisor.runDestroyTransaction(container?.id || null, {
            deleteVolumes: route.deleteVolumes,
        });
        if (route.deleteVolumes) {
            output.write(`Ploinky Box ${status.identity.instance} and its named volumes were deleted.\n`);
        }
        return 0;
    }
    if (route.kind === 'dry-run') {
        const plan = await selectedSupervisor.planDryRun({
            explicitPort: route.hostPort,
            ...(route.localReleaseDescriptor
                ? { releaseDescriptor: route.localReleaseDescriptor }
                : {}),
        });
        output.write(`${JSON.stringify(plan, null, 2)}\n`);
        return 0;
    }
    if (route.kind === 'start') {
        if (String(env.PLOINKY_AGENTLIB_REF || '').trim()) {
            throw new Error(
                'PLOINKY_AGENTLIB_REF is not an outer Box override; select AgentLib only through --local-release-descriptor.',
            );
        }
        await selectedSupervisor.runStartTransaction(route.coreArgv, {
            explicitPort: route.hostPort,
            ...(route.localReleaseDescriptor
                ? { releaseDescriptor: route.localReleaseDescriptor }
                : {}),
        });
        return 0;
    }

    const interactive = ['bash', 'repl', 'agent-cli'].includes(route.kind);
    const terminal = interactive
        ? admitInteractiveTerminal(input, output, errorOutput)
        : null;
    if (interactive) {
        if (callerSignal !== null && callerSignal !== undefined
            && typeof callerSignal.addEventListener !== 'function') {
            throw terminalError(
                'Interactive outer Box caller cancellation requires an AbortSignal',
                'PLOINKY_BOX_HOST_CONTROL_INVALID',
            );
        }
        if (callerSignal?.aborted) {
            throw terminalError(
                'Interactive outer Box session was cancelled before preparation',
                'PLOINKY_BOX_INTERACTIVE_CANCELLED',
                callerSignal.reason,
            );
        }
    }
    const prepared = await selectedSupervisor.prepareBoxForCommand(
        route.localReleaseDescriptor
            ? { releaseDescriptor: route.localReleaseDescriptor }
            : {},
    );
    if (route.kind === 'bash') {
        return runInteractiveSession({
            supervisor: selectedSupervisor,
            prepared,
            argv: [],
            shell: true,
            input,
            output,
            errorOutput,
            terminal,
            signalSource,
            callerSignal,
            resizeDebounceMs,
            timeoutMs: interactiveTimeoutMs,
            inactivityTimeoutMs: interactiveInactivityTimeoutMs,
        });
    }
    if (interactive) {
        return runInteractiveSession({
            supervisor: selectedSupervisor,
            prepared,
            argv: ['/opt/ploinky/bin/ploinky-local', ...route.coreArgv],
            shell: false,
            input,
            output,
            errorOutput,
            terminal,
            signalSource,
            callerSignal,
            resizeDebounceMs,
            timeoutMs: interactiveTimeoutMs,
            inactivityTimeoutMs: interactiveInactivityTimeoutMs,
        });
    }
    return selectedSupervisor.executeCommand(
        prepared,
        ['/opt/ploinky/bin/ploinky-local', ...route.coreArgv],
        { interactive: false },
    );
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = await runOuterCli(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`ploinky: ${error.message}\n`);
        process.exitCode = 1;
    }
}
