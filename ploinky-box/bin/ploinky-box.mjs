#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { parseOuterArguments } from '../command/parse.mjs';
import { routeOuterCommand } from '../command/route.mjs';
import { executeProcess } from '../command/execute.mjs';
import { BOX_LABELS } from '../constants.mjs';
import { createBoxSupervisor, formatBoxStatus } from '../supervisor.mjs';
import { isInsideBox } from '../lib/boxMarker.mjs';

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

    const prepared = await selectedSupervisor.prepareBoxForCommand(
        route.localReleaseDescriptor
            ? { releaseDescriptor: route.localReleaseDescriptor }
            : {},
    );
    if (route.kind === 'bash') {
        return selectedSupervisor.executeCommand(prepared, [], {
            shell: true,
            interactive: true,
        });
    }
    return selectedSupervisor.executeCommand(
        prepared,
        ['/opt/ploinky/bin/ploinky-local', ...route.coreArgv],
        {
        interactive: ['repl', 'agent-cli'].includes(route.kind),
        },
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
