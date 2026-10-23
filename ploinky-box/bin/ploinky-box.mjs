#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildHostSkillScope } from '../skillScope.mjs';
import { parseOuterArguments } from '../command/parse.mjs';
import { routeOuterCommand } from '../command/route.mjs';
import { buildContainerExecArgs, executeProcess, executeProcessStreaming } from '../command/execute.mjs';
import { updateHostPloinkySource } from '../command/hostUpdate.mjs';
import { resolvePloinkyUpdateScope } from '../../cli/commands/ploinkyUpdateScope.js';
import { resolveUpdateFolderScope, withDefaultUpdateFolder } from '../../cli/commands/updateRequest.js';
import { buildUpdateResult, createOperationRecord } from '../../cli/commands/updateOutcome.js';
import { agentLibIdentity } from '../../agentlib/contract.mjs';
import { PloinkyBoxError } from '../errors.mjs';
import { createUpdateHostState } from '../update/hostState.mjs';
import {
    UPDATE_HANDOFF_ENV,
    consumeRelaunchHandoff,
    createRelaunchHandoff,
    discardRelaunchHandoff,
} from '../update/relaunchHandoff.mjs';
import { BOX_IMAGE_OVERRIDE_ENV, BOX_IMAGE_REFERENCE, BOX_LABELS } from '../constants.mjs';
import { buildEngineProcessEnvironment } from '../process.mjs';
import { isLoopbackRouterBinding } from '../routerBinding.mjs';
import {
    createBoxSupervisor,
    formatBindResult,
    formatBoxStatus,
    formatGpuGrantResult,
    formatGpuGrantStatus,
    formatRouterBindingLines,
    formatUpdateStateLines,
} from '../supervisor.mjs';
import { isInsideBox } from '../lib/boxMarker.mjs';
import { parseBranchPolicy, stripBranchPolicyArgs } from '../../agentlib/branchPolicy.mjs';
import { TARGETED_UPDATE_OPERATION, formatLimitsStatus } from '../hardwareLimitsGate.mjs';
import { formatUnlockReport } from '../unlock.mjs';

function formatLimitsClearResult(result) {
    if (result.absent) return 'No hardware limits are stored for this workspace; nothing was changed.\n';
    const scope = result.all ? 'every stored hardware limit' : `the stored hardware limits of ${result.agentRef}`;
    const reset = result.reset ? ' The unreadable policy was reset to a new policy epoch.' : '';
    const pending = result.cleared === false ? ' No entry was stored for that agent.' : '';
    return `Cleared ${scope}.${reset}${pending} Running agents keep their applied limits until the next start, restart or Apply.\n`;
}

