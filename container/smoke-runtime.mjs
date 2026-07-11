#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    IDENTITY_SCHEMA_LABEL,
    PATH_HASH_LABEL,
    REQUIRED_RUNTIME_IMAGE,
    VOLUME_ROLE_LABEL,
    VOLUME_ROLES,
    runtimeVolumeNames,
} from './runtime-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PLOINKY = path.join(ROOT, 'bin', 'ploinky');
const IMAGE = process.env.SMOKE_IMAGE || REQUIRED_RUNTIME_IMAGE;
const PORT = process.env.SMOKE_PORT || '18080';
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-smoke-')));
const HASH = crypto.createHash('sha256').update(TMP).digest('hex').slice(0, 12);
const SLUG = path.basename(TMP).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 48);
const INSTANCE = `ploinky-box-${SLUG}-${HASH}`;
const VOLUMES = runtimeVolumeNames(INSTANCE);
const ENV = {
    ...process.env,
    PLOINKY_BOX_INSTALL_DEPS: '1',
    PLOINKY_BOX_SOURCE: ROOT,
    PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY || '5'.repeat(64),
};
delete ENV.PLOINKY_BOX_ENGINE;

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
function answeringEngines() {
    return ['podman', 'docker'].filter(engine =>
        invoke(engine, ['info']).status === 0
    );
}

const ENGINES = answeringEngines();
if (ENGINES.length === 0) throw new Error('smoke requires an answering podman or docker engine');

function requireOk(label, result) {
    if (result.status === 0 && !result.error) return result;
    throw new Error(
        label + ' failed (' + result.status + '): '
        + (result.stderr || result.stdout || result.error || ''),
    );
}

function ploinky(args, options) {
    return invoke(PLOINKY, args, options);
}

function containerExists(engine) {
    return invoke(engine, ['container', 'inspect', INSTANCE]).status === 0;
}

function volumeExists(engine, name) {
    return invoke(engine, ['volume', 'inspect', name]).status === 0;
}

function discoverOwner() {
    const owners = ENGINES.filter(containerExists);
    if (owners.length !== 1) {
        throw new Error(`expected one owner for ${INSTANCE}, found: ${owners.join(', ') || '<none>'}`);
    }
    return owners[0];
}

function assertRetainedVolumeLabels(engine) {
    for (const [role, name] of Object.entries(VOLUMES)) {
        const inspected = requireOk(
            `inspect retained ${role} volume`,
            invoke(engine, ['volume', 'inspect', name]),
        );
        const raw = JSON.parse(inspected.stdout)[0];
        const labels = raw.Labels || raw.labels || {};
        if (labels[IDENTITY_SCHEMA_LABEL] !== '1') {
            throw new Error(`${name} lost ${IDENTITY_SCHEMA_LABEL}=1`);
        }
        if (labels[PATH_HASH_LABEL] !== HASH) {
            throw new Error(`${name} lost ${PATH_HASH_LABEL}=${HASH}`);
        }
        if (labels[VOLUME_ROLE_LABEL] !== VOLUME_ROLES[role]) {
            throw new Error(`${name} lost ${VOLUME_ROLE_LABEL}=${VOLUME_ROLES[role]}`);
        }
    }
}

function installPlanningProbe(engine) {
    const fixtureDir = path.join(TMP, 'planning-probe');
    const fixtureManifest = path.join(fixtureDir, 'manifest.json');
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(fixtureManifest, JSON.stringify({
        container: 'docker.io/library/alpine:latest',
        start: 'sleep 600',
        readiness: { protocol: 'none' },
        profiles: { default: {} },
    }, null, 2));
    requireOk(
        'create planning-probe repository',
        invoke(engine, ['exec', INSTANCE, 'mkdir', '-p', '/workspace/.ploinky/repos/smoke/planning-probe']),
    );
    requireOk(
        'copy planning-probe manifest',
        invoke(engine, ['cp', fixtureManifest, `${INSTANCE}:/workspace/.ploinky/repos/smoke/planning-probe/manifest.json`]),
    );
}

function assertNoTemporaryPlanner(engine) {
    const listed = requireOk(
        'inventory temporary planners',
        invoke(engine, ['ps', '-a', '--format', '{{.Names}}']),
    );
    const remaining = listed.stdout
        .split(/\r?\n/)
        .map(value => value.trim())
        .filter(value => value.startsWith(`${INSTANCE}-planner-`));
    if (remaining.length) {
        throw new Error(`temporary publication planner remained: ${remaining.join(', ')}`);
    }
}

let owner = '';
try {
    requireOk('host-local help', ploinky(['help']));
    if (ENGINES.some(containerExists)) throw new Error('help created the runtime');

    requireOk(
        'automatic runtime startup',
        ploinky(['--port', PORT, '--image', IMAGE, 'list', 'agents']),
    );
    owner = discoverOwner();
    requireOk('nested podman version', invoke(owner, ['exec', INSTANCE, 'podman', 'version']));
    requireOk('nested podman info', invoke(owner, ['exec', INSTANCE, 'podman', 'info']));
    installPlanningProbe(owner);
    requireOk(
        'write retained-state marker',
        invoke(owner, ['exec', INSTANCE, 'sh', '-lc', 'printf retained > /workspace/.runtime-smoke-marker']),
    );
    requireOk('combined status', ploinky(['status']));
    requireOk('stop before real-engine planning', ploinky(['stop']));
    requireOk(
        'stopped-box planning with stdin delivery',
        ploinky(['--image', IMAGE, 'start', 'smoke/planning-probe', PORT]),
    );
    assertNoTemporaryPlanner(owner);
    requireOk('stop after planned start', ploinky(['stop']));
    requireOk('idempotent stop', ploinky(['stop']));
    requireOk('confirmed destroy', ploinky(['destroy'], { input: 'y\n' }));

    if (containerExists(owner)) throw new Error('destroy left ' + INSTANCE);
    assertRetainedVolumeLabels(owner);

    requireOk(
        'recreate from retained state',
        ploinky(['--port', PORT, '--image', IMAGE, 'list', 'agents']),
    );
    owner = discoverOwner();
    const marker = requireOk(
        'read retained-state marker',
        invoke(owner, ['exec', INSTANCE, 'cat', '/workspace/.runtime-smoke-marker']),
    );
    if (marker.stdout.trim() !== 'retained') throw new Error('workspace state did not survive destroy');
    process.stdout.write(`runtime smoke passed (${owner}, ${INSTANCE})\n`);
} finally {
    for (const engine of ENGINES) {
        if (containerExists(engine)) invoke(engine, ['rm', '-f', '--volumes', INSTANCE]);
        for (const name of Object.values(VOLUMES)) {
            if (volumeExists(engine, name)) invoke(engine, ['volume', 'rm', name]);
        }
    }
    fs.rmSync(TMP, { recursive: true, force: true });
}
