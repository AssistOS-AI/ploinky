import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import {
    BOX_EDGE_DESIRED_MAX_BYTES,
    readWorkspaceEdgeDesired,
    stageWorkspaceEdgeDesired,
    replaceWorkspaceEdgeDesired,
    writeWorkspaceEdgeDesired,
} from '../../ploinky-box/edgeDesired.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';

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

test('host authority replacement is digest-fenced and requires coordination', t => {
    const fixture = workspaceFixture(t);
    fs.writeFileSync(fixture.candidatePath, JSON.stringify(desiredDocument()), { mode: 0o600 });
    const before = readWorkspaceEdgeDesired(fixture.identity);
    const bytes = JSON.stringify({ hosts: { 'external.test': { agent: 'demo/app', dnsManagement: 'external' } } });
    assert.throws(() => replaceWorkspaceEdgeDesired(fixture.identity, { expectedDigest: before.digest, bytes }), /coordination/);
    assert.throws(() => replaceWorkspaceEdgeDesired(fixture.identity, {
        expectedDigest: 'a'.repeat(64), bytes, assertHeld() {},
    }), /changed before replacement/);
    assert.equal(readWorkspaceEdgeDesired(fixture.identity).digest, before.digest);
    const after = replaceWorkspaceEdgeDesired(fixture.identity, { expectedDigest: before.digest, bytes, assertHeld() {} });
    assert.equal(after.digest, crypto.createHash('sha256').update(bytes).digest('hex'));
    assert.throws(() => replaceWorkspaceEdgeDesired(fixture.identity, { expectedDigest: before.digest,
        bytes: JSON.stringify(desiredDocument()), assertHeld() {} }), /changed before replacement/);
});

test('the operator save is atomic, private and needs the mutation lock', (t) => {
    const fixture = workspaceFixture(t);
    const bytes = Buffer.from(`${JSON.stringify(desiredDocument(), null, 2)}\n`);
    assert.throws(() => writeWorkspaceEdgeDesired(fixture.identity, { bytes }), /requires mutation coordination/);
    assert.equal(fs.existsSync(fixture.candidatePath), false);

    let held = 0;
    const saved = writeWorkspaceEdgeDesired(fixture.identity, { bytes, assertHeld() { held += 1; } });
    assert.equal(held >= 2, true);
    assert.deepEqual(saved, {
        path: fixture.candidatePath,
        digest: crypto.createHash('sha256').update(bytes).digest('hex'),
        size: bytes.length,
    });
    assert.equal(fs.statSync(fixture.candidatePath).mode & 0o777, 0o600);

    const next = Buffer.from(JSON.stringify({ hosts: { 'external.test': { agent: 'demo/app' } } }));
    fs.chmodSync(fixture.candidatePath, 0o664);
    const replaced = writeWorkspaceEdgeDesired(fixture.identity, { bytes: next, assertHeld() {} });
    assert.equal(replaced.digest, crypto.createHash('sha256').update(next).digest('hex'));
    assert.equal(fs.statSync(fixture.candidatePath).mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(path.dirname(fixture.candidatePath)), ['edge-desired.json']);
});

test('the operator save keeps the old file when the input or the target is unsafe', (t) => {
    const fixture = workspaceFixture(t);
    const original = JSON.stringify(desiredDocument());
    fs.writeFileSync(fixture.candidatePath, original, { mode: 0o600 });
    const assertHeld = () => {};
    for (const bytes of ['not json', '[]', '{}', '{"hosts":[]}', Buffer.alloc(BOX_EDGE_DESIRED_MAX_BYTES + 1, 'a')]) {
        assert.throws(
            () => writeWorkspaceEdgeDesired(fixture.identity, { bytes, assertHeld }),
            (error) => error.code === 'PLOINKY_BOX_EDGE_DESIRED_INVALID',
        );
        assert.equal(fs.readFileSync(fixture.candidatePath, 'utf8'), original);
    }

    const elsewhere = path.join(fixture.root, 'elsewhere.json');
    fs.writeFileSync(elsewhere, original, { mode: 0o600 });
    fs.rmSync(fixture.candidatePath);
    fs.symlinkSync(elsewhere, fixture.candidatePath);
    assert.throws(
        () => writeWorkspaceEdgeDesired(fixture.identity, { bytes: original, assertHeld }),
        /one non-linked regular file/,
    );
    fs.rmSync(fixture.candidatePath);
    fs.linkSync(elsewhere, fixture.candidatePath);
    assert.throws(
        () => writeWorkspaceEdgeDesired(fixture.identity, { bytes: original, assertHeld }),
        /one non-linked regular file/,
    );
    fs.rmSync(fixture.candidatePath);
    fs.mkdirSync(fixture.candidatePath);
    assert.throws(
        () => writeWorkspaceEdgeDesired(fixture.identity, { bytes: original, assertHeld }),
        /one non-linked regular file/,
    );
});

