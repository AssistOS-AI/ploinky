import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
    PODMAN_V6_SOURCE_CLOSURE,
    PodmanHostClient,
} from '../../ploinky-box/engine/libpodClient.mjs';
import {
    Phase10xRemoteClient,
    createPhase10xRemoteClient,
} from '../helpers/phase10xRemoteClient.mjs';

const OWNED = 'a'.repeat(64);
const PROTECTED = 'b'.repeat(64);
const UNRELATED = 'c'.repeat(64);
const IMAGE = 'd'.repeat(64);
const SESSION = 'e'.repeat(64);

function record(id, name, state = 'running', extra = {}) {
    return {
        Id: id,
        Names: [name],
        Image: IMAGE,
        ImageID: IMAGE,
        State: state,
        Status: state,
        Pid: state === 'running' ? 42 : 0,
        AutoRemove: false,
        Labels: { owner: name },
        ...extra,
    };
}

function response(statusCode, body = Buffer.alloc(0), contentType = undefined) {
    const headers = contentType ? { 'content-type': contentType } : {};
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
    return { statusCode, headers, body: bytes };
}

function jsonResponse(statusCode, value) {
    return response(statusCode, `${JSON.stringify(value)}\n`, 'application/json');
}

function createClient(requestImpl, options = {}) {
    return new PodmanHostClient({
        socketPath: '/tmp/phase10x-test.sock',
        engineIdentity: '1'.repeat(64),
        connectionIdentity: 'podman-machine-default',
        connectionUri: 'ssh://localhost/run/user/501/podman.sock',
        hostKind: 'podman-machine',
        requestImpl,
        ...options,
    });
}

function journal(id = OWNED, overrides = {}) {
    return {
        transaction: {
            id: 'phase10x-test-transaction',
            generation: 'f'.repeat(64),
        },
        phase: 'candidate-created',
        engine: {
            name: 'podman',
            identity: '1'.repeat(64),
            apiVersion: 'v6.0.1',
            hostKind: 'podman-machine',
            connection: {
                name: 'podman-machine-default',
                identity: 'podman-machine-default',
                uri: 'ssh://localhost/run/user/501/podman.sock',
                socketPath: '/tmp/phase10x-test.sock',
            },
        },
        container: {
            id,
            name: 'owned',
            labels: { owner: 'owned' },
            image: { rawId: IMAGE },
            creation: {
                dependencies: [],
                autoRemove: false,
                volumes: ['ploinky-box-workspace-0123456789ab-workspace'],
                mounts: [{
                    type: 'volume',
                    name: 'ploinky-box-workspace-0123456789ab-workspace',
                    source: 'ploinky-box-workspace-0123456789ab-workspace',
                    destination: '/workspace',
                    rw: true,
                }],
                ...(overrides.creation || {}),
            },
        },
        ...Object.fromEntries(Object.entries(overrides).filter(([key]) => key !== 'creation')),
    };
}

function createSpec(overrides = {}) {
    return {
        name: 'ploinky-box-workspace-0123456789ab',
        image: IMAGE,
        raw_image_name: IMAGE,
        command: [],
        env: { PLOINKY_PUBLIC_BIND: '0.0.0.0' },
        labels: {
            'io.assistos.ploinky-box.path-hash': '0123456789ab',
            'io.assistos.ploinky-box.role': 'container',
        },
        user: 'podman',
        init: true,
        mounts: [{
            destination: '/tmp',
            type: 'tmpfs',
            source: 'tmpfs',
            options: ['rw', 'nosuid', 'nodev', 'mode=1777'],
        }],
        volumes: [{
            Name: 'ploinky-box-workspace-0123456789ab-workspace',
            Dest: '/workspace',
            Options: ['rw'],
            IsAnonymous: false,
            SubPath: '',
        }],
        devices: [
            { path: '/dev/fuse:/dev/fuse:rwm' },
            { path: '/dev/net/tun:/dev/net/tun:rwm' },
        ],
        privileged: false,
        remove: false,
        removeImage: false,
        dependencyContainers: [],
        pod: '',
        image_volume_mode: 'ignore',
        portmappings: [{
            host_ip: '127.0.0.1',
            host_port: 18081,
            container_port: 8080,
            range: 1,
            protocol: 'tcp',
        }],
        netns: { nsmode: 'bridge' },
        Networks: { podman: {} },
        networkOrder: ['podman'],
        unmask: ['ALL'],
        selinux_opts: ['disable'],
        work_dir: '/workspace',
        ...overrides,
    };
}