export function publicUsageText() {
    return `ploinky - run Ploinky through its managed outer Box

Usage: ploinky [--debug] [--dry-run] [--port PORT] [--udp-port PORT] [--allow-host-process PID] [--] COMMAND [ARGS]

Commands:
  ploinky                         Prepare the Box and open the Ploinky REPL
  ploinky start [AGENT [PORT]]    Start the graph; omit AGENT to reuse the saved workspace agent
  ploinky restart                 Reconcile sources and restart the whole workspace graph
  ploinky restart AGENT           Restart one agent in the existing Box generation
  ploinky restart AGENT --accept-failed-drain CONTAINER_ID
                                  Replace the stopped predecessor whose targeted drain
                                  was refused, accepting possible loss of its data
  ploinky --udp-port PORT start AGENT [PORT]
                                  Select the media UDP port (host and in-Box listener); defaults to 7882
  ploinky bind [ADDRESS:PORT:8080]
                                  Publish the public Router on this host's ADDRESS and
                                  TCP PORT; the Box and graph restart when it changes
  ploinky --dry-run bind [ADDRESS:PORT:8080]
                                  Show the bind plan without changing anything
  ploinky gpu status              Show GPU agents and their source, denies, host GPU
                                  discovery, and Box wiring
  ploinky gpu grant [--agent REPO/AGENT...] [--vendor VENDOR]
                                  Let the named agents use the host NVIDIA GPU and lift
                                  their denies; without --agent, lift a workspace
                                  revoke so manifests that declare
                                  containerSecurity.gpu get the GPU again; the Box
                                  and graph restart when the wiring changes
  ploinky gpu revoke [--agent REPO/AGENT...]
                                  Deny the named agents, overriding their manifests;
                                  without --agent, turn GPU access off for the whole
                                  workspace, manifest defaults included
  ploinky status [--verbose]      Inspect Box and core state without mutation
  ploinky diagnose [--json]       Check prerequisites, Podman storage, and security
                                  profiles using temporary deployment probes
  ploinky --port PORT --udp-port PORT diagnose
                                  Check ports selected for a failed deployment
  ploinky repair [--dry-run] [--json]
                                  Apply supported user-level fixes, recheck, and
                                  list remaining manual or administrator actions
  ploinky --dry-run repair        Show the repair plan without applying fixes
  ploinky stop                    Stop core services and the outer Box
  ploinky unlock [--force-holder PID@MACHINE]
                                  Remove a workspace or hardware store lock left by a
                                  command that is no longer running; a holder that
                                  cannot be checked needs the exact --force-holder
                                  value from the busy error. Locks with leftover
                                  contents are listed, never removed
  ploinky update [PATH]           Verified fast-forward update of repos and skills
  ploinky update all [PATH]       (Ploinky only when its checkout is within PATH)
  ploinky update repos|repo NAME  Update registered repositories; activation is pending
  ploinky destroy                 Remove the outer Box without prompting, then this workspace's
                                  GPU grants and hardware-limits records (in .ploinky-box);
                                  retain .ploinky/box, .data, .ploinky/data and .env
  ploinky destroy --delete-cache  Remove the outer Box and those records, and delete
                                  .ploinky/box/dependencies and .ploinky/box/images without prompting;
                                  with no Box present, also .ploinky/agentlib
  ploinky cli                     Open Bash in the Box
  ploinky cli AGENT [ARGS]        Run an agent CLI through ploinky-local
  ploinky logs tail [TARGET]      Follow Router or agent logs; inspect-only
  ploinky logs last [N] [TARGET]  Show the last N lines; inspect-only
  ploinky help                    Show this help without engine discovery

Logs are observational: they require an already running, initialized, owned Box
and never create, prepare, or repair one.

Diagnose runs explicitly; start and restart do not run prerequisite diagnostics.
It reports failing commands and next steps without changing host configuration
or starting, stopping, or repairing the workspace's existing Box.

Repair applies only supported fixes for the current user and never invokes sudo.
Both reports distinguish automatic fixes, manual user actions, and actions that
require administrator privileges. Diagnose and repair must run on the host.

Box host state lives in <workspace>/.ploinky-box: router bindings, GPU grants,
hardware limits, update records, the workspace lock, quarantine and tmp. Nothing
goes in ~/.ploinky-box, which is ignored. Every Box and every agent runtime sees
.ploinky-box as an empty read-only directory (a Box with hardware limits on also
gets its limits store as a writable bind inside it). Writable mounts must stay
inside the workspace, manifest volumes may not reach .ploinky-box, and a Ploinky
checkout inside the workspace is bound read-only over its workspace path. Nested
Box workspaces are refused in both directions. The first command that configures
a workspace without .ploinky-box/workspace.json (for example start, restart,
update, bind, gpu grant or gpu revoke) moves any pre-existing content in
.ploinky-box (other than its own skeleton) into .ploinky-box/quarantine/ instead
of trusting it; nothing is deleted. stop, destroy, limits clear and unlock never
do this.

Creating, recreating or adopting a Box, and creating its data paths, is refused
while anything else can write the workspace: a host-runtime agent of it or a
container with a read-write bind of it. Linux checks the mount table of every
process of the invoking user, with rootless Podman's own infrastructure exempt;
any other process that has the workspace (or a directory containing it, such as
the home directory) mounted read-write blocks, for example a snap or Flatpak
helper. macOS checks the workspace's launch records and ps for command lines that
name the workspace; a host agent started by an older Ploinky whose launch records
were erased is not detected and is unsupported. Stop what is listed, or put
--allow-host-process PID before the command to excuse one process that does not
write the workspace (repeatable; its start time is checked again, and on macOS
an agent that an older Ploinky started without the mask cannot be excused).

Upgrading has no backward compatibility. A Box made by an older Ploinky fails the
compatibility check: run ploinky destroy, then ploinky start. If an older Ploinky
already destroyed the old Box before this version ever ran, remove the directory
<workspace>/.ploinky-box (it holds host state only) before the first start. That
never means deleting .data/, .ploinky/data/ or .env: they hold user data and
keys, and destroy and destroy --delete-cache keep them. State in the old
~/.ploinky-box is ignored: re-apply ploinky bind, ploinky gpu grant or revoke and
hardware limits after the Box is recreated.

ploinky unlock removes a workspace lock, its reclaim guard and the hardware store
lock (.ploinky-box/hardware-limits/INSTANCE/store/write.lock) that a command no
longer running left behind, only when the holder is gone. A holder that cannot be
checked (another machine, or a store lock whose PID is alive on this host) needs
--force-holder PID@MACHINE, exactly as the busy error prints it; name only a
holder that is really gone, since naming one that still runs can let two commands
hold the lock at once. A holder classified as running is never removed, and the
store lock is removed only with the workspace lock held and the Box stopped or
absent. A lock with leftover contents, no or a malformed owner record, or that is
not a private directory is listed with manual steps and never removed; the
command then exits 1. It does not wait for the
lock it is recovering and does not accept --allow-host-process. Unlock commands
for one workspace run one at a time under .ploinky-box/locks/unlock.lock: a
second one waits up to 2 seconds, then refuses and names the running one. The
lock of an unlock that is no longer running is taken over automatically; a
stuck .ploinky-box/locks/unlock.lock.reclaim is never removed by unlock, which
lists it with the rm -r step to run by hand.

Bind uses BIND_ADDRESS:HOST_TCP_PORT:8080. BIND_ADDRESS is 0 or 0.0.0.0 (all IPv4
interfaces), 127.0.0.1 (restore local-only access), or an IPv4 address assigned
to this host, never the browser machine's address. 8080 is the fixed public
Router port inside the Box; 8081 and agent ports cannot be published. Bare bind
uses 0.0.0.0 and the current host port. Bind requires a configured graph, starts
it if it is stopped, keeps the current image, AgentLib source, and UDP port, and
saves the binding for later start, restart, update, and Box recreation. A later
"ploinky --port PORT start" keeps the saved address and saves the new port.
Router traffic is plain HTTP, and the bind address is not a client access rule.

A GPU grant is an operator decision for this workspace only, saved in this
workspace's .ploinky-box until ploinky destroy removes it (with the saved
hardware-limits gate and stored limits; router bindings are kept). The Box gets the NVIDIA device nodes and read-only
driver libraries (no privileged mode or added capabilities), and only the named
agents may request the device ploinky.local/gpu=all. A grant needs a configured
graph once a Box exists, starts it if it is stopped, and keeps the current
image, AgentLib source, and publication. Every start, restart, and update
rediscovers the driver: an updated driver replaces the Box, and a failed
discovery starts it without GPU devices, marking the grant stale for GPU agents.

The default Box image is ${BOX_IMAGE_REFERENCE}.
Set ${BOX_IMAGE_OVERRIDE_ENV} to pull a different Box image reference.
Public CLI image options, engine, instance-name, and master-key overrides are unsupported.
If .ploinky/edge-desired.json exists, start stages it as the host-owned routing/security authority.
`;
}

