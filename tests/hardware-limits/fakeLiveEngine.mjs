// File-backed fake engine, candidate and SSH host for the offline live-runner
// tests. No real engine, SSH, GPU or network is touched: the "remote host" is
// a local directory and every command is interpreted here. The world state
// lives in one JSON file, so a fresh process resumes against the same world.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { fixtureContainerName, FIXTURE_REPOSITORY } from './liveFixture.mjs';

// Exit status of a child runner that died at its named crash point.
export const CRASH_EXIT = 99;
const hex = value => crypto.createHash('sha256').update(String(value)).digest('hex');
export const ok = (stdout = '', extra = {}) => ({ status: 0, signal: null, stdout, stderr: '', timedOut: false, truncated: false, cancelled: false, errorCode: null, settlementForced: false, ...extra });
const failed = (stderr, status = 1) => ok('', { status, stderr });

// --- Strict Go-template evaluation -----------------------------------------
// Real Podman renders `--format` with Go's text/template over its Go structs,
// so a field is addressed by its Go struct name (`.ID`), not by the JSON key
// of the same document (`.Id`). The fake evaluates the same way: only the
// field paths listed here exist, and any other path fails with exit 125 and
// Podman's message shape, `can't evaluate field X in type interface {}`. The
// lists are deliberately the fields the harness reads; a template that reaches
// for another field fails in unit tests until the field is added here on
// purpose, after it is proved on a real engine.
const INSPECT_FIELDS = Object.freeze({
    ID: true, Created: true, Image: true, ImageName: true, Name: true, Mounts: true,
    Config: { Labels: true },
    State: { Running: true, Pid: true, StartedAt: true, ConmonPid: true },
    HostConfig: { Memory: true, MemorySwap: true, NanoCpus: true, CpuQuota: true, CpuPeriod: true, PidsLimit: true },
});
const PS_FIELDS = Object.freeze({ ID: true, Names: true, Image: true, ImageID: true, Labels: true, State: true, Status: true, Mounts: true, Created: true, CreatedAt: true, Pid: true });
// `info` is only ever rendered whole.
const TEMPLATE_SCHEMAS = Object.freeze({ inspect: INSPECT_FIELDS, ps: PS_FIELDS, info: null });
const templateFailure = message => failed(`Error: ${message}`, 125);
const goString = value => (typeof value === 'string' ? value : value === undefined || value === null ? '' : typeof value === 'object' ? JSON.stringify(value) : String(value));

// Render `template` for `kind` over `model` (undefined: validate only). Returns
// the rendered text, or a failed engine result for an unsupported template.
export function evaluateTemplate(template, kind, model) {
    const schema = TEMPLATE_SCHEMAS[kind];
    if (typeof template !== 'string') return templateFailure('template: no format given');
    let output = ''; let last = 0;
    for (const match of template.matchAll(/\{\{(.*?)\}\}/g)) {
        output += template.slice(last, match.index); last = match.index + match[0].length;
        const words = match[1].trim().split(/\s+/);
        const json = words[0] === 'json';
        const expression = json ? words.slice(1) : words;
        const column = match.index + match[0].indexOf(expression[0] ?? '');
        if (words[0] && !json && !expression[0].startsWith('.')) return templateFailure(`template: ${kind}:1: function "${words[0]}" not defined`);
        if (expression.length !== 1) return templateFailure(`template: ${kind}:1:${match.index + 2}: unexpected number of operands in {{${match[1]}}}`);
        const reference = expression[0];
        let value = model; let node = schema;
        if (reference !== '.') {
            const names = reference.slice(1).split('.');
            if (!/^\.[A-Za-z]+(\.[A-Za-z]+)*$/.test(reference)) return templateFailure(`template: ${kind}:1:${column}: bad character in ${reference}`);
            for (const name of names) {
                if (!node || typeof node !== 'object' || !Object.hasOwn(node, name)) {
                    return templateFailure(`template: ${kind}:1:${column}: executing "${kind}" at <${reference}>: can't evaluate field ${name} in type interface {}`);
                }
                node = node[name]; value = value === undefined ? undefined : value?.[name];
            }
        } else if (node !== null) return templateFailure(`template: ${kind}:1:${column}: executing "${kind}" at <.>: this command does not render the whole document`);
        output += json ? (value === undefined ? 'null' : JSON.stringify(value)) : goString(value);
    }
    return output + template.slice(last);
}

