import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPodmanHarness, execInBox, requirePodmanCandidate } from '../e2e/ploinkyBox/nativeHelpers.mjs';

const DRIVER = '/opt/ploinky/tests/integration/webttyBoxSessionCleanupDriver.mjs';
const ROOT = fs.realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const SOURCES = [
    'tests/integration/webttyBoxSessionCleanupDriver.mjs',
    'core-services/webtty/process-identity.mjs',
    'core-services/webtty/terminal-worker.mjs',
];

async function freePort(udp = false) {
    const socket = udp ? dgram.createSocket('udp4') : net.createServer();
    return new Promise((resolve, reject) => {
        socket.once('error', reject);
        const ready = () => {
            const port = socket.address().port;
            socket.close(() => resolve(port));
        };
        if (udp) socket.bind(0, '0.0.0.0', ready);
        else socket.listen(0, '127.0.0.1', ready);
    });
}

test('native Box terminal reclaims every anchored session group and admits another terminal', {
    timeout: 180_000,
}, async (t) => {
    const candidate = requirePodmanCandidate(t);
    if (!candidate) return;
    const harness = createPodmanHarness(t, candidate);
    try {
        const prepared = await harness.supervisor.prepareBoxForCommand({
            explicitPort: await freePort(),
            explicitMediaPort: await freePort(true),
            imageRef: candidate,
        });
        const inspected = harness.runner.query('podman', ['container', 'inspect', prepared.containerId]);
        assert.equal(inspected.ok, true, inspected.stderr);
        const [container] = JSON.parse(inspected.stdout);
        const mount = container.Mounts.find((entry) => entry.Destination === '/opt/ploinky');
        assert.equal(mount?.Type, 'bind');
        assert.equal(fs.realpathSync(mount.Source), ROOT);
        assert.equal(mount.RW, false);
        const image = harness.runner.query('podman', ['image', 'inspect', candidate]);
        assert.equal(image.ok, true, image.stderr);
        assert.equal(container.Image, JSON.parse(image.stdout)[0].Id);
        const output = execInBox(harness.runner, prepared.containerId, ['/usr/local/bin/node', DRIVER], {
            timeoutMs: 90_000,
        });
        const evidence = JSON.parse(output.split('\n').at(-1));
        assert.deepEqual(evidence.sources, Object.fromEntries(SOURCES.map((source) => [
            source, crypto.createHash('sha256').update(fs.readFileSync(`${ROOT}/${source}`)).digest('hex'),
        ])));
        assert.equal(evidence.childDifferentGroup, true);
        assert.equal(evidence.shellGone, true);
        assert.equal(evidence.childGone, true);
        assert.equal(evidence.sentinelUnchanged, true);
        assert.equal(evidence.reclaimed, true);
        assert.equal(evidence.recordRemoved, true);
        assert.equal(evidence.secondAdmitted, true);
        assert.equal(evidence.exitNotifications, 1);
        assert.equal(evidence.cleanupUnproven, 0);
        assert.ok(evidence.workerExitMs < 2_000);
        t.diagnostic(`PLOINKY_WEBTTY_BOX_CLEANUP ${JSON.stringify({ imageId: container.Image, ...evidence })}`);
    } finally {
        await harness.cleanup();
    }
});
