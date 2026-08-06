import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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

const CONTAINER_ID = 'a'.repeat(64);

function desiredDocument() {
    return {
        hosts: {},
        media: {
            publicIPv4: '8.8.8.8',
            addressMode: 'nat-forward',
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

function writeCandidate(fixture) {
    const bytes = Buffer.from(`${JSON.stringify(desiredDocument(), null, 2)}\n`);
    fs.writeFileSync(fixture.candidatePath, bytes, { mode: 0o600 });
    return {
        bytes,
        candidate: readWorkspaceEdgeDesired(fixture.identity),
    };
}

function directClient(candidate, {
    stagedDigest = candidate.digest,
    installedDigest = candidate.digest,
    failArgv = null,
} = {}) {
    const calls = [];
    return {
        calls,
        async execContainer(request) {
            calls.push({ operation: 'exec', request });
            if (failArgv && request.argv.join(' ') === failArgv.join(' ')) {
                return { exitCode: 23, stdout: '', stderr: 'bounded command failed' };
            }
            if (request.argv[0] === 'sha256sum') {
                const digest = request.argv[1].endsWith('.box-candidate')
                    ? stagedDigest
                    : installedDigest;
                return { exitCode: 0, stdout: `${digest}  ${request.argv[1]}\n`, stderr: '' };
            }
            return { exitCode: 0, stdout: '', stderr: '' };
        },
        async putArchive(request) {
            calls.push({
                operation: 'put-archive',
                request: { ...request, body: Buffer.from(request.body) },
            });
            return { copied: true };
        },
    };
}

function execCalls(client) {
    return client.calls.filter(({ operation }) => operation === 'exec');
}

test('host-owned edge desired state is optional and captured by exact digest', (t) => {
    const fixture = workspaceFixture(t);
    assert.equal(readWorkspaceEdgeDesired(fixture.identity), null);

    const { bytes, candidate } = writeCandidate(fixture);
    assert.deepEqual(candidate, {
        path: fixture.candidatePath,
        digest: crypto.createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
    });
    assert.equal(Object.isFrozen(candidate), true);
});

test('host-owned edge desired state rejects unsafe or malformed authority files', (t) => {
    const fixture = workspaceFixture(t);

    fs.writeFileSync(fixture.candidatePath, '{');
    assert.throws(() => readWorkspaceEdgeDesired(fixture.identity), /must contain valid JSON/);

    fs.writeFileSync(fixture.candidatePath, JSON.stringify({ schemaVersion: 1 }));
    assert.throws(() => readWorkspaceEdgeDesired(fixture.identity), /required hosts shape/);

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

test('staging rejects authority swaps before host action', async (t) => {
    const fixture = workspaceFixture(t);
    const swaps = [
        {
            name: 'replacement inode with the same bytes',
            replace(bytes) {
                fs.writeFileSync(fixture.candidatePath, bytes, { mode: 0o600 });
            },
        },
        {
            name: 'FIFO',
            replace() {
                execFileSync('mkfifo', [fixture.candidatePath]);
            },
        },
        {
            name: 'device',
            replace() {
                fs.symlinkSync('/dev/null', fixture.candidatePath);
            },
        },
        {
            name: 'oversized file',
            replace() {
                fs.writeFileSync(
                    fixture.candidatePath,
                    Buffer.alloc(BOX_EDGE_DESIRED_MAX_BYTES + 1),
                    { mode: 0o600 },
                );
            },
        },
    ];

    for (const swap of swaps) {
        const { bytes, candidate } = writeCandidate(fixture);
        fs.rmSync(fixture.candidatePath);
        swap.replace(bytes);
        const client = directClient(candidate);

        await assert.rejects(stageWorkspaceEdgeDesired({
            candidate,
            containerId: CONTAINER_ID,
            hostClient: client,
            journal: {},
        }), /changed before archive staging|non-linked regular file|exceeds 1048576 bytes/, swap.name);
        assert.deepEqual(client.calls, [], swap.name);
        fs.rmSync(fixture.candidatePath, { force: true });
    }
});

test('structured staging initializes, archives, verifies, activates, and cleans up in order', async (t) => {
    const fixture = workspaceFixture(t);
    const { bytes, candidate } = writeCandidate(fixture);
    const client = directClient(candidate);
    const journal = { phase: 'edge-staging', revision: 4 };

    for (let attempt = 0; attempt < 2; attempt += 1) {
        assert.deepEqual(await stageWorkspaceEdgeDesired({
            candidate,
            containerId: CONTAINER_ID,
            hostClient: client,
            journal,
        }), {
            staged: true,
            digest: candidate.digest,
        });
    }

    const firstAttempt = client.calls.slice(0, 12);
    assert.deepEqual(firstAttempt.map((call) => (
        call.operation === 'exec' ? call.request.argv : ['put-archive']
    )), [
        ['/opt/ploinky/bin/ploinky-local', 'list', 'agents'],
        ['mkdir', '-p', '/workspace/.ploinky/data/edge-routing'],
        ['chown', 'podman:podman', '/workspace/.ploinky/data/edge-routing'],
        ['chmod', '700', '/workspace/.ploinky/data/edge-routing'],
        ['rm', '-f', '/workspace/.ploinky/data/edge-routing/desired.json.box-candidate'],
        ['put-archive'],
        ['sha256sum', '/workspace/.ploinky/data/edge-routing/desired.json.box-candidate'],
        ['mv', '/workspace/.ploinky/data/edge-routing/desired.json.box-candidate',
            '/workspace/.ploinky/data/edge-routing/desired.json'],
        ['chown', 'podman:podman', '/workspace/.ploinky/data/edge-routing/desired.json'],
        ['chmod', '600', '/workspace/.ploinky/data/edge-routing/desired.json'],
        ['sha256sum', '/workspace/.ploinky/data/edge-routing/desired.json'],
        ['rm', '-f', '/workspace/.ploinky/data/edge-routing/desired.json.box-candidate'],
    ]);
    assert.equal(firstAttempt.length, 12);

    for (const { request } of execCalls(client)) {
        assert.equal(request.id, CONTAINER_ID);
        assert.equal(request.journal, journal);
        assert.deepEqual(request.env, {});
        assert.equal(request.maxOutputBytes, 1024 * 1024);
    }
    const archiveCalls = client.calls.filter(({ operation }) => operation === 'put-archive');
    assert.equal(archiveCalls.length, 2);
    const archive = archiveCalls[0].request;
    assert.equal(archive.id, CONTAINER_ID);
    assert.equal(archive.path, '/workspace/.ploinky/data/edge-routing');
    assert.equal(archive.journal, journal);
    assert.equal(archive.body.subarray(0, 100).toString().replaceAll('\0', ''),
        'desired.json.box-candidate');
    assert.equal(archive.body.subarray(100, 108).toString(), '0000600\0');
    assert.deepEqual(archive.body.subarray(512, 512 + bytes.length), bytes);
});

test('candidate digest mismatch cleans the staged name and never activates it', async (t) => {
    const fixture = workspaceFixture(t);
    const { candidate } = writeCandidate(fixture);
    const client = directClient(candidate, { stagedDigest: '0'.repeat(64) });

    await assert.rejects(stageWorkspaceEdgeDesired({
        candidate,
        containerId: CONTAINER_ID,
        hostClient: client,
        journal: { phase: 'edge-staging' },
    }), /changed before in-box staging completed/);

    const argv = execCalls(client).map(({ request }) => request.argv);
    assert.equal(argv.some((args) => args[0] === 'mv'), false);
    assert.equal(argv.filter((args) => (
        args[0] === 'rm' && args.at(-1).endsWith('.box-candidate')
    )).length, 2);
});

test('installed digest mismatch is reported after activation and still cleans the staged name', async (t) => {
    const fixture = workspaceFixture(t);
    const { candidate } = writeCandidate(fixture);
    const client = directClient(candidate, { installedDigest: '0'.repeat(64) });

    await assert.rejects(stageWorkspaceEdgeDesired({
        candidate,
        containerId: CONTAINER_ID,
        hostClient: client,
        journal: { phase: 'edge-staging' },
    }), /does not match its host authority/);
    const argv = execCalls(client).map(({ request }) => request.argv);
    assert.equal(argv.some((args) => args[0] === 'mv'), true);
    assert.equal(argv.at(-1)[0], 'rm');
});

test('runner-only staging and incomplete structured clients fail before any host action', async (t) => {
    const fixture = workspaceFixture(t);
    const { candidate } = writeCandidate(fixture);
    const runnerCalls = [];
    const runner = new Proxy({}, {
        get(_target, property) {
            runnerCalls.push(String(property));
            throw new Error('unsafe ordinary host CLI fallback');
        },
    });

    await assert.rejects(stageWorkspaceEdgeDesired({
        candidate,
        containerId: CONTAINER_ID,
        engine: { name: 'podman' },
        runner,
    }), /requires the structured host client/);
    assert.deepEqual(runnerCalls, []);

    const calls = [];
    await assert.rejects(stageWorkspaceEdgeDesired({
        candidate,
        containerId: CONTAINER_ID,
        hostClient: {
            async execContainer() { calls.push('exec'); },
        },
    }), /requires the structured host client/);
    assert.deepEqual(calls, []);
});

test('invalid identity, stale host bytes, and failed setup are bounded before archive activation', async (t) => {
    const fixture = workspaceFixture(t);
    const { candidate } = writeCandidate(fixture);

    for (const [containerId, digest, pattern] of [
        ['short-id', candidate.digest, /immutable outer container ID/],
        [CONTAINER_ID, 'short-digest', /exact SHA-256 candidate digest/],
    ]) {
        const client = directClient(candidate);
        await assert.rejects(stageWorkspaceEdgeDesired({
            candidate: { ...candidate, digest },
            containerId,
            hostClient: client,
            journal: {},
        }), pattern);
        assert.deepEqual(client.calls, []);
    }

    fs.appendFileSync(candidate.path, '\n');
    const staleClient = directClient(candidate);
    await assert.rejects(stageWorkspaceEdgeDesired({
        candidate,
        containerId: CONTAINER_ID,
        hostClient: staleClient,
        journal: {},
    }), /changed before archive staging/);
    assert.deepEqual(staleClient.calls, []);

    const { candidate: fresh } = writeCandidate(fixture);
    const failedClient = directClient(fresh, {
        failArgv: ['mkdir', '-p', '/workspace/.ploinky/data/edge-routing'],
    });
    await assert.rejects(stageWorkspaceEdgeDesired({
        candidate: fresh,
        containerId: CONTAINER_ID,
        hostClient: failedClient,
        journal: {},
    }), /staging command failed with status 23/);
    assert.equal(failedClient.calls.some(({ operation }) => operation === 'put-archive'), false);
});

test('missing desired state is a frozen no-op that needs no structured client', async () => {
    const result = await stageWorkspaceEdgeDesired();
    assert.deepEqual(result, { staged: false });
    assert.equal(Object.isFrozen(result), true);
});