// The engine's reply to an unsupported `--format` template in a command line,
// or null when the command has none or the template is supported. For fakes
// that interpret commands themselves.
export function unsupportedFormat(args) {
    const kind = args[0] === 'info' ? 'info' : args.includes('ps') ? 'ps' : args.includes('inspect') ? 'inspect' : null;
    const at = args.indexOf('--format');
    if (!kind || at < 0) return null;
    const rendered = evaluateTemplate(args[at + 1], kind);
    return typeof rendered === 'string' ? null : rendered;
}
const formatOf = args => { const at = args.indexOf('--format'); return at < 0 ? args.find(value => value.startsWith('--format='))?.slice(9) : args[at + 1]; };
const filtersOf = args => args.flatMap((value, at) => (value === '--filter' ? [args[at + 1]] : value.startsWith('--filter=') ? [value.slice(9)] : []));
const inspectModel = record => ({
    ID: record.id, Created: record.created, Image: record.image, ImageName: record.imageName ?? '', Name: record.name ?? '', Mounts: record.mounts ?? [],
    Config: { Labels: record.labels ?? null },
    State: { Running: record.running ?? false, Pid: record.pid ?? 1, StartedAt: record.startedAt ?? 'x', ConmonPid: record.conmonPid ?? 2 },
    HostConfig: { Memory: record.memory ?? 0, MemorySwap: record.memorySwap ?? 0, NanoCpus: record.nanoCpus ?? 0, CpuQuota: record.cpuQuota ?? 0, CpuPeriod: record.cpuPeriod ?? 0, PidsLimit: record.pidsLimit ?? 0 },
});
const psModel = record => ({
    ID: record.id, Names: record.name ?? record.id.slice(0, 12), Image: record.imageName ?? record.image, ImageID: record.image, Labels: record.labels ?? {},
    State: record.running === false ? 'exited' : 'running', Status: record.running === false ? 'Exited' : 'Up', Mounts: (record.mounts ?? []).map(mount => mount.Destination), Created: record.created, CreatedAt: record.created, Pid: record.pid ?? 1,
});
// Podman's ps filters: `label=K[=V]` is exact, `name=` and `id=` match by regular expression.
function psMatches(record, filters) {
    for (const filter of filters) {
        const at = filter.indexOf('='); const key = filter.slice(0, at); const value = filter.slice(at + 1);
        if (at < 0 || !['label', 'name', 'id'].includes(key)) return null;
        if (key === 'label') {
            const split = value.indexOf('=');
            const [name, expected] = split < 0 ? [value, undefined] : [value.slice(0, split), value.slice(split + 1)];
            const labels = record.labels ?? {};
            if (!Object.hasOwn(labels, name) || (expected !== undefined && labels[name] !== expected)) return false;
        } else if (key === 'name' ? !new RegExp(value).test(psModel(record).Names) : !record.id.startsWith(value)) return false;
    }
    return true;
}

// The `info --format {{json .}}` reply of the fake engine service: the given
// host facts over stable defaults for every fact the runner's identity uses.
export function fakeEngineInfo(host = {}) {
    return {
        host: { kernel: '6.12.0-fake', serviceIsRemote: false, remoteSocket: { path: '/run/fake/podman/podman.sock', exists: true }, memFree: 1, uptime: 'volatile', ...host },
        store: { graphRoot: '/var/lib/fake/storage', runRoot: '/run/fake/storage', imageStore: { number: 3 } },
        version: { Version: '6.0.1', APIVersion: '6.0.1' },
    };
}
// The fake's default remote connections reply when its service is remote.
export const FAKE_CONNECTIONS = Object.freeze([{ Name: 'fake-machine', URI: 'ssh://core@127.0.0.1:50123/run/user/501/podman/podman.sock', Identity: '/fake/key', Default: true }]);