function outerDebug(parsed, route, stdout) {
    if (!parsed.debug.enabled) return;
    if (['help', 'status', 'stop', 'destroy', 'bash', 'dry-run', 'bind', 'bind-dry-run',
        'gpu-status', 'gpu-grant', 'gpu-revoke', 'limits-status', 'limits-clear', 'unlock'].includes(route.kind)) {
        stdout.write('[INFO] Debug mode enabled.\n');
    }
}

function executePrepared(prepared, coreArgv, {
    execute,
    input,
    output,
    shell = false,
    interactive = false,
    logStream = false,
    colorOutput = false,
    engineEnv,
    launchCwd,
}) {
    return execute(prepared.engine.name, buildContainerExecArgs(
        prepared.containerId,
        coreArgv,
        {
            workspaceRoot: prepared.identity?.workspaceRoot,
            hostPort: prepared.hostPort,
            skillScopeEnv: prepared.identity && launchCwd ? buildHostSkillScope(prepared.identity.workspaceRoot, launchCwd) : {},
            mediaHostPort: prepared.mediaHostPort,
            shell,
            interactive,
            logStream,
            colorOutput,
            inputIsTty: input.isTTY === true,
            outputIsTty: output.isTTY === true,
        },
    ), { env: engineEnv });
}

const DEPLOYMENT_DIAGNOSTIC_HINT = 'Run ploinky diagnose from this workspace for prerequisite, storage, and security-profile diagnostics.';
const DEPLOYMENT_ROUTES = new Set([
    'start', 'restart', 'bind', 'gpu-grant', 'gpu-revoke', 'update', 'generic', 'repl', 'agent-cli', 'bash',
]);

export async function runOuterCli(argv, options = {}) {
    const {
        env: inheritedEnv = process.env,
        output = process.stdout,
        errorOutput = process.stderr,
        execute = executeProcess,
        detectInsideBox = isInsideBox,
        cwd = () => process.cwd(),
        repositoryRoot = path.resolve(import.meta.dirname, '../..'),
        diagnose,
        repair,
    } = options;
    // A relaunch handoff value is consumed only by the update route and never
    // travels further: no engine, Box, or core process receives it.
    const updateHandoff = inheritedEnv[UPDATE_HANDOFF_ENV];
    const env = { ...inheritedEnv };
    delete env[UPDATE_HANDOFF_ENV];
    if (inheritedEnv === process.env) delete process.env[UPDATE_HANDOFF_ENV];
    if (detectInsideBox()) {
        // Preserve unchanged core forwarding for other commands, including
        // core-only options that the outer argument parser does not accept.
        let command = '';
        try { command = parseOuterArguments(argv).command; } catch (_) {}
        // Host-only commands: lock recovery included, since the Box masks the
        // host state that holds the locks.
        if (command === 'diagnose' || command === 'repair' || command === 'unlock') {
            errorOutput.write(`ploinky ${command} must run on the physical host, outside the Box. Exit this shell and run ploinky ${command} from the host workspace.\n`);
            return 1;
        }
        return execute('/opt/ploinky/bin/ploinky-local', [...argv], { env });
    }
    const parsed = parseOuterArguments(argv);
    const launchDirectory = cwd();
    const route = routeOuterCommand(parsed, { cwd: launchDirectory });
    if (route.kind === 'diagnose') {
        const runDiagnosis = diagnose || (await import('../diagnose.mjs')).diagnoseWorkspace;
        const report = await runDiagnosis({
            env,
            cwd: launchDirectory,
            repositoryRoot,
            explicitPort: parsed.explicitPort,
            explicitMediaPort: parsed.explicitMediaPort,
            progress: message => errorOutput.write(`[diagnose] ${message}\n`),
        });
        if (route.json) {
            output.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
            const { formatDiagnosticReport } = await import('../diagnose.mjs');
            output.write(formatDiagnosticReport(report));
        }
        return report.exitCode;
    }
    if (route.kind === 'repair') {
        const runRepair = repair || (await import('../repair.mjs')).repairWorkspace;
        const report = await runRepair({
            env,
            cwd: launchDirectory,
            repositoryRoot,
            explicitPort: parsed.explicitPort,
            explicitMediaPort: parsed.explicitMediaPort,
            dryRun: route.dryRun,
            progress: message => errorOutput.write(`[repair] ${message}\n`),
        });
        if (route.json) {
            output.write(`${JSON.stringify(report, null, 2)}\n`);
        } else {
            const { formatRepairReport } = await import('../repair.mjs');
            output.write(formatRepairReport(report));
        }
        return report.exitCode;
    }
    const dispatch = { relaunched: false, reported: false };
    try {
        const exitCode = await runRoutedOuterCli(argv, parsed, route, launchDirectory, dispatch, {
            ...options,
            env,
            updateHandoff,
        });
        // A structured update result already names its failed phases.
        if (exitCode !== 0 && DEPLOYMENT_ROUTES.has(route.kind) && !dispatch.relaunched && !dispatch.reported) {
            errorOutput.write(`${DEPLOYMENT_DIAGNOSTIC_HINT}\n`);
        }
        return exitCode;
    } catch (error) {
        // Another command holding the lock is not a deployment problem to diagnose.
        if (DEPLOYMENT_ROUTES.has(route.kind) && error?.lockBusy !== true) {
            errorOutput.write(`${DEPLOYMENT_DIAGNOSTIC_HINT}\n`);
        }
        throw error;
    }
}

