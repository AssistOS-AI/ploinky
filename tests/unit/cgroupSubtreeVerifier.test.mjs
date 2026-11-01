import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import { validateManifest, verifySelectedFixture } from '../cgroup-subtree/verify.mjs';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';

const manifest = () => ({ schemaVersion: 1, purpose: 'cgroup-subtree-acceptance', host: { hostname: 'selected-test-host', uid: 1000 },
    workspaceRoot: '/fixture', evidenceDirectory: '/evidence',
    repositories: [{ name: 'ploinky', root: '/source', commit: '1'.repeat(40), tree: '2'.repeat(40) }],
    box: { id: 'a'.repeat(64), imageId: `sha256:${'b'.repeat(64)}` },
    agent: { id: 'c'.repeat(64), imageId: `sha256:${'d'.repeat(64)}` },
    peer: { id: 'e'.repeat(64), imageId: `sha256:${'f'.repeat(64)}` } });

test('C4: missing pins, wrong host/user and changed source stop before a runtime probe', () => {
    const calls = [], query = (command, args) => { calls.push([command, args]); return 'wrong-source'; };
    const options = { query, hostname: 'selected-test-host', uid: 1000, fsApi: { realpathSync: (target) => target } };
    const invalid = manifest(); delete invalid.peer.imageId;
    assert.throws(() => validateManifest(invalid), /exact peer identity/);
    assert.throws(() => verifySelectedFixture(manifest(), { ...options, hostname: 'other-host' }), /host\/user/);
    assert.equal(calls.length, 0);
    assert.throws(() => verifySelectedFixture(manifest(), options), /repository/);
    assert.ok(calls.every(([command]) => command === 'git'));
});

test('C4: exact fake fixture pins yield bounded identity proofs; no provision/pull/root exec command exists', () => {
    const value = manifest(), calls = [];
    const query = (command, args) => {
        calls.push([command, args]);
        if (command === 'git') return args.includes('HEAD') ? value.repositories[0].commit
            : args.includes('HEAD^{tree}') ? value.repositories[0].tree : '';
        if (args[0] === 'container') return JSON.stringify([{ Id: value.box.id, Image: value.box.imageId, State: { Running: true },
            Config: { Labels: { [BOX_LABELS.pathHash]: crypto.createHash('sha256').update(value.workspaceRoot).digest('hex').slice(0, 12) } },
            Mounts: [{ Destination: '/opt/ploinky', Source: '/source', RW: false }] }]);
        assert.deepEqual(args.slice(0, 2), ['exec', value.box.id]);
        return JSON.stringify({ schemaVersion: 1, proofs: ['agent', 'peer'].map((selected, index) => ({ selected,
            id: value[selected].id, image: value[selected].imageId, root: `/ploinky/agents/libpod-${value[selected].id}`,
            namespace: { pid: `pid:[${200 + index}]`, cgroup: `cgroup:[${200 + index}]` }, mountIdentity: { dev: '1', ino: String(10 + index) } })) });
    };
    const result = verifySelectedFixture(value, { query, hostname: value.host.hostname, uid: value.host.uid,
        fsApi: { realpathSync: (target) => target } });
    assert.equal(result.proofs.length, 2);
    assert.equal(calls.filter(([command, args]) => command === 'podman' && args[0] === 'exec').length, 1);
    assert.equal(calls.some(([, args]) => args.includes('pull') || args.includes('create') || args.includes('--user')), false);
});