export function createFakeWorld({ statePath, node, engine, host, unrelated = [], faults = {} }) {
    const load = () => (fs.existsSync(statePath) ? JSON.parse(fs.readFileSync(statePath, 'utf8'))
        : { boxes: {}, agents: {}, calls: [], destroyCalls: 0, startCalls: 0, unshare: [], unrelated, counter: 0 });
    const save = state => fs.writeFileSync(statePath, JSON.stringify(state));
    const kindOf = (binary, args) => {
        if (binary === node) return args.includes('destroy') ? 'destroy' : args.includes('start') ? 'start' : 'node';
        if (args[0] === 'info') return 'info';
        if (args[0] === 'system' && args[1] === 'connection') return 'connections';
        if (args[0] === 'unshare') return 'unshare';
        if (args[0] === 'container' && args[1] === 'ps') return filtersOf(args).length ? 'ps-filter' : 'ps';
        if (args[0] === 'container' && args[1] === 'inspect') return 'inspect';
        if (args[0] === 'container' && args[1] === 'exec' && args.includes('inspect')) return 'agent-inspect';
        return 'exec';
    };
    const render = (args, kind, model) => {
        const rendered = evaluateTemplate(formatOf(args), kind, model);
        return typeof rendered === 'string' ? ok(rendered) : rendered;
    };
    return async function provider(binary, args, options = {}) {
        const state = load();
        const kind = kindOf(binary, args);
        state.calls.push({ binary, args, kind, cwd: options.cwd, gate: options.env?.PLOINKY_BOX_HARDWARE_LIMITS ?? null, boxImage: options.env?.PLOINKY_BOX_IMAGE ?? null, path: options.env?.PATH ?? null });
        const fault = faults[kind];
        const index = state.calls.filter(call => call.kind === kind).length;
        save(state);
        if (fault && (fault.at === undefined || fault.at === index)) {
            if (fault.result) return fault.result;
        }
        try {
            switch (kind) {
            case 'info': return render(args, 'info', fault?.info || fakeEngineInfo(fault?.host || host));
            case 'connections': return ok(JSON.stringify(fault?.connections || FAKE_CONNECTIONS));
            case 'ps': case 'ps-filter': {
                const filters = filtersOf(args);
                const rows = [];
                for (const record of [...Object.values(state.boxes), ...state.unrelated]) {
                    const matches = psMatches(record, filters);
                    if (matches === null) return failed('Error: invalid filter', 125);
                    if (!matches) continue;
                    const rendered = evaluateTemplate(formatOf(args), 'ps', psModel(record));
                    if (typeof rendered !== 'string') return rendered;
                    rows.push(rendered);
                }
                return ok(rows.map(row => `${row}\n`).join(''));
            }
            case 'inspect': {
                const id = args.at(-1);
                const box = state.boxes[id] || state.unrelated.find(value => value.id === id);
                return box ? render(args, 'inspect', inspectModel(box)) : failed('no such container');
            }
            case 'agent-inspect': {
                const name = args.at(-1);
                const agent = state.agents[name];
                if (!agent || fault?.drop === name) return failed('no such container');
                return render(args, 'inspect', inspectModel({ ...agent, ...(fault?.patch || {}) }));
            }
            case 'start': {
                const workspace = options.cwd;
                const identity = buildWorkspaceIdentity(workspace);
                state.startCalls += 1;
                if (!fault?.noBox && !Object.values(state.boxes).some(box => box.labels[BOX_LABELS.pathHash] === identity.pathHash)) {
                    const id = hex(`box-${workspace}-${++state.counter}`);
                    state.boxes[id] = {
                        id, name: identity.instance, created: `2026-10-02T00:00:0${state.counter % 10}Z`, image: hex('box-image'), running: true,
                        labels: { [BOX_LABELS.pathHash]: identity.pathHash, [BOX_LABELS.role]: 'box', [BOX_LABELS.hardwareLimits]: hex('gate'), [BOX_LABELS.imageRef]: options.env?.PLOINKY_BOX_IMAGE },
                        mounts: [{ Source: workspace, Destination: workspace }],
                    };
                    const repository = path.join(workspace, '.ploinky', 'repos', FIXTURE_REPOSITORY);
                    for (const name of fs.existsSync(repository) ? fs.readdirSync(repository).sort() : []) {
                        const manifest = JSON.parse(fs.readFileSync(path.join(repository, name, 'manifest.json'), 'utf8'));
                        const container = fixtureContainerName(workspace, name);
                        state.agents[container] = { id: hex(`agent-${container}-${state.counter}`), created: '2026-10-02T00:01:00Z', image: hex(manifest.container), name: `/${container}`, imageName: manifest.container, running: true, labels: {}, mounts: [] };
                    }
                }
                // Production saves the gate and initializes the hardware store
                // under the host home, outside the workspace.
                const records = path.join(options.env.HOME, '.ploinky-box', 'hardware-limits');
                fs.mkdirSync(path.join(records, identity.instance, 'store'), { recursive: true, mode: 0o700 });
                fs.writeFileSync(path.join(records, identity.instance, 'store', 'identity.json'), '{}');
                const record = path.join(records, `${identity.instance}.json`);
                fs.writeFileSync(`${record}.tmp`, JSON.stringify({ enabled: true, savedAt: state.startCalls }));
                fs.renameSync(`${record}.tmp`, record);
                save(state);
                return fault?.status ? failed('start failed', fault.status) : ok('');
            }
            case 'destroy': {
                const identity = buildWorkspaceIdentity(options.cwd);
                state.destroyCalls += 1;
                for (const [id, box] of Object.entries(state.boxes)) if (box.labels[BOX_LABELS.pathHash] === identity.pathHash) delete state.boxes[id];
                state.agents = {};
                save(state);
                return ok('');
            }
            case 'unshare': {
                const target = args.at(-1);
                state.unshare.push(args);
                const restore = target => {
                    if (!fs.lstatSync(target).isDirectory()) return;
                    fs.chmodSync(target, 0o700);
                    for (const name of fs.readdirSync(target)) restore(path.join(target, name));
                };
                restore(target);
                fs.rmSync(target, { recursive: true, force: false });
                save(state);
                return ok('');
            }
            default: return ok('{}');
            }
        } catch (error) { return failed(String(error.message)); }
    };
}