test('retains an immutable Podman Machine engine/socket/connection identity', () => {
    const client = createClient(async () => response(500));
    assert.deepEqual(client.identity, {
        engine: 'podman',
        engineIdentity: '1'.repeat(64),
        connectionIdentity: 'podman-machine-default',
        connectionUri: 'ssh://localhost/run/user/501/podman.sock',
        socketPath: '/tmp/phase10x-test.sock',
        hostKind: 'podman-machine',
        apiVersion: 'v6.0.1',
    });
    assert.equal(Object.isFrozen(client.identity), true);
    assert.throws(() => new PodmanHostClient({
        socketPath: 'relative.sock',
        engineIdentity: 'short',
        connectionIdentity: '',
        connectionUri: '',
        hostKind: 'podman-machine',
    }), /identity|socket/i);
});

test('source closure table pins the accepted v6.0.2 handler call paths', () => {
    assert.equal(PODMAN_V6_SOURCE_CLOSURE.version, '6.0.2');
    assert.equal(PODMAN_V6_SOURCE_CLOSURE.commit, 'b28edb9ad70ce4317dc762ee9ce0a6d081d154e9');
    assert.match(PODMAN_V6_SOURCE_CLOSURE.containers.list, /sync=false/);
    assert.match(PODMAN_V6_SOURCE_CLOSURE.containers.start, /dependencies/);
    assert.match(PODMAN_V6_SOURCE_CLOSURE.containers.remove, /depend=false/);
    assert.match(PODMAN_V6_SOURCE_CLOSURE.exec.create, /LookupContainer.*ExecCreate/s);
    assert.match(PODMAN_V6_SOURCE_CLOSURE.archive.put, /LookupContainer.*CopyFromArchive/s);
    assert.match(PODMAN_V6_SOURCE_CLOSURE.volumes.find, /anchored exact name/i);
    assert.match(PODMAN_V6_SOURCE_CLOSURE.volumes.remove, /force=false/);
});

