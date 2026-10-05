// Offline world for the step-4 executor tests: a candidate source, a fake
// engine binary, a host home, an evidence directory and a concrete manifest
// built by the REAL builder for any implemented block. Test-only; nothing here
// touches an engine, SSH, a GPU or the network.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { writePrivateJson } from './fixtures.mjs';
import { liveSourceDigest, engineIdentityDigest } from './liveCommon.mjs';
import { CONCRETE_BLOCKS, buildConcreteManifest } from './liveManifest.mjs';
import { writeUstar } from './liveStage.mjs';
import { createFakeWorld, fakeEngineInfo } from './fakeLiveEngine.mjs';

export const hash = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
export const ENGINE_HOST = { arch: 'test', os: 'linux', hostname: 'fake-engine', id: 'engine-1' };
export const IMAGE = `docker.io/assistos/ploinky-node@sha256:${'a'.repeat(64)}`;
export const BOX_IMAGE = `docker.io/assistos/ploinky-box@sha256:${'b'.repeat(64)}`;
export const free = async () => ({ tcp: true, udp: true });
export const exists = target => { try { fs.lstatSync(target); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; } };

const openAll = target => { const stat = fs.lstatSync(target); if (!stat.isDirectory()) return; fs.chmodSync(target, 0o700); for (const name of fs.readdirSync(target)) openAll(path.join(target, name)); };
export function scratch(t, prefix = 'hwl-x4-') {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    t.after(() => { if (exists(root)) { openAll(root); fs.rmSync(root, { recursive: true, force: true }); } });
    return root;
}
// A live workspace leaves room for the CLI's Unix sockets: a short task-owned parent.
export function shortParent(t) {
    const base = [os.tmpdir(), '/tmp'].map(value => fs.realpathSync(value)).find(value => Buffer.byteLength(value) <= 24);
    const parent = fs.realpathSync(fs.mkdtempSync(path.join(base, 'hwl-')));
    t.after(() => { if (exists(parent)) { openAll(parent); fs.rmSync(parent, { recursive: true, force: true }); } });
    return parent;
}

// `extraSource` lets a block carry the reviewed in-Box programs it freezes (name -> text).
export function world(t, { block, stagedRoot = true, faults = {}, suffix = 'claude', home: homeOverride = null, parentRoot: parentRootOverride = null, extraSource = {}, extraPins = {}, buildOptions = {}, ports = { tcp: 23456, udp: 34567 } } = {}) {
    const spec = CONCRETE_BLOCKS[block];
    if (!spec) throw new Error(`no concrete block ${block}`);
    const root = scratch(t);
    const remote = spec.remote;
    const directory = name => { const target = path.join(root, name); fs.mkdirSync(target, { recursive: true, mode: 0o700 }); return target; };
    const home = homeOverride || directory('home');
    if (homeOverride) fs.mkdirSync(home, { recursive: true });
    const source = directory('source');
    fs.mkdirSync(path.join(source, 'ploinky-box', 'bin'), { recursive: true });
    fs.writeFileSync(path.join(source, 'ploinky-box', 'bin', 'ploinky-box.mjs'), '// fixture candidate\n');
    fs.mkdirSync(path.join(source, 'tests', 'hardware-limits'), { recursive: true });
    fs.writeFileSync(path.join(source, 'tests', 'hardware-limits', 'verify.mjs'), '// fixture runner\n');
    for (const [name, text] of Object.entries(extraSource)) { fs.mkdirSync(path.dirname(path.join(source, name)), { recursive: true }); fs.writeFileSync(path.join(source, name), text); }
    const bin = directory('bin');
    const engine = path.join(bin, 'podman'); fs.writeFileSync(engine, 'fake engine\n');
    const ssh = path.join(bin, 'ssh'); fs.writeFileSync(ssh, 'fake ssh\n');
    const knownHosts = path.join(root, 'known_hosts'); fs.writeFileSync(knownHosts, '192.168.1.63 ssh-ed25519 AAAAfixture\n');
    const evidence = directory('evidence');
    const parentRoot = parentRootOverride || shortParent(t);
    if (parentRootOverride) fs.mkdirSync(parentRoot, { recursive: true });
    const node = fs.realpathSync(process.execPath);
    const hostIdentity = remote ? { hostname: 'apparatus', platform: 'linux', home } : { hostname: os.hostname(), platform: process.platform, home };
    const pins = {
        schema: 1, host: hostIdentity, node: { path: node, digest: hash(fs.readFileSync(node)) },
        engine: { path: engine, digest: hash(fs.readFileSync(engine)), identityDigest: engineIdentityDigest(fakeEngineInfo(ENGINE_HOST)) }, boxImage: BOX_IMAGE,
        ...(remote ? { ssh: { alias: 'ubuntu-codex', sshBinary: ssh, address: '100.76.22.69', hostKeyAlias: '192.168.1.63', user: 'skutner', knownHosts, identityFile: null } } : { workspaceParentRoot: parentRoot }),
        ...extraPins,
    };
    const runId = crypto.randomBytes(16).toString('hex');
    const candidate = { root: source, digest: liveSourceDigest(source), revision: 'c'.repeat(40) };
    if (remote) {
        const payloadPath = path.join(evidence, `candidate-${runId}.tar`);
        candidate.payload = { path: payloadPath, ...writeUstar(source, payloadPath) };
    }
    const run = buildConcreteManifest({
        block, runId, configDigest: hash('config'), casesDigest: hash('cases'), documentSuffix: suffix, pins, candidate, image: IMAGE,
        ports, unsupported: {}, ...buildOptions,
    });
    const remoteRoot = remote ? run.target.stage.root : null;
    if (remote && stagedRoot) {
        fs.mkdirSync(remoteRoot, { recursive: true }); fs.chmodSync(remoteRoot, 0o700);
        fs.writeFileSync(path.join(remoteRoot, '.ploinky-hwl-owner'), runId, { mode: 0o600 });
        fs.cpSync(source, path.join(remoteRoot, 'source'), { recursive: true });
    }
    const runPath = path.join(evidence, `run_${suffix}.json`);
    writePrivateJson(runPath, run);
    const statePath = path.join(root, 'world_claude.json');
    const engineProvider = createFakeWorld({ statePath, node, engine, host: ENGINE_HOST, unrelated: [], faults });
    const persist = () => writePrivateJson(runPath, run);
    return { root, home, source, engine, ssh, knownHosts, evidence, node, pins, run, runId, runPath, statePath, engineProvider, hostIdentity, remote, remoteRoot, persist, candidate };
}
