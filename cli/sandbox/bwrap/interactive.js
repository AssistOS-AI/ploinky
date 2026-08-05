import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import {
    resolveInteractiveSpawnResult,
    shouldAllocateInteractiveTty,
} from '../interactiveProcess.js';

function shellQuote(value) {
    return `'${String(value).replace(/'/g, `'\\''`)}'`;
}

export function buildShellCommand(argv) {
    return argv.map((arg) => shellQuote(arg)).join(' ');
}

export function spawnBwrapInteractive(bwrapPath, bwrapArgs, {
    env = process.env,
    stdin = process.stdin,
    stdout = process.stdout,
    scriptPath = '/usr/bin/script',
    existsSync = fs.existsSync,
    spawnSyncImpl = spawnSync,
} = {}) {
    let result;
    if (shouldAllocateInteractiveTty({ env, stdin, stdout }) && existsSync(scriptPath)) {
        const command = buildShellCommand([bwrapPath, ...bwrapArgs]);
        result = spawnSyncImpl(scriptPath, ['-qfec', command, '/dev/null'], { stdio: 'inherit' });
    } else {
        result = spawnSyncImpl(bwrapPath, bwrapArgs, { stdio: 'inherit' });
    }
    return resolveInteractiveSpawnResult(result, { label: 'bwrap interactive session' });
}