async function runRoutedOuterCli(argv, parsed, route, launchDirectory, dispatch, {
    env = process.env,
    input = process.stdin,
    output = process.stdout,
    errorOutput = process.stderr,
    supervisor,
    execute = executeProcess,
    executeStreaming = executeProcessStreaming,
    cwd = () => process.cwd(),
    repositoryRoot = path.resolve(import.meta.dirname, '../..'),
    updateHostSource = updateHostPloinkySource,
    relaunch = executeProcess,
    updateHostState,
    updateHandoff,
    handoffParentPid = process.ppid,
    handoffNow,
    onUpdateResult,
} = {}) {
    const selectedSupervisor = supervisor || createBoxSupervisor({
        env, launchCwd: launchDirectory, allowHostProcesses: parsed.allowHostProcesses,
    });
    const engineEnv = buildEngineProcessEnvironment(env);
    outerDebug(parsed, route, output);

    if (route.kind === 'help') {
        output.write(publicUsageText());
        return 0;
    }
    if (route.kind === 'status') {
        const status = selectedSupervisor.inspectBoxStatus();
        // Host update state is read-only here: nothing is probed or cleared.
        if (typeof selectedSupervisor.inspectUpdateState === 'function') {
            let lines;
            try {
                lines = formatUpdateStateLines(selectedSupervisor.inspectUpdateState(status.identity));
            } catch (error) {
                lines = [`Update state could not be read: ${error.message}`];
            }
            if (lines.length) output.write(`${lines.join('\n')}\n`);
        }
        const container = status.ownership?.handles?.container;
        if (status.state === 'running-initialized' && container) {
            // The in-Box renderer knows the canonical local authority only; a
            // non-loopback publication is host state, so report it here.
            if (status.routerBinding && !isLoopbackRouterBinding(status.routerBinding)) {
                output.write(`${formatRouterBindingLines(status.routerBinding).join('\n')}\n`);
            }
            if (status.mediaNotice) output.write(`Media: ${status.mediaNotice}\n`);
            const coreStatus = executePrepared({
                identity: status.identity,
                containerId: container.id,
                engine: status.ownership.engine,
                hostPort: Number(container.labels?.[BOX_LABELS.routerHostPort]),
                mediaHostPort: Number(container.labels?.[BOX_LABELS.mediaHostPort]),
            }, route.coreArgv, {
                execute,
                input,
                output,
                colorOutput: output.isTTY === true && !env.NO_COLOR,
                engineEnv,
            });
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
        const status = selectedSupervisor.inspectBoxStatus();
        const container = status.ownership?.handles?.container;
        // An absent Box still needs locked cleanup of retained current markers.
        // Keep unsupported/ambiguous observations read-only.
        if (!container && !route.deleteCache && status.state !== 'absent') {
            output.write(formatBoxStatus(status));
            return ['foreign', 'incompatible', 'unknown', 'unsupported'].includes(status.state) ? 1 : 0;
        }
        const destroyed = await selectedSupervisor.runDestroyTransaction(container?.id || null, {
            deleteCache: route.deleteCache,
        });
        const removedRecords = destroyed?.removedRecords || [];
        output.write(
            `Ploinky Box ${status.identity.instance} was destroyed; host operator records removed: `
            + `${removedRecords.length > 0 ? removedRecords.join(', ') : 'none remained'}.\n`,
        );
        if (route.deleteCache) {
            const deletedPaths = destroyed?.deletedPaths || [];
            output.write(
                `Ploinky Box ${status.identity.instance} was destroyed and its cache data was deleted: `
                + `${deletedPaths.length > 0 ? deletedPaths.join(', ') : 'nothing remained to delete'}.\n`,
            );
        }
        return 0;
    }
    if (route.kind === 'bind-dry-run') {
        const plan = selectedSupervisor.planBindDryRun(route.mapping);
        output.write(`${JSON.stringify(plan, null, 2)}\n`);
        return 0;
    }
    if (route.kind === 'bind') {
        const result = await selectedSupervisor.runBindTransaction(route.mapping);
        output.write(formatBindResult(result));
        return 0;
    }
    if (route.kind === 'gpu-status') {
        output.write(formatGpuGrantStatus(selectedSupervisor.inspectGpuGrant()));
        return 0;
    }
    if (route.kind === 'gpu-grant') {
        const result = await selectedSupervisor.runGpuGrantTransaction({
            vendor: route.vendor,
            agents: route.agents,
        });
        output.write(formatGpuGrantResult(result));
        return 0;
    }
    if (route.kind === 'gpu-revoke') {
        const result = await selectedSupervisor.runGpuRevokeTransaction({ agents: route.agents });
        output.write(formatGpuGrantResult(result));
        return 0;
    }
    if (route.kind === 'limits-status') {
        output.write(formatLimitsStatus(selectedSupervisor.inspectLimitsStatus()));
        return 0;
    }
    if (route.kind === 'unlock') {
        const report = await selectedSupervisor.runUnlock({ forceHolder: route.forceHolder });
        output.write(formatUnlockReport(report));
        return report.exitCode;
    }
    if (route.kind === 'limits-clear') {
        const result = await selectedSupervisor.runLimitsClearTransaction({ agentRef: route.agentRef, all: route.all });
        output.write(formatLimitsClearResult(result));
        return 0;
    }
    if (route.kind === 'dry-run') {
        const plan = selectedSupervisor.planDryRun({
            explicitPort: route.hostPort,
            explicitMediaPort: route.mediaHostPort,
        });
        output.write(`${JSON.stringify(plan, null, 2)}\n`);
        return 0;
    }
    if (route.kind === 'start') {
        await selectedSupervisor.runStartTransaction(route.coreArgv, {
            explicitPort: route.hostPort,
            explicitMediaPort: route.mediaHostPort,
            branchPolicy: parseBranchPolicy(route.coreArgv),
        });
        return 0;
    }
    if (route.kind === 'restart') {
        const coreArgv = stripBranchPolicyArgs(route.coreArgv);
        const targeted = stripBranchPolicyArgs(parsed.commandArgs)
            .some((argument) => !['--debug', '-d'].includes(argument));
        if (targeted) {
            await selectedSupervisor.runTargetedRestartTransaction(coreArgv);
        } else {
            try {
                await selectedSupervisor.runRestartTransaction(coreArgv, {
                    branchPolicy: parseBranchPolicy(route.coreArgv),
                });
            } catch (error) {
                // A failed restart whose rollback rebuilt the prior graph and
                // passed its checks says so; the error itself still fails.
                if (error?.activation?.outcome === 'restored') {
                    output.write(`${UPDATE_ACTIVATION_WORDING.restored}\n`);
                }
                throw error;
            }
        }
        return 0;
    }

    // Logs are inspect-only at this boundary. The route reads Box status once
    // and forwards only into an already owned, running, initialized Box; it
    // never prepares, reconciles, installs dependencies, or takes a mutation
    // lock, so asking for logs can never create or repair a Box.
    if (route.kind === 'logs') {
        const status = selectedSupervisor.inspectBoxStatus();
        const container = status.ownership?.handles?.container;
        const engine = status.ownership?.engine;
        if (status.state !== 'running-initialized' || !container?.id || !engine?.name) {
            errorOutput.write(
                `ploinky logs: the outer Box is not running and initialized (state: ${status.state}).\n`
                + 'Logs never create or repair a Box; start the workspace first with `ploinky start AGENT`.\n',
            );
            return 1;
        }
        return executePrepared({
            identity: status.identity,
            containerId: container.id,
            engine,
            hostPort: Number(container.labels?.[BOX_LABELS.routerHostPort]),
            mediaHostPort: Number(container.labels?.[BOX_LABELS.mediaHostPort]),
        }, route.coreArgv, {
            execute: executeStreaming,
            input,
            output,
            logStream: true,
            engineEnv,
        });
    }

    if (route.kind === 'update') {
        return runHostUpdate({
            argv,
            route,
            dispatch,
            supervisor: selectedSupervisor,
            env,
            output,
            errorOutput,
            cwd,
            repositoryRoot,
            updateHostSource,
            relaunch,
            updateHostState,
            updateHandoff,
            handoffParentPid,
            handoffNow,
            onUpdateResult,
        });
    }

    const prepared = await selectedSupervisor.prepareBoxForCommand();
    if (route.kind === 'bash') {
        return executePrepared(prepared, [], {
            execute,
            input,
            output,
            shell: true,
            interactive: true,
            engineEnv,
            launchCwd: launchDirectory,
        });
    }
    return executePrepared(prepared, route.coreArgv, {
        execute,
        input,
        output,
        interactive: ['repl', 'agent-cli'].includes(route.kind),
        launchCwd: launchDirectory,
        engineEnv,
    });
}

const UPDATE_ACTIVATION_WORDING = Object.freeze({
    restarted: 'Activation: the workspace graph was restarted and the Router health check passed.',
    'not-required': 'Activation not required; no configured running workspace required a restart.',
    deferred: 'Activation deferred; the running workspace graph was not restarted. Updated sources may require '
        + 'activation: run `ploinky restart` to activate them.',
    restored: 'Activation blocked; reconstruction of the previous Box and graph configuration was attempted and '
        + 'passed its checks. It runs from the current checkouts: sources that were already pulled are not rolled back.',
    'recovery-required': 'Activation blocked and the previous workspace graph could not be fully reconstructed; '
        + 'recover it from this workspace with `ploinky stop`, then `ploinky start`.',
});

const UPDATE_FAILURE_WORDING = Object.freeze({
    preserved: 'Update failed before a new graph was activated; the previous workspace graph was left as it was. '
        + 'Source checkouts that were already pulled are not rolled back.',
    restored: 'Update failed; reconstruction of the previous Box and graph configuration was attempted and '
        + 'passed its checks. It runs from the current checkouts: sources that were already pulled are not rolled back.',
    'recovery-required': 'Update failed and the previous workspace state could not be fully reconstructed; '
        + 'recover it from this workspace with `ploinky stop`, then `ploinky start`.',
    'not-started': 'Update did not start in this workspace: its mutation lock could not be acquired, '
        + 'so the workspace graph and its registered repositories were left as they were.',
    'source-mismatch': 'Update did not start in this workspace: its Box runs another Ploinky checkout, so no '
        + 'source checkout was pulled and the workspace graph was left as it was.',
});

function describeRecord(record) {
    return `${record.phase} ${record.id}: ${record.outcome}${record.code ? ` [${record.code}]` : ''}`;
}

// The final status line names every phase that was not verified.
export function formatUpdateStatusLine(result) {
    const unverified = result.records.filter(record => !['changed', 'unchanged'].includes(record.outcome)
        && !(record.phase === 'activation' && record.id === 'workspace-graph'));
    const errors = unverified.filter(record => ['failed', 'uncertain'].includes(record.outcome));
    const skipped = unverified.filter(record => !['failed', 'uncertain'].includes(record.outcome));
    const list = records => records.map(describeRecord).join('; ');
    if (result.status === 'complete') return 'Update complete.';
    if (result.status === 'complete-with-skips') return `Update complete with skips: ${list(skipped)}.`;
    const parts = [];
    if (errors.length) parts.push(`failed or uncertain: ${list(errors)}`);
    if (skipped.length) parts.push(`not verified: ${list(skipped)}`);
    const label = result.status === 'partial' ? 'Update partially failed' : 'Update failed';
    return `${label} (exit status ${result.exitCode}): ${parts.join('; ') || 'no verified result'}.`;
}

function hostPloinkyRecord(host) {
    if (!host) return null;
    // The graph runs from the Box, not the host checkout: a preserved or failed
    // host self-update never blocks activation, and only failed or uncertain
    // outcomes make the final status nonzero.
    if (host.record) {
        return createOperationRecord({
            phase: 'host-ploinky',
            id: String(host.record.id || host.repoPath || 'host-ploinky'),
            outcome: host.record.outcome,
            attempted: typeof host.record.attempted === 'boolean' ? host.record.attempted : host.record.outcome !== 'skipped',
            required: false,
            code: host.record.code || '',
            reason: host.record.reason || '',
            before: host.record.before ?? null,
            after: host.record.after ?? null,
            details: host.record.details ?? null,
        });
    }
    const evidence = value => ({ repoPath: host.repoPath || null, revision: value || null });
    if (host.outcome === 'changed') {
        return createOperationRecord({
            phase: 'host-ploinky', id: String(host.repoPath || 'host-ploinky'), outcome: 'changed', required: true,
            before: evidence(host.before), after: evidence(host.after),
            details: { relaunched: host.relaunched === true },
        });
    }
    if (host.outcome === 'skipped') {
        return createOperationRecord({
            phase: 'host-ploinky', id: String(host.repoPath || 'host-ploinky'), outcome: 'skipped', required: false,
            code: 'scope-excluded', reason: host.reason || '',
        });
    }
    return createOperationRecord({
        phase: 'host-ploinky', id: String(host.repoPath || 'host-ploinky'), outcome: 'unchanged', required: true,
    });
}

function shortRevision(value) {
    return String(value || 'unknown').slice(0, 12);
}

/**
 * The AgentLib part of the public update result: whether the source changed and
 * the current and previous mode-aware identities. A local source reports its
 * fingerprint and source ID hash; an image source reports the supplying image
 * ID, its source ID hash and any available provenance.
 */
export function projectUpdateAgentLib(result) {
    if (!result?.agentLib) return null;
    return {
        changed: Boolean(result.changed),
        current: agentLibIdentity(result.agentLib),
        previous: agentLibIdentity(result.previous ?? null),
    };
}

function scopeError(error) {
    return new PloinkyBoxError(error.message, {
        code: error?.code || 'PLOINKY_UPDATE_SCOPE_UNMAPPABLE',
        cause: error,
    });
}

/**
 * Host side of every `ploinky update` form. Scope is validated against the
 * exact workspace before host self-update, Box creation or source mutation;
 * the in-Box command runs inside the supervisor's mutation transaction, and
 * the printed outcome comes from what that transaction actually did.
 */
async function runHostUpdate({
    argv,
    route,
    dispatch,
    supervisor,
    env,
    output,
    cwd,
    repositoryRoot,
    updateHostSource,
    relaunch,
    updateHostState,
    updateHandoff,
    handoffParentPid,
    handoffNow,
    onUpdateResult,
}) {
    const identity = supervisor.resolveWorkspaceIdentity();
    // The hardware gate is parsed and the stored-limits (U9) check runs before
    // any mutation, including the host source update and the relaunch. Only the
    // full form applies a requested gate; the repository forms follow the saved
    // gate and refuse a request for another one.
    if (typeof supervisor.preflightHardwareGate === 'function') {
        await supervisor.preflightHardwareGate(route.request?.kind === 'all' ? 'update' : TARGETED_UPDATE_OPERATION);
    }
    const request = withDefaultUpdateFolder(route.request, cwd(), identity.workspaceRoot);
    let scope = null;
    if (request.folderPath) {
        try {
            scope = resolveUpdateFolderScope(request.folderPath, identity.workspaceRoot);
        } catch (error) {
            throw scopeError(error);
        }
    }
    const full = request.kind === 'all';
    const updateScopeRoot = full
        ? (scope ? scope.canonicalFolder : resolvePloinkyUpdateScope(undefined, { cwd }))
        : null;
    let store = updateHostState || null;
    const hostState = () => {
        store ||= createUpdateHostState({ identity });
        return store;
    };
    const summary = {
        request,
        scope: scope ? { relative: scope.relative, canonicalFolder: scope.canonicalFolder } : null,
        host: null,
        workspacePloinky: null,
        activation: null,
    };

    if (updateHandoff !== undefined) {
        const accepted = consumeRelaunchHandoff({
            store: hostState(),
            value: updateHandoff,
            argv,
            request,
            identity,
            scopeRoot: updateScopeRoot,
            parentPid: handoffParentPid,
            ...(handoffNow ? { now: handoffNow } : {}),
        });
        summary.host = accepted.host;
        output.write(
            `Host Ploinky checkout at ${accepted.host.repoPath} was updated from `
            + `${shortRevision(accepted.host.before)} to ${shortRevision(accepted.host.after)} before this relaunch.\n`,
        );
    } else if (full) {
        // A Box that runs another checkout refuses this command under the
        // lock anyway; refuse before the host self-update pulls this checkout.
        try {
            supervisor.assertUpdateSourceMatchesBox?.(identity);
        } catch (error) {
            const refused = buildUpdateResult({
                command: argv,
                records: [createOperationRecord({
                    phase: 'activation', id: 'update-transaction', outcome: 'failed', required: true,
                    code: String(error?.code || 'update-failed'), reason: String(error?.message || error),
                })],
            });
            output.write(`${formatUpdateStatusLine(refused)}\n`);
            output.write(`${UPDATE_FAILURE_WORDING['source-mismatch']}\n`);
            onUpdateResult?.({ ...summary, failed: true, error, result: refused });
            throw error;
        }
        output.write(`Using Ploinky update folder ${updateScopeRoot}.\n`);
        let hostUpdate;
        try {
            hostUpdate = await updateHostSource({ repositoryRoot, updateScopeRoot });
        } catch (error) {
            // A preserved or failed host checkout is reported and the update
            // continues: the in-Box graph does not run from the host checkout.
            if (!error?.record) throw error;
            hostUpdate = { updated: false, record: error.record, reason: error.message, repoPath: repositoryRoot };
        }
        if (hostUpdate.record && !['changed', 'unchanged'].includes(hostUpdate.record.outcome)) {
            summary.host = {
                outcome: hostUpdate.record.outcome,
                record: hostUpdate.record,
                repoPath: hostUpdate.repoPath || repositoryRoot,
            };
            output.write(
                `Host Ploinky checkout at ${hostUpdate.repoPath || repositoryRoot} was not updated `
                + `(${hostUpdate.record.outcome}${hostUpdate.record.code ? `: ${hostUpdate.record.code}` : ''}): `
                + `${hostUpdate.record.reason || hostUpdate.reason || 'no reason recorded'}.\n`,
            );
        } else if (hostUpdate.updated) {
            const handoff = createRelaunchHandoff({
                store: hostState(),
                argv,
                request,
                identity,
                scopeRoot: updateScopeRoot,
                host: hostUpdate,
            });
            output.write('Host Ploinky checkout updated; continuing with the updated CLI.\n');
            // The updated CLI owns diagnostics for its invocation; do not
            // duplicate its hint when the child propagates a failure status.
            dispatch.relaunched = true;
            let status;
            try {
                status = await relaunch(process.execPath, [fileURLToPath(import.meta.url), ...argv], {
                    env: { ...env, [UPDATE_HANDOFF_ENV]: handoff.envValue },
                });
            } finally {
                let unconsumed = false;
                try {
                    unconsumed = discardRelaunchHandoff(hostState(), handoff.operationId);
                } catch (_) {}
                if (unconsumed) {
                    output.write('The updated CLI did not accept the relaunch handoff; its result does not include '
                        + 'the host self-update.\n');
                }
            }
            if (status !== 0) {
                output.write(
                    `The updated CLI exited with status ${status}. The host Ploinky checkout at `
                    + `${hostUpdate.repoPath || hostUpdate.canonicalRoot || repositoryRoot} remains updated `
                    + `(${shortRevision(hostUpdate.before)} -> ${shortRevision(hostUpdate.after)}).\n`,
                );
            }
            return status;
        }
        if (summary.host) {
            // Already named from the writer's operation record.
        } else if (hostUpdate.skipped) {
            summary.host = { outcome: 'skipped', reason: hostUpdate.reason || '', repoPath: hostUpdate.repoPath || repositoryRoot };
            output.write(
                `Host Ploinky checkout at ${hostUpdate.repoPath || repositoryRoot} was not updated: `
                + `${hostUpdate.reason}.\n`,
            );
        } else {
            summary.host = { outcome: 'unchanged', repoPath: hostUpdate.repoPath || repositoryRoot };
            output.write('Host Ploinky checkout is already up to date.\n');
        }
    }

    const hostRecords = [hostPloinkyRecord(summary.host)].filter(Boolean);
    let result;
    try {
        result = await supervisor.runUpdateTransaction(stripBranchPolicyArgs(route.coreArgv), {
            request,
            scope: summary.scope,
            debug: route.debug,
            branchPolicy: parseBranchPolicy(route.coreArgv),
            branchPolicyArgs: route.branchPolicyArgs,
            updateScopeRoot,
            hostRecords,
        });
    } catch (error) {
        const outcome = error?.workspaceTransactionStarted === false ? 'not-started' : error?.activation?.outcome;
        // A thrown transaction is never reported as complete, whatever
        // verified records preceded it.
        const failed = buildUpdateResult({
            command: argv,
            records: [...hostRecords, ...(error?.updateRecords || []), createOperationRecord({
                phase: 'activation', id: 'update-transaction', outcome: 'failed', required: true,
                code: String(error?.code || 'update-failed'), reason: String(error?.message || error),
            })],
        });
        output.write(`${formatUpdateStatusLine(failed)}\n`);
        output.write(`${UPDATE_FAILURE_WORDING[outcome]
            || 'Update failed; the activation outcome could not be determined.'}\n`);
        summary.activation = error?.activation || null;
        onUpdateResult?.({ ...summary, failed: true, error, result: failed });
        throw error;
    }
    const workspacePloinky = result?.workspacePloinky;
    summary.workspacePloinky = workspacePloinky || null;
    if (workspacePloinky?.found && !workspacePloinky.duplicateOfHost) {
        if (workspacePloinky.skipped) {
            output.write(`Workspace Ploinky checkout skipped: ${workspacePloinky.reason}.\n`);
        } else {
            const state = workspacePloinky.updated ? 'updated' : 'already up to date';
            output.write(
                `Workspace Ploinky checkout at ${workspacePloinky.repoPath} is ${state} `
                + '(verified fast-forward only).\n',
            );
        }
    }
    for (const journal of result?.unresolvedAdmissions || []) {
        output.write(
            `Warning: an earlier ${journal.operation} admission (${journal.name}) did not settle `
            + `(${journal.phase}); its journal was retained for recovery.\n`,
        );
    }
    for (const warning of result?.warnings || []) output.write(`Warning: ${warning}.\n`);
    // Transactions that predate structured records report only the host side.
    const records = result?.records || hostRecords;
    const final = {
        activation: result?.activation ? { ...result.activation } : null,
        ...buildUpdateResult({
            command: argv,
            records,
            context: result?.reportContext || null,
            agentLib: projectUpdateAgentLib(result),
        }),
    };
    const outcome = result?.activation?.outcome;
    summary.activation = result?.activation || null;
    output.write(`${formatUpdateStatusLine(final)}\n`);
    output.write(`${UPDATE_ACTIVATION_WORDING[outcome] || 'The activation outcome was not reported.'}\n`);
    if (outcome === 'deferred' && result?.activation?.blockedBy?.length) {
        output.write(`Activation was blocked by: ${result.activation.blockedBy
            .map(entry => `${entry.phase} ${entry.id} (${entry.code || entry.outcome})`).join('; ')}.\n`);
    }
    onUpdateResult?.({ ...summary, failed: final.exitCode !== 0, result: final });
    dispatch.reported = true;
    return final.exitCode;
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
