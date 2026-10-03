// What a fixture agent's process does when Ploinky drains it. Ploinky starts a manifest `agent` as `<shell> -c "cd <cwd> && <agent>"`
// (cli/sandbox/docker/agentServiceManager.js, agentShell.js) under a control entrypoint that forwards SIGTERM, SIGINT and SIGHUP to
// that shell; the targeted drain accepts only EXIT ZERO (targetedContainerLifecycle.js assertCleanTermination). This module runs the
// exact command, in that launch form, as a local process: no engine, no container. Test-only.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const READY_LINE = /fixture agent ready/;
export const TERMINATED_EXIT = Object.freeze({ SIGTERM: 143, SIGINT: 130, SIGHUP: 129 });

// Spawn `<shell> -c "cd <cwd> && <command>"`, wait for the ready line (a command that prints none gets `settleMs`), send `signal`, and
// report how it ended: { code, signal, timedOut, ready }. Its own process group is always removed afterwards (a shell without
// `exec` leaves its node behind).
export async function drainAgent(command, signal = 'SIGTERM', { shell = '/bin/sh', boundMs = 5000, readyMs = 10000, settleMs = 600 } = {}) {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-drain-'));
    const child = spawn(shell, ['-c', `cd ${cwd} && ${command}`], { stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let out = '';
    child.stdout.on('data', chunk => { out += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, sig) => resolve({ code, signal: sig })));
    try {
        const prints = /fixture agent ready/.test(command);
        const started = Date.now();
        while (!READY_LINE.test(out) && Date.now() - started < (prints ? readyMs : settleMs)) await new Promise(resolve => setTimeout(resolve, 20));
        child.kill(signal);
        let timer;
        const outcome = await Promise.race([exited, new Promise(resolve => { timer = setTimeout(() => resolve({ timedOut: true }), boundMs); })]);
        clearTimeout(timer);
        return { ...outcome, ready: READY_LINE.test(out) };
    } finally {
        try { process.kill(-child.pid, 'SIGKILL'); } catch { /* the group is already gone */ }
        child.stdout.destroy(); child.stderr.destroy(); fs.rmSync(cwd, { recursive: true, force: true });
    }
}

// The exit code the targeted drain would see for this agent command on SIGTERM: 0 when the process acknowledges it, 143 when it is
// killed by the signal (or does not end). Synchronous (a node child runs `drainAgent`) and cached per command, for the fakes.
const cache = new Map();
export function drainExitCode(command, { signal = 'SIGTERM' } = {}) {
    const key = `${signal}\0${command}`;
    if (cache.has(key)) return cache.get(key);
    const driver = `import(${JSON.stringify(fileURLToPath(import.meta.url))}).then(async m => { process.stdout.write(JSON.stringify(await m.drainAgent(${JSON.stringify(command)}, ${JSON.stringify(signal)}))); });`;
    const result = spawnSync(process.execPath, ['-e', driver], { encoding: 'utf8', timeout: 30000, env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR } });
    let outcome = null;
    try { outcome = JSON.parse(result.stdout); } catch { outcome = null; }
    const code = outcome && !outcome.timedOut && outcome.signal === null && outcome.code === 0 ? 0 : TERMINATED_EXIT[signal];
    cache.set(key, code);
    return code;
}
