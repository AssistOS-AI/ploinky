import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { createPodmanHarness } from '../e2e/ploinkyBox/nativeHelpers.mjs';

// Native broker-only gate: the real createHomeMountBroker() from the read-only
// /opt/ploinky checkout drives `podman unshare` helpers against a nested
// rootless Podman target inside a fresh harness-owned Box. The in-Box driver
// does the work; this host side owns the Box, the evidence files and the
// before/after resource inventories.
const BOX = 'docker.io/assistos/ploinky-box@sha256:8ebee099206b3996fdf2a0ffb1987d411b575ab76a93dc058509c72b8995ea66';
const BOX_ID = 'd56a212e46e2a1cc0b08b589fe397823f54ea89289f4cc84413e8f6c84739735';
const NODE_IMAGE = 'docker.io/assistos/ploinky-node@sha256:accd925fcbf460c1f4c7a5cd9e2d46539c615bbfad2e896cabb7556d8050a669';
const NODE_IMAGE_ID = '07fd7e99fa11ca9bab2f06792e94fff2952bb30fcc8f6703227e96cde64fa7f1';
const DRIVER = '/opt/ploinky/tests/integration/webttyHomeMountBrokerNative.driver.mjs';
const ROOT = fs.realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
// Optional: a `sha256  relative/path` list pinning the frozen candidate sources. Without it the actual hashes are
// recorded but not asserted against a list (the Box's copies are still compared with the host's).
const FROZEN_HASHES = process.env.WEBTTY_BROKER_FROZEN_HASHES || '';
// Broker-relevant frozen files; sessionManager is informational (recorded, not asserted).
const FROZEN = ['cli/server/webtty/homeMountBroker.mjs', 'cli/server/webtty/homeMountHelper.py',
    'cli/server/webtty/runtimeRecords.mjs', 'cli/server/webtty/README.md'];
const INFORMATIONAL = ['cli/server/webtty/sessionManager.mjs', 'tests/unit/webttySessionManager.test.mjs'];

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function frozenHashes() {
    const expected = new Map(!FROZEN_HASHES ? [] : fs.readFileSync(FROZEN_HASHES, 'utf8').split('\n').filter(Boolean)
        .map((line) => { const [hash, ...rest] = line.split(/\s+/); return [rest.join(' '), hash]; }));
    return Object.fromEntries([...FROZEN, ...INFORMATIONAL].map((name) => [name, {
        expected: expected.get(name) || null, actual: sha256(path.join(ROOT, name)), informational: INFORMATIONAL.includes(name),
    }]));
}
function inventory(runner) {
    const read = (args) => {
        const result = runner.query('podman', args);
        assert.equal(result.ok, true, `podman ${args.join(' ')}: ${result.stderr}`);
        return result.stdout.split('\n').map((line) => line.trim()).filter(Boolean).sort();
    };
    return {
        containers: read(['ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}}']),
        volumes: read(['volume', 'ls', '-q']),
        networks: read(['network', 'ls', '-q']),
        pods: read(['pod', 'ls', '-q']),
    };
}
async function freePort(udp = false) {
    const { default: dgram } = await import('node:dgram');
    const { default: net } = await import('node:net');
    const socket = udp ? dgram.createSocket('udp4') : net.createServer();
    return new Promise((resolve, reject) => {
        socket.once('error', reject);
        const ready = () => { const port = socket.address().port; socket.close(() => resolve(port)); };
        if (udp) socket.bind(0, '0.0.0.0', ready);
        else socket.listen(0, '127.0.0.1', ready);
    });
}

