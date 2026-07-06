#!/usr/bin/env node
// End-to-end smoke for ploinky-box. Needs a container engine and either the
// published image or SMOKE_IMAGE pointing at a local build (e.g. ploinky-box:dev).
// Usage: [SMOKE_IMAGE=...] [SMOKE_PORT=...] [SMOKE_AGENT=...] node smoke-box.mjs
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BOX = path.join(HERE, 'ploinky-box');
const PUBLIC_PLOINKY = path.resolve(HERE, '../bin/ploinky');
const NAME = `smoke${process.pid}`;
const PORT = process.env.SMOKE_PORT || '8090';
const IMAGE = process.env.SMOKE_IMAGE || 'docker.io/assistos/ploinky-box:podman-node24';
const AGENT = process.env.SMOKE_AGENT || 'webtty';
const USE_PUBLIC_PLOINKY = process.env.SMOKE_PUBLIC_PLOINKY === '1';
let failed = 0;

function box(...args) {
    return spawnSync(BOX, args, { stdio: 'inherit' }).status === 0;
}

function publicPloinky(...args) {
    return spawnSync(PUBLIC_PLOINKY, args, { stdio: 'inherit' }).status === 0;
}

function step(desc, ok) {
    if (ok) {
        console.log(`PASS: ${desc}`);
    } else {
        console.log(`FAIL: ${desc}`);
        failed = 1;
    }
}

async function probeRouter() {
    for (let i = 0; i < 30; i += 1) {
        for (const p of ['status', 'health']) {
            try {
                const r = await fetch(`http://127.0.0.1:${PORT}/${p}`, { signal: AbortSignal.timeout(2000) });
                if (r.ok) return true;
            } catch { /* not up yet */ }
        }
        await sleep(1000);
    }
    return false;
}

console.log(`== ploinky-box smoke: instance=${NAME} port=${PORT} image=${IMAGE} agent=${AGENT} ==`);
console.log(`publicPloinky=${USE_PUBLIC_PLOINKY ? 'enabled' : 'disabled'}`);

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-smoke-'));
const tmpIn = path.join(tmpDir, 'in.txt');
const tmpOut = path.join(tmpDir, 'out.txt');

step('up', box('--name', NAME, '--port', PORT, '--image', IMAGE, 'up'));
step('enable agent', box('--name', NAME, 'run', 'enable', 'agent', AGENT));
step('start agent + router', box('--name', NAME, 'run', 'start', AGENT, '8080'));
step('router responds', await probeRouter());

fs.writeFileSync(tmpIn, 'smoke payload\n');
step('cp into box', box('--name', NAME, 'cp', tmpIn, 'box:/workspace/smoke.txt'));
step('cp out of box', box('--name', NAME, 'cp', 'box:/workspace/smoke.txt', tmpOut));
step('cp round-trip intact',
    fs.existsSync(tmpOut) && fs.readFileSync(tmpIn).equals(fs.readFileSync(tmpOut)));

step('stop', box('--name', NAME, 'stop'));
step('re-up (state kept)', box('--name', NAME, '--port', PORT, '--image', IMAGE, 'up'));
step('resume agents', box('--name', NAME, 'run', 'start'));
step('router responds again', await probeRouter());
if (USE_PUBLIC_PLOINKY) {
    step(
        'public ploinky start command (idempotent on a running box)',
        publicPloinky('--name', NAME, '--port', PORT, 'start', AGENT),
    );
    step('public ploinky status command', publicPloinky('--name', NAME, 'status'));
    step('public ploinky box status command', publicPloinky('--name', NAME, 'box', 'status'));
} else {
    step('start command (idempotent on a running box)', box('--name', NAME, 'start', AGENT));
}

if (process.env.SMOKE_WS_AGENT) {
    step('ws agent enable', box('--name', NAME, 'run', 'enable', 'agent', process.env.SMOKE_WS_AGENT));
    step('ws agent restart', box('--name', NAME, 'run', 'start'));
    console.log(`NOTE: verify the additionalServerPort surface of ${process.env.SMOKE_WS_AGENT} manually via the router, then record the outcome in container/README.md`);
} else {
    console.log('WS-CHECK SKIPPED (set SMOKE_WS_AGENT=<agent-with-additionalServerPort> to exercise it)');
}

spawnSync(BOX, ['--name', NAME, 'destroy'], { input: 'y\n', stdio: ['pipe', 'inherit', 'inherit'] });
fs.rmSync(tmpDir, { recursive: true, force: true });

console.log('');
console.log(failed === 0 ? '== SMOKE PASSED ==' : '== SMOKE FAILED ==');
process.exit(failed);
