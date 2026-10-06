import test from 'node:test';
import assert from 'node:assert/strict';
import { manifestFixture, installPureGuards, generationManifest } from './test_support_codex.mjs';
import { createMemoryFs } from './fake_fs_support_codex.mjs';
import { createRunEnvironment, createRealPorts } from './real_adapters_codex.mjs';
import { createLinuxProcessObserver } from './linux_observer_codex.mjs';
installPureGuards();

// The adapter assembly is the one place the release generations meet the gate and activation ports. Under the pure guards no command can
// launch, so a gate that reaches its launch fails with a command error; one whose generation was never loaded fails earlier with gate-port-unavailable.
function wiring() {
    const { value: manifest, nowMs } = manifestFixture(), r1 = generationManifest(manifest, 'R1'), r2 = generationManifest(manifest, 'R2');
    const reads = [], memory = createMemoryFs({ [manifest.evidence.release]: JSON.stringify(r1), [manifest.evidence.release2]: JSON.stringify(r2) }), open = memory.openSync;
    const io = { ...memory, openSync: (file, ...rest) => { reads.push(file); return open(file, ...rest); } };
    const environment = createRunEnvironment({ nowWall: () => nowMs });
    const create = createRealPorts({ manifestPath: '/m_codex.json', ...environment, io, processEnv: { PATH: '/usr/bin' }, createProcessObserver: () => createLinuxProcessObserver({ platform: 'linux' }) });
    const inputs = { probeAgentImage: `docker.io/library/node@sha256:${'a'.repeat(64)}`, releaseManifest: '/r.json', expectedUpdates: {} };
    return { manifest, r1, r2, reads, ports: create({ manifest, inputs, check() {} }), environment };
}
const codeIs = code => error => error.code === code;

test('release load(R1) reads evidence.release and load(R2) reads evidence.release2, each validated; any other role is refused', async () => {
    const w = wiring(), ports = await w.ports;
    const first = await ports.release.load('R1'); assert.equal(first.runId, w.r1.runId); assert.deepEqual(w.reads, [w.manifest.evidence.release]); assert.equal(first.activation, null);
    const second = await ports.release.load('R2'); assert.equal(second.runId, w.r2.runId); assert.deepEqual(w.reads, [w.manifest.evidence.release, w.manifest.evidence.release2]); assert.equal(Array.isArray(second.activation), true);
    for (const role of ['R3', undefined, 'release', 'r1']) await assert.rejects(ports.release.load(role), codeIs('release-generation-unknown'));
    assert.equal(typeof ports.activation.start, 'function', 'the activation port is assembled');
});

test('each gate runs through the port of its own generation: Copilot needs R1 and OnlyOffice and WebMeet need R2', async () => {
    const outcome = async (loaded, gate) => { const w = wiring(), ports = await w.ports; for (const role of loaded) await ports.release.load(role);
        try { await ports.gates.run(gate); return 'ran'; } catch (error) { return error.code === 'gate-port-unavailable' ? 'unavailable' : 'reached-launch'; } };
    assert.equal(await outcome([], 'Copilot'), 'unavailable'); assert.equal(await outcome(['R2'], 'Copilot'), 'unavailable', 'R2\'s port never serves Copilot');
    assert.equal(await outcome(['R1'], 'Copilot'), 'reached-launch');
    assert.equal(await outcome(['R1'], 'OnlyOffice'), 'unavailable', 'R1\'s port never serves OnlyOffice'); assert.equal(await outcome(['R1'], 'WebMeet'), 'unavailable');
    assert.equal(await outcome(['R2'], 'OnlyOffice'), 'reached-launch'); assert.equal(await outcome(['R2'], 'WebMeet'), 'reached-launch');
    assert.equal(await outcome(['R1', 'R2'], 'Copilot'), 'reached-launch');
    await assert.rejects(async () => { const w = wiring(), ports = await w.ports; await ports.gates.run('Nope'); }, error => error.code === 'gate-port-unavailable');
});
