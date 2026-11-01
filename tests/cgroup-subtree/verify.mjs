#!/usr/bin/env node
// Observe an already selected task fixture. This never creates, restarts,
// removes or pulls a Box/agent/image. Other live acceptance cases remain separate.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';

function fail(message) { throw new Error(message); }
const ID = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;

export function validateManifest(value) {
    if (value?.schemaVersion !== 1 || value.purpose !== 'cgroup-subtree-acceptance'
        || typeof value.host?.hostname !== 'string' || !Number.isSafeInteger(value.host?.uid) || value.host.uid < 1
        || !path.isAbsolute(value.workspaceRoot || '') || !path.isAbsolute(value.evidenceDirectory || '')
        || !Array.isArray(value.repositories) || !value.repositories.length || value.repositories.length > 16) fail('invalid cgroup fixture manifest');
    for (const key of ['box', 'agent', 'peer']) {
        if (!ID.test(value[key]?.id) || !DIGEST.test(value[key]?.imageId)) fail(`exact ${key} identity is required`);
    }
    if (new Set(['box', 'agent', 'peer'].map((key) => value[key].id)).size !== 3) fail('fixture identities must be distinct');
    const names = new Set();
    for (const repo of value.repositories) {
        if (!/^[A-Za-z0-9_.-]+$/.test(repo.name || '') || names.has(repo.name) || !path.isAbsolute(repo.root || '')
            || !COMMIT.test(repo.commit) || !COMMIT.test(repo.tree)) fail('exact repository identity is required');
        names.add(repo.name);
    }
    if (!names.has('ploinky')) fail('Ploinky source identity is required');
    return value;
}

function run(command, args) {
    const result = spawnSync(command, args, { encoding: 'utf8', timeout: 15000, maxBuffer: 1024 * 1024,
        killSignal: 'SIGKILL', cwd: '/' });
    if (result.error || result.status !== 0) fail(`bounded ${command} observation failed`);
    return String(result.stdout || '').trim();
}

const INSIDE = `
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { verifyAgentCgroupSubtree } from '/opt/ploinky/cli/sandbox/cgroupSubtree.mjs';
const m = JSON.parse(process.argv[1]);
const query = (command, args) => { const r = spawnSync(command, args, { encoding: 'utf8', timeout: 5000, maxBuffer: 1048576 });
    return { ok: !r.error && r.status === 0, stdout: r.stdout }; };
const file = m.workspaceRoot + '/.ploinky/agents.json';
const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
let records;
try { if (fs.fstatSync(fd).size > 1048576) throw new Error('registry exceeds bound'); records = JSON.parse(fs.readFileSync(fd, 'utf8')); }
finally { fs.closeSync(fd); }
const proofs = [];
for (const selected of ['agent', 'peer']) {
    const matching = Object.values(records).filter(r => r.type === 'agent' && r.containerId === m[selected].id);
    if (matching.length !== 1 || !matching[0].cgroupSubtree) throw new Error('selected agent ownership is ambiguous');
    const r = matching[0], reservation = r.cgroupSubtree;
    const result = query('podman', ['container', 'inspect', m[selected].id]);
    if (!result.ok) throw new Error('selected agent is unavailable');
    const rows = JSON.parse(result.stdout), inspected = rows.length === 1 ? rows[0] : null;
    const image = String(inspected?.Image || '').replace(/^(?!sha256:)([a-f0-9]{64})$/, 'sha256:$1');
    if (image !== m[selected].imageId || inspected?.State?.Running !== true) throw new Error('selected agent image/readiness mismatch');
    const descriptor = { boxContext: { markerIdentity: reservation.box.markerIdentity }, cgroupDelegation: {
        schemaVersion: 1, ready: true, parent: reservation.parent, controllers: ['cpu', 'memory', 'pids'],
        cgroupNamespace: reservation.box.cgroupNamespace, pidNamespace: reservation.box.pidNamespace, reason: null } };
    if (fs.readlinkSync('/proc/self/ns/cgroup') !== reservation.box.cgroupNamespace
        || fs.readlinkSync('/proc/self/ns/pid') !== reservation.box.pidNamespace) throw new Error('Box namespace mismatch');
    const proof = verifyAgentCgroupSubtree({ descriptor, containerId: m[selected].id, query });
    if (JSON.stringify(proof.reservation.nativeRoot) !== JSON.stringify(reservation.nativeRoot)) throw new Error('native reservation mismatch');
    // A supported engine exec must still work after startup tasks moved to core.
    if (!query('podman', ['exec', m[selected].id, '/bin/true']).ok) throw new Error('post-preparation exec unavailable');
    proofs.push({ selected, id: m[selected].id, image, root: proof.root,
        namespace: proof.namespace, mountIdentity: proof.mountIdentity });
}
if (proofs[0].namespace.pid === proofs[1].namespace.pid || proofs[0].namespace.cgroup === proofs[1].namespace.cgroup)
    throw new Error('selected agents share a namespace');
console.log(JSON.stringify({ schemaVersion: 1, proofs }));
`;

