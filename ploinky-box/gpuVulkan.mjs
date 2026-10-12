import fs from 'node:fs';
import path from 'node:path';

import { PloinkyBoxError } from './errors.mjs';
import { buildEngineProcessEnvironment, createProcessRunner } from './process.mjs';

export const RENDER_DEVICE_PATH_RE = /^\/dev\/dri\/renderD[1-9][0-9]{2,6}$/;
const MACHINE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const REPORT_MAX_BYTES = 64 * 1024;
const KERNEL_RE = /^[0-9A-Za-z._+-]{1,128}$/;

// Fixed guest-shell program: no host or workspace input is interpolated.
export const MACHINE_RENDER_QUERY = 'R=${PLOINKY_QUERY_ROOT:-}; echo "kernel $(uname -r)"; for n in "$R"/dev/dri/renderD*; do [ -e "$n" ] || [ -L "$n" ] || continue; b=${n##*/}; st=$(stat -c \'%f %t %T\' "$n" 2>/dev/null) || st=\'- - -\'; sd=$(cat "$R/sys/class/drm/$b/dev" 2>/dev/null) || sd=-; d=; [ -e "$R/sys/class/drm/$b/device" ] && d=$(readlink -f "$R/sys/class/drm/$b/device"); t=-; v=-; vr=-; if [ -n "$d" ]; then [ -e "$d/driver" ] && t=$(readlink -f "$d/driver") && t=${t##*/}; v=$(cat "$d/vendor" 2>/dev/null) || v=-; vr=$(cat "$d/mem_info_vram_total" 2>/dev/null) || vr=-; fi; rw=no; [ -r "$n" ] && [ -w "$n" ] && rw=rw; echo "node $b $st ${sd:--} ${t:--} ${v:--} ${vr:--} $rw"; if [ -n "$d" ]; then for c in "$d"/virtio*; do [ -d "$c" ] || continue; cd=-; [ -e "$c/driver" ] && cd=$(readlink -f "$c/driver") && cd=${cd##*/}; ci=$(cat "$c/device" 2>/dev/null) || ci=-; echo "child $b ${c##*/} ${cd:--} ${ci:--}"; done; fi; done; echo end';

function discoveryError(message) {
    return new PloinkyBoxError(message, { code: 'PLOINKY_BOX_GPU_DISCOVERY_FAILED' });
}

export function nvidiaAbsent({ platform = process.platform, fsApi = fs, root = '' } = {}) {
    if (platform === 'darwin') return true;
    if (platform !== 'linux') return false;
    try {
        try {
            fsApi.lstatSync(`${root}/proc/driver/nvidia/version`);
            return false;
        } catch (error) {
            if (error.code !== 'ENOENT') return false;
        }
        if (fsApi.readdirSync(`${root}/dev`).some((name) => /^nvidia/.test(name))) return false;
        for (const name of fsApi.readdirSync(`${root}/sys/bus/pci/devices`)) {
            if (fsApi.readFileSync(`${root}/sys/bus/pci/devices/${name}/vendor`, 'utf8').trim() === '0x10de') return false;
        }
        return true;
    } catch { return false; }
}

