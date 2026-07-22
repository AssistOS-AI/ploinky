#!/usr/bin/env node
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createInterface } from 'node:readline/promises';

import { parseOuterArguments } from '../command/parse.mjs';
import { routeOuterCommand } from '../command/route.mjs';
import { buildContainerExecArgs, executeProcess } from '../command/execute.mjs';
import { buildEngineProcessEnvironment } from '../process.mjs';
import { createBoxSupervisor, formatBoxStatus } from '../supervisor.mjs';
import { isInsideBox } from '../lib/boxMarker.mjs';

export function publicUsageText() {
    return `ploinky - run Ploinky through its managed outer Box

Usage: ploinky [--debug] [--dry-run] [--port PORT] [--] COMMAND [ARGS]

Commands:
  ploinky                         Prepare the Box and open the Ploinky REPL
  ploinky start AGENT [PORT]      Start the graph; the host port defaults to 8080
  ploinky status                  Inspect Box and core state without mutation
  ploinky stop                    Stop core services and the outer Box
  ploinky destroy                 Remove the outer Box after confirmation; retain data volumes
  ploinky cli                     Open Bash in the Box
  ploinky cli AGENT [ARGS]        Run an agent CLI through ploinky-local
  ploinky help                    Show this help without engine discovery

Public image, engine, instance-name, and master-key overrides are intentionally unsupported.
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
} = {}) {
    if (detectInsideBox()) {
        return execute('/opt/ploinky/bin/ploinky-local', [...argv], { env });
    }
    const selectedSupervisor = supervisor || createBoxSupervisor();
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
        if (!container) {
            output.write(formatBoxStatus(status));
            return ['foreign', 'incompatible', 'unknown', 'unsupported'].includes(status.state) ? 1 : 0;
        }
        const confirmed = await confirmDestroy(status.identity.instance, { input, output });
        if (!confirmed) {
            output.write('Destroy cancelled; no resources changed.\n');
            return 0;
        }
        await selectedSupervisor.runDestroyTransaction(container.id);
        return 0;
    }
    if (route.kind === 'dry-run') {
        const plan = selectedSupervisor.planDryRun({ explicitPort: route.hostPort });
        output.write(`${JSON.stringify(plan, null, 2)}\n`);
        return 0;
    }
    if (route.kind === 'start') {
        await selectedSupervisor.runStartTransaction(route.coreArgv, {
            explicitPort: route.hostPort,
        });
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
