#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PLOINKY = path.join(ROOT, 'bin', 'ploinky');
const NAME = 'runtime-smoke-' + process.pid;
const INSTANCE = 'ploinky-box-' + NAME;
const IMAGE = process.env.SMOKE_IMAGE
    || 'docker.io/assistos/ploinky-box:podman-node24-runtime-v1';
const PORT = process.env.SMOKE_PORT || '18080';
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-smoke-'));
const ENV = { ...process.env, PLOINKY_BOX_INSTALL_DEPS: '1' };

function selectEngine() {
    const candidates = process.env.SMOKE_ENGINE
        ? [process.env.SMOKE_ENGINE]
        : ['podman', 'docker'];
    const selected = candidates.find(name =>
        spawnSync(name, ['version'], { stdio: 'ignore' }).status === 0
    );
    if (!selected) throw new Error('smoke requires podman or docker');
    return selected;
}

const ENGINE = selectEngine();
const VOLUMES = [
    INSTANCE + '-workspace',
    INSTANCE + '-containers',
    INSTANCE + '-ploinky-deps',
];

function invoke(command, args, options = {}) {
    return spawnSync(command, args, {
        cwd: TMP,
        env: ENV,
        encoding: 'utf8',
        stdio: options.input === undefined
            ? ['ignore', 'pipe', 'pipe']
            : ['pipe', 'pipe', 'pipe'],
        input: options.input,
    });
}

function requireOk(label, result) {
    if (result.status === 0 && !result.error) return;
    throw new Error(
        label + ' failed (' + result.status + '): '
        + (result.stderr || result.stdout || result.error || ''),
    );
}

function ploinky(args, options) {
    return invoke(PLOINKY, ['--engine', ENGINE, '--name', NAME, ...args], options);
}

function containerExists() {
    return invoke(ENGINE, ['container', 'inspect', INSTANCE]).status === 0;
}

function volumeExists(name) {
    return invoke(ENGINE, ['volume', 'inspect', name]).status === 0;
}

try {
    requireOk('host-local help', ploinky(['help']));
    if (containerExists()) throw new Error('help created the runtime');

    requireOk(
        'automatic runtime startup',
        ploinky(['--port', PORT, '--image', IMAGE, 'list', 'agents']),
    );
    requireOk(
        'nested podman version',
        invoke(ENGINE, ['exec', INSTANCE, 'podman', 'version']),
    );
    requireOk(
        'nested podman info',
        invoke(ENGINE, ['exec', INSTANCE, 'podman', 'info']),
    );
    requireOk('combined status', ploinky(['status']));
    requireOk('first stop', ploinky(['stop']));
    requireOk('idempotent stop', ploinky(['stop']));
    requireOk('confirmed destroy', ploinky(['destroy'], { input: 'y\n' }));

    if (containerExists()) throw new Error('destroy left ' + INSTANCE);
    for (const volume of VOLUMES) {
        if (volumeExists(volume)) throw new Error('destroy left ' + volume);
    }
    process.stdout.write('runtime smoke passed\n');
} finally {
    if (containerExists()) {
        invoke(ENGINE, ['rm', '-f', INSTANCE]);
    }
    for (const volume of VOLUMES) {
        if (volumeExists(volume)) invoke(ENGINE, ['volume', 'rm', volume]);
    }
    fs.rmSync(TMP, { recursive: true, force: true });
}
