// `ploinky logs` grammar, target resolution, and source selection.
//
// One parser and one handler serve both entry paths: the lightweight dispatch
// in `cli/index.js`, which must never initialize the workspace, and the
// interactive REPL in `cli/commands/cli.js`, which is already initialized. The
// command is observational: it reads verified descriptors and inspects runtime
// state, but it never creates, repairs, or mutates workspace or runtime state.

import fsDefault from 'node:fs';

import {
    followDescriptor,
    openVerifiedLogFile,
    readLastLinesFromDescriptor,
    routerLogSource,
    runRuntimeLogs,
    sleepUntil,
    writeWithBackpressure,
} from './logUtils.js';
import {
    NO_WAIT_DIR_NAME,
    noWaitRunScopedLogName,
} from './noWaitPaths.js';
import {
    createNoWaitRunBinding,
    observeBoundNoWaitRun,
    readNoWaitRunMarker,
    summarizeNoWaitFailure,
} from './noWaitLogObserver.js';
import { readAgentRegistrySnapshot } from '../utils/agentRegistrySnapshot.js';
import {
    explainAgentReferenceFailure,
    resolveEnabledAgentRecordFromMap,
} from '../utils/agentRegistryResolver.js';
import {
    OCI_LOG_RUNTIMES,
    proveExactOciLogSource,
} from '../sandbox/docker/containerOwnership.js';
import { proveSandboxLogSource } from '../sandbox/sandboxLogFiles.js';
import { LOGS_DIR, RUNNING_DIR } from '../utils/config.js';
import { sanitizeControlDiagnosticText } from '../utils/diagnosticText.js';

export const SANDBOX_LOG_RUNTIMES = Object.freeze(['bwrap', 'seatbelt']);

// Literal unqualified `router` is reserved by the log grammar and always
// selects Router logs, even when an agent alias uses the same spelling.
export const ROUTER_LOG_TARGET = 'router';
export const DEFAULT_LAST_LINES = 200;
export const MAX_LAST_LINES = 10000;
export const TAIL_INITIAL_LINES = 10;

const EXACT_LINE_COUNT = /^[1-9][0-9]*$/;

function writeLogDiagnostic(errorOutput, message) {
    errorOutput.write(`${sanitizeControlDiagnosticText(message)}\n`);
}

export const LOG_USAGE = [
    'Usage:',
    '  logs tail [router|<agent>] [--startup]',
    '  logs last [<count>] [router|<agent>] [--startup]',
    '',
    `<count> is one exact integer between 1 and ${MAX_LAST_LINES}; it defaults to ${DEFAULT_LAST_LINES}.`,
    '--startup follows only the current no-wait startup log and requires an agent reference.',
].join('\n');

export class LogUsageError extends Error {
    constructor(message) {
        super(message);
        this.name = 'LogUsageError';
        this.code = 'LOG_USAGE';
    }
}

// A token that opens like a number is treated as a count attempt so malformed
// counts fail with usage instead of being read as an agent reference.
const COUNT_SHAPED = /^[-+.]?[0-9]/;

function exactLineCount(value) {
    if (!EXACT_LINE_COUNT.test(value)) {
        throw new LogUsageError(`logs last: '${value}' is not one exact line count`);
    }
    const count = Number(value);
    if (!Number.isSafeInteger(count) || count < 1 || count > MAX_LAST_LINES) {
        throw new LogUsageError(`logs last: line count must be between 1 and ${MAX_LAST_LINES}`);
    }
    return count;
}

