import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { getRuntimeForAgent } from '../../cli/sandbox/docker/common.js';
import { BOX_MARKER_CONTENT } from '../../ploinky-box/constants.mjs';

const identities = Object.freeze([
    ['OpenCode', { provider: 'opencode', command: ['opencode'] }],
    ['Codex', { provider: 'codex', command: ['codex'] }],
    ['PI', { provider: 'pi', command: ['pi'] }],
    ['Explorer', { role: 'service', command: ['node', 'explorer.mjs'] }],
    ['generic worker', { role: 'worker', command: ['node', 'worker.mjs'] }],
]);

const helperCapabilities = [
    'protocol=2 descriptor-fd=3',
    'path-resolution=openat2-beneath-no-magiclinks-no-symlinks',
    'bwrap-fd-options=bind-fd,ro-bind-fd,ro-bind-data,perms',
    'typed-fs=dir,tmpfs,proc,dev,system-symlink,ro-data-path-file',
    'ro-data-path-hardening=sealed-memfd-ro-bind-data',
    'task-broker-transport=type13-sealed-memfd-ro-bind-data-0400',
].join('\n');

test('coding and non-coding agents retain the literal selector matrix on every platform boundary', (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-phase10x-selector-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const boxMarkerPath = path.join(root, 'ploinky-box');
    const absentMarkerPath = path.join(root, 'not-a-box');
    fs.writeFileSync(boxMarkerPath, BOX_MARKER_CONTENT);

    const environments = Object.freeze([
        ['Linux host', {
            platform: 'linux',
            boxMarkerPath: absentMarkerPath,
            sandboxRuntime: 'bwrap',
        }],
        ['macOS host', {
            platform: 'darwin',
            boxMarkerPath: absentMarkerPath,
            sandboxRuntime: 'seatbelt',
        }],
        ['Linux Box', {
            platform: 'linux',
            boxMarkerPath,
            sandboxRuntime: 'bwrap',
        }],
    ]);

    for (const [identity, metadata] of identities) {
        for (const [environment, options] of environments) {
            const manifest = {
                ...metadata,
                container: 'registry.example/agent-runtime:immutable',
            };
            const probes = [];
            const runtimeOptions = {
                platform: options.platform,
                boxMarkerPath: options.boxMarkerPath,
                runtimeInstalled(runtime) {
                    probes.push(runtime);
                    return true;
                },
                spawnSyncImpl(command, args) {
                    probes.push(`${command} ${args.join(' ')}`);
                    return { status: 0, stdout: helperCapabilities };
                },
            };

            assert.equal(
                getRuntimeForAgent({ ...manifest, 'lite-sandbox': true }, runtimeOptions),
                options.sandboxRuntime,
                `${identity} / ${environment} / true`,
            );
            assert.equal(
                getRuntimeForAgent({ ...manifest, 'lite-sandbox': false }, runtimeOptions),
                'podman',
                `${identity} / ${environment} / false`,
            );
            assert.equal(
                getRuntimeForAgent(manifest, runtimeOptions),
                'podman',
                `${identity} / ${environment} / missing`,
            );

            const expectedSandboxProbe = options.sandboxRuntime === 'seatbelt'
                ? 'sandbox-exec'
                : 'bwrap';
            assert.equal(probes[0], expectedSandboxProbe, `${identity} / ${environment} sandbox probe`);
            assert.equal(
                probes.filter((probe) => probe === 'podman').length,
                2,
                `${identity} / ${environment} container selector probes`,
            );
            assert.equal(
                probes.some((probe) => probe === 'docker'),
                false,
                `${identity} / ${environment} must not fall back to Docker`,
            );
        }
    }
});

test('truthy non-literal selectors are rejected for coding and non-coding agents', () => {
    for (const [identity, metadata] of identities) {
        for (const selector of ['true', 1, null, [], {}]) {
            assert.throws(
                () => getRuntimeForAgent({
                    ...metadata,
                    container: 'registry.example/agent-runtime:immutable',
                    'lite-sandbox': selector,
                }, {
                    platform: 'linux',
                    boxMarkerPath: '/definitely-absent-ploinky-box-marker',
                    runtimeInstalled() {
                        assert.fail(`${identity}: malformed selector must fail before probing a runtime`);
                    },
                }),
                { code: 'PLOINKY_LITE_SANDBOX_SELECTOR_INVALID' },
                `${identity} / ${JSON.stringify(selector)}`,
            );
        }
    }
});
