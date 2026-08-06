import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough, Readable, Writable } from 'node:stream';
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

function multiplexFrame(stream, value) {
    const payload = Buffer.from(value);
    const frameHeader = Buffer.alloc(8);
    frameHeader[0] = stream;
    frameHeader.writeUInt32BE(payload.length, 4);
    return Buffer.concat([frameHeader, payload]);
}

function execInspection({
    running,
    exitCode,
    canRemove,
    pid = running ? 4321 : 0,
    tty = false,
    attachStdin = true,
    argv = ['/bin/test', '--flag'],
    user = 'podman',
    containerId = OWNED,
    sessionId = SESSION,
} = {}) {
    return {
        ID: sessionId,
        ContainerID: containerId,
        Running: running,
        ExitCode: exitCode,
        CanRemove: canRemove,
        Pid: pid,
        OpenStdin: attachStdin,
        OpenStdout: true,
        OpenStderr: true,
        ProcessConfig: {
            entrypoint: argv[0],
            arguments: argv.length === 1 ? null : argv.slice(1),
            privileged: false,
            tty,
            user,
        },
    };
}

async function rawUpgradeServer(t, onUpgradeRequest) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'p10y-upgrade-'));
    const socketPath = path.join(root, 'podman.sock');
    const sockets = new Set();
    const server = net.createServer({ allowHalfOpen: true }, (socket) => {
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        let pending = Buffer.alloc(0);
        let admitted = false;
        let bodyBytes = 0;
        let requestHead;
        const consume = (chunk) => {
            pending = Buffer.concat([pending, chunk]);
            if (!admitted) {
                const boundary = pending.indexOf('\r\n\r\n');
                if (boundary < 0) return;
                requestHead = pending.subarray(0, boundary + 4).toString('latin1');
                const match = /\r\ncontent-length:\s*(\d+)\r\n/iu.exec(requestHead);
                bodyBytes = Number(match?.[1] || 0);
                pending = pending.subarray(boundary + 4);
                admitted = true;
            }
            if (pending.length < bodyBytes) return;
            const requestBody = pending.subarray(0, bodyBytes);
            const streamHead = pending.subarray(bodyBytes);
            pending = Buffer.alloc(0);
            socket.removeListener('data', consume);
            onUpgradeRequest({ socket, requestHead, requestBody, streamHead });
        };
        socket.on('data', consume);
    });
    await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(socketPath, resolve);
    });
    fs.chmodSync(socketPath, 0o600);
    t.after(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise((resolve) => server.close(resolve));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return socketPath;
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

function journalForSocket(socketPath) {
    return journal(OWNED, {
        phase: 'candidate-started',
        engine: {
            name: 'podman',
            identity: '1'.repeat(64),
            apiVersion: 'v6.0.1',
            hostKind: 'podman-machine',
            connection: {
                name: 'podman-machine-default',
                identity: 'podman-machine-default',
                uri: 'ssh://localhost/run/user/501/podman.sock',
                socketPath,
            },
        },
    });
}

function execRequestHarness({
    requests,
    tty = false,
    attachStdin = true,
    argv = ['/bin/test', '--flag'],
    user = 'podman',
    finalExitCode = 0,
    inspections,
    removeResponse = response(200),
} = {}) {
    const queue = inspections ? [...inspections] : [
        execInspection({ running: false, exitCode: 0, canRemove: false, tty, attachStdin, argv, user }),
        execInspection({ running: false, exitCode: finalExitCode, canRemove: true, tty, attachStdin, argv, user }),
    ];
    return async (request) => {
        requests.push(request);
        if (request.path.includes('/containers/json?')) {
            return jsonResponse(200, [record(OWNED, 'owned', 'running')]);
        }
        if (request.path === `/v6.0.1/libpod/containers/${OWNED}%25/exec`) {
            return jsonResponse(201, { Id: SESSION });
        }
        if (request.path === `/v6.0.1/libpod/exec/${SESSION}/json`) {
            assert.ok(queue.length > 0, 'inspection response queue was exhausted');
            return jsonResponse(200, queue.shift());
        }
        if (request.path.startsWith(`/v6.0.1/libpod/exec/${SESSION}/resize?`)) {
            return response(201);
        }
        if (request.path === `/v6.0.1/libpod/exec/${SESSION}/remove`) return removeResponse;
        throw new Error(`unexpected request ${request.method} ${request.path}`);
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
    assert.equal(
        PODMAN_V6_SOURCE_CLOSURE.archiveSha256,
        '0895a541aeb7aa8e99133ed2b328c1bb40fd397b7c3b01e083396c90e8628756',
    );
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
    let inspection = 0;
    const client = createClient(async (request) => {
        requests.push(request);
        if (request.path.includes('/containers/json?')) {
            return jsonResponse(200, [record(OWNED, 'owned', 'running')]);
        }
        if (request.path.endsWith('/exec')) return jsonResponse(201, { Id: SESSION });
        if (request.path.endsWith('/json')) {
            inspection += 1;
            return jsonResponse(200, {
                ID: SESSION,
                ContainerID: OWNED,
                Running: false,
                ExitCode: inspection === 1 ? 0 : 3,
                CanRemove: inspection !== 1,
                Pid: 0,
                OpenStdin: false,
                OpenStdout: true,
                OpenStderr: true,
                ProcessConfig: {
                    entrypoint: '/bin/test',
                    arguments: ['--flag'],
                    privileged: false,
                    tty: false,
                    user: 'podman',
                },
            });
        }
        if (request.path.endsWith('/remove')) return response(200);
        throw new Error(`unexpected request ${request.path}`);
    }, {
        duplexImpl: async (request) => {
            requests.push(request);
            request.onUpgraded();
            request.stdout.write(Buffer.from('out'));
            request.stderr.write(Buffer.from('err'));
            return { statusCode: 101, detached: false };
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
        ['POST', `/v6.0.1/libpod/containers/${OWNED}%25/exec`],
        ['GET', `/v6.0.1/libpod/exec/${SESSION}/json`],
        ['POST', `/v6.0.1/libpod/exec/${SESSION}/start`],
        ['GET', `/v6.0.1/libpod/exec/${SESSION}/json`],
        ['POST', `/v6.0.1/libpod/exec/${SESSION}/remove`],
    ]);
    assert.equal(requests.some(({ path: requestPath }) => (
        requestPath === `/v6.0.1/libpod/containers/${OWNED}/exec`
    )), false, 'literal full-ID exec route remains name-shadowable in Podman v6.0.2');
});

test('real upgraded Unix socket handles fragmented handshake/frames and preserves reads after stdin half-close', async (t) => {
    let startRequest;
    let stdinBytes = Buffer.alloc(0);
    let observedHalfClose = false;
    const socketPath = await rawUpgradeServer(t, ({ socket, requestHead, requestBody, streamHead }) => {
        startRequest = {
            head: requestHead,
            body: JSON.parse(requestBody.toString('utf8')),
        };
        stdinBytes = Buffer.from(streamHead);
        socket.on('data', (chunk) => { stdinBytes = Buffer.concat([stdinBytes, chunk]); });
        socket.once('end', () => {
            observedHalfClose = true;
            const frames = Buffer.concat([
                multiplexFrame(1, 'stdout-1'),
                multiplexFrame(2, 'stderr-1'),
                multiplexFrame(1, 'stdout-2'),
            ]);
            socket.write(frames.subarray(0, 3));
            setImmediate(() => {
                socket.write(frames.subarray(3, 19));
                socket.end(frames.subarray(19));
            });
        });
        socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Up');
        setImmediate(() => socket.write([
            'grade\r\n',
            'Upgrade: tcp\r\n',
            'Content-Type: application/vnd.docker.multiplexed-stream\r\n',
            '\r\n',
        ].join('')));
    });
    const requests = [];
    const client = createClient(execRequestHarness({
        requests,
        finalExitCode: 17,
    }), {
        socketPath,
        timeoutMs: 2_000,
    });
    const result = await client.execContainer({
        id: OWNED,
        argv: ['/bin/test', '--flag'],
        input: Buffer.from('bounded stdin'),
        journal: journalForSocket(socketPath),
        timeoutMs: 2_000,
        inactivityTimeoutMs: 1_000,
        maxOutputBytes: 64,
    });
    assert.deepEqual(result, {
        stdout: 'stdout-1stdout-2',
        stderr: 'stderr-1',
        exitCode: 17,
        sessionId: SESSION,
    });
    assert.equal(observedHalfClose, true);
    assert.equal(stdinBytes.toString(), 'bounded stdin');
    assert.deepEqual(startRequest.body, { Detach: false, Tty: false, h: 0, w: 0 });
    assert.match(startRequest.head, /^POST \/v6\.0\.1\/libpod\/exec\/[a-f0-9]{64}\/start HTTP\/1\.1\r\n/u);
    const remove = requests.find(({ path: requestPath }) => requestPath.endsWith('/remove'));
    assert.equal(remove.body.toString(), '{"Force":false}');
});

test('real upgraded TTY stream is raw merged output and honors sink backpressure', async (t) => {
    const socketPath = await rawUpgradeServer(t, ({ socket }) => {
        socket.write([
            'HTTP/1.1 101 Switching Protocols\r\n',
            'Connection: Upgrade\r\n',
            'Upgrade: tcp\r\n',
            'Content-Type: application/vnd.docker.raw-stream\r\n',
            '\r\n',
        ].join(''));
        socket.once('end', () => {
            socket.write('raw ');
            setImmediate(() => socket.end('terminal'));
        });
    });
    const requests = [];
    const chunks = [];
    const stdout = new Writable({
        highWaterMark: 1,
        write(chunk, _encoding, callback) {
            chunks.push(Buffer.from(chunk));
            setImmediate(callback);
        },
    });
    const stderr = new PassThrough();
    const client = createClient(execRequestHarness({
        requests,
        tty: true,
        argv: ['/bin/sh'],
    }), {
        socketPath,
        timeoutMs: 2_000,
    });
    assert.deepEqual(await client.execContainerInteractive({
        id: OWNED,
        argv: ['/bin/sh'],
        journal: journalForSocket(socketPath),
        rows: 24,
        columns: 80,
        stdin: Readable.from([]),
        stdout,
        stderr,
        timeoutMs: 2_000,
        inactivityTimeoutMs: 1_000,
    }), { exitCode: 0, detached: false });
    assert.equal(Buffer.concat(chunks).toString(), 'raw terminal');
    assert.equal(stderr.read(), null);
});

test('closed output sink settles promptly without post-stream inspection or cleanup', async (t) => {
    const socketPath = await rawUpgradeServer(t, ({ socket }) => {
        socket.end(Buffer.concat([
            Buffer.from([
                'HTTP/1.1 101 Switching Protocols\r\n',
                'Connection: Upgrade\r\n',
                'Upgrade: tcp\r\n',
                'Content-Type: application/vnd.docker.raw-stream\r\n',
                '\r\n',
            ].join('')),
            Buffer.from('blocked output'),
        ]));
    });
    const requests = [];
    const sink = new EventEmitter();
    sink.write = () => {
        setImmediate(() => sink.emit('close'));
        return false;
    };
    const client = createClient(execRequestHarness({
        requests,
        tty: true,
        argv: ['/bin/sh'],
    }), {
        socketPath,
        timeoutMs: 2_000,
    });
    const startedAt = Date.now();
    await assert.rejects(client.execContainerInteractive({
        id: OWNED,
        argv: ['/bin/sh'],
        journal: journalForSocket(socketPath),
        rows: 24,
        columns: 80,
        stdin: Readable.from([]),
        stdout: sink,
        stderr: new PassThrough(),
        timeoutMs: 1_500,
        inactivityTimeoutMs: 1_000,
        maxOutputBytes: 64,
    }), /output sink.*closed|closed.*output sink/i);
    assert.ok(Date.now() - startedAt < 500, 'sink close must not wait for inactivity or overall timeout');
    assert.equal(requests.filter(({ path: requestPath }) => requestPath.endsWith('/json')).length, 1);
    assert.equal(requests.some(({ path: requestPath }) => requestPath.endsWith('/remove')), false);
});

test('real upgraded non-TTY decoder rejects invalid, oversized, and truncated frames without cleanup', async (t) => {
    const cases = [
        ['invalid', Buffer.from([3, 0, 0, 0, 0, 0, 0, 0]), /invalid multiplex frame/i],
        ['oversized', (() => {
            const header = Buffer.alloc(8);
            header[0] = 1;
            header.writeUInt32BE(8_193, 4);
            return header;
        })(), /oversized multiplex frame|frame limit|response limit/i],
        ['truncated header', Buffer.from([1, 0, 0]), /truncated multiplex frame/i],
        ['truncated payload', multiplexFrame(1, 'payload').subarray(0, 12), /truncated multiplex frame|truncated multiplex payload/i],
    ];
    for (const [label, frame, expected] of cases) {
        await t.test(label, async (subtest) => {
            const socketPath = await rawUpgradeServer(subtest, ({ socket }) => {
                socket.end(Buffer.concat([
                    Buffer.from([
                        'HTTP/1.1 101 Switching Protocols\r\n',
                        'Connection: Upgrade\r\n',
                        'Upgrade: tcp\r\n',
                        'Content-Type: application/vnd.docker.multiplexed-stream\r\n',
                        '\r\n',
                    ].join('')),
                    frame,
                ]));
            });
            const requests = [];
            const client = createClient(execRequestHarness({
                requests,
                attachStdin: false,
            }), {
                socketPath,
                timeoutMs: 2_000,
            });
            await assert.rejects(client.execContainer({
                id: OWNED,
                argv: ['/bin/test', '--flag'],
                journal: journalForSocket(socketPath),
                timeoutMs: 2_000,
                inactivityTimeoutMs: 1_000,
                maxOutputBytes: 16_384,
            }), expected);
            assert.equal(requests.some(({ path: requestPath }) => requestPath.endsWith('/remove')), false);
            assert.equal(requests.filter(({ path: requestPath }) => requestPath.endsWith('/json')).length, 1);
        });
    }
});

test('upgrade admission rejects wrong headers and bounded non-101 bodies without final inspection', async (t) => {
    const cases = [
        ['wrong upgrade headers', [
            'HTTP/1.1 101 Switching Protocols\r\n',
            'Connection: close\r\n',
            'Upgrade: tcp\r\n',
            'Content-Type: application/vnd.docker.multiplexed-stream\r\n',
            '\r\n',
        ].join(''), /HTTP 101.*not 101 Upgrade|invalid upgrade response/i, {}],
        ['oversized error body', [
            'HTTP/1.1 500 Internal Server Error\r\n',
            'Content-Type: text/plain\r\n',
            'Content-Length: 2048\r\n',
            '\r\n',
            'x'.repeat(2048),
        ].join(''), /response limit/i, { maxResponseBytes: 1024 }],
    ];
    for (const [label, rawResponse, expected, options] of cases) {
        await t.test(label, async (subtest) => {
            const socketPath = await rawUpgradeServer(subtest, ({ socket }) => socket.end(rawResponse));
            const requests = [];
            const client = createClient(execRequestHarness({
                requests,
                attachStdin: false,
            }), {
                socketPath,
                timeoutMs: 2_000,
                ...options,
            });
            await assert.rejects(client.execContainer({
                id: OWNED,
                argv: ['/bin/test', '--flag'],
                journal: journalForSocket(socketPath),
                timeoutMs: 2_000,
                inactivityTimeoutMs: 1_000,
                maxOutputBytes: 16_384,
            }), expected);
            assert.equal(requests.filter(({ path: requestPath }) => requestPath.endsWith('/json')).length, 1);
            assert.equal(requests.some(({ path: requestPath }) => requestPath.endsWith('/remove')), false);
        });
    }
});

test('upgraded stream inactivity and caller cancellation retain session evidence', async (t) => {
    const cases = [
        ['inactivity', /inactive/i, undefined, 500, 30],
        ['overall deadline', /overall deadline/i, undefined, 40, 40],
        ['caller cancellation', /cancelled by its caller/i, new AbortController(), 500, 30],
    ];
    for (const [label, expected, abort, timeoutMs, inactivityTimeoutMs] of cases) {
        await t.test(label, async (subtest) => {
            const socketPath = await rawUpgradeServer(subtest, ({ socket }) => {
                socket.write([
                    'HTTP/1.1 101 Switching Protocols\r\n',
                    'Connection: Upgrade\r\n',
                    'Upgrade: tcp\r\n',
                    'Content-Type: application/vnd.docker.multiplexed-stream\r\n',
                    '\r\n',
                ].join(''));
            });
            const requests = [];
            const client = createClient(execRequestHarness({
                requests,
                attachStdin: false,
            }), {
                socketPath,
                timeoutMs: 1_000,
            });
            const execution = client.execContainer({
                id: OWNED,
                argv: ['/bin/test', '--flag'],
                journal: journalForSocket(socketPath),
                timeoutMs,
                inactivityTimeoutMs,
                signal: abort?.signal,
            });
            if (abort) setImmediate(() => abort.abort(new Error('test cancellation')));
            await assert.rejects(execution, expected);
            assert.equal(requests.filter(({ path: requestPath }) => requestPath.endsWith('/json')).length, 1);
            assert.equal(requests.some(({ path: requestPath }) => requestPath.endsWith('/remove')), false);
        });
    }
});

test('coalesced local detach keys are not forwarded and are distinct from process exit', async (t) => {
    let received = Buffer.alloc(0);
    const socketPath = await rawUpgradeServer(t, ({ socket, streamHead }) => {
        received = Buffer.from(streamHead);
        socket.on('data', (chunk) => { received = Buffer.concat([received, chunk]); });
        socket.write([
            'HTTP/1.1 101 Switching Protocols\r\n',
            'Connection: Upgrade\r\n',
            'Upgrade: tcp\r\n',
            'Content-Type: application/vnd.docker.raw-stream\r\n',
            '\r\n',
            'before-detach',
        ].join(''));
    });
    const requests = [];
    const client = createClient(execRequestHarness({
        requests,
        tty: true,
        argv: ['/bin/sh'],
        inspections: [
            execInspection({ running: false, exitCode: 0, canRemove: false, tty: true, argv: ['/bin/sh'] }),
            execInspection({ running: true, exitCode: 0, canRemove: false, tty: true, argv: ['/bin/sh'] }),
        ],
    }), {
        socketPath,
        timeoutMs: 2_000,
    });
    const stdout = new PassThrough();
    assert.deepEqual(await client.execContainerInteractive({
        id: OWNED,
        argv: ['/bin/sh'],
        journal: journalForSocket(socketPath),
        rows: 24,
        columns: 80,
        stdin: Readable.from([Buffer.from([0x10, 0x11])]),
        stdout,
        stderr: new PassThrough(),
        timeoutMs: 2_000,
        inactivityTimeoutMs: 1_000,
    }), { exitCode: 0, detached: true });
    assert.equal(stdout.read().toString(), 'before-detach');
    assert.equal(received.includes(Buffer.from([0x10, 0x11])), false);
    assert.equal(requests.filter(({ path: requestPath }) => requestPath.endsWith('/json')).length, 2);
    assert.equal(requests.some(({ path: requestPath }) => requestPath.endsWith('/remove')), false);
});

test('live TTY resize re-proves binding and uses the exact bounded running=false route', async () => {
    const requests = [];
    let controller;
    let release;
    const streamDone = new Promise((resolve) => { release = resolve; });
    const inspections = [
        execInspection({ running: false, exitCode: 0, canRemove: false, tty: true, argv: ['/bin/sh'] }),
        execInspection({ running: true, exitCode: 0, canRemove: false, tty: true, argv: ['/bin/sh'] }),
        execInspection({ running: false, exitCode: 23, canRemove: true, tty: true, argv: ['/bin/sh'] }),
    ];
    const client = createClient(execRequestHarness({
        requests,
        tty: true,
        argv: ['/bin/sh'],
        finalExitCode: 23,
        inspections,
    }), {
        duplexImpl: async (request) => {
            requests.push(request);
            request.onUpgraded();
            await streamDone;
            return { statusCode: 101, detached: false };
        },
    });
    const execution = client.execContainerInteractive({
        id: OWNED,
        argv: ['/bin/sh'],
        journal: journal(OWNED, { phase: 'candidate-started' }),
        rows: 24,
        columns: 80,
        stdin: Readable.from([]),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        onSession(value) { controller = value; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(Object.isFrozen(controller), true);
    assert.deepEqual(await controller.resize(41, 132), { rows: 41, columns: 132 });
    release();
    assert.deepEqual(await execution, { exitCode: 23, detached: false });
    assert.equal(requests.some(({ path: requestPath }) => (
        requestPath === `/v6.0.1/libpod/exec/${SESSION}/resize?h=41&w=132&running=false`
    )), true);
});

test('foreign exec binding and ambiguous non-force cleanup fail closed without unowned session mutation', async () => {
    const foreignRequests = [];
    let duplexCalls = 0;
    const foreign = createClient(execRequestHarness({
        requests: foreignRequests,
        attachStdin: false,
        inspections: [execInspection({
            running: false,
            exitCode: 0,
            canRemove: false,
            attachStdin: false,
            containerId: PROTECTED,
        })],
    }), {
        duplexImpl: async () => {
            duplexCalls += 1;
            throw new Error('must not start foreign-bound session');
        },
    });
    await assert.rejects(foreign.execContainer({
        id: OWNED,
        argv: ['/bin/test', '--flag'],
        journal: journal(OWNED, { phase: 'candidate-started' }),
    }), /exact session binding/i);
    assert.equal(duplexCalls, 0);
    assert.equal(foreignRequests.some(({ path: requestPath }) => (
        requestPath.endsWith('/start') || requestPath.endsWith('/remove')
    )), false);

    const cleanupRequests = [];
    const cleanup = createClient(execRequestHarness({
        requests: cleanupRequests,
        attachStdin: false,
        removeResponse: response(200, 'ambiguous'),
    }), {
        duplexImpl: async (request) => {
            cleanupRequests.push(request);
            request.onUpgraded();
            return { statusCode: 101, detached: false };
        },
    });
    await assert.rejects(cleanup.execContainer({
        id: OWNED,
        argv: ['/bin/test', '--flag'],
        journal: journal(OWNED, { phase: 'candidate-started' }),
    }), /unexpected response body|empty body/i);
    const removes = cleanupRequests.filter(({ path: requestPath }) => requestPath.endsWith('/remove'));
    assert.equal(removes.length, 1);
    assert.equal(removes[0].body.toString(), '{"Force":false}');
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

test('shared remote fake models functional TTY stdin half-close, resize, exit, and exact cleanup', async () => {
    let release;
    const waitFor = new Promise((resolve) => { release = resolve; });
    const fake = createPhase10xRemoteClient({
        containers: [
            record(OWNED, 'owned'),
            record(PROTECTED, 'protected'),
            record(UNRELATED, 'unrelated'),
        ],
        ownedIds: [OWNED],
        generatedSessionIds: [SESSION],
        execOutcomes: [{ ttyBytes: Buffer.from('terminal output'), exitCode: 7, waitFor }],
    });
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let controller;
    const execution = fake.execContainerInteractive({
        id: OWNED,
        argv: ['/bin/sh'],
        user: 'podman',
        workdir: '/workspace',
        env: { SAFE: 'yes' },
        journal: journal(OWNED, { phase: 'candidate-started' }),
        tty: true,
        detachKeys: 'ctrl-p,ctrl-q',
        rows: 24,
        columns: 80,
        stdin: Readable.from([Buffer.from('input bytes')]),
        stdout,
        stderr,
        onSession(value) { controller = value; },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(Object.isFrozen(controller), true);
    assert.equal(controller.sessionId, SESSION);
    assert.deepEqual(await controller.resize(41, 132), { rows: 41, columns: 132 });
    release();
    assert.deepEqual(await execution, { exitCode: 7, detached: false });
    assert.equal(stdout.read().toString(), 'terminal output');
    assert.equal(stderr.read(), null);
    const input = fake.requestJournal.find(({ operation }) => operation === 'exec-stdin');
    assert.equal(input.bytes.toString(), 'input bytes');
    const create = fake.requestJournal.find(({ operation }) => operation === 'exec-create');
    assert.equal(create.path, `/v6.0.1/libpod/containers/${OWNED}%25/exec`);
    assert.equal(fake.requestJournal.some(({ path: requestPath }) => (
        requestPath === `/v6.0.1/libpod/containers/${OWNED}/exec`
    )), false);
    assert.equal(fake.requestJournal.some(({ operation }) => operation === 'exec-write-half-close'), true);
    const resize = fake.requestJournal.find(({ operation }) => operation === 'exec-resize');
    assert.deepEqual({ rows: resize.rows, columns: resize.columns, running: resize.running }, {
        rows: 41,
        columns: 132,
        running: false,
    });
    const remove = fake.requestJournal.find(({ operation }) => operation === 'exec-remove');
    assert.equal(remove.force, false);
    assert.equal(fake.requestJournal.every(({ actor }) => (
        actor === undefined || actor === OWNED || actor === SESSION
    )), true);
    assert.equal(fake.eventJournal.every(({ actor }) => actor === OWNED), true);
});

test('shared remote fake retains detached and cancelled exec evidence without cleanup', async () => {
    const detached = createPhase10xRemoteClient({
        containers: [record(OWNED, 'owned'), record(PROTECTED, 'protected')],
        ownedIds: [OWNED],
        generatedSessionIds: [SESSION],
        execOutcomes: [{ detached: true, ttyBytes: Buffer.from('before detach') }],
    });
    const output = new PassThrough();
    assert.deepEqual(await detached.execContainerInteractive({
        id: OWNED,
        argv: ['/bin/sh'],
        journal: journal(OWNED, { phase: 'candidate-started' }),
        tty: true,
        detachKeys: 'ctrl-p,ctrl-q',
        rows: 24,
        columns: 80,
        stdin: Readable.from([Buffer.from([0x10]), Buffer.from([0x11])]),
        stdout: output,
        stderr: new PassThrough(),
    }), { exitCode: 0, detached: true });
    assert.equal(detached.requestJournal.some(({ operation }) => operation === 'exec-remove'), false);
    assert.equal(detached.execSessions.has(SESSION), true);

    const cancelled = createPhase10xRemoteClient({
        containers: [record(OWNED, 'owned'), record(UNRELATED, 'unrelated')],
        ownedIds: [OWNED],
        generatedSessionIds: [SESSION],
        execOutcomes: [{ waitForAbort: true }],
    });
    const abort = new AbortController();
    const execution = cancelled.execContainerInteractive({
        id: OWNED,
        argv: ['/bin/sh'],
        journal: journal(OWNED, { phase: 'candidate-started' }),
        tty: false,
        stdin: Readable.from([]),
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        signal: abort.signal,
    });
    await new Promise((resolve) => setImmediate(resolve));
    abort.abort();
    await assert.rejects(execution, /cancelled/i);
    assert.equal(cancelled.requestJournal.some(({ operation }) => operation === 'exec-remove'), false);
    assert.equal(cancelled.execSessions.has(SESSION), true);
    assert.equal(cancelled.eventJournal.every(({ actor }) => actor === OWNED), true);
});

test('shared remote fake rejects full-ID name shadowing and privileged users before exec mutation', async () => {
    const shadowed = createPhase10xRemoteClient({
        containers: [record(OWNED, 'owned'), record(PROTECTED, OWNED)],
        ownedIds: [OWNED],
    });
    await assert.rejects(shadowed.execContainerInteractive({
        id: OWNED,
        argv: ['/bin/true'],
        journal: journal(OWNED, { phase: 'candidate-started' }),
        tty: false,
        stdout: new PassThrough(),
        stderr: new PassThrough(),
    }), /shadowed|foreign exact container name/i);
    assert.deepEqual(shadowed.requestJournal, []);
    assert.deepEqual(shadowed.eventJournal, []);

    const privileged = createPhase10xRemoteClient({
        containers: [record(OWNED, 'owned'), record(UNRELATED, 'unrelated')],
        ownedIds: [OWNED],
    });
    for (const user of ['root', 'root:1000', '0', '0:1000']) {
        await assert.rejects(privileged.execContainerInteractive({
            id: OWNED,
            argv: ['/bin/true'],
            user,
            journal: journal(OWNED, { phase: 'candidate-started' }),
            tty: false,
            stdout: new PassThrough(),
            stderr: new PassThrough(),
        }), /privileged exec user/i);
    }
    assert.deepEqual(privileged.requestJournal, []);
    assert.deepEqual(privileged.eventJournal, []);

    const dimensions = createPhase10xRemoteClient({
        containers: [record(OWNED, 'owned')],
        ownedIds: [OWNED],
    });
    for (const [rows, columns] of [[0, 80], [24, 65_536]]) {
        await assert.rejects(dimensions.execContainerInteractive({
            id: OWNED,
            argv: ['/bin/true'],
            journal: journal(OWNED, { phase: 'candidate-started' }),
            tty: true,
            rows,
            columns,
            stdout: new PassThrough(),
            stderr: new PassThrough(),
        }), /terminal bounds/i);
    }
    assert.deepEqual(dimensions.requestJournal, []);
    assert.deepEqual(dimensions.eventJournal, []);
});
