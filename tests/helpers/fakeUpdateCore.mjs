import fs from 'node:fs';
import path from 'node:path';

import {
    buildUpdateResult,
    createOperationRecord,
    updateReportPath,
    writeUpdateReport,
} from '../../cli/commands/updateOutcome.js';

export function verifiedRecord(id = 'fixture-repo', extra = {}) {
    return createOperationRecord({ phase: 'registered-repository', id, outcome: 'unchanged', required: true, ...extra });
}

/**
 * A stand-in for the update-specific bounded runner. It plays the in-Box core:
 * echoes the expected context and publishes one report for the nonce (or the
 * requested malformed variant), then returns what the runner would report.
 */
export function fakeUpdateCore({
    onCall = null,
    records = () => [verifiedRecord()],
    report = 'valid',
    status = null,
    cause = 'exited',
    signal = null,
    quiescence = 'confirmed',
    quiescenceDetail = '',
    resultExtra = null,
} = {}) {
    return async (engine, containerId, argv, hostPort, mediaHostPort, runner, options) => {
        await onCall?.({ engine, containerId, argv: [...argv], hostPort, mediaHostPort, options });
        const ploinkyDir = path.join(options.workspaceRoot, '.ploinky');
        const context = JSON.parse(JSON.stringify(options.reportContext));
        const selected = typeof records === 'function' ? records({ argv, options }) : records;
        const result = {
            ...buildUpdateResult({ command: argv, records: selected, context }),
            ...(typeof resultExtra === 'function' ? resultExtra({ argv, options }) : resultExtra || {}),
        };
        const mode = typeof report === 'function' ? report({ argv, options }) : report;
        if (mode === 'valid') {
            writeUpdateReport(ploinkyDir, options.reportNonce, result);
        } else if (mode === 'wrong-nonce') {
            writeUpdateReport(ploinkyDir, 'f'.repeat(32), result);
        } else if (mode === 'wrong-context') {
            writeUpdateReport(ploinkyDir, options.reportNonce, { ...result, context: { ...context, box: { containerId: 'other' } } });
        } else if (mode === 'inconsistent') {
            writeUpdateReport(ploinkyDir, options.reportNonce, { ...result, exitCode: result.exitCode ? 0 : 1 });
        } else if (mode === 'truncated' || mode === 'duplicate') {
            const target = updateReportPath(ploinkyDir, options.reportNonce);
            fs.mkdirSync(path.dirname(target), { recursive: true });
            const envelope = JSON.stringify({ schema: 'ploinky-update-report', version: 1, nonce: options.reportNonce, result });
            fs.writeFileSync(target, mode === 'truncated' ? envelope.slice(0, 40) : `${envelope}\n${envelope}\n`, { mode: 0o600 });
        }
        return {
            cause,
            status: status === null ? (cause === 'exited' && !signal ? result.exitCode : null) : status,
            signal,
            clientExited: true,
            escalation: cause === 'exited' ? null : 'SIGTERM',
            outputBytes: 0,
            tails: { stdout: '', stderr: '' },
            quiescence: { state: quiescence, method: 'fixture', detail: quiescenceDetail },
        };
    };
}

/**
 * A stand-in for the bounded update-restart runner that delegates to a
 * generic core-command fake: a throw is a failed restart, a return is a
 * normal exit whose end the engine confirmed.
 */
export function fakeRestartCore(runCoreCommand, { quiescence = 'confirmed', cause = 'exited', status = 0 } = {}) {
    return async (...args) => {
        await runCoreCommand?.(...args);
        return {
            cause,
            status,
            signal: null,
            clientExited: true,
            escalation: cause === 'exited' ? null : 'SIGKILL',
            tails: { stdout: '', stderr: '' },
            quiescence: { state: quiescence, method: 'fixture', detail: quiescence === 'confirmed' ? '' : 'engine unavailable' },
        };
    };
}