export function classifyRenderFacts(facts, { platform = process.platform } = {}) {
    const { name, rawMode, major, minor, sysDev, transport, vendor, rw, children = [] } = facts;
    const refuse = (reason) => ({ accepted: false, reason });
    const match = /^renderD([1-9][0-9]{2,6})$/.exec(name);
    const number = match ? Number(match[1]) : 0;
    if (number < 128) return refuse(`${name} is not a render node name`);
    if (![rawMode, major, minor].every(Number.isSafeInteger)) {
        return refuse(`${name} could not be inspected (stat failed)`);
    }
    if ((rawMode & 0o170000) !== 0o020000 || major !== 226 || minor !== number) {
        return refuse(`${name} is not a character device 226:${number}`);
    }
    if (sysDev !== `226:${number}`) return refuse(`${name} sysfs entry does not match its device number`);
    if (!transport || transport === '-') return refuse(`${name} has no bound driver`);
    const driver = transport === 'amdgpu' && vendor === '0x1002' ? 'amdgpu'
        : ['virtio-pci', 'virtio-mmio'].includes(transport)
            && children.filter((child) => child.driver === 'virtio_gpu' && child.device === '0x0010').length === 1
            ? 'virtio_gpu' : 'other';
    if (platform === 'linux' && driver === 'virtio_gpu') {
        return refuse(`${name}: virtio-gpu (virtio_gpu via ${transport}) is granted only inside a libkrun Podman machine`);
    }
    if (platform === 'linux' && driver !== 'amdgpu') {
        return refuse(`${name}: driver ${transport} is not supported; only AMD amdgpu render nodes are granted on Linux`);
    }
    if (platform !== 'linux' && (platform !== 'darwin' || driver !== 'virtio_gpu')) {
        return refuse(`${name}: driver ${transport} is not a virtio-gpu device`);
    }
    if ((rawMode & 0o006) !== 0o006) {
        const where = platform === 'darwin' ? ' inside the Podman machine (podman machine ssh <machine>)' : '';
        return refuse(`${name} is mode ${(rawMode & 0o7777).toString(8).padStart(4, '0')} (group-only); `
            + 'Ploinky grants only render nodes every local user can read and write. To allow it, add '
            + `\`SUBSYSTEM=="drm", KERNEL=="renderD*", DRIVERS=="${transport}", MODE="0666"\` `
            + `to /etc/udev/rules.d/70-ploinky-render.rules${where}, then run `
            + '`sudo udevadm control --reload && sudo udevadm trigger --subsystem-match=drm`. '
            + 'This lets every local user submit work to this GPU.');
    }
    if (rw !== true) return refuse(`${name} is not readable and writable by this user`);
    return { accepted: true, node: { ...facts, driver, path: `/dev/dri/${name}` } };
}

function readOptional(fsApi, target) {
    try { return fsApi.readFileSync(target, 'utf8').trim() || null; } catch { return null; }
}

function driverAt(fsApi, target) {
    try { return path.basename(fsApi.realpathSync(`${target}/driver`)); } catch { return null; }
}

// Linux and the machine report feed the same classifier. A failed stat is a
// node refusal, not a reason to discard another usable node.
export function collectLinuxRenderFacts(name, { fsApi = fs, root = '' } = {}) {
    const facts = { name, children: [] };
    const devicePath = `${root}/dev/dri/${name}`;
    try {
        const stat = fsApi.lstatSync(devicePath);
        const rdev = BigInt(stat.rdev);
        facts.rawMode = stat.mode;
        facts.major = Number(((rdev >> 8n) & 0xfffn) | ((rdev >> 32n) & ~0xfffn));
        facts.minor = Number((rdev & 0xffn) | ((rdev >> 12n) & ~0xffn));
    } catch { /* The classifier reports the missing stat. */ }
    facts.sysDev = readOptional(fsApi, `${root}/sys/class/drm/${name}/dev`);
    let device;
    try { device = fsApi.realpathSync(`${root}/sys/class/drm/${name}/device`); } catch { /* No bound driver. */ }
    facts.transport = device ? driverAt(fsApi, device) : null;
    facts.vendor = device ? readOptional(fsApi, `${device}/vendor`) : null;
    facts.vramBytes = device ? readOptional(fsApi, `${device}/mem_info_vram_total`) : null;
    if (device) {
        try {
            for (const child of fsApi.readdirSync(device).filter((entry) => /^virtio\d+$/.test(entry))) {
                facts.children.push({ name: child, driver: driverAt(fsApi, `${device}/${child}`),
                    device: readOptional(fsApi, `${device}/${child}/device`) });
            }
        } catch { /* Missing children cannot establish virtio-gpu. */ }
    }
    try {
        fsApi.accessSync(devicePath, fs.constants.R_OK | fs.constants.W_OK);
        facts.rw = true;
    } catch { facts.rw = false; }
    return facts;
}

