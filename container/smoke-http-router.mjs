#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
    BOX_MEDIA_PORT,
    BOX_ROUTER_PORT,
    REQUIRED_RUNTIME_IMAGE,
    runtimeVolumeNames,
} from './runtime-contract.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PLOINKY = path.join(ROOT, 'bin', 'ploinky');
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'http-router-service');
const IMAGE = process.env.SMOKE_IMAGE || REQUIRED_RUNTIME_IMAGE;
const PORT = String(process.env.SMOKE_PORT || '18080');
const TMP = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-http-router-smoke-')));
const HASH = crypto.createHash('sha256').update(TMP).digest('hex').slice(0, 12);
const SLUG = path.basename(TMP).replace(/[^a-zA-Z0-9_.-]/g, '_').slice(0, 48);
const INSTANCE = `ploinky-box-${SLUG}-${HASH}`;
const VOLUMES = runtimeVolumeNames(INSTANCE);
const EXPECTED_BINDINGS = Object.freeze({
    [`${BOX_ROUTER_PORT}/tcp`]: [{ HostIp: '127.0.0.1', HostPort: PORT }],
    [`${BOX_MEDIA_PORT}/udp`]: [{ HostIp: '0.0.0.0', HostPort: String(BOX_MEDIA_PORT) }],
});
const FORBIDDEN_TARGETS = Object.freeze(['7000/tcp', '8081/tcp', '7880/tcp', '7881/tcp']);
const ENV = {
    ...process.env,
    PLOINKY_BOX_INSTALL_DEPS: '1',
    PLOINKY_BOX_SOURCE: ROOT,
    PLOINKY_BOX_AUTO_BRANCH: '0',
    PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY || '5'.repeat(64),
};
delete ENV.PLOINKY_BOX_ENGINE;

function invoke(command, args) {
    return spawnSync(command, args, {
        cwd: TMP,
        env: ENV,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
    });
}

function requireOk(label, result) {
    if (result.status === 0 && !result.error) return result;
    throw new Error(
        `${label} failed (${result.status}): ${result.stderr || result.stdout || result.error || ''}`,
    );
}

function ploinky(args) {
    return invoke(PLOINKY, args);
}

function containerExists() {
    return invoke('podman', ['container', 'inspect', INSTANCE]).status === 0;
}

function volumeExists(name) {
    return invoke('podman', ['volume', 'inspect', name]).status === 0;
}

function normalizeBindings(bindings = {}) {
    return Object.fromEntries(Object.entries(bindings)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([target, values]) => [target, (values || []).map(value => ({
            HostIp: String(value?.HostIp || '0.0.0.0'),
            HostPort: String(value?.HostPort || ''),
        })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)))]));
}

function inspectOuter(phase) {
    const record = JSON.parse(requireOk(
        `${phase}: inspect outer container`,
        invoke('podman', ['container', 'inspect', INSTANCE]),
    ).stdout)[0];
    const actual = normalizeBindings(record?.HostConfig?.PortBindings);
    const expected = normalizeBindings(EXPECTED_BINDINGS);
    assert.deepEqual(actual, expected, `${phase}: HostConfig.PortBindings drifted`);
    assert.equal(Object.keys(actual).length, 2, `${phase}: outer container must have two targets`);
    for (const target of FORBIDDEN_TARGETS) {
        assert.equal(Object.hasOwn(actual, target), false, `${phase}: forbidden ${target} publication`);
    }
    process.stdout.write(`PORT_BINDINGS ${phase} ${JSON.stringify(actual)}\n`);
}

