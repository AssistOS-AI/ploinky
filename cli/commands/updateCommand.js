import { PLOINKY_DIR } from '../utils/config.js';
import {
    acquireWorkspaceMutationLease,
    assertWorkspaceMutationLease,
    releaseWorkspaceMutationLease,
    runWithWorkspaceMutationLease,
} from '../utils/runtime/maintenanceLocks.js';
import { isInsideBoxRuntime } from '../../agentlib/bootstrap.mjs';
import { parseUpdateRequest } from './updateRequest.js';
import { UPDATE_REPORT_CONTEXT_ENV, UPDATE_REPORT_NONCE_ENV, writeUpdateReport } from './updateOutcome.js';
import { appendUpdateRecords, buildCoreUpdateResult, commandErrorRecord } from './updateRecords.js';
import { printUpdateSummary } from './updateSummary.js';
import { withUpdateSkillScopes } from './updateGraph.js';
import { updateAllRepos, updatePloinkyRepos, updateRepoResult } from './repoAgentCommands.js';
import { UpdateCancelledError, createUpdateCancellation } from './updateCancellation.js';

// The core `ploinky update` command boundary.
//
// Every form is parsed once, runs under the workspace mutation lease and ends
// as one structured result: a thrown error becomes a record, the exit status
// and activation eligibility come from the records, and a host-requested
// report is published exactly once before anything is printed.
//
// Lock order: the host holds its workspace authority, then this in-Box lease,
// then repository/common-Git locks. A lease capability already held by the
// caller is validated and reused, never re-acquired. The wait is bounded well
// below the host's in-Box command timeout.
//
// Cancellation: from the moment it holds the lease until its report is
// published the update owns SIGINT/SIGTERM. A signal stops it at the next
// checkpoint, after the step in progress released its locks, and ends it with
// a failed `cancelled` record; a signal after the last checkpoint still blocks
// activation, and one that arrives after the result was decided ends the
// process by its default action.

export const UPDATE_LEASE_WAIT_MS = 5 * 60 * 1000;
export const IN_BOX_ACTIVATION_NOTICE = 'This update ran inside the Box: activate it from the host with `ploinky update` or `ploinky restart`.';

const LOCK_BUSY_CODES = new Set(['workspace_mutation_lock_timeout', 'PLOINKY_WORKSPACE_MUTATION_BUSY']);

// The host exec's this update into the exact Box container named by the
// report context, after listing every container of this workspace under its
// workspace lock. Its checkout and skill-export locks bind to that Box run.
export function boxRunFromReportContext(context, { insideBox }) {
    const workspace = context?.workspace?.instance;
    const containerId = context?.box?.containerId;
    if (!insideBox || typeof workspace !== 'string' || !workspace || typeof containerId !== 'string') return null;
    const listed = context.box.workspaceContainers;
    return Object.freeze({
        workspace,
        containerId,
        engine: typeof context.box.engine === 'string' ? context.box.engine : '',
        soleContainer: Array.isArray(listed) && listed.length === 1 && listed[0] === containerId,
    });
}

export function readReportRequest(env = process.env) {
    const nonce = String(env[UPDATE_REPORT_NONCE_ENV] || '').trim();
    if (!nonce) return null;
    let context = null;
    try {
        const raw = env[UPDATE_REPORT_CONTEXT_ENV];
        context = raw === undefined ? null : JSON.parse(raw);
    } catch (_) {
        // Published with a null context; the host rejects the mismatch.
        context = null;
    }
    return { nonce, context };
}

function cancelledRecord(error) {
    return commandErrorRecord(error, { code: 'cancelled' });
}

const isCancelledResult = result => Boolean(result?.records?.some(record => record.phase === 'command' && record.code === 'cancelled'));

function thrownRecord(error) {
    if (error instanceof UpdateCancelledError) return cancelledRecord(error);
    if (LOCK_BUSY_CODES.has(error?.code)) {
        return commandErrorRecord(error, { outcome: 'uncertain', code: 'lock-busy' });
    }
    if (String(error?.code || '').startsWith('PLOINKY_UPDATE_')) {
        // Request/scope rejection before any mutation.
        return commandErrorRecord(error, { outcome: 'failed' });
    }
    // An unexpected throw may have happened after mutations began.
    return commandErrorRecord(error, { outcome: 'uncertain', attempted: true, code: String(error?.code || 'update-threw') });
}

