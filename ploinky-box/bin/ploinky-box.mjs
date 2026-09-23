#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildHostSkillScope } from '../skillScope.mjs';
import { parseOuterArguments } from '../command/parse.mjs';
import { routeOuterCommand } from '../command/route.mjs';
import { buildContainerExecArgs, executeProcess, executeProcessStreaming } from '../command/execute.mjs';
import { updateHostPloinkySource } from '../command/hostUpdate.mjs';
import { resolvePloinkyUpdateScope } from '../../cli/commands/ploinkyUpdateScope.js';
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
} from '../supervisor.mjs';
import { isInsideBox } from '../lib/boxMarker.mjs';
import { parseBranchPolicy, stripBranchPolicyArgs } from '../../agentlib/branchPolicy.mjs';

export function publicUsageText() {
    return `ploinky - run Ploinky through its managed outer Box

Usage: ploinky [--debug] [--dry-run] [--port PORT] [--udp-port PORT] [--] COMMAND [ARGS]

Commands:
  ploinky                         Prepare the Box and open the Ploinky REPL
  ploinky start [AGENT [PORT]]    Start the graph; omit AGENT to reuse the saved workspace agent
  ploinky restart                 Reconcile sources and restart the whole workspace graph
  ploinky restart AGENT           Restart one agent in the existing Box generation
  ploinky --udp-port PORT start AGENT [PORT]
                                  Select the media host UDP port; defaults to 7882
  ploinky bind [ADDRESS:PORT:8080]
                                  Publish the public Router on this host's ADDRESS and
                                  TCP PORT; the Box and graph restart when it changes
  ploinky --dry-run bind [ADDRESS:PORT:8080]
                                  Show the bind plan without changing anything
  ploinky gpu status              Show the GPU grant, host GPU discovery, and Box wiring
  ploinky gpu grant nvidia --agent REPO/AGENT [--agent REPO/AGENT...]
                                  Let the named agents request the host NVIDIA GPU;
                                  the Box and graph restart when the wiring changes
  ploinky gpu revoke [--agent REPO/AGENT...]
                                  Remove the named agents, or the whole grant
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
  ploinky update [PATH]           Update Ploinky only when its checkout is within
  ploinky update all [PATH]       the selected folder; always refresh repos/deps/skills
  ploinky destroy                 Remove the outer Box without prompting; retain .ploinky/box
  ploinky destroy --delete-cache  Remove the outer Box and delete .ploinky/box/dependencies
                                  and .ploinky/box/images without prompting
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

Bind uses BIND_ADDRESS:HOST_TCP_PORT:8080. BIND_ADDRESS is 0 or 0.0.0.0 (all IPv4
interfaces), 127.0.0.1 (restore local-only access), or an IPv4 address assigned
to this host, never the browser machine's address. 8080 is the fixed public
Router port inside the Box; 8081 and agent ports cannot be published. Bare bind
uses 0.0.0.0 and the current host port. Bind requires a configured graph, starts
it if it is stopped, keeps the current image, AgentLib source, and UDP port, and
saves the binding for later start, restart, update, and Box recreation. A later
"ploinky --port PORT start" keeps the saved address and saves the new port.
Router traffic is plain HTTP, and the bind address is not a client access rule.

A GPU grant is an operator decision for this workspace only, saved outside the
workspace in ~/.ploinky-box. The Box gets the NVIDIA device nodes and read-only
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
        'gpu-status', 'gpu-grant', 'gpu-revoke'].includes(route.kind)) {
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
        env = process.env,
        output = process.stdout,
        errorOutput = process.stderr,
        execute = executeProcess,
        detectInsideBox = isInsideBox,
        cwd = () => process.cwd(),
        repositoryRoot = path.resolve(import.meta.dirname, '../..'),
        diagnose,
        repair,
    } = options;
    if (detectInsideBox()) {
        // Preserve unchanged core forwarding for other commands, including
        // core-only options that the outer argument parser does not accept.
        let command = '';
        try { command = parseOuterArguments(argv).command; } catch (_) {}
        if (command === 'diagnose' || command === 'repair') {
            errorOutput.write(`ploinky ${command} must run on the physical host, outside the Box. Exit this shell and run ploinky ${command} from the host workspace.\n`);
            return 1;
        }
        return execute('/opt/ploinky/bin/ploinky-local', [...argv], { env });
    }
    const parsed = parseOuterArguments(argv);
    const route = routeOuterCommand(parsed);
    const launchDirectory = cwd();
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
    const dispatch = { relaunched: false };
    try {
        const exitCode = await runRoutedOuterCli(argv, parsed, route, launchDirectory, dispatch, options);
        if (exitCode !== 0 && DEPLOYMENT_ROUTES.has(route.kind) && !dispatch.relaunched) {
            errorOutput.write(`${DEPLOYMENT_DIAGNOSTIC_HINT}\n`);
        }
        return exitCode;
    } catch (error) {
        if (DEPLOYMENT_ROUTES.has(route.kind)) {
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
} = {}) {
    const selectedSupervisor = supervisor || createBoxSupervisor({ env, launchCwd: launchDirectory });
    const engineEnv = buildEngineProcessEnvironment(env);
    outerDebug(parsed, route, output);

    if (route.kind === 'help') {
        output.write(publicUsageText());
        return 0;
    }
    if (route.kind === 'status') {
        const status = selectedSupervisor.inspectBoxStatus();
        const container = status.ownership?.handles?.container;
        if (status.state === 'running-initialized' && container) {
            // The in-Box renderer knows the canonical local authority only; a
            // non-loopback publication is host state, so report it here.
            if (status.routerBinding && !isLoopbackRouterBinding(status.routerBinding)) {
                output.write(`${formatRouterBindingLines(status.routerBinding).join('\n')}\n`);
            }
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
            await selectedSupervisor.runRestartTransaction(coreArgv, {
                branchPolicy: parseBranchPolicy(route.coreArgv),
            });
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
        const normalizedUpdateArgs = stripBranchPolicyArgs(parsed.commandArgs);
        const updateScopeArg = String(normalizedUpdateArgs[0] || '');
        const updateFolderPath = updateScopeArg.toLowerCase() === 'all'
            ? normalizedUpdateArgs[1]
            : updateScopeArg || undefined;
        const updateScopeRoot = resolvePloinkyUpdateScope(updateFolderPath, { cwd });
        output.write(`Using Ploinky update folder ${updateScopeRoot}.\n`);
        const hostUpdate = await updateHostSource({ repositoryRoot, updateScopeRoot });
        if (hostUpdate.updated) {
            output.write('Host Ploinky checkout updated; continuing with the updated CLI.\n');
            // The updated CLI owns diagnostics for its invocation; do not
            // duplicate its hint when the child propagates a failure status.
            dispatch.relaunched = true;
            return relaunch(process.execPath, [fileURLToPath(import.meta.url), ...argv], { env });
        }
        if (hostUpdate.skipped) {
            output.write(
                `Host Ploinky checkout at ${hostUpdate.repoPath || repositoryRoot} was not updated: `
                + `${hostUpdate.reason}.\n`,
            );
        } else {
            output.write('Host Ploinky checkout is already up to date.\n');
        }

        const priorStatus = selectedSupervisor.inspectBoxStatus();
        const restartAfterUpdate = priorStatus.state === 'running-initialized'
            && priorStatus.inbox?.routingConfigured === true;
        const updateResult = await selectedSupervisor.runUpdateTransaction(stripBranchPolicyArgs(route.coreArgv), {
            branchPolicy: parseBranchPolicy(route.coreArgv),
            restartAfterUpdate,
            updateScopeRoot,
        });
        const workspacePloinky = updateResult?.workspacePloinky;
        if (workspacePloinky?.found && !workspacePloinky.duplicateOfHost) {
            if (workspacePloinky.skipped) {
                output.write(`Workspace Ploinky checkout skipped: ${workspacePloinky.reason}.\n`);
            } else {
                const state = workspacePloinky.updated ? 'updated' : 'already up to date';
                output.write(
                    `Workspace Ploinky checkout at ${workspacePloinky.repoPath} is ${state} `
                    + '(git pull --rebase --autostash).\n',
                );
            }
        }
        if (!restartAfterUpdate) {
            output.write('Update complete; no configured running workspace required a restart.\n');
            return 0;
        }
        output.write('Update complete; the Router and managed agents were restarted coherently.\n');
        return 0;
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

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : '';
if (invokedPath === fileURLToPath(import.meta.url)) {
    try {
        process.exitCode = await runOuterCli(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`ploinky: ${error.message}\n`);
        process.exitCode = 1;
    }
}
