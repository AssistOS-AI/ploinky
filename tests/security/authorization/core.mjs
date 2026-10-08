import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { normalizeContainerRuntime } from '../../../ploinky-box/contract/container.mjs';
import { expectedAgentLibMounts } from '../../../ploinky-box/contract/agentlib.mjs';
import { boxWorkspaceMount } from '../../../ploinky-box/contract/workspace-root.mjs';
import { BOX_DATA_MOUNTS, BOX_DATA_RELATIVE_NAMES, BOX_DATA_ROOT_NAME, BOX_TMPFS } from '../../../ploinky-box/constants.mjs';
import { AGENTLIB_STABLE_MOUNT_PATH } from '../../../agentlib/contract.mjs';

export const TARGET = 'http://127.0.0.1:8080';
export const WORKSPACE = '/Users/danielsava/work/testExplorerFresh';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const command = (exe, args) => execFileSync(exe, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 16 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] }).trim();

export function validateTarget(value) {
    assert.equal(value, TARGET, 'Only the explicitly selected loopback Router is authorized');
    return new URL(value);
}

export async function privateJson(filename) {
    const real = await fs.realpath(filename);
    const metadata = await fs.stat(real);
    assert.ok(metadata.isFile() && metadata.uid === process.getuid() && !(metadata.mode & 0o077), 'Credential input must be a private operator-owned file');
    return JSON.parse(await fs.readFile(real, 'utf8'));
}

