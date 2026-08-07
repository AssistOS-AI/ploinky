#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { parseOuterArguments } from '../command/parse.mjs';
import { routeOuterCommand } from '../command/route.mjs';
import { buildContainerExecArgs, executeProcess } from '../command/execute.mjs';
import { updateHostPloinkySource } from '../command/hostUpdate.mjs';
import { BOX_IMAGE_OVERRIDE_ENV, BOX_IMAGE_REFERENCE, BOX_LABELS } from '../constants.mjs';
import { buildEngineProcessEnvironment } from '../process.mjs';
import { createBoxSupervisor, formatBoxStatus } from '../supervisor.mjs';
import { isInsideBox } from '../lib/boxMarker.mjs';

export function publicUsageText() {
    return `ploinky - run Ploinky through its managed outer Box

Usage: ploinky [--debug] [--dry-run] [--port PORT] [--udp-port PORT] [--] COMMAND [ARGS]

Commands:
  ploinky                         Prepare the Box and open the Ploinky REPL
  ploinky start AGENT [PORT]      Start the graph; the Router host port defaults to 8080
  ploinky --udp-port PORT start AGENT [PORT]
                                  Select the media host UDP port; defaults to 7882
  ploinky status                  Inspect Box and core state without mutation
  ploinky stop                    Stop core services and the outer Box
  ploinky update [all [PATH]]     Update host core, in-Box repos/deps/skills,
                                  then restart a configured running workspace
  ploinky destroy                 Remove the outer Box after confirmation; retain data volumes
  ploinky destroy --delete-volumes
                                  Remove the outer Box and its data volumes without prompting
  ploinky cli                     Open Bash in the Box
  ploinky cli AGENT [ARGS]        Run an agent CLI through ploinky-local
  ploinky help                    Show this help without engine discovery

The default Box image is ${BOX_IMAGE_REFERENCE}.
Set ${BOX_IMAGE_OVERRIDE_ENV} to pull a different Box image reference.
Public CLI image options, engine, instance-name, and master-key overrides are unsupported.
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

function executePrepared(prepared, coreArgv, {
    execute,
    input,
    output,
    shell = false,
    interactive = false,
    engineEnv,
}) {
    return execute(prepared.engine.name, buildContainerExecArgs(
        prepared.containerId,
        coreArgv,
        {
            hostPort: prepared.hostPort,
            mediaHostPort: prepared.mediaHostPort,
            shell,
            interactive,
            inputIsTty: input.isTTY === true,
            outputIsTty: output.isTTY === true,
        },
    ), { env: engineEnv });
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
    repositoryRoot = path.resolve(import.meta.dirname, '../..'),
    updateHostSource = updateHostPloinkySource,
    relaunch = executeProcess,
} = {}) {
    if (detectInsideBox()) {
        return execute('/opt/ploinky/bin/ploinky-local', [...argv], { env });
    }
    const selectedSupervisor = supervisor || createBoxSupervisor({ env });
    const parsed = parseOuterArguments(argv);
    const route = routeOuterCommand(parsed);
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
            const coreStatus = executePrepared({
                containerId: container.id,
                engine: status.ownership.engine,
                hostPort: Number(container.labels?.[BOX_LABELS.routerHostPort]),
                mediaHostPort: Number(container.labels?.[BOX_LABELS.mediaHostPort]),
            }, ['status'], {
                execute,
                input,
                output,
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
        const hasOwnedVolumes = Object.values(status.ownership?.handles?.volumes || {})
            .some(Boolean);
        if (!container && !(route.deleteVolumes && hasOwnedVolumes)) {
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
        });
        return 0;
    }

    if (route.kind === 'update') {
        output.write(`Updating host Ploinky checkout at ${repositoryRoot}...\n`);
        const hostUpdate = await updateHostSource({ repositoryRoot });
        if (hostUpdate.updated) {
            output.write('Host Ploinky checkout updated; continuing with the updated CLI.\n');
            return relaunch(process.execPath, [fileURLToPath(import.meta.url), ...argv], { env });
        }
        output.write('Host Ploinky checkout is already up to date.\n');

        const priorStatus = selectedSupervisor.inspectBoxStatus();
        const restartAfterUpdate = priorStatus.state === 'running-initialized'
            && priorStatus.inbox?.routingConfigured === true;
        const prepared = await selectedSupervisor.prepareBoxForCommand();
        const updateCode = executePrepared(prepared, route.coreArgv, {
            execute,
            input,
            output,
            engineEnv,
        });
        if (updateCode !== 0) return updateCode;
        if (!restartAfterUpdate) {
            output.write('Update complete; no configured running workspace required a restart.\n');
            return 0;
        }
        output.write('Update complete; restarting the Router and managed agents...\n');
        return executePrepared(prepared, ['restart'], {
            execute,
            input,
            output,
            engineEnv,
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
        });
    }
    return executePrepared(prepared, route.coreArgv, {
        execute,
        input,
        output,
        interactive: ['repl', 'agent-cli'].includes(route.kind),
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