test('real home-mount broker: prepare, validate, release, R7 stall and spawn-gap recovery in a native rootless Box', {
    timeout: 15 * 60_000,
}, async (t) => {
    if (process.env.PLOINKY_BOX_REQUIRE_PODMAN !== '1') {
        t.skip('set PLOINKY_BOX_REQUIRE_PODMAN=1 for the rootless-Podman candidate gate');
        return;
    }
    assert.match(process.platform, /^(?:darwin|linux)$/, 'authoritative Box tests require Linux or macOS Podman Machine');
    const EVIDENCE = process.env.WEBTTY_BROKER_NATIVE_EVIDENCE || fs.mkdtempSync(path.join(os.tmpdir(), 'webtty-broker-native-evidence-'));
    fs.mkdirSync(EVIDENCE, { recursive: true });
    t.diagnostic(`evidence: ${EVIDENCE}`);
    const harness = createPodmanHarness(t, BOX);
    const hashesBefore = frozenHashes();
    fs.writeFileSync(path.join(EVIDENCE, 'frozen-hashes-before.json'), `${JSON.stringify(hashesBefore, null, 2)}\n`);
    for (const [name, value] of Object.entries(hashesBefore)) {
        if (FROZEN_HASHES && !value.informational) assert.equal(value.actual, value.expected, `frozen source ${name} differs before the run`);
    }
    const inventoryBefore = inventory(harness.runner);
    fs.writeFileSync(path.join(EVIDENCE, 'inventory-before.json'), `${JSON.stringify(inventoryBefore, null, 2)}\n`);
    let boxId = null;
    let writebackOnHost = null;
    let summary = null;
    try {
        const image = harness.runner.query('podman', ['image', 'inspect', BOX]);
        assert.equal(image.ok, true, image.stderr);
        const [inspectedImage] = JSON.parse(image.stdout);
        assert.equal(inspectedImage.Id.replace(/^sha256:/, ''), BOX_ID);
        assert.equal(inspectedImage.Digest, BOX.split('@')[1]);
        const prepared = await harness.supervisor.prepareBoxForCommand({
            explicitPort: await freePort(), explicitMediaPort: await freePort(true), imageRef: BOX,
        });
        boxId = prepared.containerId;
        assert.equal(prepared.ownership.handles.container.runtime.imageId.replace(/^sha256:/, ''), BOX_ID);
        const inspection = harness.runner.query('podman', ['container', 'inspect', boxId]);
        assert.equal(inspection.ok, true, inspection.stderr);
        const mount = JSON.parse(inspection.stdout)[0].Mounts.find((entry) => entry.Destination === '/opt/ploinky');
        assert.equal(mount?.Type, 'bind');
        assert.equal(fs.realpathSync(mount.Source), ROOT);
        assert.equal(mount.RW, false);
        fs.writeFileSync(path.join(EVIDENCE, 'box.json'), `${JSON.stringify({ boxId, workspace: harness.workspace, imageId: BOX_ID }, null, 2)}\n`);

        // The Box store is empty: copy the pinned node image from the host store by local save/load (no registry pull).
        // The harness runner's candidate proxy only admits the Box image, so use the plain host podman for the node image.
        const hostPodman = (args) => { const r = spawnSync('podman', args, { encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 * 1024 }); return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '' }; };
        const hostImage = hostPodman(['image', 'inspect', NODE_IMAGE]);
        assert.equal(hostImage.ok, true, hostImage.stderr);
        const [hostNode] = JSON.parse(hostImage.stdout);
        assert.equal(hostNode.Id.replace(/^sha256:/, ''), NODE_IMAGE_ID);
        assert.equal(hostNode.Digest, NODE_IMAGE.split('@')[1]);
        const archive = path.join(harness.workspace, 'node-image.oci.tar');
        const saved = hostPodman(['image', 'save', '--format', 'oci-archive', '-o', archive, NODE_IMAGE_ID]);
        assert.equal(saved.ok, true, saved.stderr);
        const loaded = harness.runner.query('podman', ['container', 'exec', '--user', 'podman', boxId, '/usr/bin/podman', 'load', '-i', archive], { timeoutMs: 300_000 });
        fs.writeFileSync(path.join(EVIDENCE, 'seed-node-image.log'), `${loaded.stdout}\n${loaded.stderr}\n`);
        assert.equal(loaded.ok, true, loaded.stderr);
        fs.rmSync(archive);

        const result = harness.runner.query('podman', ['container', 'exec', '--user', 'podman', boxId,
            '/usr/local/bin/node', DRIVER, harness.workspace], { timeoutMs: 600_000 });
        fs.writeFileSync(path.join(EVIDENCE, 'driver.stdout.log'), result.stdout);
        fs.writeFileSync(path.join(EVIDENCE, 'driver.stderr.log'), result.stderr);
        const events = result.stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line));
        summary = events.find((event) => event.phase === 'summary');
        assert.ok(summary, `driver produced no summary (status ${result.status}): ${result.stderr.slice(-2000)}`);

        // The Box must have run exactly the frozen candidate files.
        const boxSources = summary.steps.sources;
        for (const name of FROZEN.filter((file) => /\.(?:mjs|js|py)$/.test(file))) {
            assert.equal(boxSources[path.basename(name)], hashesBefore[name].actual, `Box saw a different ${name}`);
        }
        assert.equal(summary.steps.driver, sha256(path.join(ROOT, 'tests/integration/webttyHomeMountBrokerNative.driver.mjs')), 'Box ran a different driver');
        const failed = summary.checks.filter((check) => !check.ok);
        assert.deepEqual(failed, [], `driver checks failed: ${JSON.stringify(failed, null, 2)}`);
        const markerPath = path.join(harness.workspace, '.data/.private/brokerNative/robots/robot-a/home/browser-writeback');
        writebackOnHost = fs.existsSync(markerPath) ? fs.readFileSync(markerPath, 'utf8') : null;
        assert.equal(writebackOnHost, summary.steps.writeNonce, 'write-back must be visible on the host side of the workspace');
        assert.equal(result.status, 0, result.stderr);
        assert.ok(summary.checks.length >= 50, `unexpectedly few checks: ${summary.checks.length}`);
        t.diagnostic(`broker native checks=${summary.checks.length} failed=0 box=${boxId}`);
    } finally {
        let cleanupError = null;
        try { await harness.cleanup(); } catch (error) { cleanupError = error; }
        const evidence = { boxId, writebackOnHost, summary: summary && { total: summary.total, failed: summary.failed, cleanup: summary.cleanup, checks: summary.checks, steps: summary.steps, signals: summary.signals },
            hashesAfter: frozenHashes(), cleanupError: cleanupError && String(cleanupError.message || cleanupError) };
        const inventoryAfter = inventory(harness.runner);
        evidence.inventoryBefore = inventoryBefore;
        evidence.inventoryAfter = inventoryAfter;
        evidence.removed = Object.fromEntries(Object.keys(inventoryBefore).map((kind) => [kind, inventoryBefore[kind].filter((item) => !inventoryAfter[kind].includes(item))]));
        evidence.added = Object.fromEntries(Object.keys(inventoryBefore).map((kind) => [kind, inventoryAfter[kind].filter((item) => !inventoryBefore[kind].includes(item))]));
        if (boxId) {
            const absent = harness.runner.query('podman', ['container', 'inspect', boxId]);
            evidence.boxAbsent = !absent.ok && /(?:no such|not found|does not exist)/i.test(`${absent.stderr}${absent.stdout}`);
        }
        fs.writeFileSync(path.join(EVIDENCE, 'summary.json'), `${JSON.stringify(evidence, null, 2)}\n`);
        assert.equal(cleanupError, null, 'harness cleanup must succeed');
        if (boxId) assert.equal(evidence.boxAbsent, true, `Box ${boxId} absence not proven`);
        for (const [name, value] of Object.entries(evidence.hashesAfter)) {
            assert.equal(value.actual, hashesBefore[name].actual, `${name} changed during the run`);
            if (FROZEN_HASHES && !value.informational) assert.equal(value.actual, value.expected, `frozen source ${name} differs after the run`);
        }
        // Other tenants of this Podman Machine may create or remove their own resources while the test runs, so the
        // raw added/removed sets are recorded in summary.json; only resources this harness owns or must not touch are asserted.
        const ours = (item) => item.includes('ploinky-box') || item.includes('broker-native') || (boxId && item.includes(boxId));
        for (const [kind, items] of Object.entries(evidence.added)) assert.deepEqual(items.filter(ours), [], `harness-owned ${kind} remain after cleanup`);
        // Pre-existing Ploinky Boxes are not ours and must survive the run untouched.
        for (const [kind, items] of Object.entries(evidence.removed)) {
            assert.deepEqual(items.filter((item) => item.includes('ploinky-box')), [], `pre-existing ${kind} vanished`);
        }
    }
});
