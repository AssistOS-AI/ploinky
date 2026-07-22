import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

import { PloinkyBoxError } from '../errors.mjs';

function transportError(message, cause) {
    return new PloinkyBoxError(message, {
        code: 'PLOINKY_BOX_TRANSPORT_FAILED',
        cause,
    });
}

function parseJsonArray(value, label) {
    let parsed;
    try {
        parsed = JSON.parse(String(value || ''));
    } catch (error) {
        throw transportError(`${label} is not valid JSON`, error);
    }
    if (!Array.isArray(parsed)) {
        throw transportError(`${label} must be a JSON array`);
    }
    return parsed;
}

function validInterface(value) {
    return value && !/[\u0000-\u0020\u007f/\\]/.test(value);
}

function routableIpv4(address) {
    if (net.isIP(address) !== 4) return false;
    const first = Number(address.split('.')[0]);
    return first > 0 && first !== 127 && first < 224;
}

export function parseExactTransport(routeOutput, addressOutput) {
    const routes = parseJsonArray(routeOutput, 'IPv4 route output');
    if (routes.length !== 1) {
        throw transportError('IPv4 route lookup must return exactly one result');
    }
    const address = String(routes[0]?.prefsrc || '').trim();
    const interfaceName = String(routes[0]?.dev || '').trim();
    if (!routableIpv4(address) || !validInterface(interfaceName)) {
        throw transportError('IPv4 route lacks an exact routable preferred source and interface');
    }
    const interfaces = parseJsonArray(addressOutput, 'IPv4 address output');
    const record = interfaces.find((entry) => String(entry?.ifname || '') === interfaceName);
    const assigned = Array.isArray(record?.addr_info) && record.addr_info.some((entry) => (
        String(entry?.family || '') === 'inet'
        && String(entry?.local || '') === address
    ));
    if (!assigned) {
        throw transportError(`Route address ${address} is not assigned to interface ${interfaceName}`);
    }
    return Object.freeze({ address, interface: interfaceName });
}

function currentUid() {
    return typeof process.getuid === 'function' ? process.getuid() : null;
}

function currentGid() {
    return typeof process.getgid === 'function' ? process.getgid() : null;
}

function assertPrivateDirectory(directory, fsApi, uid) {
    const stat = fsApi.lstatSync(directory);
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw transportError(`Transport parent is not a real directory: ${directory}`);
    }
    if (uid !== null && stat.uid !== uid) {
        throw transportError(`Transport parent is not owned by the Box user: ${directory}`);
    }
    fsApi.chmodSync(directory, 0o700);
}

function ensurePrivateDirectory(directory, fsApi, uid, gid) {
    try {
        fsApi.mkdirSync(directory, { recursive: true, mode: 0o700 });
    } catch (error) {
        throw transportError(`Unable to create transport parent ${directory}`, error);
    }
    assertPrivateDirectory(directory, fsApi, uid);
    if (uid !== null && gid !== null) fsApi.chownSync(directory, uid, gid);
}

function snapshotFile(target, fsApi, uid) {
    try {
        const stat = fsApi.lstatSync(target);
        if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1) {
            throw transportError(`Transport destination is not a private regular file: ${target}`);
        }
        if (uid !== null && stat.uid !== uid) {
            throw transportError(`Transport destination is not owned by the Box user: ${target}`);
        }
        return Object.freeze({
            exists: true,
            bytes: fsApi.readFileSync(target),
            mode: stat.mode & 0o777,
            uid: stat.uid,
            gid: stat.gid,
        });
    } catch (error) {
        if (error.code === 'ENOENT') return Object.freeze({ exists: false });
        throw error;
    }
}

function fsyncDirectory(directory, fsApi) {
    const descriptor = fsApi.openSync(directory, fsApi.constants.O_RDONLY);
    try {
        try {
            fsApi.fsyncSync(descriptor);
        } catch (error) {
            if (!['EINVAL', 'ENOTSUP'].includes(error.code)) throw error;
        }
    } finally {
        fsApi.closeSync(descriptor);
    }
}

function stageFile(target, bytes, fsApi, uid, gid, token) {
    const directory = path.dirname(target);
    const staged = path.join(directory, `.${path.basename(target)}.${token}.tmp`);
    const flags = fsApi.constants.O_WRONLY
        | fsApi.constants.O_CREAT
        | fsApi.constants.O_EXCL
        | (fsApi.constants.O_NOFOLLOW || 0);
    const descriptor = fsApi.openSync(staged, flags, 0o600);
    try {
        fsApi.writeFileSync(descriptor, bytes);
        fsApi.fchmodSync(descriptor, 0o600);
        if (uid !== null && gid !== null) fsApi.fchownSync(descriptor, uid, gid);
        fsApi.fsyncSync(descriptor);
    } catch (error) {
        try { fsApi.closeSync(descriptor); } catch {}
        try { fsApi.unlinkSync(staged); } catch {}
        throw error;
    }
    fsApi.closeSync(descriptor);
    return staged;
}

