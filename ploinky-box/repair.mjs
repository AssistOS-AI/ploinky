import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { diagnoseWorkspace, formatDiagnosticCommand } from './diagnose.mjs';
import { annotateRemediations, formatRemediationActions } from './diagnose/remediations.mjs';
import { distributionFamily } from './hostPrerequisites.mjs';
import { resolveWorkspaceIdentity } from './identity.mjs';
import { createMutationLockManager } from './locks.mjs';
import { assertRouterBindingStateConfined } from './routerBinding.mjs';
import { createProcessRunner, buildEngineProcessEnvironment } from './process.mjs';
import { repairBindingPermissions } from './repair/bindingPermissions.mjs';
import { pullMissingBoxImage, startSelectedMachine } from './repair/automatic.mjs';
import { sanitizeAuthorityDiagnostic } from '../cli/sandbox/authorityCommandDiagnostics.mjs';

const clean = (value) => sanitizeAuthorityDiagnostic(String(value ?? ''), { limit: 4000 });
const AUTOMATIC_REPAIRS = Object.freeze({
    'secure-binding-permissions': repairBindingPermissions,
    'pull-box-image': pullMissingBoxImage,
    'start-podman-machine': startSelectedMachine,
});

function assertSafeLockParents(homeDirectory, fsApi, uid) {
    for (const directory of [path.resolve(homeDirectory), path.join(homeDirectory, '.ploinky-box'), path.join(homeDirectory, '.ploinky-box', 'locks')]) {
        let stat;
        try { stat = fsApi.lstatSync(directory); } catch (error) {
            if (error.code === 'ENOENT' && directory !== path.resolve(homeDirectory)) return;
            throw error;
        }
        if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid || (stat.mode & 0o022) !== 0) {
            throw new Error(`Repair lock directory is unsafe or shared-writable: ${directory}. Review it manually before automatic repairs.`);
        }
    }
}

function resultReport({ before, after = before, outcomes, dryRun }) {
    // A fresh diagnosis may pass while an action or lock operation failed.
    // Preserve a separate recovery path for those execution failures.
    const repairChecks = outcomes.filter((outcome) => outcome.status === 'failed').map((outcome) => ({
        id: outcome.id.startsWith('repair.lock') ? outcome.id : `repair.execution.${outcome.id}`,
        label: outcome.title, status: 'fail', detail: outcome.detail,
        next: outcome.id.startsWith('repair.lock')
            ? 'Inspect the exact repair lock path and ownership as this login account. Resolve unsafe paths or a stale lock only after proving ownership and that no operation is active, then rerun ploinky repair.'
            : 'Inspect this failed repair command and its error as the deployment account. Resolve the reported cause, then rerun ploinky repair to obtain a successful execution and fresh diagnostics.',
        ...(outcome.command ? { command: outcome.command } : {}),
        ...(Number.isInteger(outcome.exitCode) ? { exitCode: outcome.exitCode } : {}),
    }));
    const actions = repairChecks.length
        ? annotateRemediations({ ...after, checks: repairChecks }).actions
        : [];
    actions.unshift(...(after.actions || []));
    const sudoRequired = actions.filter((action) => action.required && action.requiresSudo === true);
    return {
        version: 1, command: 'repair', workspace: after.workspace ?? before.workspace,
        dryRun, before, after, outcomes, repairChecks, remainingActions: actions, sudoRequired,
        exitCode: outcomes.some((outcome) => outcome.status === 'failed') ? 1 : after.exitCode,
    };
}

export function formatRepairReport(report) {
    const lines = [`Ploinky repair${report.dryRun ? ' — preview' : ''} — ${clean(report.workspace || 'workspace unavailable')}`];
    for (const outcome of report.outcomes || []) {
        lines.push(`[${outcome.status.toUpperCase()} — no sudo] ${clean(outcome.title)}`);
        if (outcome.detail) lines.push(`  ${clean(outcome.detail)}`);
        if (outcome.command) lines.push(`  Command: ${formatDiagnosticCommand(outcome.command)}`);
        if (outcome.operation) lines.push(`  Operation: ${formatDiagnosticCommand(outcome.operation)}`);
        if (Number.isInteger(outcome.exitCode)) lines.push(`  Exit: ${outcome.exitCode}`);
    }
    if (!report.outcomes?.length) lines.push('No eligible automatic repairs were found.');
    if (report.dryRun) lines.push('Preview only. No repairs or temporary deployment probes were run. Run ploinky repair to apply eligible actions and verify the runtime.');
    else {
        const failed = report.after.checks.filter((check) => check.status === 'fail');
        lines.push(`Verification: ${failed.length} failed check(s).`);
        for (const check of failed) {
            lines.push(`  ${clean(check.label)}: ${clean(check.detail)}`);
            if (check.command) lines.push(`    Command: ${formatDiagnosticCommand(check.command)}`);
            if (Number.isInteger(check.exitCode)) lines.push(`    Exit: ${check.exitCode}`);
            if (check.next) lines.push(`    Next: ${clean(check.next)}`);
        }
        if (!failed.length && report.after.exitCode === 0) lines.push(report.repairChecks?.length
            ? 'Deployment diagnostics passed, but repair execution failures still need review.'
            : 'The applicable deployment diagnostics passed.');
        else if (!failed.length) lines.push('Some required diagnostics could not be completed; deployment readiness is not confirmed.');
    }
    lines.push(formatRemediationActions(report.remainingActions || [], { remaining: true }).trimEnd());
    if (!report.sudoRequired?.length) lines.push('No required sudo actions were identified. Optional administrator inspections are not deployment blockers.');
    else lines.push(`${report.sudoRequired.length} required administrator action(s) remain. Run those separately, then rerun ploinky diagnose.`);
    return `${lines.filter(Boolean).join('\n')}\n`;
}