export function parseMachineRenderReport(text) {
    const malformed = () => { throw discoveryError('machine query output is malformed'); };
    if (typeof text !== 'string' || Buffer.byteLength(text) > REPORT_MAX_BYTES) return malformed();
    const lines = text.replace(/\n$/, '').split('\n');
    const kernel = /^kernel ([0-9A-Za-z._+-]{1,128})$/.exec(lines.shift() || '')?.[1];
    if (!kernel || lines.pop() !== 'end') return malformed();
    const nodes = [];
    for (const line of lines) {
        const fields = line.split(' ');
        if (fields[0] === 'node') {
            if (fields.length !== 10 || nodes.length >= 16) return malformed();
            const [, name, mode, major, minor, sysDev, transport, vendor, vramBytes, rw] = fields;
            if (!/^renderD[0-9]+$/.test(name) || nodes.some((node) => node.name === name)
                || !/^(?:226:[0-9]+|-)$/.test(sysDev) || !/^(?:[A-Za-z0-9_.+-]+|-)$/.test(transport)
                || !/^(?:0x[0-9a-fA-F]{4}|-)$/.test(vendor) || !/^(?:[0-9]+|-)$/.test(vramBytes)
                || !['rw', 'no'].includes(rw)) return malformed();
            const statMissing = mode === '-' && major === '-' && minor === '-';
            if (!statMissing && (!/^[0-9a-fA-F]{4,6}$/.test(mode)
                || !/^[0-9a-fA-F]+$/.test(major) || !/^[0-9a-fA-F]+$/.test(minor))) return malformed();
            const stat = statMissing ? {} : { rawMode: parseInt(mode, 16), major: parseInt(major, 16), minor: parseInt(minor, 16) };
            if (Object.values(stat).some((value) => !Number.isSafeInteger(value))) return malformed();
            nodes.push({ name, ...stat, sysDev: sysDev === '-' ? null : sysDev,
                transport: transport === '-' ? null : transport, vendor: vendor === '-' ? null : vendor,
                vramBytes: vramBytes === '-' ? null : vramBytes, rw: rw === 'rw', children: [] });
        } else if (fields[0] === 'child') {
            const [, name, child, driver, device] = fields;
            const node = nodes.at(-1);
            if (fields.length !== 5 || !node || node.name !== name || !/^virtio\d+$/.test(child)
                || !/^(?:[A-Za-z0-9_.+-]+|-)$/.test(driver) || !/^(?:0x[0-9a-fA-F]{4}|-)$/.test(device)
                || node.children.some((entry) => entry.name === child)) return malformed();
            node.children.push({ name: child, driver: driver === '-' ? null : driver, device: device === '-' ? null : device });
        } else return malformed();
    }
    return { kernel, nodes };
}

function selectedRunner({ engineRunner, env = process.env }) {
    return engineRunner ?? createProcessRunner({ env: buildEngineProcessEnvironment(env) });
}

export function queryMachineRenderNodes({ machine, engineRunner, env = process.env }) {
    if (!MACHINE_NAME_RE.test(machine)) throw discoveryError('no single default Podman machine connection');
    const result = selectedRunner({ engineRunner, env }).query('podman',
        ['machine', 'ssh', machine, MACHINE_RENDER_QUERY], { timeoutMs: 10_000 });
    if (!result?.ok || Buffer.byteLength(String(result.stdout || '')) > REPORT_MAX_BYTES) {
        throw discoveryError('machine query failed or timed out');
    }
    return parseMachineRenderReport(result.stdout);
}

