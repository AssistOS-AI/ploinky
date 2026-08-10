#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { showHelp } from './commands/help.js';
import { runOuterRuntimeShell } from './sandbox/runtimeShell.js';

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

export async function launchCli(args = process.argv.slice(2), {
    showHelpImpl = showHelp,
    runOuterRuntimeShellImpl = runOuterRuntimeShell,
    statusWorkspaceImpl,
    importCoreImpl = () => import('./main.js'),
    importLogCommandsImpl = () => import('./commands/logCommands.js'),
    importConfigImpl = () => import('./utils/config.js'),
    importForegroundImpl = () => import('./commands/foregroundCommand.js'),
    input = process.stdin,
    env = process.env,
    errorOutput = process.stderr,
} = {}) {
    if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
        showHelpImpl(args[0] === 'help' ? args.slice(1) : [], { surface: 'core' });
        return 0;
    }
    if (args.length === 1 && args[0] === 'status') {
        const renderStatus = statusWorkspaceImpl
            || (await import('./utils/status.js')).statusWorkspace;
        await renderStatus();
        return 0;
    }
    if (args.length === 1 && args[0] === 'cli') {
        return runOuterRuntimeShellImpl();
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
