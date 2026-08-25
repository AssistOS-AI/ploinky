#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { showHelp } from './commands/help.js';
import { bootstrapAgentLibRuntime } from '../agentlib/bootstrap.mjs';
import { parseBranchPolicy } from '../agentlib/branchPolicy.mjs';

// `runCoreCli()` accepts one global debug flag in any position. The read-only
// log dispatch has to recognize the same placement before it can decide whether
// `logs` is the command, but it must not take the initializing core path to do
// it.
function extractGlobalDebugFlag(args) {
    const index = args.findIndex(arg => arg === '--debug' || arg === '-d');
    if (index === -1) return { commandArgs: args, debug: false };
    const commandArgs = [...args];
    commandArgs.splice(index, 1);
    return { commandArgs, debug: true };
}

// Branch policy only narrows the AgentLib selection; a malformed value is
// reported by the command that owns it, so bootstrap treats it as absent rather
// than failing before the command can produce its own message.
function safeBranchPolicy(args) {
    try {
        return parseBranchPolicy(args);
    } catch (_) {
        return null;
    }
}

export async function launchCli(args = process.argv.slice(2), {
    showHelpImpl = showHelp,
    // The runtime shell reaches the Router security path, which resolves
    // achillesAgentLib at module load. Importing it lazily keeps `help` and
    // `logs` loadable without any AgentLib runtime contract at all.
    runOuterRuntimeShellImpl = null,
    statusWorkspaceImpl,
    importCoreImpl = () => import('./main.js'),
    importLogCommandsImpl = () => import('./commands/logCommands.js'),
    importConfigImpl = () => import('./utils/config.js'),
    importForegroundImpl = () => import('./commands/foregroundCommand.js'),
    bootstrapAgentLibImpl = bootstrapAgentLibRuntime,
    input = process.stdin,
    env = process.env,
    errorOutput = process.stderr,
} = {}) {
    if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
        showHelpImpl(args[0] === 'help' ? args.slice(1) : [], { surface: 'core' });
        return 0;
    }
    if (args.length === 1 && args[0] === 'status') {
        // Status reports the selected AgentLib source, so it needs the runtime
        // contract — but in read-only mode, which never clones, fetches, or
        // creates workspace state.
        await bootstrapAgentLibImpl({ env, readOnly: true });
        const renderStatus = statusWorkspaceImpl
            || (await import('./utils/status.js')).statusWorkspace;
        await renderStatus();
        return 0;
    }
    if (args.length === 1 && args[0] === 'cli') {
        await bootstrapAgentLibImpl({ env, readOnly: true });
        const runShell = runOuterRuntimeShellImpl
            || (await import('./sandbox/runtimeShell.js')).runOuterRuntimeShell;
        return runShell();
    }
    // Logs are observational, so they bypass dependency assertion, environment
    // initialization, and repository bootstrap. Stdout carries only log bytes;
    // every informational message goes to stderr.
    const { commandArgs, debug } = extractGlobalDebugFlag(args);
    if (commandArgs[0] === 'logs') {
        if (debug) {
            const { setDebugMode } = await importConfigImpl();
            setDebugMode(true);
            errorOutput.write('[INFO] Debug mode enabled.\n');
        }
        const { runLogCommand } = await importLogCommandsImpl();
        // A follower runs until the operator interrupts it, so the coordinator
        // owns SIGINT/SIGTERM for the whole command and maps them to 130/143
        // only after the follower has released its child and descriptors.
        const { getForegroundCommandCoordinator } = await importForegroundImpl();
        const coordinator = getForegroundCommandCoordinator();
        const running = coordinator.run(({ signal }) => runLogCommand(commandArgs, { signal }));
        if (env.PLOINKY_BOX_LOG_STREAM !== '1') return (await running).code;

        const onEof = () => coordinator.cancel();
        input.once?.('end', onEof);
        input.once?.('close', onEof);
        input.resume?.();
        try {
            return (await running).code;
        } finally {
            input.removeListener?.('end', onEof);
            input.removeListener?.('close', onEof);
        }
    }
    // Establish the achillesAgentLib runtime contract before importing any core
    // module. Outside the Box this selects (and, for a managed source, stages)
    // the one workspace source; inside the Box it only validates the mount the
    // host supervisor established. Help, logs, and single-word status returned
    // above, so they stay free of any clone or fetch side effect.
    await bootstrapAgentLibImpl({ env, branchPolicy: safeBranchPolicy(args) });
    const { runCoreCli } = await importCoreImpl();
    return runCoreCli(args);
}

const entryPoint = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (entryPoint === fileURLToPath(import.meta.url)) {
    launchCli().then(code => {
        if (Number.isInteger(code)) process.exitCode = code;
    }).catch(error => {
        console.error('❌ Error: ' + error.message);
        process.exitCode = 1;
    });
}