export function verifySelectedFixture(manifest, { query = run, hostname = os.hostname(), uid = process.getuid(), fsApi = fs } = {}) {
    const value = validateManifest(manifest);
    // Validate every pin before the first Box/agent command.
    if (hostname !== value.host.hostname || uid !== value.host.uid) fail('selected host/user mismatch');
    if (fsApi.realpathSync(value.workspaceRoot) !== value.workspaceRoot) fail('workspace is not canonical');
    const sources = [];
    for (const repo of value.repositories) {
        if (fsApi.realpathSync(repo.root) !== repo.root || query('git', ['-C', repo.root, 'rev-parse', 'HEAD']) !== repo.commit
            || query('git', ['-C', repo.root, 'rev-parse', 'HEAD^{tree}']) !== repo.tree
            || query('git', ['-C', repo.root, 'status', '--porcelain']) !== '') fail('selected repository revision/cleanliness mismatch');
        sources.push({ ...repo });
    }
    let rows;
    try { rows = JSON.parse(query('podman', ['container', 'inspect', value.box.id])); }
    catch { fail('selected Box inspection is malformed or unavailable'); }
    const box = Array.isArray(rows) && rows.length === 1 ? rows[0] : null;
    const image = String(box?.Image || '').replace(/^(?!sha256:)([a-f0-9]{64})$/, 'sha256:$1');
    const expectedHash = crypto.createHash('sha256').update(value.workspaceRoot).digest('hex').slice(0, 12);
    const source = value.repositories.find((repo) => repo.name === 'ploinky');
    const mounts = box?.Mounts || [];
    if (box?.Id !== value.box.id || image !== value.box.imageId || box?.State?.Running !== true
        || box?.Config?.Labels?.[BOX_LABELS.pathHash] !== expectedHash
        || !mounts.some((mount) => mount.Destination === '/opt/ploinky' && mount.Source === source.root && mount.RW === false)) {
        fail('selected Box identity/image/source mismatch');
    }
    let result;
    try { result = JSON.parse(query('podman', ['exec', value.box.id, '/usr/local/bin/node', '--input-type=module', '-e', INSIDE,
        JSON.stringify({ workspaceRoot: value.workspaceRoot, agent: value.agent, peer: value.peer })])); }
    catch { fail('selected cgroup runtime verification failed'); }
    if (result?.schemaVersion !== 1 || result.proofs?.length !== 2) fail('invalid cgroup verification result');
    for (const selected of ['agent', 'peer']) {
        const proof = result.proofs.find((entry) => entry.selected === selected);
        if (!proof || proof.id !== value[selected].id || proof.image !== value[selected].imageId
            || !new RegExp(`^/ploinky/agents/libpod-${proof.id}(?:\\.scope)?$`).test(proof.root)
            || !/^pid:\[\d+\]$/.test(proof.namespace?.pid) || !/^cgroup:\[\d+\]$/.test(proof.namespace?.cgroup)
            || !/^\d+$/.test(proof.mountIdentity?.dev) || !/^\d+$/.test(proof.mountIdentity?.ino)) fail('cgroup result identity mismatch');
    }
    if (result.proofs[0].namespace.pid === result.proofs[1].namespace.pid
        || result.proofs[0].namespace.cgroup === result.proofs[1].namespace.cgroup) fail('cgroup result shares namespaces');
    return Object.freeze({ schemaVersion: 1, observedAt: new Date().toISOString(), sources,
        box: value.box, host: value.host, workspaceRoot: value.workspaceRoot, ...result });
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
    try {
        if (process.argv.length !== 4 || process.argv[2] !== '--manifest' || !path.isAbsolute(process.argv[3])) {
            fail('usage: node tests/cgroup-subtree/verify.mjs --manifest ABS');
        }
        const file = process.argv[3], stat = fs.lstatSync(file);
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 65536) fail('manifest must be one bounded regular JSON file');
        const manifest = validateManifest(JSON.parse(fs.readFileSync(file, 'utf8')));
        const result = verifySelectedFixture(manifest);
        const output = path.join(fs.realpathSync(manifest.evidenceDirectory), `cgroup-${crypto.randomUUID()}.json`);
        fs.writeFileSync(output, JSON.stringify(result, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        process.stdout.write(JSON.stringify({ ok: true, evidence: output }) + '\n');
    } catch (error) { process.stderr.write((error instanceof SyntaxError ? 'fixture JSON is malformed' : error.message) + '\n'); process.exitCode = 1; }
}