export function parseLogCommandArgs(args = []) {
    const tokens = Array.isArray(args) ? args.map((token) => String(token)) : [];
    if (tokens[0] !== 'logs') {
        throw new LogUsageError("logs: expected 'logs' as the first command token");
    }
    const subcommand = tokens[1];
    if (subcommand !== 'tail' && subcommand !== 'last') {
        throw new LogUsageError(`logs: unknown subcommand '${subcommand ?? ''}'`);
    }

    let startup = false;
    const positionals = [];
    for (const token of tokens.slice(2)) {
        if (token === '--startup') {
            if (startup) throw new LogUsageError('logs: --startup was supplied more than once');
            startup = true;
            continue;
        }
        if (token.startsWith('-')) {
            throw new LogUsageError(`logs: unknown flag '${token}'`);
        }
        if (!token.trim()) {
            throw new LogUsageError('logs: an empty argument is not one usable target');
        }
        // Neither a line count nor an agent reference may carry surrounding
        // whitespace, so ' 5' fails instead of being coerced or read as a name.
        if (token !== token.trim()) {
            throw new LogUsageError(`logs: '${token}' has surrounding whitespace`);
        }
        positionals.push(token);
    }

    let lineCount = DEFAULT_LAST_LINES;
    let target = ROUTER_LOG_TARGET;
    if (subcommand === 'tail') {
        if (positionals.length > 1) {
            throw new LogUsageError(`logs tail: unexpected argument '${positionals[1]}'`);
        }
        if (positionals.length === 1) target = positionals[0];
    } else if (positionals.length > 2) {
        throw new LogUsageError(`logs last: unexpected argument '${positionals[2]}'`);
    } else if (positionals.length === 2) {
        lineCount = exactLineCount(positionals[0]);
        target = positionals[1];
    } else if (positionals.length === 1) {
        // A number-shaped positional is always a count attempt, so `0`, `-1`,
        // and `1.5` fail as malformed counts instead of silently becoming an
        // agent reference. Anything else is the target.
        if (COUNT_SHAPED.test(positionals[0])) lineCount = exactLineCount(positionals[0]);
        else target = positionals[0];
    }

    const isRouter = target === ROUTER_LOG_TARGET;
    if (startup && isRouter) {
        throw new LogUsageError('logs: --startup requires one agent reference');
    }

    return Object.freeze({
        subcommand,
        target,
        isRouter,
        lineCount,
        initialLines: TAIL_INITIAL_LINES,
        startup,
    });
}

// Router logs are one workspace-owned file. The descriptor stays open for the
// whole read or follow, so replacing `router.log` never redirects the reader.
async function runRouterSource(command, {
    output,
    errorOutput,
    logsDir,
    signal,
    fsApi,
    sleepImpl,
}) {
    let opened;
    try {
        opened = openVerifiedLogFile({ ...routerLogSource({ logsDir }), fsApi });
    } catch (error) {
        writeLogDiagnostic(errorOutput, `logs: ${error.message}`);
        return 1;
    }
    if (!opened) {
        writeLogDiagnostic(errorOutput, `logs: no Router log file exists yet under ${logsDir}.`);
        return 1;
    }
    try {
        if (command.subcommand === 'last') {
            const suffix = readLastLinesFromDescriptor(opened.descriptor, {
                lineCount: command.lineCount,
                fsApi,
            });
            if (suffix.length) await writeWithBackpressure(output, suffix, { signal });
            return 0;
        }
        await followDescriptor(opened.descriptor, {
            initialLines: command.initialLines,
            signal,
            output,
            fsApi,
            sleepImpl,
        });
        return 0;
    } catch (error) {
        if (error?.code === 'LOG_OUTPUT_LIMIT' || error?.code === 'LOG_PATH_UNSAFE') {
            writeLogDiagnostic(errorOutput, `logs: ${error.message}`);
            return 1;
        }
        throw error;
    } finally {
        try { fsApi.closeSync(opened.descriptor); } catch (_) {}
    }
}

function logSourceError(message) {
    const error = new Error(message);
    error.code = 'LOG_SOURCE_UNAVAILABLE';
    return error;
}

function runtimeIdentityTuple(record) {
    const exactText = (value) => (
        typeof value === 'string' && value === value.trim() ? value : ''
    );
    return {
        instanceId: exactText(record?.instanceId),
        enableGeneration: exactText(record?.enableGeneration),
    };
}

function sameRuntimeIdentityTuple(left, right) {
    return left.instanceId === right.instanceId
        && left.enableGeneration === right.enableGeneration;
}

