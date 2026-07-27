import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    BOX_EDGE_DESIRED_MAX_BYTES,
    readWorkspaceEdgeDesired,
    stageWorkspaceEdgeDesired,
} from '../../ploinky-box/edgeDesired.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';

function desiredDocument() {
    return {
        schemaVersion: 1,
        hosts: {},
        media: {
            publicIPv4: '8.8.8.8',
            addressMode: 'nat-forward',
        },
        security: {
            hostNetworkAllowedInstances: ['webmeetInfra/liveKitServerAgent'],
            internalServiceConsumers: {},
        },
    };
}

function workspaceFixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-edge-desired-'));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky'));
    return {
        root,
        identity: buildWorkspaceIdentity(root, { markerFound: true }),
        candidatePath: path.join(root, '.ploinky', 'edge-desired.json'),
    };
}

test('host-owned edge desired state is optional and captured by exact digest', (t) => {
    const fixture = workspaceFixture(t);
    assert.equal(readWorkspaceEdgeDesired(fixture.identity), null);

    const bytes = Buffer.from(`${JSON.stringify(desiredDocument(), null, 2)}\n`);
    fs.writeFileSync(fixture.candidatePath, bytes, { mode: 0o600 });
    const candidate = readWorkspaceEdgeDesired(fixture.identity);

    assert.deepEqual(candidate, {
        path: fixture.candidatePath,
        digest: crypto.createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
    });
});

test('host-owned edge desired state rejects unsafe or malformed authority files', (t) => {
    const fixture = workspaceFixture(t);

    fs.writeFileSync(fixture.candidatePath, '{');
    assert.throws(
        () => readWorkspaceEdgeDesired(fixture.identity),
        /must contain valid JSON/,
    );

    fs.writeFileSync(fixture.candidatePath, JSON.stringify({ schemaVersion: 1 }));
    assert.throws(
        () => readWorkspaceEdgeDesired(fixture.identity),
        /required schema 1 hosts\/security shape/,
    );

    fs.writeFileSync(fixture.candidatePath, JSON.stringify(desiredDocument()));
    fs.chmodSync(fixture.candidatePath, 0o666);
    assert.throws(
        () => readWorkspaceEdgeDesired(fixture.identity),
        /must not be group- or world-writable/,
    );

    fs.rmSync(fixture.candidatePath);
    fs.writeFileSync(fixture.candidatePath, Buffer.alloc(BOX_EDGE_DESIRED_MAX_BYTES + 1), {
        mode: 0o600,
    });
    assert.throws(
        () => readWorkspaceEdgeDesired(fixture.identity),
        /exceeds 1048576 bytes/,
    );

    fs.rmSync(fixture.candidatePath);
    const source = path.join(fixture.root, 'source.json');
    fs.writeFileSync(source, JSON.stringify(desiredDocument()), { mode: 0o600 });
    fs.symlinkSync(source, fixture.candidatePath);
    assert.throws(
        () => readWorkspaceEdgeDesired(fixture.identity),
        /Unable to open Box edge desired state|non-linked regular file/,
    );
});

test('staging initializes all sources, verifies bytes before activation, and is idempotent', (t) => {
    const fixture = workspaceFixture(t);
    const bytes = Buffer.from(`${JSON.stringify(desiredDocument(), null, 2)}\n`);
    fs.writeFileSync(fixture.candidatePath, bytes, { mode: 0o600 });
    const candidate = readWorkspaceEdgeDesired(fixture.identity);
    const calls = [];
    const runner = {
        run(command, args) {
            calls.push(['run', command, ...args]);
        },
        query(command, args) {
            calls.push(['query', command, ...args]);
            if (args.includes('sha256sum')) {
                return { ok: true, stdout: `${candidate.digest}  desired.json\n` };
            }
            return { ok: true, stdout: '' };
        },
    };
    const containerId = 'a'.repeat(64);

    for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.deepEqual(stageWorkspaceEdgeDesired({
            candidate,
            engine: { name: 'podman' },
            containerId,
            runner,
        }), {
            staged: true,
            digest: candidate.digest,
        });
    }

    const firstInitialize = calls.findIndex((call) => (
        call.includes('/opt/ploinky/bin/ploinky-local')
        && call.slice(-2).join(' ') === 'list agents'
    ));
    const firstCopy = calls.findIndex((call) => call.includes('cp'));
    const stagedDigest = calls.findIndex((call) => (
        call.includes('sha256sum')
        && call.at(-1).endsWith('desired.json.box-candidate')
    ));
    const install = calls.findIndex((call) => (
        call.includes('mv')
        && call.at(-1).endsWith('/desired.json')
    ));
    const installedDigest = calls.findIndex((call, index) => (
        index > install
        && call.includes('sha256sum')
        && call.at(-1).endsWith('/desired.json')
    ));
    assert.ok(firstInitialize >= 0);
    assert.ok(firstInitialize < firstCopy);
    assert.ok(firstCopy < stagedDigest);
    assert.ok(stagedDigest < install);
    assert.ok(install < installedDigest);
    assert.equal(calls.filter((call) => call.includes('cp')).length, 2);
});

test('digest mismatch never installs the candidate', (t) => {
    const fixture = workspaceFixture(t);
    fs.writeFileSync(fixture.candidatePath, JSON.stringify(desiredDocument()), { mode: 0o600 });
    const candidate = readWorkspaceEdgeDesired(fixture.identity);
    const calls = [];
    const runner = {
        run(command, args) {
            calls.push(['run', command, ...args]);
        },
        query(command, args) {
            calls.push(['query', command, ...args]);
            if (args.includes('sha256sum')) {
                return { ok: true, stdout: `${'0'.repeat(64)}  desired.json\n` };
            }
            return { ok: true, stdout: '' };
        },
    };

    assert.throws(() => stageWorkspaceEdgeDesired({
        candidate,
        engine: 'podman',
        containerId: 'b'.repeat(64),
        runner,
    }), /changed before in-box staging completed/);
    assert.equal(calls.some((call) => call.includes('mv')), false);
    assert.ok(calls.some((call) => (
        call.includes('rm')
        && call.at(-1).endsWith('desired.json.box-candidate')
    )));
});
