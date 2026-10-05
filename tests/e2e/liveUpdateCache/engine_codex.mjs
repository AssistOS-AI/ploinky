import { createHash } from 'node:crypto';
import { AcceptanceError, need, absolute } from './manifest_codex.mjs';

// Exact-ID engine reads for the live acceptance run. Templates select only named nonsecret fields; the full
// inspection document, `Config.Env` and registry/auth data are never requested.
const hex64 = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
export const sha256Hex = value => createHash('sha256').update(value).digest('hex');
const canonical = value => {
    if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
    if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
    return JSON.stringify(value);
};
export const canonicalJson = canonical;

function keyedLines(bytes, keys, code) {
    need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1024 * 1024, code);
    let text; try { text = new TextDecoder('utf-8', { fatal: true }).decode(bytes); } catch { throw new AcceptanceError(code); }
    const lines = text.replace(/\n$/, '').split('\n'), result = {};
    need(lines.length === keys.length, code);
    lines.forEach((line, index) => {
        const separator = line.indexOf('=');
        need(separator > 0 && line.slice(0, separator) === keys[index], code);
        try { result[keys[index]] = JSON.parse(line.slice(separator + 1)); } catch { throw new AcceptanceError(code); }
    });
    return result;
}
const template = keys => keys.map(([key, expression]) => `${key}={{json ${expression}}}`).join('\n');

const BOX_FIELDS = [['id', '.Id'], ['name', '.Name'], ['image', '.Image'], ['running', '.State.Running'], ['status', '.State.Status'], ['startedAt', '.State.StartedAt'],
    ['privileged', '.HostConfig.Privileged'], ['init', '.HostConfig.Init'], ['capAdd', '.HostConfig.CapAdd'], ['securityOpt', '.HostConfig.SecurityOpt'],
    ['devices', '.HostConfig.Devices'], ['networkMode', '.HostConfig.NetworkMode'], ['ports', '.HostConfig.PortBindings'], ['mounts', '.Mounts'],
    ['labels', '.Config.Labels'], ['workdir', '.Config.WorkingDir'], ['user', '.Config.User']];
export const BOX_INSPECT_FORMAT = template(BOX_FIELDS);
export const boxInspectArgs = (engineBin, boxId) => { need(absolute(engineBin) && hex64(boxId), 'engine-argument'); return [engineBin, 'container', 'inspect', '--format', BOX_INSPECT_FORMAT, boxId]; };

// The safe subset of a Box inspection the Marketplace receipt helper reads (identity, start, workspace bind, Router publication).
// It never selects Config.Env, labels or any other field.
export const RECEIPT_INSPECT_FORMAT = '{"Id":{{json .Id}},"State":{"Running":{{json .State.Running}},"StartedAt":{{json .State.StartedAt}}},"Mounts":{{json .Mounts}},'
    + '"NetworkSettings":{"Ports":{{json .NetworkSettings.Ports}}},"HostConfig":{"PortBindings":{{json .HostConfig.PortBindings}}}}';
export const receiptInspectArgs = (engineBin, container) => { need(absolute(engineBin) && typeof container === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,254}$/.test(container), 'engine-argument');
    return [engineBin, 'container', 'inspect', '--format', RECEIPT_INSPECT_FORMAT, container]; };
export function parseReceiptInspect(bytes) {
    need(Buffer.isBuffer(bytes) && bytes.length > 0 && bytes.length <= 1024 * 1024, 'receipt-inspect-shape');
    let value; try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new AcceptanceError('receipt-inspect-shape'); }
    need(value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join() === 'HostConfig,Id,Mounts,NetworkSettings,State', 'receipt-inspect-shape');
    return value;
}

const LABELS = Object.freeze({ gpuGrant: 'io.assistos.ploinky-box.gpu-grant', routerHostPort: 'io.assistos.ploinky-box.router-host-port',
    mediaHostPort: 'io.assistos.ploinky-box.media-host-port', routerBindAddress: 'io.assistos.ploinky-box.router-bind-address',
    agentLibFingerprint: 'io.assistos.ploinky-box.agentlib-fingerprint', imageRef: 'io.assistos.ploinky-box.image-ref' });
export const BOX_LABEL_KEYS = LABELS;