// The one place a runtime source is chosen. A record is only a candidate until
// its runtime proves exact ownership, so nothing here trusts the record alone.
function resolveRuntimeLogSource(containerName, record, ctx) {
    const runtime = String(record?.runtime || '').trim();
    if (OCI_LOG_RUNTIMES.includes(runtime)) {
        return { kind: 'oci', ...ctx.proveOciSource(containerName, record) };
    }
    if (SANDBOX_LOG_RUNTIMES.includes(runtime)) {
        const source = { kind: 'sandbox', ...ctx.proveSandboxSource(containerName, record, ctx) };
        const opened = openVerifiedLogFile({ ...source.fileSpec, fsApi: ctx.fsApi });
        if (!opened) throw logSourceError('the recorded sandbox log file no longer exists');
        return { ...source, opened };
    }
    throw logSourceError(`'${containerName}' records no runtime whose logs can be read`);
}

// A pre-cut record derives a file that was never written, so it is reported as
// needing one operator restart. No legacy name is probed, copied, or inferred.
function defaultSandboxLogSource(containerName, record, ctx) {
    return proveSandboxLogSource(containerName, record, {
        logsDir: ctx.logsDir,
        fsApi: ctx.fsApi,
    });
}

async function emitRuntimeLast(source, command, ctx) {
    if (source.kind === 'oci') {
        return runRuntimeLogs({
            runtime: source.runtime,
            containerId: source.containerId,
            lineCount: command.lineCount,
            output: ctx.output,
            errorOutput: ctx.errorOutput,
            signal: ctx.signal,
            spawnImpl: ctx.spawnImpl,
        });
    }
    const opened = source.opened;
    try {
        const suffix = readLastLinesFromDescriptor(opened.descriptor, {
            lineCount: command.lineCount,
            fsApi: ctx.fsApi,
        });
        if (suffix.length) await writeWithBackpressure(ctx.output, suffix, { signal: ctx.signal });
        return 0;
    } finally {
        try { ctx.fsApi.closeSync(opened.descriptor); } catch (_) {}
    }
}

async function followRuntime(source, command, ctx) {
    if (source.kind === 'oci') {
        return runRuntimeLogs({
            runtime: source.runtime,
            containerId: source.containerId,
            follow: true,
            initialLines: command.initialLines,
            output: ctx.output,
            errorOutput: ctx.errorOutput,
            signal: ctx.signal,
            spawnImpl: ctx.spawnImpl,
        });
    }
    const opened = source.opened;
    try {
        await followDescriptor(opened.descriptor, {
            initialLines: command.initialLines,
            signal: ctx.signal,
            output: ctx.output,
            fsApi: ctx.fsApi,
            sleepImpl: ctx.sleepImpl,
        });
        return 0;
    } finally {
        try { ctx.fsApi.closeSync(opened.descriptor); } catch (_) {}
    }
}

function startupLogSpec(containerName, runId, logsDir) {
    return {
        trustedRoot: logsDir,
        relativeSegments: [NO_WAIT_DIR_NAME, noWaitRunScopedLogName(containerName, runId)],
    };
}

async function emitBoundStartupSuffix(binding, command, ctx, observe, allowedStates = null) {
    // Selection and descriptor acquisition are separate race windows. Fence
    // both sides of the open with the complete immutable observation.
    observe();
    const opened = openVerifiedLogFile({
        ...startupLogSpec(binding.containerName, binding.marker.runId, ctx.logsDir),
        fsApi: ctx.fsApi,
    });
    if (!opened) return false;
    try {
        const fenced = observe();
        if (allowedStates && !allowedStates.includes(fenced.state)) {
            throw logSourceError(
                `the no-wait run for '${binding.containerName}' changed state during startup-log acquisition`,
            );
        }
        const suffix = readLastLinesFromDescriptor(opened.descriptor, {
            lineCount: command.lineCount,
            fsApi: ctx.fsApi,
        });
        if (suffix.length) await writeWithBackpressure(ctx.output, suffix, { signal: ctx.signal });
        return fenced;
    } finally {
        try { ctx.fsApi.closeSync(opened.descriptor); } catch (_) {}
    }
}