function machineFacts(options) {
    const { env = process.env } = options;
    if (env.CONTAINER_HOST || env.PODMAN_HOST) {
        throw discoveryError('a remote Podman engine is selected; the render node cannot be verified');
    }
    const engineRunner = selectedRunner(options);
    const query = (args) => {
        const result = engineRunner.query('podman', args, { timeoutMs: 10_000 });
        try {
            if (!result?.ok || Buffer.byteLength(String(result.stdout || '')) > REPORT_MAX_BYTES) return null;
            return JSON.parse(result.stdout);
        } catch { return null; }
    };
    const connections = query(['system', 'connection', 'list', '--format', 'json']);
    const defaults = Array.isArray(connections) ? connections.filter((entry) => entry?.Default === true) : [];
    const selected = defaults.length === 1 ? defaults[0] : null;
    if (!selected || selected.IsMachine !== true || !MACHINE_NAME_RE.test(selected.Name)) {
        throw discoveryError('no single default Podman machine connection');
    }
    const machine = selected.Name;
    const machines = query(['machine', 'list', '--format', 'json']);
    const matches = Array.isArray(machines) ? machines.filter((entry) => entry?.Name === machine) : [];
    if (matches.length !== 1) throw discoveryError('no single default Podman machine connection');
    if (matches[0].VMType !== 'libkrun') {
        throw discoveryError(`the selected Podman machine ${machine} uses ${matches[0].VMType}; `
            + 'Apple GPU access needs a libkrun machine: create one with '
            + `\`podman machine init --provider libkrun ${machine}\` and select it with `
            + `\`podman system connection default ${machine}\``);
    }
    if (matches[0].Running !== true) throw discoveryError(`machine ${machine} is not running`);
    const records = query(['machine', 'inspect', machine]);
    if (!Array.isArray(records) || records.length !== 1 || records[0]?.Name !== machine) {
        throw discoveryError('no single default Podman machine connection');
    }
    if (records[0].Rootful !== false) throw discoveryError(`machine ${machine} is rootful`);
    return { ...queryMachineRenderNodes({ machine, engineRunner, env }), machine };
}

export function discoverVulkanRenderNode(options = {}) {
    const { platform = process.platform, fsApi = fs, root = '' } = options;
    let nodes;
    let driverVersion;
    if (platform === 'darwin') {
        const report = machineFacts(options);
        nodes = report.nodes;
        driverVersion = `virtio_gpu ${report.machine} ${report.kernel}`;
    } else if (platform === 'linux') {
        let names;
        try { names = fsApi.readdirSync(`${root}/dev/dri`).filter((name) => /^renderD/.test(name)); }
        catch { names = []; }
        nodes = names.map((name) => collectLinuxRenderFacts(name, { fsApi, root }));
    } else throw discoveryError('no /dev/dri render node');
    const accepted = [];
    const reasons = [];
    for (const facts of nodes) {
        const result = classifyRenderFacts(facts, { platform });
        if (!result.accepted) reasons.push(result.reason);
        else if (platform === 'linux' && !/^[0-9]+$/.test(result.node.vramBytes ?? '')) {
            reasons.push(`${facts.name} VRAM size is unreadable`);
        } else accepted.push(result.node);
    }
    if (!accepted.length) throw discoveryError(reasons.join('; ') || 'no /dev/dri render node');
    if (platform === 'linux') {
        const kernel = readOptional(fsApi, `${root}/proc/sys/kernel/osrelease`);
        if (!kernel || !KERNEL_RE.test(kernel)) throw discoveryError('kernel release unreadable');
        driverVersion = `amdgpu ${kernel}`;
    }
    accepted.sort((a, b) => {
        if (platform === 'linux' && BigInt(a.vramBytes) !== BigInt(b.vramBytes)) {
            return BigInt(a.vramBytes) > BigInt(b.vramBytes) ? -1 : 1;
        }
        return a.minor - b.minor;
    });
    const node = accepted[0];
    return Object.freeze({ vendor: 'vulkan', driver: node.driver, driverVersion,
        devices: Object.freeze([Object.freeze({ path: node.path, major: 226, minor: node.minor })]),
        libraries: Object.freeze([]), tools: Object.freeze([]) });
}

export function revalidateRenderNode(devicePath, options = {}) {
    const { platform = process.platform } = options;
    if (!RENDER_DEVICE_PATH_RE.test(devicePath)) throw discoveryError('not a render node path');
    const name = path.posix.basename(devicePath);
    const facts = platform === 'darwin' ? machineFacts(options).nodes.find((node) => node.name === name)
        : platform === 'linux' ? collectLinuxRenderFacts(name, options) : null;
    if (!facts) throw discoveryError(`${name} is missing`);
    const result = classifyRenderFacts(facts, { platform });
    if (!result.accepted) throw discoveryError(result.reason);
}