function restoreSnapshot(target, snapshot, fsApi, token) {
    const directory = path.dirname(target);
    if (!snapshot.exists) {
        try { fsApi.unlinkSync(target); } catch (error) {
            if (error.code !== 'ENOENT') throw error;
        }
        fsyncDirectory(directory, fsApi);
        return;
    }
    const staged = stageFile(
        target,
        snapshot.bytes,
        fsApi,
        snapshot.uid,
        snapshot.gid,
        `${token}.restore`,
    );
    fsApi.chmodSync(staged, snapshot.mode);
    fsApi.renameSync(staged, target);
    fsyncDirectory(directory, fsApi);
}

export function writeTransportPair({
    transport,
    transportFile = '/run/ploinky/box-transport.json',
    containersConf = '/home/podman/.config/containers/containers.conf',
    fsApi = fs,
    uid = currentUid(),
    gid = currentGid(),
    token = crypto.randomBytes(10).toString('hex'),
    afterFirstCommit = () => {},
} = {}) {
    if (!transport || !routableIpv4(transport.address) || !validInterface(transport.interface)) {
        throw transportError('Transport pair requires a validated IPv4 address and interface');
    }
    if (path.resolve(transportFile) === path.resolve(containersConf)) {
        throw transportError('Transport destinations must be distinct files');
    }
    const files = [path.resolve(transportFile), path.resolve(containersConf)];
    for (const directory of new Set(files.map(path.dirname))) {
        ensurePrivateDirectory(directory, fsApi, uid, gid);
    }
    const snapshots = files.map((target) => snapshotFile(target, fsApi, uid));
    if (snapshots[0].exists !== snapshots[1].exists) {
        throw transportError('Existing transport state is incomplete; refusing a one-sided update');
    }
    const contents = [
        Buffer.from(`${JSON.stringify(transport)}\n`),
        Buffer.from([
            '[containers]',
            'volumes=["/proc:/proc"]',
            'default_sysctls=[]',
            '',
        ].join('\n')),
    ];
    const staged = [];
    try {
        for (let index = 0; index < files.length; index += 1) {
            staged[index] = stageFile(files[index], contents[index], fsApi, uid, gid, `${token}.${index}`);
        }
        fsApi.renameSync(staged[0], files[0]);
        staged[0] = '';
        fsyncDirectory(path.dirname(files[0]), fsApi);
        afterFirstCommit();
        fsApi.renameSync(staged[1], files[1]);
        staged[1] = '';
        fsyncDirectory(path.dirname(files[1]), fsApi);
        for (const target of files) fsApi.chmodSync(target, 0o600);
        return Object.freeze({ transportFile: files[0], containersConf: files[1] });
    } catch (error) {
        for (const target of staged.filter(Boolean)) {
            try { fsApi.unlinkSync(target); } catch {}
        }
        const rollbackFailures = [];
        for (let index = 0; index < files.length; index += 1) {
            try {
                restoreSnapshot(files[index], snapshots[index], fsApi, `${token}.${index}`);
            } catch (rollbackError) {
                rollbackFailures.push(rollbackError.message);
            }
        }
        const suffix = rollbackFailures.length
            ? `; rollback failures: ${rollbackFailures.join('; ')}`
            : '';
        throw transportError(`Transport pair update failed${suffix}`, error);
    }
}

export function configureBoxTransport({
    runner,
    transportFile,
    containersConf,
    fsApi = fs,
    ...writeOptions
} = {}) {
    if (!runner || typeof runner.query !== 'function') {
        throw transportError('Transport discovery requires a process runner');
    }
    const route = runner.query('ip', ['-j', '-4', 'route', 'get', '198.51.100.1']);
    if (!route.ok) {
        throw transportError(`Unable to discover the Box IPv4 route: ${route.stderr || 'no diagnostic'}`);
    }
    const parsedRoute = parseJsonArray(route.stdout, 'IPv4 route output');
    if (parsedRoute.length !== 1) {
        throw transportError('IPv4 route lookup must return exactly one result');
    }
    const interfaceName = String(parsedRoute[0]?.dev || '').trim();
    if (!validInterface(interfaceName)) {
        throw transportError('IPv4 route lacks an exact interface');
    }
    const address = runner.query('ip', ['-j', '-4', 'address', 'show', 'dev', interfaceName]);
    if (!address.ok) {
        throw transportError(`Unable to inspect Box interface ${interfaceName}: ${address.stderr || 'no diagnostic'}`);
    }
    const transport = parseExactTransport(route.stdout, address.stdout);
    const files = writeTransportPair({
        transport,
        transportFile,
        containersConf,
        fsApi,
        ...writeOptions,
    });
    return Object.freeze({ ...transport, ...files });
}