test('real Unix-socket transport sends only the canonical sync=false container list route', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10x-'));
    const socketPath = path.join(root, 'p.sock');
    let request;
    const server = http.createServer((req, res) => {
        request = { method: req.method, url: req.url, host: req.headers.host };
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(`${JSON.stringify([record(OWNED, 'owned')])}\n`);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    fs.chmodSync(socketPath, 0o600);
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const client = new PodmanHostClient({
        socketPath,
        engineIdentity: '1'.repeat(64),
        connectionIdentity: 'machine',
        connectionUri: 'ssh://localhost/run/user/501/podman.sock',
        hostKind: 'podman-machine',
    });
    const records = await client.listContainers();
    assert.equal(records[0].Id, OWNED);
    assert.deepEqual(request, {
        method: 'GET',
        url: '/v6.0.1/libpod/containers/json?all=true&sync=false&size=false&namespace=false',
        host: 'd',
    });
});

test('list validation rejects caller drift, short IDs, duplicate IDs, and malformed JSON', async () => {
    const requests = [];
    const client = createClient(async (request) => {
        requests.push(request);
        return jsonResponse(200, [record(OWNED, 'one')]);
    });
    await assert.rejects(
        client.listContainers({ all: true, sync: true, size: false, namespace: false }),
        /sync=false/i,
    );
    assert.equal(requests.length, 0);

    const short = createClient(async () => jsonResponse(200, [record('abc123', 'short')]));
    await assert.rejects(short.listContainers(), /full 64-hex/i);
    const duplicate = createClient(async () => jsonResponse(200, [
        record(OWNED, 'one'), record(OWNED, 'two'),
    ]));
    await assert.rejects(duplicate.listContainers(), /duplicate/i);
    const malformed = createClient(async () => response(200, '{', 'application/json'));
    await assert.rejects(malformed.listContainers(), /malformed JSON/i);
});

test('findContainerById performs exact client-side matching with zero inspect route', async () => {
    const requests = [];
    const client = createClient(async (request) => {
        requests.push(request);
        return jsonResponse(200, [
            record(PROTECTED, 'protected'),
            record(OWNED, 'owned'),
            record(UNRELATED, 'unrelated'),
        ]);
    });
    assert.equal((await client.findContainerById(OWNED)).Names[0], 'owned');
    assert.equal(requests.length, 1);
    assert.equal(requests[0].path.includes('/json?all=true&sync=false'), true);
    assert.equal(requests[0].path.includes(`/${OWNED}/json`), false);
});

test('direct create accepts only a complete standalone pull-free immutable spec and full-ID response', async () => {
    const requests = [];
    const client = createClient(async (request) => {
        requests.push(request);
        return jsonResponse(201, { Id: OWNED, Warnings: [] });
    });
    const result = await client.createContainer(createSpec());
    assert.equal(result.id, OWNED);
    assert.equal(requests[0].method, 'POST');
    assert.equal(requests[0].path, '/v6.0.1/libpod/containers/create');
    assert.deepEqual(JSON.parse(requests[0].body.toString()), createSpec());

    for (const bad of [
        { image: 'node:latest' },
        { remove: true },
        { removeImage: true },
        { work_dir: 'relative' },
        { dependencyContainers: [PROTECTED] },
        { pod: 'shared' },
        { privileged: true },
        { image_volume_mode: 'anonymous' },
        { netns: { nsmode: 'container', value: PROTECTED } },
        { Networks: { default: {} } },
        { networkOrder: ['default'] },
        { devices: [{ path: '/dev/fuse' }, { path: '/dev/net/tun' }] },
        { volumes_from: [PROTECTED] },
        { devices_from: [PROTECTED] },
        { secrets: [{ name: 'foreign' }] },
        { overlay_volumes: ['/foreign:/target'] },
        { image_volumes: ['/foreign:/target'] },
        { artifact_volumes: ['/foreign:/target'] },
        { restart_policy: 'always' },
        { unknownFutureField: true },
    ]) {
        await assert.rejects(client.createContainer(createSpec(bad)), /create|immutable|standalone|unsupported/i);
    }
    assert.equal(requests.length, 1);
});

test('start and stop require exact journal ownership and use only accepted exact-ID routes', async () => {
    const requests = [];
    let state = 'created';
    const client = createClient(async (request) => {
        requests.push(request);
        if (request.method === 'GET') {
            return jsonResponse(200, [record(OWNED, 'owned', state)]);
        }
        if (request.path.endsWith('/start')) {
            state = 'running';
            return response(204);
        }
        state = 'exited';
        return response(204);
    });
    await client.startContainer({ id: OWNED, journal: journal() });
    await client.stopContainer({
        id: OWNED,
        timeout: 7,
        journal: journal(OWNED, { phase: 'candidate-started' }),
    });
    assert.deepEqual(requests.filter((entry) => entry.method === 'POST').map((entry) => entry.path), [
        `/v6.0.1/libpod/containers/${OWNED}/start`,
        `/v6.0.1/libpod/containers/${OWNED}/stop?timeout=7&ignore=false`,
    ]);
    await assert.rejects(
        client.startContainer({ id: OWNED, journal: journal(OWNED, { creation: { dependencies: [PROTECTED] } }) }),
        /dependencies/i,
    );
    await assert.rejects(
        client.startContainer({ id: OWNED, journal: journal(OWNED, { creation: { autoRemove: true } }) }),
        /auto-remove/i,
    );
    await assert.rejects(
        client.startContainer({ id: OWNED, journal: journal(PROTECTED) }),
        /journal/i,
    );
});

test('safe delete proves stopped state, exact report schema, and sync=false absence', async () => {
    const requests = [];
    let present = true;
    const client = createClient(async (request) => {
        requests.push(request);
        if (request.method === 'GET') {
            return jsonResponse(200, present ? [record(OWNED, 'owned', 'exited')] : []);
        }
        present = false;
        return jsonResponse(200, [{ Id: OWNED }]);
    });
    const result = await client.deleteContainer({ id: OWNED, timeout: 9, journal: journal() });
    assert.deepEqual(result, { removed: true, id: OWNED, absent: true });
    assert.equal(requests[1].path,
        `/v6.0.1/libpod/containers/${OWNED}?depend=false&force=false&ignore=false&timeout=9&volumes=false`);
    assert.equal(requests.filter((entry) => entry.method === 'GET').length, 2);
});

test('safe delete fails closed for running/ambiguous targets and malformed or non-absent delete results', async () => {
    let deleteCalls = 0;
    const running = createClient(async (request) => {
        if (request.method === 'DELETE') deleteCalls += 1;
        return jsonResponse(200, [record(OWNED, 'owned', 'running')]);
    });
    await assert.rejects(
        running.deleteContainer({ id: OWNED, journal: journal() }),
        /proven stopped/i,
    );
    assert.equal(deleteCalls, 0);

    let listCount = 0;
    const malformed = createClient(async (request) => {
        if (request.method === 'GET') {
            listCount += 1;
            return jsonResponse(200, [record(OWNED, 'owned', 'exited')]);
        }
        return jsonResponse(200, [{ Id: PROTECTED }]);
    });
    await assert.rejects(
        malformed.deleteContainer({ id: OWNED, journal: journal() }),
        /delete report/i,
    );
    assert.equal(listCount, 1, 'malformed deletion must not be treated as absent');

    const notAbsent = createClient(async (request) => (
        request.method === 'DELETE'
            ? jsonResponse(200, [{ Id: OWNED }])
            : jsonResponse(200, [record(OWNED, 'owned', 'exited')])
    ));
    await assert.rejects(
        notAbsent.deleteContainer({ id: OWNED, journal: journal() }),
        /absence proof/i,
    );
});

test('volume create/delete uses exact owned unused records, force=false, and absence proof', async () => {
    const name = 'ploinky-box-workspace-0123456789ab-workspace';
    const labels = { 'io.assistos.ploinky-box.path-hash': '0123456789ab' };
    const requests = [];
    let volume = null;
    const client = createClient(async (request) => {
        requests.push(request);
        if (request.method === 'GET') return jsonResponse(200, volume ? [volume] : []);
        if (request.method === 'POST') {
            volume = {
                Name: name,
                Driver: 'local',
                Labels: labels,
                Options: {},
                MountCount: 0,
                UID: 1000,
                GID: 1000,
            };
            return jsonResponse(201, volume);
        }
        volume = null;
        return response(204);
    });
    assert.equal((await client.createVolume({ name, labels })).Name, name);
    assert.deepEqual(await client.deleteVolume({
        name,
        labels,
        transactionOwned: true,
        knownUnused: true,
    }), { removed: true, name, absent: true });
    const lookups = requests.filter((entry) => entry.method === 'GET');
    assert.equal(lookups.length, 3);
    for (const lookup of lookups) {
        const url = new URL(lookup.path, 'http://podman.invalid');
        assert.equal(url.pathname, '/v6.0.1/libpod/volumes/json');
        assert.deepEqual(JSON.parse(url.searchParams.get('filters')), {
            name: [`^${name.replaceAll('.', '\\.')}$`],
            driver: ['local'],
            label: ['io.assistos.ploinky-box.path-hash=0123456789ab'],
        });
    }
    assert.equal(requests.some((entry) => entry.path === `/v6.0.1/libpod/volumes/${name}?force=false&timeout=10`), true);
    const create = requests.find((entry) => entry.method === 'POST');
    assert.deepEqual(JSON.parse(create.body), {
        Driver: 'local',
        GID: 1000,
        IgnoreIfExists: false,
        Labels: labels,
        Name: name,
        Options: {},
        UID: 1000,
    });
    await assert.rejects(client.deleteVolume({ name, labels, transactionOwned: false, knownUnused: true }), /transaction-owned/i);
});

test('execContainer uses an exact owned session and bounded multiplexed attach output', async () => {
    const requests = [];
    const frame = (stream, bytes) => {
        const payload = Buffer.from(bytes);
        const header = Buffer.alloc(8);
        header[0] = stream;
        header.writeUInt32BE(payload.length, 4);
        return Buffer.concat([header, payload]);
    };
    const client = createClient(async (request) => {
        requests.push(request);
        if (request.path.includes('/containers/json?')) {
            return jsonResponse(200, [record(OWNED, 'owned', 'running')]);
        }
        if (request.path.endsWith('/exec')) return jsonResponse(201, { Id: SESSION });
        if (request.path.endsWith('/json')) {
            return jsonResponse(200, {
                ID: SESSION,
                ContainerID: OWNED,
                Running: false,
                ExitCode: 3,
                CanRemove: true,
                OpenStdin: false,
                OpenStdout: true,
                OpenStderr: true,
                ProcessConfig: { entrypoint: '/bin/test' },
            });
        }
        if (request.path.endsWith('/remove')) return response(200);
        throw new Error(`unexpected request ${request.path}`);
    }, {
        upgradeImpl: async (request) => {
            requests.push(request);
            return {
                statusCode: 101,
                headers: {
                    connection: 'Upgrade',
                    upgrade: 'tcp',
                    'content-type': 'application/vnd.docker.multiplexed-stream',
                },
                body: Buffer.concat([frame(1, 'out'), frame(2, 'err')]),
            };
        },
    });
    const result = await client.execContainer({
        id: OWNED,
        argv: ['/bin/test', '--flag'],
        user: 'podman',
        workdir: '/workspace',
        env: { SAFE: 'yes' },
        journal: journal(OWNED, { phase: 'candidate-started' }),
        maxOutputBytes: 32,
    });
    assert.deepEqual(result, {
        stdout: 'out',
        stderr: 'err',
        exitCode: 3,
        sessionId: SESSION,
    });
    assert.deepEqual(requests.map((entry) => [entry.method, entry.path]), [
        ['GET', '/v6.0.1/libpod/containers/json?all=true&sync=false&size=false&namespace=false'],
        ['POST', `/v6.0.1/libpod/containers/${OWNED}/exec`],
        ['POST', `/v6.0.1/libpod/exec/${SESSION}/start`],
        ['GET', `/v6.0.1/libpod/exec/${SESSION}/json`],
        ['POST', `/v6.0.1/libpod/exec/${SESSION}/remove`],
    ]);
});

test('putArchive uses only the exact owned ID and fixed safe query', async () => {
    const requests = [];
    const client = createClient(async (request) => {
        requests.push(request);
        if (request.method === 'GET') {
            return jsonResponse(200, [record(OWNED, 'owned', 'running')]);
        }
        return response(200);
    });
    await client.putArchive({
        id: OWNED,
        path: '/workspace/.ploinky/edge',
        body: Buffer.from('tar bytes'),
        journal: journal(OWNED, { phase: 'candidate-started' }),
    });
    assert.deepEqual([requests[1].method, requests[1].path], [
        'PUT',
        `/v6.0.1/libpod/containers/${OWNED}/archive?path=%2Fworkspace%2F.ploinky%2Fedge&copyUIDGID=true&noOverwriteDirNonDir=true`,
    ]);
    await assert.rejects(client.putArchive({
        id: OWNED,
        path: 'relative',
        body: Buffer.alloc(0),
        journal: journal(OWNED, { phase: 'candidate-started' }),
    }), /absolute/i);
});

test('putFileArchive streams one sanitized bounded ustar file with exact content length', async (t) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10x-tar-'));
    const socketPath = path.join(root, 'p.sock');
    const sourcePath = path.join(root, 'node.oci');
    fs.writeFileSync(sourcePath, 'oci-archive-bytes', { mode: 0o600 });
    let received;
    const server = http.createServer((req, res) => {
        if (req.method === 'GET') {
            res.writeHead(200, { 'content-type': 'application/json' });
            res.end(`${JSON.stringify([record(OWNED, 'owned', 'running')])}\n`);
            return;
        }
        const chunks = [];
        req.on('data', (chunk) => chunks.push(chunk));
        req.on('end', () => {
            received = {
                method: req.method,
                url: req.url,
                length: req.headers['content-length'],
                type: req.headers['content-type'],
                body: Buffer.concat(chunks),
            };
            res.writeHead(200);
            res.end();
        });
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    fs.chmodSync(socketPath, 0o600);
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const client = new PodmanHostClient({
        socketPath,
        engineIdentity: '1'.repeat(64),
        connectionIdentity: 'machine',
        connectionUri: 'ssh://localhost/run/user/501/podman.sock',
        hostKind: 'podman-machine',
    });
    const ownership = journal(OWNED, {
        phase: 'candidate-started',
        engine: {
            name: 'podman',
            identity: '1'.repeat(64),
            apiVersion: 'v6.0.1',
            hostKind: 'podman-machine',
            connection: {
                name: 'machine',
                identity: 'machine',
                uri: 'ssh://localhost/run/user/501/podman.sock',
                socketPath,
            },
        },
    });
    assert.deepEqual(await client.putFileArchive({
        id: OWNED,
        path: '/workspace/.ploinky/incoming',
        name: 'node.oci',
        sourcePath,
        journal: ownership,
        maxBytes: 1024,
    }), {
        copied: true,
        id: OWNED,
        path: '/workspace/.ploinky/incoming',
        name: 'node.oci',
        bytes: 17,
    });
    assert.equal(received.method, 'PUT');
    assert.equal(received.url,
        `/v6.0.1/libpod/containers/${OWNED}/archive?path=%2Fworkspace%2F.ploinky%2Fincoming&copyUIDGID=true&noOverwriteDirNonDir=true`);
    assert.equal(received.type, 'application/x-tar');
    assert.equal(Number(received.length), 2048);
    assert.equal(received.body.length, 2048);
    assert.equal(received.body.subarray(0, 100).toString('utf8').replace(/\0+$/u, ''), 'node.oci');
    assert.equal(received.body.subarray(512, 529).toString(), 'oci-archive-bytes');
    assert.equal(received.body.subarray(1024).every((byte) => byte === 0), true);
    await assert.rejects(client.putFileArchive({
        id: OWNED,
        path: '/tmp',
        name: '../escape',
        sourcePath,
        journal: ownership,
    }), /journaled exact named volume|safe basename/i);
});

test('image inspect and bounded OCI export use only exact immutable image ID routes', async () => {
    const requests = [];
    const client = createClient(async (request) => {
        requests.push(request);
        if (request.path.endsWith('/json')) {
            return jsonResponse(200, { ID: `sha256:${IMAGE}`, RepoTags: [], RepoDigests: [] });
        }
        return response(200, Buffer.from('oci archive'), 'application/octet-stream');
    });
    assert.equal((await client.inspectImage(IMAGE)).ID, `sha256:${IMAGE}`);
    assert.equal(requests[0].path, `/v6.0.1/libpod/images/${IMAGE}/json`);
    assert.equal((await client.exportImage(IMAGE)).toString(), 'oci archive');
    assert.equal(requests[1].path,
        `/v6.0.1/libpod/images/${IMAGE}/get?format=oci-archive&compress=false`);
});

test('status, content-type, timeout, and response caps fail closed', async (t) => {
    const badStatus = createClient(async () => jsonResponse(500, { message: 'no' }));
    await assert.rejects(badStatus.listContainers(), /HTTP 500/i);
    const badType = createClient(async () => response(200, '[]', 'text/plain'));
    await assert.rejects(badType.listContainers(), /content-type/i);
    const oversized = createClient(async () => jsonResponse(200, [record(OWNED, 'owned')]), {
        maxResponseBytes: 16,
    });
    await assert.rejects(oversized.listContainers(), /response limit/i);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10x-time-'));
    const socketPath = path.join(root, 'p.sock');
    const server = http.createServer(() => {});
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    fs.chmodSync(socketPath, 0o600);
    t.after(async () => {
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const timeout = new PodmanHostClient({
        socketPath,
        engineIdentity: '1'.repeat(64),
        connectionIdentity: 'machine',
        connectionUri: 'ssh://localhost/run/user/501/podman.sock',
        hostKind: 'podman-machine',
        timeoutMs: 25,
    });
    await assert.rejects(timeout.listContainers(), /timed out/i);
});

test('ordinary inspect/log/wait/run/copy and unclosed host APIs reject before any request', async () => {
    let calls = 0;
    const client = createClient(async () => { calls += 1; });
    for (const invoke of [
        () => client.inspectContainer(OWNED),
        () => client.logsContainer(OWNED),
        () => client.waitContainer(OWNED),
        () => client.runContainer({ image: IMAGE }),
        () => client.copyContainer({ id: OWNED }),
        () => client.killContainer(OWNED),
        () => client.restartContainer(OWNED),
    ]) {
        await assert.rejects(invoke(), /unsupported.*(?:source-closed|unproven)|forbidden/i);
    }
    assert.equal(client.request, undefined);
    assert.equal(client.requestJson, undefined);
    assert.equal(calls, 0);
});

test('adversarial fake characterizes hidden CLI sync and direct exact actor isolation', async () => {
    const fake = createPhase10xRemoteClient({
        containers: [
            record(OWNED, 'owned', 'created', { Dependencies: [] }),
            record(PROTECTED, 'protected'),
            record(UNRELATED, 'unrelated'),
        ],
        ownedIds: [OWNED],
    });
    assert.equal(fake instanceof Phase10xRemoteClient, true);
    await fake.cliContainer('start', OWNED);
    assert.deepEqual(fake.eventJournal.slice(0, 3).map((entry) => [entry.actor, entry.status]), [
        [OWNED, 'sync'],
        [PROTECTED, 'sync'],
        [UNRELATED, 'sync'],
    ]);
    fake.clearJournals();
    await fake.listContainers({ all: true, sync: false, size: false, namespace: false });
    assert.deepEqual(fake.eventJournal, []);
    await fake.stopContainer({ id: OWNED, timeout: 2, journal: journal() });
    assert.equal(fake.eventJournal.every((entry) => entry.actor === OWNED), true);
    await assert.rejects(fake.cliContainer('inspect', OWNED), /forbidden/i);
    assert.equal(fake.eventJournal.at(-1).status, 'sync');
    fake.clearJournals();
    await assert.rejects(fake.cliContainer('run', IMAGE), /run --rm.*unproven|unproven.*forbidden/i);
    assert.deepEqual(fake.eventJournal.map(({ status }) => status), [
        'create', 'start', 'wait', 'remove',
    ]);
    assert.equal(fake.containers.has('0'.repeat(64)), false);
    for (const operation of ['logs', 'wait', 'exec', 'cp']) {
        await assert.rejects(fake.cliContainer(operation, OWNED), /unproven|forbidden/i);
    }
});
