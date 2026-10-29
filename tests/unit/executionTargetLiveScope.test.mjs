import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { discoverExecutionTargets } from '../../cli/server/executionTarget/discovery.mjs';
import { createLiveBoxScopeProvider, readLiveBoxScope, workspaceScopeId } from '../../cli/server/executionTarget/liveScope.mjs';
import { createSourceProtectionService } from '../../cli/server/executionTarget/sourceProtectionService.mjs';
import { createTargetHelperTicketMinter } from '../../cli/server/security/tokens/targetHelperTicketMinter.mjs';

const BOX_NAME = 'ploinky-box-ws-0123456789ab';
const BOX_ID = 'c'.repeat(64);

const mountLine = (id, mountPoint = '/run/.containerenv', leaf = '.containerenv') =>
    `7388 7390 0:73 /containers/overlay-containers/${id}/userdata/${leaf} ${mountPoint} rw,nosuid,nodev,relatime - tmpfs tmpfs rw,mode=700`;
const mountInfo = (id = BOX_ID, extra = []) => [
    '7300 7290 0:70 / / rw,relatime - overlay overlay rw',
    mountLine(id, '/etc/hostname', 'hostname'),
    mountLine(id),
    ...extra,
    '',
].join('\n');

// Observed Podman 5.7 rootless engine record of an unprivileged container: an empty file.
function fixture(t, { record = '', mounts = mountInfo() } = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p3-scope-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const containerEnvPath = path.join(root, '.containerenv');
    const mountInfoPath = path.join(root, 'mountinfo');
    if (record !== null) fs.writeFileSync(containerEnvPath, record);
    if (mounts !== null) fs.writeFileSync(mountInfoPath, mounts);
    const options = { workspaceRoot: path.join(root, 'ws'), expectedBoxName: BOX_NAME, insideBox: true, containerEnvPath, mountInfoPath };
    return { root, containerEnvPath, mountInfoPath, options };
}

const engineRecord = (name = BOX_NAME, id = BOX_ID) => `engine="podman-5.7.0"\nname="${name}"\nid="${id}"\nimage="docker.io/assistos/ploinky-box@sha256:${'8'.repeat(64)}"\nrootless=1\n`;

test('P3 live scope inside a Box: workspace hash, semantic Box name and the exact Box container ID from the engine mount', (t) => {
    const env = fixture(t);
    const scope = readLiveBoxScope(env.options);
    assert.deepEqual(scope, {
        workspaceId: `workspace:${crypto.createHash('sha256').update(path.resolve(env.options.workspaceRoot)).digest('hex')}`,
        boxIdentity: BOX_NAME,
        boxGeneration: BOX_ID,
    });
    assert.ok(Object.isFrozen(scope));
    assert.equal(workspaceScopeId(`${env.options.workspaceRoot}/.`), scope.workspaceId);
    // A populated (privileged-style) engine record that agrees is accepted.
    fs.writeFileSync(env.containerEnvPath, engineRecord());
    assert.deepEqual(readLiveBoxScope(env.options), scope);
});

test('P3 live scope fails closed: outside a Box, missing, ambiguous or inconsistent engine evidence', (t) => {
    const env = fixture(t);
    const base = env.options;
    assert.equal(readLiveBoxScope({ ...base, insideBox: false }), null);
    assert.equal(readLiveBoxScope({ ...base, insideBox: undefined }), null);
    assert.equal(readLiveBoxScope({ ...base, containerEnvPath: path.join(env.root, 'absent') }), null);
    assert.equal(readLiveBoxScope({ ...base, mountInfoPath: path.join(env.root, 'absent') }), null);
    assert.equal(readLiveBoxScope({ ...base, workspaceRoot: 'relative/ws' }), null);
    assert.equal(readLiveBoxScope({ ...base, expectedBoxName: '' }), null);
    for (const mounts of [
        '7300 7290 0:70 / / rw,relatime - overlay overlay rw\n',
        mountInfo(BOX_ID, [mountLine('d'.repeat(64))]),
        mountInfo('C'.repeat(64)),
        mountInfo('c'.repeat(63)),
        mountInfo(BOX_ID).replace('/userdata/.containerenv /run', '/userdata/other /run'),
    ]) {
        fs.writeFileSync(env.mountInfoPath, mounts);
        assert.equal(readLiveBoxScope(base), null, mounts.slice(0, 120));
    }
    fs.writeFileSync(env.mountInfoPath, mountInfo());
    for (const record of [engineRecord(BOX_NAME, 'd'.repeat(64)), engineRecord('ploinky-box-other-000000000000'), 'x'.repeat(20000)]) {
        fs.writeFileSync(env.containerEnvPath, record);
        assert.equal(readLiveBoxScope(base), null, record.slice(0, 60));
    }
    fs.rmSync(env.containerEnvPath);
    fs.symlinkSync(path.join(env.root, 'elsewhere'), env.containerEnvPath);
    assert.equal(readLiveBoxScope(base), null);
});

test('P3 the provider re-reads every call: a recreated Box is a new generation, never a cached one', async (t) => {
    const env = fixture(t);
    const provider = createLiveBoxScopeProvider(env.options);
    assert.equal((await provider()).boxGeneration, BOX_ID);
    fs.writeFileSync(env.mountInfoPath, mountInfo('d'.repeat(64)));
    assert.equal((await provider()).boxGeneration, 'd'.repeat(64));
    fs.rmSync(env.mountInfoPath);
    assert.equal(await provider(), null);
});

test('P3 the scope feeds discovery, the helper-ticket minter and the source-protection service', async (t) => {
    const env = fixture(t);
    const provider = createLiveBoxScopeProvider(env.options);
    const live = await provider();
    assert.ok(live);

    const discovered = discoverExecutionTargets({ live, readRegistry: () => ({ agents: {} }), readManifest: () => ({}), readInstance: () => null });
    assert.equal(discovered.ok, true);

    assert.doesNotThrow(() => createTargetHelperTicketMinter({
        live, readTarget: () => null, readWorker: () => null, callerAuthority: { resolve: () => null }, secrets: { useSecret: () => null },
    }));

    fs.mkdirSync(env.options.workspaceRoot, { recursive: true });
    const service = createSourceProtectionService({
        workspaceRoot: env.options.workspaceRoot, liveScope: provider, isSourceReservationHolder: async () => ({ status: 'holder' }),
    });
    const identity = { agentId: 'agent:rwrepo/rwworker', instanceId: 'inst-1', enableGeneration: 'egen-1' };
    const answer = await service.handle({ identity, body: Buffer.from(JSON.stringify({ version: 1, op: 'describe', workerGeneration: null })) });
    assert.equal(answer.status, 200);
    assert.equal(answer.body.ok, true);
});