function parsePodmanPort(stdout) {
    return String(stdout || '').split(/\r?\n/).map(value => value.trim()).filter(Boolean)
        .map(line => {
            const match = /^(\d+\/(?:tcp|udp))\s+->\s+(.+):(\d+)$/.exec(line);
            if (!match) throw new Error(`unrecognized podman port record: ${line}`);
            return {
                target: match[1],
                HostIp: match[2] || '0.0.0.0',
                HostPort: match[3],
            };
        })
        .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

function assertPodmanPort(phase) {
    const actual = parsePodmanPort(requireOk(
        `${phase}: podman port`,
        invoke('podman', ['port', INSTANCE]),
    ).stdout);
    const expected = [
        { target: `${BOX_ROUTER_PORT}/tcp`, HostIp: '127.0.0.1', HostPort: PORT },
        { target: `${BOX_MEDIA_PORT}/udp`, HostIp: '0.0.0.0', HostPort: String(BOX_MEDIA_PORT) },
    ].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
    assert.deepEqual(actual, expected, `${phase}: podman port output drifted`);
    process.stdout.write(`PODMAN_PORT ${phase} ${JSON.stringify(actual)}\n`);
}

function assertExactOuterBoundary(phase) {
    inspectOuter(phase);
    assertPodmanPort(phase);
}

function assertFixtureManifest() {
    const manifest = JSON.parse(fs.readFileSync(path.join(FIXTURE, 'manifest.json'), 'utf8'));
    assert.equal(Array.isArray(manifest.httpServices), true, 'fixture must declare httpServices');
    assert.equal(manifest.httpServices[0]?.port, 7000, 'fixture must target private port 7000');
}

async function assertRouterHttpService(phase) {
    const response = await fetch(
        `http://127.0.0.1:${PORT}/services/http-router-service/check?via=router`,
        { signal: AbortSignal.timeout(5000) },
    );
    const body = await response.text();
    assert.equal(response.status, 200, `${phase}: Router service status`);
    assert.match(
        body,
        /http-router-service-ok \/check\?via=router/,
        `${phase}: Router service body`,
    );
    process.stdout.write(`ROUTER_HTTP_SERVICE ${phase} ${response.status} ${body}\n`);
}

function assertRootlessPodman() {
    requireOk('answering Podman engine', invoke('podman', ['info']));
    const rootless = requireOk(
        'rootless Podman proof',
        invoke('podman', ['info', '--format', '{{json .Host.Security.Rootless}}']),
    ).stdout.trim();
    assert.equal(rootless, 'true', 'HTTP Router smoke requires rootless Podman');
}

try {
    assertRootlessPodman();
    assertFixtureManifest();
    requireOk(
        'automatic empty-workspace runtime startup',
        ploinky(['--port', PORT, '--image', IMAGE, 'list', 'agents']),
    );
    requireOk(
        'create HTTP service repository destination',
        invoke('podman', ['exec', INSTANCE, 'mkdir', '-p', '/workspace/.ploinky/repos/smoke/http-router-service']),
    );
    requireOk(
        'copy HTTP service fixture repository',
        invoke('podman', ['cp', `${FIXTURE}/.`, `${INSTANCE}:/workspace/.ploinky/repos/smoke/http-router-service`]),
    );
    requireOk(
        'start HTTP service through Router',
        ploinky(['--image', IMAGE, 'start', 'smoke/http-router-service', PORT]),
    );
    assertExactOuterBoundary('started');
    await assertRouterHttpService('started');

    requireOk('shutdown HTTP service runtime', ploinky(['shutdown']));
    requireOk(
        'restart HTTP service through Router',
        ploinky(['--image', IMAGE, 'start', 'smoke/http-router-service', PORT]),
    );
    assertExactOuterBoundary('restarted');
    await assertRouterHttpService('restarted');
    process.stdout.write(`HTTP Router smoke passed (podman, ${INSTANCE})\n`);
} finally {
    if (containerExists()) invoke('podman', ['rm', '-f', '--volumes', INSTANCE]);
    for (const name of Object.values(VOLUMES)) {
        if (volumeExists(name)) invoke('podman', ['volume', 'rm', name]);
    }
    fs.rmSync(TMP, { recursive: true, force: true });
}
