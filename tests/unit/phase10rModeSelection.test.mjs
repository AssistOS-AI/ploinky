import assert from 'node:assert/strict';
import test from 'node:test';

import { getRuntimeForAgent } from '../../cli/sandbox/docker/common.js';

const identities = Object.freeze([
    ['OpenCode', { provider: 'opencode' }],
    ['Codex', { provider: 'codex' }],
    ['PI', { provider: 'pi' }],
    ['non-coding', { command: ['node', 'worker.mjs'] }],
    ['generic', { metadata: { arbitrary: true } }],
]);

test('all agent identities obey the exact true/false/missing runtime selector contract', () => {
    for (const [name, metadata] of identities) {
        const containerManifest = {
            ...metadata,
            container: 'example.invalid/ignored-by-fake-runtime:mutable-input',
        };
        const installed = () => true;

        assert.equal(getRuntimeForAgent({
            ...containerManifest,
            'lite-sandbox': true,
        }, {
            platform: 'linux',
            runtimeInstalled: installed,
            boxMarkerPath: '/definitely-not-a-ploinky-box-marker',
        }), 'bwrap', `${name}: Linux true`);
        assert.equal(getRuntimeForAgent({
            ...containerManifest,
            'lite-sandbox': true,
        }, {
            platform: 'darwin',
            runtimeInstalled: installed,
            boxMarkerPath: '/definitely-not-a-ploinky-box-marker',
        }), 'seatbelt', `${name}: macOS true`);
        assert.equal(getRuntimeForAgent({
            ...containerManifest,
            'lite-sandbox': false,
        }, {
            platform: 'linux',
            runtimeInstalled: installed,
            boxMarkerPath: '/definitely-not-a-ploinky-box-marker',
        }), 'podman', `${name}: false`);
        assert.equal(getRuntimeForAgent(containerManifest, {
            platform: 'linux',
            runtimeInstalled: installed,
            boxMarkerPath: '/definitely-not-a-ploinky-box-marker',
        }), 'podman', `${name}: missing`);
    }
});
