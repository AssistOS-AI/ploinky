#!/usr/bin/env node

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { showHelp } from './services/help.js';
import { runOuterRuntimeShell } from './services/runtimeShell.js';

export async function launchCli(args = process.argv.slice(2), {
    showHelpImpl = showHelp,
    runOuterRuntimeShellImpl = runOuterRuntimeShell,
    importCoreImpl = () => import('./main.js'),
} = {}) {
    if (args[0] === 'help' || args[0] === '--help' || args[0] === '-h') {
        showHelpImpl(args[0] === 'help' ? args.slice(1) : [], { surface: 'core' });
        return 0;
    }
    if (args.length === 1 && args[0] === 'cli') {
        return runOuterRuntimeShellImpl();
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
