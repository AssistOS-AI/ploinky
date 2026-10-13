// Apple-only evidence for Podman's omitted HostConfig.Devices representation.
// Raw create arguments are transient; only validated device arguments survive.
import { requireTransport } from './liveProcess.mjs';

export const APPLE_DEVICE_INSPECT = '{"id":{{json .ID}},"image":{{json .Image}},"created":{{json .Created}},"pid":{{json .State.Pid}},"running":{{json .State.Running}},"devices":{{json .HostConfig.Devices}},"createCommand":{{json .Config.CreateCommand}}}';
const check = (value, message) => { if (!value) throw new Error(message); };
const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const selected = value => typeof value === 'string' && /^\/dev\/dri\/renderD\d+$/.test(value);

export function projectAppleDeviceInspect(raw) {
    check(raw && Array.isArray(raw.createCommand) && raw.createCommand.every(value => typeof value === 'string'), 'Apple create arguments unavailable');
    const recordedDevices = [];
    for (let index = 0; index < raw.createCommand.length; index += 1) {
        const arg = raw.createCommand[index];
        if (arg === '--device') {
            check(index + 1 < raw.createCommand.length, 'Apple device argument incomplete');
            recordedDevices.push(raw.createCommand[++index]);
        } else if (arg.startsWith('--device=')) recordedDevices.push(arg.slice(9));
    }
    return { id: raw.id, image: raw.image, created: raw.created, pid: raw.pid, running: raw.running,
        devices: Array.isArray(raw.devices) ? raw.devices.map(device => ({ PathOnHost: device?.PathOnHost,
            PathInContainer: device?.PathInContainer, CgroupPermissions: device?.CgroupPermissions })) : null, recordedDevices };
}

export function assertAppleDeviceArguments(value, { renderNode, role }) {
    check(selected(renderNode) && ['box', 'agent'].includes(role), 'Apple device selection invalid');
    const expected = role === 'box' ? ['/dev/fuse', '/dev/net/tun', renderNode] : ['ploinky.local/gpu=all'];
    check(equal(value.recordedDevices, expected), 'Apple recorded device set differs');
    // Match the product's empty-array exception, never null/unknown metadata.
    const paths = role === 'box' ? expected : [renderNode];
    check(Array.isArray(value.devices) && (value.devices.length === 0 || value.devices.length === paths.length
        && paths.every(name => value.devices.filter(device => device?.PathOnHost === name
            && device.PathInContainer === name && device.CgroupPermissions === 'rwm').length === 1)), 'Apple inspected device set differs');
}

// Runs as the same user as the corresponding Box/agent command. Never emits
// file contents, environment, arbitrary error messages, or the raw CDI spec.
export function readAppleRenderFacts(io, renderNode, isBox) {
    const check = value => { if (!value) throw new Error('Apple render observation rejected'); };
    const exactKeys = (value, keys) => value && typeof value === 'object' && !Array.isArray(value)
        && JSON.stringify(Object.keys(value).sort()) === JSON.stringify(keys.sort());
    check(typeof renderNode === 'string' && /^\/dev\/dri\/renderD\d+$/.test(renderNode));
    const directory = io.lstatSync('/dev/dri');
    check(directory.isDirectory() && !directory.isSymbolicLink());
    const names = io.readdirSync('/dev/dri').filter(name => name.startsWith('renderD'));
    check(names.length === 1 && `/dev/dri/${names[0]}` === renderNode);
    const before = io.lstatSync(renderNode);
    check(before.isCharacterDevice() && !before.isSymbolicLink());
    io.accessSync(renderNode, io.constants.R_OK | io.constants.W_OK);
    const after = io.lstatSync(renderNode);
    check(after.isCharacterDevice() && !after.isSymbolicLink()
        && ['dev', 'ino', 'rdev', 'mode', 'uid', 'gid'].every(key => before[key] === after[key]));
    const node = { path: renderNode, character: true, symlink: false, read: true, write: true,
        rdev: after.rdev, mode: after.mode, uid: after.uid, gid: after.gid };
    let cdi = null;
    if (isBox) {
        const file = '/etc/cdi/ploinky-gpu.json';
        const fd = io.openSync(file, io.constants.O_RDONLY | io.constants.O_NOFOLLOW);
        try {
            const stat = io.fstatSync(fd);
            check(stat.isFile() && stat.size > 0 && stat.size <= 16384);
            const bytes = io.readFileSync(fd);
            check(bytes.length <= 16384);
            const spec = JSON.parse(bytes);
            check(exactKeys(spec, ['cdiVersion', 'kind', 'devices']) && spec.cdiVersion === '0.6.0'
                && spec.kind === 'ploinky.local/gpu' && Array.isArray(spec.devices) && spec.devices.length === 1);
            const device = spec.devices[0];
            check(exactKeys(device, ['name', 'containerEdits']) && device.name === 'all'
                && exactKeys(device.containerEdits, ['deviceNodes']));
            const nodes = device.containerEdits.deviceNodes;
            check(Array.isArray(nodes) && nodes.length === 1 && exactKeys(nodes[0], ['path']) && nodes[0].path === renderNode);
            cdi = { device: `${spec.kind}=${device.name}`, deviceNodes: [{ path: renderNode }] };
        } finally { io.closeSync(fd); }
    }
    return { renderNodes: [node], cdi };
}