export function worldState(statePath) { return JSON.parse(fs.readFileSync(statePath, 'utf8')); }

// A fake SSH host rooted in a local directory. Remote words are interpreted
// exactly; anything else fails. `dispatch` runs the remote runner in-process.
export function createFakeSsh({ sshBinary, address, hostname, faults = {}, dispatch }) {
    const calls = [];
    const statLine = target => { const stat = fs.lstatSync(target); return `${stat.dev}:${stat.ino}:${stat.uid}:${(stat.mode & 0o777).toString(8)}`; };
    async function provider(binary, args, options = {}) {
        if (binary !== sshBinary) throw new Error('fake SSH called with another binary');
        const at = args.indexOf(address);
        const words = args.slice(at + 1);
        calls.push({ args, words, stdinPath: options.stdinPath || null });
        const fault = faults[words[0]];
        const count = calls.filter(call => call.words[0] === words[0]).length;
        if (fault && (fault.at === undefined || fault.at === count) && fault.result) return fault.result;
        try {
            switch (words[0]) {
            case 'uname': return ok(`${fault?.hostname || hostname}\n`);
            case 'mkdir': {
                const recursive = words.includes('-p');
                const mode = parseInt(words[words.indexOf('-m') + 1], 8);
                for (const target of words.slice(words.indexOf('--') + 1)) {
                    if (!recursive && fs.existsSync(target)) return failed(`mkdir: cannot create directory '${target}': File exists`);
                    fs.mkdirSync(target, { recursive, mode }); fs.chmodSync(target, mode);
                }
                return ok('');
            }
            case 'dd': {
                const destination = words[1].slice(3);
                if (fs.existsSync(destination)) return failed('dd: failed to open: File exists');
                fs.copyFileSync(options.stdinPath, destination); fs.chmodSync(destination, 0o644);
                return ok('');
            }
            case 'chmod': fs.chmodSync(words.at(-1), parseInt(words[1], 8)); return ok('');
            case 'stat': {
                const target = words.at(-1);
                if (!fs.existsSync(target)) return failed(`stat: cannot statx '${target}': No such file or directory`);
                return ok(`${statLine(target)}\n`);
            }
            case 'cat': {
                const target = words.at(-1);
                if (!fs.existsSync(target)) return failed('cat: No such file or directory');
                const text = fs.readFileSync(target, 'utf8');
                return ok(fault?.tamper ? fault.tamper(text, target) : text);
            }
            case 'sha256sum': {
                const files = words.slice(words.indexOf('--') + 1);
                if (files.some(file => !fs.existsSync(file))) return failed('sha256sum: No such file or directory');
                return ok(files.map(file => `${fault?.wrong ? 'f'.repeat(64) : crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')}  ${file}`).join('\n') + '\n');
            }
            case 'tar': {
                const result = spawnSync('tar', ['-x', '-f', words[words.indexOf('-f') + 1], '-C', words[words.indexOf('-C') + 1]], { encoding: 'utf8' });
                return result.status === 0 ? ok('') : failed(result.stderr);
            }
            case 'rm': fs.rmSync(words.at(-1), { recursive: true, force: true }); return ok('');
            default:
                if (dispatch && words[1]?.endsWith('/tests/hardware-limits/verify.mjs')) return dispatch(words);
                return failed(`unexpected remote command ${words[0]}`);
            }
        } catch (error) { return failed(String(error.message)); }
    }
    return { provider, calls };
}