export async function runUpdateCommand(normalizedOptions = [], options = {}) {
    const cancellation = createUpdateCancellation();
    let result = null;
    try {
        result = await runUpdate(normalizedOptions, { ...options, cancellation });
        return result;
    } finally {
        await cancellation.dispose({ reported: isCancelledResult(result) });
    }
}

async function runUpdate(normalizedOptions, {
    agentLibBranchPolicy = null,
    interactiveSession = false,
    env = process.env,
    insideBox = isInsideBoxRuntime(),
    workspaceMutationLease = null,
    ploinkyDir = PLOINKY_DIR,
    leaseWaitMs = UPDATE_LEASE_WAIT_MS,
    handlers = { updateAllRepos, updatePloinkyRepos, updateRepoResult },
    log = console.log,
    error: logError = console.error,
    cancellation,
}) {
    const args = normalizedOptions.map(value => String(value ?? ''));
    const command = ['update', ...args];
    const reportRequest = readReportRequest(env);
    let result;
    let releaseFailed = false;
    try {
        const request = parseUpdateRequest(args);
        let lease = null;
        let ownsLease = false;
        if (workspaceMutationLease) {
            lease = assertWorkspaceMutationLease(workspaceMutationLease);
        } else {
            lease = await acquireWorkspaceMutationLease({ operation: 'update', waitTimeoutMs: leaseWaitMs });
            ownsLease = true;
        }
        cancellation.arm();
        try {
            const boxRun = boxRunFromReportContext(reportRequest?.context, { insideBox });
            const options = { interactiveSession, agentLibBranchPolicy, command, cancellation, boxRun,
                delegatedWorkspacePloinkyPath: reportRequest?.context?.source?.workspacePloinky?.delegatedBoxRepoPath || null };
            // Git pin refresh inside the update reuses this lease.
            result = await runWithWorkspaceMutationLease(lease, () => withUpdateSkillScopes(
                reportRequest?.context?.source?.skillScopes,
                async () => {
                    if (request.kind === 'repos') return handlers.updatePloinkyRepos(options);
                    if (request.kind === 'repo') return handlers.updateRepoResult(request.repoName, { command, cancellation, boxRun });
                    return handlers.updateAllRepos(request.folderPath || undefined, options);
                },
            ));
        } finally {
            if (ownsLease && !releaseWorkspaceMutationLease(lease)) releaseFailed = true;
        }
        if (releaseFailed) {
            result = appendUpdateRecords(result, [commandErrorRecord(
                new Error('the workspace mutation lease for this update could not be released exactly'),
                { outcome: 'uncertain', code: 'recovery-required' },
            )]);
        }
    } catch (error) {
        const records = [...(Array.isArray(error?.records) ? error.records : []), thrownRecord(error)];
        result = buildCoreUpdateResult({ command, records });
    }
    const lateSignal = await cancellation.signalReceived();
    if (lateSignal && !isCancelledResult(result)) {
        result = appendUpdateRecords(result, [cancelledRecord(new UpdateCancelledError(lateSignal, 'activation'))]);
    }
    result.command = command;
    if (insideBox && !reportRequest) log(IN_BOX_ACTIVATION_NOTICE);
    if (reportRequest) {
        result.context = reportRequest.context;
        try {
            writeUpdateReport(ploinkyDir, reportRequest.nonce, result);
        } catch (publishError) {
            logError(`[update] The update report could not be published: ${publishError?.message || publishError}`);
            result = appendUpdateRecords(result, [commandErrorRecord(publishError, {
                outcome: 'uncertain', attempted: true, code: 'report-publication-failed',
            })]);
        }
    }
    printUpdateSummary(result, { log, error: logError, hostPhase: Boolean(reportRequest) });
    return result;
}