export function parsePortBindings(ports) {
    need(ports && typeof ports === 'object' && !Array.isArray(ports), 'box-publications-shape');
    const rows = [];
    for (const [spec, bindings] of Object.entries(ports)) {
        const match = /^(\d{1,5})\/(tcp|udp)$/.exec(spec);
        need(match && Array.isArray(bindings) && bindings.length <= 8, 'box-publications-shape');
        for (const binding of bindings) {
            need(binding && typeof binding.HostIp === 'string' && /^\d{1,5}$/.test(String(binding.HostPort)), 'box-publications-shape');
            rows.push({ protocol: match[2], hostIP: binding.HostIp === '' ? '0.0.0.0' : binding.HostIp, hostPort: Number(binding.HostPort), containerPort: Number(match[1]) });
        }
    }
    return rows.sort((a, b) => a.protocol === b.protocol ? a.containerPort - b.containerPort : a.protocol.localeCompare(b.protocol));
}

export function parseBoxInspect(bytes) {
    const raw = keyedLines(bytes, BOX_FIELDS.map(([key]) => key), 'box-inspect-shape');
    need(hex64(raw.id) && typeof raw.name === 'string' && /^\/?[^\s/][^\s]{0,254}$/.test(raw.name) && typeof raw.image === 'string' && /^(?:sha256:)?[a-f0-9]{64}$/.test(raw.image) && typeof raw.running === 'boolean'
        && typeof raw.status === 'string' && typeof raw.startedAt === 'string' && typeof raw.privileged === 'boolean'
        && typeof raw.networkMode === 'string' && raw.labels && typeof raw.labels === 'object' && !Array.isArray(raw.labels)
        && Array.isArray(raw.mounts ?? []) && ['boolean', 'object'].includes(typeof raw.init), 'box-inspect-shape');
    const labels = {};
    for (const [name, key] of Object.entries(LABELS)) if (typeof raw.labels[key] === 'string' && raw.labels[key].length <= 256) labels[name] = raw.labels[key];
    const mounts = (raw.mounts ?? []).map(mount => { need(mount && typeof mount.Source === 'string' && typeof mount.Destination === 'string' && typeof mount.RW === 'boolean', 'box-mounts-shape');
        return { source: mount.Source, destination: mount.Destination, readOnly: mount.RW === false }; }).sort((a, b) => a.destination.localeCompare(b.destination));
    const list = value => { need(value === null || (Array.isArray(value) && value.length <= 256 && value.every(item => typeof item === 'string' || (item && typeof item === 'object'))), 'box-inspect-shape'); return value ?? []; };
    // Podman reports the container name with a leading slash; the manifest and SMOKE_PLOINKY_BOX_CONTAINER carry it without.
    return Object.freeze({ id: raw.id, name: raw.name.replace(/^\//, ''), imageId: raw.image.replace(/^sha256:/, ''), gpuGrantLabelPresent: Object.hasOwn(raw.labels, LABELS.gpuGrant), running: raw.running, status: raw.status, startedAt: raw.startedAt,
        privileged: raw.privileged, init: raw.init === true, capAdd: list(raw.capAdd), securityOpt: list(raw.securityOpt), devices: list(raw.devices),
        networkMode: raw.networkMode, publications: parsePortBindings(raw.ports ?? {}), mounts, labels, workdir: raw.workdir, user: raw.user });
}

const ENGINE_FIELDS = [['rootless', '.Host.Security.Rootless'], ['version', '.Version.Version'], ['graphRoot', '.Store.GraphRoot'], ['runRoot', '.Store.RunRoot']];
export const ENGINE_INFO_FORMAT = template(ENGINE_FIELDS);
export const engineInfoArgs = engineBin => { need(absolute(engineBin), 'engine-argument'); return [engineBin, 'info', '--format', ENGINE_INFO_FORMAT]; };
export function parseEngineInfo(bytes) {
    const raw = keyedLines(bytes, ENGINE_FIELDS.map(([key]) => key), 'engine-info-shape');
    need(typeof raw.rootless === 'boolean' && ['version', 'graphRoot', 'runRoot'].every(key => typeof raw[key] === 'string' && raw[key].length > 0 && raw[key].length <= 4096), 'engine-info-shape');
    return Object.freeze(raw);
}
// The manifest generator must use this exact derivation for engine.identity.
export function engineIdentityOf({ info, path, uid }) {
    need(info && typeof path === 'string' && Number.isSafeInteger(uid), 'engine-identity-input');
    return sha256Hex(canonical({ kind: 'podman', path, uid, version: info.version, graphRoot: info.graphRoot, runRoot: info.runRoot, rootless: info.rootless }));
}
// The Box label is the existing fingerprint of the exact GPU wiring; absence is its own stable value.
// A present gpu-grant label must be exactly 64 lowercase hex characters; gpuWiringIdentityOf alone would map any other value to the absent sentinel.
export const gpuGrantLabelValid = box => !box.gpuGrantLabelPresent || hex64(box.labels?.gpuGrant);
export const gpuWiringIdentityOf = labels => hex64(labels?.gpuGrant) ? labels.gpuGrant : sha256Hex('ploinky-box-gpu-wiring:absent');
export const publicationsId = rows => `pub:${sha256Hex(canonical([...rows].sort((a, b) => canonical(a).localeCompare(canonical(b)))))}`;
export const mountsId = rows => `mnt:${sha256Hex(canonical([...rows].sort((a, b) => canonical(a).localeCompare(canonical(b)))))}`;

// Nested engine reads through the exact Box ID. The format never selects Config.Env.
const READER_FIELDS = [['id', '.Id'], ['name', '.Name'], ['running', '.State.Running'], ['startedAt', '.State.StartedAt'], ['image', '.Image'], ['instanceId', `(index .Config.Labels "io.assistos.ploinky.instance-id")`],
    ['enableGeneration', `(index .Config.Labels "io.assistos.ploinky.enable-generation")`], ['mounts', '.Mounts']];
export const READER_INSPECT_FORMAT = template(READER_FIELDS);
export function nestedInspectArgs(engineBin, boxId, containerId) {
    need(absolute(engineBin) && hex64(boxId) && hex64(containerId), 'engine-argument');
    return [engineBin, 'exec', boxId, 'podman', 'container', 'inspect', '--format', READER_INSPECT_FORMAT, containerId];
}
export function parseReaderInspect(bytes, containerId) {
    const raw = keyedLines(bytes, READER_FIELDS.map(([key]) => key), 'reader-inspect-shape');
    need(raw.id === containerId && typeof raw.running === 'boolean' && typeof raw.name === 'string' && typeof raw.image === 'string'
        && typeof raw.instanceId === 'string' && typeof raw.enableGeneration === 'string' && Array.isArray(raw.mounts)
        && typeof raw.startedAt === 'string' && raw.startedAt.length > 0 && raw.startedAt.length <= 64 && Number.isFinite(Date.parse(raw.startedAt)), 'reader-inspect-shape');
    const mounts = raw.mounts.map(mount => { need(mount && typeof mount.Source === 'string' && typeof mount.Destination === 'string' && typeof mount.RW === 'boolean', 'reader-inspect-shape');
        return { source: mount.Source, destination: mount.Destination, readOnly: mount.RW === false }; });
    return Object.freeze({ id: raw.id, name: raw.name.replace(/^\//, ''), running: raw.running, startedAt: raw.startedAt, imageId: raw.image.replace(/^sha256:/, ''),
        instanceId: raw.instanceId, enableGeneration: raw.enableGeneration, mounts });
}

// The in-Box read invocation mirrors the product's own exec form: nested workspace path, host ports, nested user.
export function boxExecArgs({ engineBin, boxId, workspace, routerHostPort, mediaHostPort, interactive = false, argv }) {
    need(absolute(engineBin) && hex64(boxId) && absolute(workspace) && Number.isSafeInteger(routerHostPort) && routerHostPort > 0 && routerHostPort < 65536
        && Number.isSafeInteger(mediaHostPort) && mediaHostPort > 0 && mediaHostPort < 65536 && Array.isArray(argv) && argv.length > 0
        && argv.every(value => typeof value === 'string' && !value.includes('\0')), 'engine-argument');
    return [engineBin, 'container', 'exec', ...(interactive ? ['--interactive'] : []), '--env', `PLOINKY_ROUTER_HOST_PORT=${routerHostPort}`,
        '--env', `PLOINKY_MEDIA_HOST_PORT=${mediaHostPort}`, '--user', 'podman', '--workdir', workspace, boxId, ...argv];
}