test('the Box writer saves stdin into the workspace and reports its digest', async (t) => {
    const fixture = workspaceFixture(t);
    const entry = fileURLToPath(new URL('../../ploinky-box/entrypoint/write-edge-desired.mjs', import.meta.url));
    const document = JSON.stringify(desiredDocument());
    const run = (input) => spawnSync(process.execPath, [entry], {
        encoding: 'utf8', input, env: { ...process.env, PLOINKY_WORKSPACE_ROOT: fixture.root },
    });
    const saved = run(document);
    assert.equal(saved.status, 0, saved.stderr);
    assert.deepEqual(JSON.parse(saved.stdout), {
        digest: crypto.createHash('sha256').update(document).digest('hex'),
        size: Buffer.byteLength(document),
    });
    assert.equal(fs.readFileSync(fixture.candidatePath, 'utf8'), document);
    assert.equal(fs.statSync(fixture.candidatePath).mode & 0o777, 0o600);
    const refused = run('not json');
    assert.equal(refused.status, 1);
    assert.match(refused.stderr, /EDGE DESIRED WRITE FAILED/);
    assert.equal(fs.readFileSync(fixture.candidatePath, 'utf8'), document);
});

test('the operator save refuses a symlinked workspace anchor', (t) => {
    const fixture = workspaceFixture(t);
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-box-edge-elsewhere-'));
    t.after(() => fs.rmSync(elsewhere, { recursive: true, force: true }));
    fs.rmdirSync(path.join(fixture.root, '.ploinky'));
    fs.symlinkSync(elsewhere, path.join(fixture.root, '.ploinky'));
    assert.throws(
        () => writeWorkspaceEdgeDesired(fixture.identity, { bytes: JSON.stringify(desiredDocument()), assertHeld() {} }),
        /must be a real directory/,
    );
    assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('host-owned edge desired state rejects unsafe or malformed authority files', (t) => {
    const fixture = workspaceFixture(t);

    fs.writeFileSync(fixture.candidatePath, '{', { mode: 0o600 });
    assert.throws(
        () => readWorkspaceEdgeDesired(fixture.identity),
        /must contain valid JSON/,
    );

    fs.writeFileSync(fixture.candidatePath, JSON.stringify({ schemaVersion: 1 }));
    assert.throws(
        () => readWorkspaceEdgeDesired(fixture.identity),
        /required hosts shape/,
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
            workspaceRoot: fixture.identity.workspaceRoot,
        }), {
            staged: true,
            digest: candidate.digest,
        });
    }

    const root = fixture.identity.workspaceRoot;
    const firstInitialize = calls.findIndex((call) => (
        call.includes('/opt/ploinky/ploinky-box/entrypoint/initialize-edge-routing.mjs')
        && call.includes(`PLOINKY_WORKSPACE_ROOT=${root}`)
        && call[call.indexOf('--workdir') + 1] === root
    ));
    // Every staged path is the selected workspace path inside the Box.
    for (const call of calls.filter((entry) => entry.includes('mkdir') || entry.includes('mv'))) {
        assert.ok(call.at(-1).startsWith(`${root}/.ploinky/data/edge-routing`), call.join(' '));
    }
    assert.equal(calls.some((call) => call.some((value) => /(?:^|[:=])\/workspace(?:\/|$)/.test(value))), false);
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
        workspaceRoot: fixture.identity.workspaceRoot,
    }), /changed before in-box staging completed/);
    const staleCalls = calls.length;
    assert.throws(() => stageWorkspaceEdgeDesired({
        candidate,
        engine: 'podman',
        containerId: 'b'.repeat(64),
        runner,
    }), (error) => error.code === 'PLOINKY_BOX_WORKSPACE_ROOT_INVALID');
    assert.equal(calls.length, staleCalls, 'a missing workspace root fails before any in-Box command');
    assert.equal(calls.some((call) => call.includes('mv')), false);
    assert.ok(calls.some((call) => (
        call.includes('rm')
        && call.at(-1).endsWith('desired.json.box-candidate')
    )));
});