/** Apply only named, locally implemented user repairs; diagnostic prose is never executable. */
export async function repairWorkspace({
    env = process.env, cwd = process.cwd(), repositoryRoot = path.resolve(import.meta.dirname, '..'),
    platform = process.platform, uid = process.getuid?.(), homeDirectory = os.homedir(), fsApi = fs,
    explicitPort, explicitMediaPort, dryRun = false, progress = () => {},
    runner = createProcessRunner({ env: buildEngineProcessEnvironment(env) }),
    diagnose = diagnoseWorkspace, lockManager = createMutationLockManager({ homeDirectory, fsApi }),
    executors = AUTOMATIC_REPAIRS,
} = {}) {
    const context = { packageFamily: platform === 'linux' ? distributionFamily(fsApi) : '' };
    if (uid === 0) {
        const report = annotateRemediations({ version: 1, workspace: null, platform, exitCode: 1, checks: [
            { id: 'host.user', label: 'Repair execution account', status: 'fail',
                detail: 'Run ploinky repair as the normal deployment account, without sudo.',
                next: 'Administrator actions are reported for you to run separately; repair does not elevate privileges.' },
        ], commands: [] }, { context });
        return resultReport({ before: report, outcomes: [], dryRun });
    }
    const options = { env, cwd, repositoryRoot, platform, uid, homeDirectory, fsApi,
        explicitPort, explicitMediaPort, runner, progress };
    progress('Inspecting user-repair preconditions');
    const before = annotateRemediations(await diagnose({ ...options, inspectionOnly: true }), { context });
    const candidates = before.actions.filter((action) => action.mode === 'automatic' && action.requiresSudo === false
        && Object.hasOwn(AUTOMATIC_REPAIRS, action.repairId) && action.id === action.repairId);
    if (dryRun) return resultReport({ before, dryRun, outcomes: candidates.map((action) => ({
        id: action.id, title: action.title, status: 'planned', detail: action.instructions,
    })) });

    const outcomes = [];
    if (candidates.length) {
        let lock;
        try {
            const resolveIdentity = () => resolveWorkspaceIdentity({ env, cwd: () => typeof cwd === 'function' ? cwd() : cwd });
            const identity = resolveIdentity();
            assertRouterBindingStateConfined(identity, { homeDirectory, fsApi });
            // The normal lock manager tightens existing directory modes. A
            // repair must not hide previously untrusted state as a side effect.
            assertSafeLockParents(homeDirectory, fsApi, uid);
            lock = await lockManager.acquire(identity.instance);
            for (const action of candidates) {
                progress(`Repairing: ${action.title}`);
                try {
                    const current = resolveIdentity();
                    if (current.instance !== identity.instance || current.workspaceRoot !== identity.workspaceRoot
                        || !isDeepStrictEqual(current.rootFingerprint, identity.rootFingerprint)) {
                        throw new Error('Workspace identity changed before repair; no action was applied.');
                    }
                    lock.assertHeld(current.instance);
                    const execute = executors[action.repairId];
                    if (typeof execute !== 'function') throw new Error('The selected automatic repair is unavailable.');
                    const machineCheck = action.repairId === 'start-podman-machine'
                        ? before.checks.find((check) => check.id === 'repair.machine.state'
                            && check.code === 'MACHINE_STOPPED_ELIGIBLE' && check.repairEligible === true)
                        : null;
                    const expectedMachine = machineCheck?.machineIdentity
                        ? { name: machineCheck.machineIdentity.name, fingerprint: machineCheck.machineIdentity.fingerprint }
                        : undefined;
                    const outcome = await execute({ ...options, identity: current, lock, expectedMachine });
                    if (!outcome || !['applied', 'skipped', 'failed'].includes(outcome.status)) throw new Error('The repair returned no valid execution result.');
                    outcomes.push({ id: action.id, title: action.title, ...outcome, detail: clean(outcome.detail) });
                } catch (error) {
                    outcomes.push({ id: action.id, title: action.title, status: 'failed', detail: clean(error.message) });
                }
            }
        } catch (error) {
            outcomes.push({ id: 'repair.lock', title: 'Acquire the selected workspace repair lock', status: 'failed', detail: clean(error.message) });
        } finally {
            try { lock?.release(); } catch (error) {
                outcomes.push({ id: 'repair.lock.release', title: 'Release the repair lock', status: 'failed', detail: clean(error.message) });
            }
        }
    }
    progress('Rechecking deployment diagnostics and remaining administrator actions');
    let after;
    try { after = annotateRemediations(await diagnose({ ...options, inspectionOnly: false }), { context }); }
    catch (error) {
        after = annotateRemediations({ ...before, exitCode: 1, inspectionOnly: false, checks: [...before.checks,
            { id: 'repair.verification', label: 'Post-repair verification', status: 'fail', detail: clean(error.message),
                next: 'Rerun ploinky diagnose; no successful runtime verification was obtained.' }], actions: [] }, { context });
    }
    return resultReport({ before, after, outcomes, dryRun: false });
}
