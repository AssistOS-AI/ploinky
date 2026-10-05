// Shared by the D2S.13 retirement leaf (not a test file): run the retirement driver in a child process
// against one fixture workspace, under the loaders every test process runs with (and the mutation loader
// when a mutant run asked for one, so a mutant patches the driver's modules too).
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const hrefOf = (relative) => pathToFileURL(path.join(ROOT, relative)).href;
export const DRIVER = path.join(ROOT, 'tests/unit/hardwareAvailabilityRetirementDriver.mjs');

export function runRetirementDriver(world, phase, argument = {}) {
    const env = { ...process.env, PLOINKY_WORKSPACE_ROOT: world.root, PLOINKY_ROUTER_HOST_PORT: '18080', PLOINKY_MEDIA_HOST_PORT: '17891' };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnSync(process.execPath, [
        '--import', hrefOf('tests/helpers/agentlibTestContract.mjs'),
        '--import', hrefOf('tests/helpers/engineSpawnGuard.mjs'),
        ...(process.env.C5_MUTATION ? ['--import', hrefOf('tests/hardware-limits/c5MutationRegister.mjs')] : []),
        DRIVER, phase, JSON.stringify(argument),
    ], { cwd: ROOT, env, encoding: 'utf8', timeout: 120_000 });
    const line = String(child.stdout).trim().split('\n').filter(Boolean).pop();
    if (!line) throw new Error(`the retirement driver wrote no result (exit ${child.status}): ${String(child.stderr).slice(-800)}`);
    const value = JSON.parse(line);
    if (value.driverError) throw new Error(`the retirement driver failed: ${value.driverError.slice(0, 1500)}`);
    return value;
}