async function acquireBoundStartupLog(binding, ctx, observe) {
    while (!ctx.signal?.aborted) {
        const observation = observe();
        const opened = openVerifiedLogFile({
            ...startupLogSpec(binding.containerName, binding.marker.runId, ctx.logsDir),
            fsApi: ctx.fsApi,
        });
        if (opened) {
            try {
                // No byte is emitted until the exact marker, registry tuple,
                // and worker/terminal state are fenced again after open.
                const fenced = observe();
                return { opened, observation: fenced };
            } catch (error) {
                try { ctx.fsApi.closeSync(opened.descriptor); } catch (_) {}
                throw error;
            }
        }
        if (observation.state === 'running' || observation.state === 'failed') {
            throw logSourceError(
                `the terminal no-wait run for '${binding.containerName}' has no exact startup log`,
            );
        }
        await ctx.sleepImpl(100, ctx.signal);
    }
    return { opened: null, observation: null };
}

// FOLLOW_STARTUP. Breaking out of the follow loop on a status transition is an
// internal cancellation: it never touches the operator's signal, so a handoff
// can never be reported as an interrupt.
async function followStartupUntilTerminal(binding, command, ctx, observe) {
    const acquired = await acquireBoundStartupLog(binding, ctx, observe);
    const opened = acquired.opened;
    if (!opened) return { kind: 'cancelled' };
    if (acquired.observation.state === 'running' || acquired.observation.state === 'failed') {
        try {
            const suffix = readLastLinesFromDescriptor(opened.descriptor, {
                lineCount: command.initialLines,
                fsApi: ctx.fsApi,
            });
            if (suffix.length) {
                await writeWithBackpressure(ctx.output, suffix, { signal: ctx.signal });
            }
            return {
                kind: acquired.observation.state,
                status: acquired.observation.status,
                record: acquired.observation.record,
            };
        } finally {
            try { ctx.fsApi.closeSync(opened.descriptor); } catch (_) {}
        }
    }
    let outcome = { kind: 'cancelled' };
    try {
        await followDescriptor(opened.descriptor, {
            initialLines: command.initialLines,
            signal: ctx.signal,
            output: ctx.output,
            fsApi: ctx.fsApi,
            sleepImpl: ctx.sleepImpl,
            onIdle: async () => {
                try {
                    const next = observe();
                    if (next.state === 'running') {
                        outcome = { kind: 'running', status: next.status, record: next.record };
                        return 'stop';
                    }
                    if (next.state === 'failed') {
                        outcome = { kind: 'failed', status: next.status };
                        return 'stop';
                    }
                    return 'continue';
                } catch (error) {
                    outcome = { kind: 'error', error };
                    return 'stop';
                }
            },
        });
        return outcome;
    } finally {
        try { ctx.fsApi.closeSync(opened.descriptor); } catch (_) {}
    }
}

function sourceMatchesRecord(source, record) {
    if (!source || !record || source.runtime !== String(record.runtime || '').trim()) return false;
    if (source.kind === 'oci') {
        return typeof record.containerId === 'string'
            && source.containerId === record.containerId;
    }
    if (source.kind === 'sandbox') {
        return typeof record.pid === 'number' && source.pid === record.pid;
    }
    return false;
}

function closeUnconsumedRuntimeSource(source, ctx) {
    if (source?.kind !== 'sandbox' || !source.opened) return;
    try { ctx.fsApi.closeSync(source.opened.descriptor); } catch (_) {}
}

function staleInitialObservation(error) {
    return error?.code === 'PROCESS_IDENTITY_STALE'
        || error?.code === 'NO_WAIT_OBSERVATION_STALE';
}