export const APPLE_RENDER_FACTS = `try { process.stdout.write(JSON.stringify((${readAppleRenderFacts.toString()})(require('node:fs'), process.argv[1], process.argv[2] === 'box'))); } catch { process.stderr.write('Apple render observation rejected'); process.exitCode = 1; }`;

export function assertAppleRenderFacts(facts, { renderNode, role }) {
    check(facts && Array.isArray(facts.renderNodes) && facts.renderNodes.length === 1, 'Apple render node set unavailable');
    const node = facts.renderNodes[0];
    check(node?.path === renderNode && node.character === true && node.symlink === false && node.read === true && node.write === true
        && Number.isSafeInteger(node.rdev) && node.rdev > 0 && Number.isSafeInteger(node.mode) && (node.mode & 0xf000) === 0x2000
        && [node.uid, node.gid].every(value => Number.isSafeInteger(value) && value >= 0), 'Apple render character/read-write proof unavailable');
    check(role === 'box' ? equal(facts.cdi, { device: 'ploinky.local/gpu=all', deviceNodes: [{ path: renderNode }] })
        : facts.cdi === null, 'Apple CDI mapping differs');
    return { path: node.path, character: node.character, symlink: node.symlink, read: node.read, write: node.write,
        rdev: node.rdev, mode: node.mode, uid: node.uid, gid: node.gid };
}

export async function observeAppleDevices({ engine, core, nested, box, agent, renderNode, abort }) {
    const read = async (name, args) => {
        const result = await engine(name, args, { journal: false, maxBytes: 65536, deadlineMs: 30000, abort });
        requireTransport(result);
        check(['timedOut', 'truncated', 'cancelled', 'settlementForced'].every(key => result[key] === false)
            && result.signal === null && result.errorCode === null, 'Apple device transport metadata unavailable');
        check(typeof result.stdout === 'string' && Buffer.byteLength(result.stdout) <= 65536, 'Apple device output exceeds bound');
        try { return JSON.parse(result.stdout); } catch { throw new Error('Apple device output invalid'); }
    };
    const identity = (observed, expected) => {
        check(observed?.running === true && expected?.running === true
            && /^[a-f0-9]{64}$/.test(observed.id) && /^[a-f0-9]{64}$/.test(observed.image)
            && typeof observed.created === 'string' && observed.created.length > 0 && Number.isSafeInteger(observed.pid) && observed.pid > 0
            && ['id', 'image', 'created', 'pid'].every(key => observed[key] === expected[key]), 'Apple container identity changed');
    };
    const inspect = async (role, expected) => {
        const raw = await read(`model-apple-${role}-devices`, [...(role === 'box' ? [] : nested), 'container', 'inspect', '--format', APPLE_DEVICE_INSPECT, expected.id]);
        const value = projectAppleDeviceInspect(raw);
        identity(value, expected);
        const devices = Array.isArray(expected.devices) ? expected.devices.map(device => ({ PathOnHost: device?.PathOnHost,
            PathInContainer: device?.PathInContainer, CgroupPermissions: device?.CgroupPermissions })) : null;
        check(equal(value.devices, devices), 'Apple inspected devices changed');
        assertAppleDeviceArguments(value, { role, renderNode });
        return value;
    };
    const beforeBox = await inspect('box', box); const beforeAgent = await inspect('agent', agent);
    const boxFacts = await read('model-apple-box-render', [...core, 'node', '-e', APPLE_RENDER_FACTS, renderNode, 'box']);
    const agentFacts = await read('model-apple-agent-render', [...nested, 'container', 'exec', agent.id, 'node', '-e', APPLE_RENDER_FACTS, renderNode, 'agent']);
    const boxNode = assertAppleRenderFacts(boxFacts, { role: 'box', renderNode });
    const agentNode = assertAppleRenderFacts(agentFacts, { role: 'agent', renderNode });
    check(boxNode.rdev === agentNode.rdev, 'Apple render device identity differs');
    const afterBox = await inspect('box', beforeBox); const afterAgent = await inspect('agent', beforeAgent);
    return { box: { ...afterBox, renderNodes: [boxNode], cdi: { device: 'ploinky.local/gpu=all', deviceNodes: [{ path: renderNode }] } },
        agent: { ...afterAgent, renderNodes: [agentNode], cdi: null } };
}
