import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const REPO_ROOT = path.resolve(new URL('../..', import.meta.url).pathname);
const SUPERVISOR = path.join(REPO_ROOT, 'Agent/server/AgentServer.sh');

async function runSupervisor(t, acknowledgedExit) {
    const fixture = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-server-supervisor-'));
    t.after(async () => fs.rm(fixture, { recursive: true, force: true }));
    const bin = path.join(fixture, 'bin');
    const ready = path.join(fixture, 'ready');
    await fs.mkdir(bin);
    await fs.writeFile(path.join(bin, 'node'), [
        '#!/bin/sh',
        "child_pid=''",
        'stop() {',
        "  trap '' HUP INT TERM",
        '  [ -z "$child_pid" ] || kill -TERM "$child_pid" 2>/dev/null || true',
        '  [ -z "$child_pid" ] || wait "$child_pid" 2>/dev/null || true',
        `  exit ${acknowledgedExit}`,
        '}',
        "trap 'stop' HUP INT TERM",
        'printf ready > "$SUPERVISOR_READY"',
        'while :; do sleep 60 & child_pid="$!"; wait "$child_pid"; child_pid=""; done',
        '',
    ].join('\n'), { mode: 0o755 });

    const child = spawn('sh', [SUPERVISOR], {
        env: {
            ...process.env,
            PATH: `${bin}:${process.env.PATH || ''}`,
            PLOINKY_AGENT_LIB_DIR: path.join(REPO_ROOT, 'Agent'),
            SUPERVISOR_READY: ready,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk) => { output += chunk.toString('utf8'); });
    t.after(async () => {
        if (child.exitCode === null && child.signalCode === null) {
            child.kill('SIGKILL');
            await once(child, 'exit');
        }
    });

    const deadline = Date.now() + 3_000;
    while (Date.now() < deadline) {
        try {
            await fs.access(ready);
            break;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, 20));
        }
    }
    await fs.access(ready);
    assert.equal(child.kill('SIGTERM'), true);
    const [code, signal] = await once(child, 'exit');
    return { code, signal, output };
}

test('default agent supervisor preserves an in-band zero drain acknowledgement', async (t) => {
    const result = await runSupervisor(t, 0);
    assert.equal(result.signal, null, result.output);
    assert.equal(result.code, 0, result.output);
});

test('default agent supervisor cannot manufacture a clean drain acknowledgement', async (t) => {
    const result = await runSupervisor(t, 143);
    assert.equal(result.signal, null, result.output);
    assert.equal(result.code, 143, result.output);
});