async function runAgentSource(command, ctx) {
    let registry;
    try {
        registry = ctx.readRegistrySnapshot();
    } catch (error) {
        writeLogDiagnostic(ctx.errorOutput, `logs: ${error.message}`);
        return 1;
    }

    // RESOLVE_TARGET. The operator reference is resolved exactly once; every
    // later lookup uses the canonical registry key.
    let resolved;
    try {
        resolved = resolveEnabledAgentRecordFromMap(command.target, registry);
    } catch (error) {
        writeLogDiagnostic(ctx.errorOutput, `logs: ${error.message}`);
        return 1;
    }
    if (!resolved) {
        const failure = explainAgentReferenceFailure(command.target, registry);
        writeLogDiagnostic(ctx.errorOutput, `logs: ${failure.message}.`);
        const suggestions = failure.suggestions || [];
        if (suggestions.length) {
            const omitted = Number(failure.omittedSuggestionCount) || 0;
            writeLogDiagnostic(
                ctx.errorOutput,
                `logs: enabled agents: ${suggestions.join(', ')}${omitted ? ` … (+${omitted} more)` : ''}`,
            );
        }
        return 1;
    }

    // SNAPSHOT_IDENTITY.
    const containerName = resolved.containerName;
    const boundTuple = runtimeIdentityTuple(resolved.record);

    // Re-reads the registry by canonical key only and proves the generation
    // this command bound to is still the current one.
    const revalidateBinding = () => {
        const current = ctx.readRegistrySnapshot();
        const record = current[containerName];
        if (!record || record.type !== 'agent') {
            throw logSourceError(`'${containerName}' is no longer an enabled agent`);
        }
        if (!sameRuntimeIdentityTuple(runtimeIdentityTuple(record), boundTuple)) {
            throw logSourceError(`the runtime generation for '${containerName}' changed during observation`);
        }
        return record;
    };

    // Runtime ownership proof can perform an external inspect or pin a file
    // descriptor. Fence the registry again before any bytes are emitted so a
    // same-tuple runtime-field replacement cannot race source acquisition.
    const proveCurrentRuntime = () => {
        let source;
        try {
            source = resolveRuntimeLogSource(containerName, revalidateBinding(), ctx);
            const current = revalidateBinding();
            if (!sourceMatchesRecord(source, current)) {
                throw logSourceError(
                    `the runtime source for '${containerName}' changed during source acquisition`,
                );
            }
            return source;
        } catch (error) {
            closeUnconsumedRuntimeSource(source, ctx);
            throw error;
        }
    };

    // Runtime-first `last` never consults no-wait state after exact runtime
    // ownership succeeds.
    let initialRuntimeError = null;
    if (!command.startup && command.subcommand === 'last') {
        try {
            const runtimeSource = proveCurrentRuntime();
            return emitRuntimeLastGuarded(runtimeSource, command, ctx);
        } catch (error) {
            initialRuntimeError = error;
        }
    }

    let marker = null;
    try {
        marker = readNoWaitRunMarker(containerName, {
            runningDir: ctx.runningDir,
            fsApi: ctx.fsApi,
        });
    } catch (error) {
        writeLogDiagnostic(ctx.errorOutput, `logs: ${error.message}`);
        return 1;
    }

    const binding = marker ? createNoWaitRunBinding(containerName, resolved.record, marker) : null;
    const observe = () => observeBoundNoWaitRun(binding, {
        runningDir: ctx.runningDir,
        fsApi: ctx.fsApi,
        nowMs: ctx.nowMs(),
        proveWorkerProcess: ctx.proveWorkerProcess,
        readRegistrySnapshot: ctx.readRegistrySnapshot,
    });

    let observation = null;
    let observationError = null;
    if (marker) {
        try {
            observation = observe();
        } catch (error) {
            observationError = error;
        }
    }

    if (observationError && !staleInitialObservation(observationError)) {
        writeLogDiagnostic(ctx.errorOutput, `logs: ${observationError.message}`);
        return 1;
    }

    if (command.startup) {
        return runStartupOnly(containerName, {
            binding, marker, observation, observationError, command, ctx, observe,
        });
    }

    const proveRuntime = (record = null) => resolveRuntimeLogSource(
        containerName,
        record || revalidateBinding(),
        ctx,
    );

    if (command.subcommand === 'last') {
        // A verified runtime wins regardless of stale, starting, or failed
        // no-wait files.
        if (observation?.state === 'running') {
            // The current run published `running`, so the registry record must
            // already name a provable runtime. A mismatch is a protocol failure.
            writeLogDiagnostic(
                ctx.errorOutput,
                `logs: '${containerName}' published 'running' but its runtime could not be proved: ${initialRuntimeError.message}`,
            );
            return 1;
        }
        if (observation?.state === 'starting' || observation?.state === 'pending'
            || observation?.state === 'failed') {
            let fenced;
            try {
                const allowedStates = observation.state === 'failed'
                    ? ['failed']
                    : ['pending', 'starting'];
                fenced = await emitBoundStartupSuffix(binding, command, ctx, observe, allowedStates);
            } catch (error) {
                writeLogDiagnostic(ctx.errorOutput, `logs: ${error.message}`);
                return 1;
            }
            if (!fenced) {
                writeLogDiagnostic(ctx.errorOutput, `logs: the current startup log for '${containerName}' is not present`);
                return 1;
            }
            if (fenced.state === 'failed') {
                writeLogDiagnostic(ctx.errorOutput, `logs: '${containerName}' failed to start — ${summarizeNoWaitFailure(fenced.status)}`);
                return 1;
            }
            return 0;
        }
        writeLogDiagnostic(
            ctx.errorOutput,
            `logs: no exact log source is available for '${containerName}': ${(observationError || initialRuntimeError)?.message || 'no current run and no proved runtime'}`,
        );
        return 1;
    }

    // `logs tail`. A live current worker outranks any predecessor runtime so a
    // slow start is observable from its first line.
    if (observation?.state === 'starting' || observation?.state === 'pending') {
        let followed;
        try {
            followed = await followStartupUntilTerminal(binding, command, ctx, observe);
        } catch (error) {
            writeLogDiagnostic(ctx.errorOutput, `logs: ${error.message}`);
            return 1;
        }
        if (followed.kind === 'running') {
            let runtimeSource;
            try {
                runtimeSource = proveRuntime(followed.record);
                const finalObservation = observe();
                if (finalObservation.state !== 'running'
                    || !sourceMatchesRecord(runtimeSource, finalObservation.record)) {
                    throw logSourceError(
                        `the runtime source for '${containerName}' changed during the final handoff fence`,
                    );
                }
            } catch (error) {
                closeUnconsumedRuntimeSource(runtimeSource, ctx);
                writeLogDiagnostic(
                    ctx.errorOutput,
                    `logs: '${containerName}' published 'running' but its runtime could not be proved: ${error.message}`,
                );
                return 1;
            }
            writeLogDiagnostic(ctx.errorOutput, `logs: '${containerName}' is running; following its application output.`);
            return followRuntimeGuarded(runtimeSource, command, ctx);
        }
        if (followed.kind === 'failed') {
            writeLogDiagnostic(ctx.errorOutput, `logs: '${containerName}' failed to start — ${summarizeNoWaitFailure(followed.status)}`);
            return 1;
        }
        if (followed.kind === 'error') {
            writeLogDiagnostic(ctx.errorOutput, `logs: ${followed.error.message}`);
            return 1;
        }
        if (followed.kind === 'cancelled') return 0;
    }

    if (observation?.state === 'running') {
        let runtimeSource;
        try {
            runtimeSource = proveRuntime(observation.record);
            const finalObservation = observe();
            if (finalObservation.state !== 'running'
                || !sourceMatchesRecord(runtimeSource, finalObservation.record)) {
                throw logSourceError(
                    `the runtime source for '${containerName}' changed during the final handoff fence`,
                );
            }
        } catch (error) {
            closeUnconsumedRuntimeSource(runtimeSource, ctx);
            writeLogDiagnostic(
                ctx.errorOutput,
                `logs: '${containerName}' published 'running' but its runtime could not be proved: ${error.message}`,
            );
            return 1;
        }
        return followRuntimeGuarded(runtimeSource, command, ctx);
    }

    let runtimeSource = null;
    let runtimeError = null;
    try {
        runtimeSource = proveCurrentRuntime();
    } catch (error) {
        runtimeError = error;
    }
    if (runtimeSource) {
        return followRuntimeGuarded(runtimeSource, command, ctx);
    }
    if (observation?.state === 'failed') {
        try {
            if (!await emitBoundStartupSuffix(binding, command, ctx, observe, ['failed'])) {
                throw logSourceError(`the terminal no-wait run for '${containerName}' has no exact startup log`);
            }
        } catch (error) {
            writeLogDiagnostic(ctx.errorOutput, `logs: ${error.message}`);
            return 1;
        }
        writeLogDiagnostic(ctx.errorOutput, `logs: '${containerName}' failed to start — ${summarizeNoWaitFailure(observation.status)}`);
        return 1;
    }
    writeLogDiagnostic(
        ctx.errorOutput,
        `logs: no exact log source is available for '${containerName}': ${(observationError || runtimeError)?.message || 'no current run and no proved runtime'}`,
    );
    return 1;
}