export async function writePrivate(filename, value) {
    await fs.writeFile(filename, typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
    await fs.chmod(filename, 0o600);
}

const BOX_DATA_SOURCE = (workspace, key) => path.join(workspace, '.ploinky', BOX_DATA_ROOT_NAME, BOX_DATA_RELATIVE_NAMES[key]);

/**
 * Fixed Box confinement, derived from the canonical Box contract
 * (ploinky-box/contract/container.mjs:495-567) and the reviewed pins, never
 * from a captured snapshot: /opt/ploinky read-only from the pinned checkout,
 * the workspace writable at its own path, the two writable data binds
 * (BOX_DATA_MOUNTS), the AgentLib read-only binds only in local mode, the
 * canonical /tmp tmpfs, and nothing else.
 */
export function assertBoxConfinement(box, { workspace, ploinkyCheckout, agentLib, policy }) {
    const runtime = normalizeContainerRuntime(box);
    assert.ok(runtime.complete, 'BOX_INSPECT_INCOMPLETE: Box inspect record is incomplete');
    assert.equal(box.HostConfig.Privileged, false, 'BOX_PRIVILEGED');
    assert.equal(box.HostConfig.Init, true, 'BOX_INIT_MISSING');
    assert.equal(box.Config.User, policy.box.user, 'BOX_USER');
    assert.deepEqual(Object.keys(box.NetworkSettings?.Ports || {}).sort(), ['7882/udp', '8080/tcp'], 'BOX_PUBLICATIONS');
    assert.deepEqual(box.NetworkSettings.Ports['8080/tcp'], policy.box.ports['8080/tcp'], 'BOX_ROUTER_PUBLICATION');
    assert.ok(!policy.box.gpuWiring && !policy.box.hardwareLimitsWiring, 'BOX_POLICY: GPU/hardware wiring requires a reviewed mount policy');
    const expectedTmpfs = [{ destination: BOX_TMPFS.destination, options: [...BOX_TMPFS.options.filter(o => o !== 'notmpcopyup'), 'rprivate'].sort() }];
    assert.deepEqual(runtime.tmpfs, expectedTmpfs, 'BOX_TMPFS');
    assert.ok(policy.box.agentLibModes.includes(agentLib?.mode), 'BOX_AGENTLIB_MODE');
    const workspaceMount = boxWorkspaceMount(workspace);
    const contract = agentLib.mode === 'local'
        ? { mode: 'local', stablePath: AGENTLIB_STABLE_MOUNT_PATH, sourceRelativePath: agentLib.sourceRelativePath, sourceDir: path.join(workspace, agentLib.sourceRelativePath) }
        : { mode: 'image' };
    const expected = {
        [policy.box.ploinkySourceDestination]: { source: ploinkyCheckout, rw: false },
        [workspaceMount.destination]: { source: workspaceMount.source, rw: true },
        [BOX_DATA_MOUNTS.dependencies]: { source: BOX_DATA_SOURCE(workspace, 'dependencies'), rw: true },
        [BOX_DATA_MOUNTS.images]: { source: BOX_DATA_SOURCE(workspace, 'images'), rw: true },
        ...expectedAgentLibMounts(contract, workspace),
    };
    assert.ok(Array.isArray(runtime.mounts), 'BOX_MOUNTS_MISSING');
    const transient = runtime.mounts.filter(m => m.destination === BOX_TMPFS.destination);
    assert.ok(transient.length <= 1 && transient.every(m => m.type === 'tmpfs' && m.source === '' && m.name === '' && m.rw === true), 'BOX_TMPFS_MOUNT');
    for (const mount of runtime.mounts) {
        if (mount.destination === BOX_TMPFS.destination) continue;
        assert.ok(Object.hasOwn(expected, mount.destination), `BOX_MOUNT_EXTRA: unexpected mount at ${mount.destination}`);
    }
    for (const [destination, want] of Object.entries(expected)) {
        const observed = runtime.mounts.filter(m => m.destination === destination);
        assert.equal(observed.length, 1, `BOX_MOUNT_MISSING_OR_DUPLICATE: ${destination}`);
        assert.equal(observed[0].type, 'bind', `BOX_MOUNT_TYPE: ${destination}`);
        assert.equal(observed[0].rw, want.rw, `BOX_MOUNT_MODE: ${destination} must be ${want.rw ? 'writable' : 'read-only'}`);
        assert.equal(observed[0].source, want.source, `BOX_MOUNT_SOURCE: ${destination}`);
    }
    assert.equal(runtime.mounts.length, Object.keys(expected).length + transient.length, 'BOX_MOUNT_COUNT');
    return true;
}

/**
 * Compare a fresh podman inspect record with the frozen pins, then apply the
 * fixed confinement policy. The captured box-identity snapshot can only add
 * agreement checks; it never widens the mount policy.
 */
export function verifyBoxAgainstPins({ box, captured, pins, policy }) {
    assert.equal(box.Id, pins.box.id, 'BOX_ID');
    assert.equal(String(box.Name).replace(/^\//, ''), pins.box.name, 'BOX_NAME');
    assert.equal(box.State?.Running, true, 'BOX_NOT_RUNNING');
    assert.equal(box.State.StartedAt, pins.box.startedAt, 'BOX_GENERATION');
    assert.equal(`sha256:${String(box.Image).replace(/^sha256:/, '')}`, pins.box.imageId, 'BOX_IMAGE');
    assert.equal(box.ImageDigest, pins.box.imageDigest, 'BOX_IMAGE_DIGEST: the running Box image digest differs from the pinned digest');
    for (const field of ['id', 'name', 'startedAt', 'imageId']) assert.equal(captured?.[field], pins.box[field], `BOX_CAPTURE_DRIFT: ${field}`);
    assertBoxConfinement(box, { workspace: pins.workspace, ploinkyCheckout: pins.ploinkyCheckout, agentLib: pins.agentlib, policy });
    return true;
}

export async function ownershipGuard(evidenceRoot, { sources = true, pins, policy } = {}) {
    assert.ok(pins && policy, 'OWNERSHIP_PINS_REQUIRED: the guard requires frozen pins and the acceptance policy');
    assert.equal(pins.workspace, WORKSPACE, 'OWNERSHIP_WORKSPACE');
    const preflight = JSON.parse(await fs.readFile(path.join(evidenceRoot, 'dependency-preflight.json')));
    const captured = JSON.parse(await fs.readFile(path.join(evidenceRoot, 'box-identity.json')));
    assert.equal(await fs.realpath(preflight.workspace), WORKSPACE);
    assert.equal(captured.pinsSha256, preflight.pinsSha256, 'OWNERSHIP_EVIDENCE_MIXED');
    const pinned = pins.repositories.map(({ name, path: p, commit, branch, upstream }) => ({ name, path: p, commit, branch, upstream }));
    assert.deepEqual(preflight.repositories, pinned, 'OWNERSHIP_PREFLIGHT_DRIFT');
    assert.match(captured.id, /^[a-f0-9]{64}$/);
    const box = JSON.parse(command('podman', ['inspect', pins.box.id]))[0];
    verifyBoxAgainstPins({ box, captured, pins, policy });
    if (sources) for (const repo of pins.repositories) {
        const root = path.join(WORKSPACE, repo.path);
        const git = args => command('git', ['-C', root, ...args]);
        assert.equal(git(['rev-parse', 'HEAD']), repo.commit, `Deployment revision changed: ${repo.name}`);
        assert.equal(git(['branch', '--show-current']), repo.branch);
        assert.equal(git(['rev-parse', '--abbrev-ref', '@{upstream}']), repo.upstream);
        assert.equal(git(['status', '--porcelain']), '', `Deployment source is dirty: ${repo.name}`);
    }
    return { boxId: box.Id, instance: pins.box.name, startedAt: box.State.StartedAt, image: { imageId: pins.box.imageId, imageDigest: pins.box.imageDigest }, repositories: pinned.map(({ name, branch, commit }) => ({ name, branch, commit })), userPersistoContainer: captured.userPersistoContainer, dpuContainer: captured.dpuContainer, classifiedContainers: captured.classifiedContainers };
}

/** Live runtimes must equal the reviewed manifest-derived set exactly. */
export function assertRuntimeSet(live, expected) {
    assert.ok(Array.isArray(expected) && expected.length > 0, 'RUNTIME_SET_EXPECTED_EMPTY');
    assert.ok(Array.isArray(live) && live.length > 0, 'RUNTIME_SET_EMPTY');
    const key = (repo, agent) => `${repo}/${agent}`;
    const expectedKeys = expected.map(e => key(e.repo, e.agent));
    assert.equal(new Set(expectedKeys).size, expectedKeys.length, 'RUNTIME_SET_EXPECTED_DUPLICATE');
    const liveKeys = live.map(r => {
        assert.ok(typeof r?.repoName === 'string' && r.repoName && typeof r.agentName === 'string' && r.agentName, 'RUNTIME_SET_MALFORMED');
        return key(r.repoName, r.agentName);
    });
    assert.equal(new Set(liveKeys).size, liveKeys.length, 'RUNTIME_SET_DUPLICATE');
    const extra = liveKeys.filter(k => !expectedKeys.includes(k));
    const missing = expectedKeys.filter(k => !liveKeys.includes(k));
    assert.deepEqual(extra, [], 'RUNTIME_SET_EXTRA');
    assert.deepEqual(missing, [], 'RUNTIME_SET_MISSING');
    for (const r of live) assert.ok(r.enabled === true && r.state?.running === true, `RUNTIME_NOT_RUNNING: ${key(r.repoName, r.agentName)}`);
    return liveKeys.sort();
}

const GAP_EVIDENCE_KINDS = new Set(['unsupported-transport', 'agent-disabled', 'rpc-method-unsupported', 'positive-unavailable', 'selfregistered-visible-tools', 'actor-unsupported', 'pagination', 'declared-limitation', 'negative-only-protocol', 'boundary-rejected', 'data-unavailable', 'username-reserved', 'fanout-errors']);
const GAP_ACTORS = new Set(['anonymous', 'selfRegistered', 'userA', 'userB', 'admin']);
const GAP_METHODS = new Set(['initialize', 'tools/list', 'resources/list', 'resources/templates/list', 'prompts/list', 'tools/call']);
const SAFE_NAME = /^[A-Za-z0-9_.:@-]{1,120}$/;

/** Typed gap evidence carries only enumerated scalars and sorted names, never error text. */
export function sanitizeGapEvidence(evidence) {
    if (!evidence || typeof evidence !== 'object' || !GAP_EVIDENCE_KINDS.has(evidence.kind)) return { kind: 'untyped' };
    const out = { kind: evidence.kind };
    if (GAP_ACTORS.has(evidence.actor)) out.actor = evidence.actor;
    if (typeof evidence.endpoint === 'string' && /^\/[A-Za-z0-9._\/-]{1,120}$/.test(evidence.endpoint)) out.endpoint = evidence.endpoint;
    for (const field of ['requestedMethod', 'stage']) if (GAP_METHODS.has(evidence[field])) out[field] = evidence[field];
    for (const field of ['httpStatus', 'rpcCode']) if (Number.isInteger(evidence[field])) out[field] = evidence[field];
    if (typeof evidence.initialized === 'boolean') out.initialized = evidence.initialized;
    if (typeof evidence.errorCode === 'string' && /^[a-z][a-z0-9_]{1,60}$/.test(evidence.errorCode)) out.errorCode = evidence.errorCode;
    if (typeof evidence.allow === 'string' && /^[A-Z]{3,7}(,[A-Z]{3,7}){0,6}$/.test(evidence.allow)) out.allow = evidence.allow;
    for (const field of ['repo', 'agent', 'probeId']) if (typeof evidence[field] === 'string' && SAFE_NAME.test(evidence[field])) out[field] = evidence[field];
    if (Array.isArray(evidence.visibleTools)) out.visibleTools = evidence.visibleTools.filter(n => typeof n === 'string' && SAFE_NAME.test(n)).sort();
    return out;
}

export function responseSummary(response) {
    return { status: response.status, type: String(response.headers?.['content-type'] || '').split(';')[0], bytes: Buffer.byteLength(response.text || ''), sha256: digest(response.text || ''), error: typeof response.json?.error === 'string' && /^[a-zA-Z0-9_. -]{1,90}$/.test(response.json.error) ? response.json.error : undefined };
}

export function assertDenied(response) {
    assert.ok([401, 403].includes(response.status), `Expected explicit authorization denial; got ${response.status}`);
    assert.ok(response.json && (response.json.error || response.json.message || response.json.reason), 'Denial must contain a structured error, not a login page');
    assert.match(JSON.stringify(response.json), /auth|denied|forbidden|capability|csrf|origin|admin.{0,20}required|permission/i, 'Denial needs authorization-specific content');
    assert.notEqual(response.json.ok, true);
}

export function assertPrincipal(payload, expectedRole, expectedId) {
    assert.ok(payload?.user?.id, 'Missing real Router principal');
    assert.deepEqual(payload.user.roles, [expectedRole], 'Incorrect current principal role');
    if (expectedId) assert.equal(payload.user.id, expectedId, 'Principal identity changed');
    assert.ok(!payload.user.roles.includes('guest'), 'Guest cannot substitute for public registration');
    return payload.user;
}

export class Client {
    constructor(cookies = [], { target = TARGET, onSecret = () => {}, beforeMutation = async () => {} } = {}) {
        validateTarget(target);
        this.cookies = cookies.map(c => ({ ...c }));
        this.onSecret = onSecret;
        this.beforeMutation = beforeMutation;
        this.csrf = '';
        this.browserCsrf = '';
        for (const cookie of cookies) onSecret(cookie.value);
    }
    async request({ method = 'GET', path: requestPath, body, headers = {}, proof = true, stream = false, timeout = 10000 }) {
        assert.ok(typeof requestPath === 'string' && requestPath.startsWith('/') && !/[\r\n]/.test(requestPath), 'Request path must be local and cannot contain header delimiters');
        assert.ok(timeout > 0 && timeout <= 30000);
        if (!['GET', 'HEAD', 'OPTIONS'].includes(method)) await this.beforeMutation();
        const requestHeaders = { accept: 'application/json', ...headers };
        if (!Object.hasOwn(requestHeaders, 'cookie')) requestHeaders.cookie = this.cookies.filter(c => requestPath.split('?')[0].startsWith(c.path || '/') && (!c.expires || c.expires < 0 || c.expires > Date.now() / 1000)).map(c => `${c.name}=${c.value}`).join('; ');
        if (proof && !['GET', 'HEAD', 'OPTIONS'].includes(method)) {
            if (!Object.hasOwn(requestHeaders, 'origin')) requestHeaders.origin = TARGET;
            if (!Object.hasOwn(requestHeaders, 'x-ploinky-csrf-token') && this.csrf) requestHeaders['x-ploinky-csrf-token'] = this.csrf;
            if (!Object.hasOwn(requestHeaders, 'x-ploinky-browser-csrf-token') && this.browserCsrf) requestHeaders['x-ploinky-browser-csrf-token'] = this.browserCsrf;
        }
        const data = body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body));
        if (data !== undefined) {
            requestHeaders['content-type'] ||= 'application/json';
            requestHeaders['content-length'] = Buffer.byteLength(data);
        }
        const response = await new Promise((resolve, reject) => {
            let done = false;
            let hardTimer;
            const finish = (res, chunks) => {
                if (done) return;
                done = true;
                clearTimeout(hardTimer);
                const text = Buffer.concat(chunks).toString('utf8');
                let json;
                try { json = JSON.parse(text); } catch {}
                resolve({ status: res.statusCode, headers: res.headers, text, json });
            };
            // Raw http preserves encoded/dot/duplicate-slash probe paths. It never follows redirects.
            const req = http.request({ hostname: '127.0.0.1', port: 8080, path: requestPath, method, headers: requestHeaders }, res => {
                const chunks = [];
                let bytes = 0;
                if (stream && res.statusCode === 200) { finish(res, chunks); res.destroy(); return; }
                res.on('data', chunk => { bytes += chunk.length; if (bytes > 4 * 1024 * 1024) { req.destroy(new Error('Response exceeds bounded probe limit')); return; } chunks.push(chunk); });
                res.on('end', () => finish(res, chunks));
                res.on('error', reject);
            });
            req.on('upgrade', (res, socket) => { finish(res, []); socket.destroy(); });
            req.setTimeout(timeout, () => req.destroy(new Error('Bounded probe transport timeout')));
            hardTimer = setTimeout(() => req.destroy(new Error('Bounded probe wall-clock timeout')), timeout);
            req.on('error', error => { clearTimeout(hardTimer); reject(error); });
            req.end(data);
        });
        for (const line of response.headers['set-cookie'] || []) {
            const [pair, ...attributes] = line.split(';');
            const index = pair.indexOf('=');
            const cookie = { name: pair.slice(0, index), value: pair.slice(index + 1), path: attributes.find(x => /^\s*path=/i.test(x))?.trim().slice(5) || '/' };
            this.onSecret(cookie.value);
            this.cookies = this.cookies.filter(c => c.name !== cookie.name || c.path !== cookie.path);
            this.cookies.push(cookie);
        }
        if (requestPath.startsWith('/auth/token') && response.status === 200) {
            this.csrf = response.json?.adminControl?.csrfToken || '';
            this.browserCsrf = response.json?.browserMutation?.csrfToken || '';
            for (const value of [this.csrf, this.browserCsrf, response.json?.token?.token, response.json?.token?.jwt]) if (value) this.onSecret(value);
        }
        return response;
    }
}

export function safeError(error, secrets = []) {
    let message = String(error?.message || error);
    for (const secret of [...secrets].filter(x => typeof x === 'string' && x.length > 3).sort((a, b) => b.length - a.length)) message = message.split(secret).join('[private]');
    return message.replace(/eyJ[A-Za-z0-9_.-]+/g, '[token]').replace(/\b\d{6}\b/g, '[code]').slice(0, 700);
}

export function collectSecrets(value, secrets, key = '') {
    if (typeof value === 'string') {
        if (/token|secret|password|jwt|cookie|authorization|api.?key|private.?key|csrf/i.test(key) && value.length >= 6) secrets.add(value);
        if (/^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\./.test(value)) secrets.add(value);
        if (key === 'text') { try { collectSecrets(JSON.parse(value), secrets); } catch {} }
    } else if (Array.isArray(value)) {
        for (const item of value) collectSecrets(item, secrets, key);
    } else if (value && typeof value === 'object') {
        for (const [name, item] of Object.entries(value)) collectSecrets(item, secrets, name);
    }
}

export function runVerdict(report) {
    if (report.setupError || report.interrupted || report.finalOwnership !== 'PASS' || report.counts.ERROR || report.cleanup.some(item => item.status !== 'PASS')) return 'ERROR';
    if (report.counts.FAIL) return 'FAIL';
    if (!report.counts.PASS) return 'ERROR';
    return report.gaps.length ? 'NO_FAILURES_WITH_GAPS' : 'PASS';
}

const containsPath = (parent, child) => parent === child || child.startsWith(parent.endsWith(path.sep) ? parent : parent + path.sep);

export async function artifactDestination(sourceRoot, root) {
    assert.ok(path.isAbsolute(root), 'Artifact directory must be absolute');
    const source = await fs.realpath(sourceRoot);
    let ancestor = path.resolve(root);
    const suffix = [];
    while (true) {
        try { ancestor = await fs.realpath(ancestor); break; }
        catch (error) {
            if (error.code !== 'ENOENT') throw error;
            suffix.unshift(path.basename(ancestor));
            const parent = path.dirname(ancestor);
            assert.notEqual(parent, ancestor, 'Cannot resolve artifact parent');
            ancestor = parent;
        }
    }
    const real = path.join(ancestor, ...suffix);
    for (const protectedRoot of [source, WORKSPACE]) {
        assert.ok(!containsPath(protectedRoot, real) && !containsPath(real, protectedRoot), 'Artifact directory must not overlap source or deployment');
    }
    return real;
}

export async function validateArtifactRoots(sourceRoot, outputRoot, privateRoot) {
    // Resolve both destinations before creating anything, including a missing
    // leaf below a symlink. Neither a source ancestor nor reused evidence is safe.
    const roots = await Promise.all([outputRoot, privateRoot].map(root => artifactDestination(sourceRoot, root)));
    assert.ok(!containsPath(roots[0], roots[1]) && !containsPath(roots[1], roots[0]), 'Artifact directories must be disjoint after resolving symlinks');
    for (const root of roots) {
        try { await fs.lstat(root); assert.fail('Live artifact directories must be new'); }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    for (const root of roots) {
        await fs.mkdir(path.dirname(root), { recursive: true, mode: 0o700 });
        await fs.mkdir(root, { mode: 0o700 });
        assert.equal(await fs.realpath(root), root, 'Artifact parent changed during creation');
    }
    return roots;
}
