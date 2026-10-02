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
        if (args[0] === 'container' && args[1] === 'ps') return 'ps';
        if (args[0] === 'container' && args[1] === 'inspect') return 'inspect';
        if (args[0] === 'container' && args[1] === 'exec' && args.includes('inspect')) return 'agent-inspect';
        return 'exec';
    };
    const inspectOf = (value) => JSON.stringify({ memory: 0, memorySwap: 0, nanoCpus: 0, cpuQuota: 0, cpuPeriod: 0, pidsLimit: 0, pid: 1, conmonPid: 2, startedAt: 'x', ...value });
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
            case 'info': return ok(JSON.stringify(fault?.info || fakeEngineInfo(fault?.host || host)));
            case 'connections': return ok(JSON.stringify(fault?.connections || FAKE_CONNECTIONS));
            case 'ps': return ok([...Object.keys(state.boxes), ...state.unrelated.map(value => value.id)].join('\n') + '\n');
            case 'inspect': {
                const id = args.at(-1);
                const box = state.boxes[id] || state.unrelated.find(value => value.id === id);
                return box ? ok(inspectOf(box)) : failed('no such container');
            }
            case 'agent-inspect': {
                const name = args.at(-1);
                const agent = state.agents[name];
                if (!agent || fault?.drop === name) return failed('no such container');
                return ok(inspectOf({ ...agent, ...(fault?.patch || {}) }));
            }
            case 'start': {
                const workspace = options.cwd;
                const identity = buildWorkspaceIdentity(workspace);
                state.startCalls += 1;
                if (!fault?.noBox && !Object.values(state.boxes).some(box => box.labels[BOX_LABELS.pathHash] === identity.pathHash)) {
                    const id = hex(`box-${workspace}-${++state.counter}`);
                    state.boxes[id] = {
                        id, created: `2026-10-02T00:00:0${state.counter % 10}Z`, image: hex('box-image'), running: true,
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