// `--startup` never selects or hands off to application runtime output.
async function runStartupOnly(containerName, {
    binding, marker, observation, observationError, command, ctx, observe,
}) {
    if (!marker || observationError || !observation) {
        writeLogDiagnostic(
            ctx.errorOutput,
            `logs: '${containerName}' has no current no-wait run to follow: ${observationError?.message || 'no run marker is present'}`,
        );
        return 1;
    }
    if (command.subcommand === 'last') {
        let fenced;
        try {
            fenced = await emitBoundStartupSuffix(binding, command, ctx, observe);
        } catch (error) {
            writeLogDiagnostic(ctx.errorOutput, `logs: ${error.message}`);
            return 1;
        }
        if (!fenced) {
            writeLogDiagnostic(ctx.errorOutput, `logs: the current startup log for '${containerName}' is not present`);
            return 1;
        }
        if (fenced.state === 'failed') {
            writeLogDiagnostic(ctx.errorOutput, `logs: '${containerName}' failed to start — ${summarizeNoWaitFailure(fenced.status)}`);
            return 1;
        }
        return 0;
    }
    let followed;
    try {
        followed = await followStartupUntilTerminal(binding, command, ctx, observe);
    } catch (error) {
        writeLogDiagnostic(ctx.errorOutput, `logs: ${error.message}`);
        return 1;
    }
    if (followed.kind === 'failed') {
        writeLogDiagnostic(ctx.errorOutput, `logs: '${containerName}' failed to start — ${summarizeNoWaitFailure(followed.status)}`);
        return 1;
    }
    if (followed.kind === 'error') {
        writeLogDiagnostic(ctx.errorOutput, `logs: ${followed.error.message}`);
        return 1;
    }
    return 0;
}

async function emitRuntimeLastGuarded(source, command, ctx) {
    try {
        return await emitRuntimeLast(source, command, ctx);
    } catch (error) {
        writeLogDiagnostic(ctx.errorOutput, `logs: ${error.message}`);
        return 1;
    }
}

async function followRuntimeGuarded(source, command, ctx) {
    try {
        return await followRuntime(source, command, ctx);
    } catch (error) {
        writeLogDiagnostic(ctx.errorOutput, `logs: ${error.message}`);
        return 1;
    }
}

export async function runLogCommand(args = [], {
    output = process.stdout,
    errorOutput = process.stderr,
    readRegistrySnapshot = readAgentRegistrySnapshot,
    workspaceRoot,
    logsDir = LOGS_DIR,
    runningDir = RUNNING_DIR,
    signal,
    fsApi = fsDefault,
    sleepImpl = sleepUntil,
    spawnImpl,
    nowMs = () => Date.now(),
    proveOciSource = proveExactOciLogSource,
    proveSandboxSource = defaultSandboxLogSource,
    proveWorkerProcess,
} = {}) {
    let command;
    try {
        command = parseLogCommandArgs(args);
    } catch (error) {
        errorOutput.write(`${sanitizeControlDiagnosticText(error.message)}\n${LOG_USAGE}\n`);
        return 1;
    }

    if (command.isRouter) {
        return runRouterSource(command, { output, errorOutput, logsDir, signal, fsApi, sleepImpl });
    }

    return runAgentSource(command, {
        output,
        errorOutput,
        logsDir,
        runningDir,
        signal,
        fsApi,
        sleepImpl,
        spawnImpl,
        nowMs,
        proveOciSource,
        proveSandboxSource,
        proveWorkerProcess,
        readRegistrySnapshot: () => readRegistrySnapshot(workspaceRoot ? { workspaceRoot } : {}),
    });
}
