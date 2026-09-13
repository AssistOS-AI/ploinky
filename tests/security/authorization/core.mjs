import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

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

export async function ownershipGuard(evidenceRoot, { sources = true } = {}) {
    const pins = JSON.parse(await fs.readFile(path.join(evidenceRoot, 'dependency-preflight.json')));
    const expected = JSON.parse(await fs.readFile(path.join(evidenceRoot, 'box-identity.json')));
    assert.equal(await fs.realpath(pins.workspace), WORKSPACE);
    assert.match(expected.id, /^[a-f0-9]{64}$/);
    const box = JSON.parse(command('podman', ['inspect', expected.id]))[0];
    assert.equal(box.Id, expected.id);
    assert.equal(box.Name.replace(/^\//, ''), expected.name);
    assert.equal(box.State.Running, true);
    assert.equal(box.State.StartedAt, expected.startedAt);
    assert.equal(box.Image.replace(/^sha256:/, ''), expected.image.replace(/^sha256:/, ''));
    assert.equal(box.Image.replace(/^sha256:/, ''), pins.image.imageId.replace(/^sha256:/, ''));
    assert.equal(box.HostConfig.Privileged, false);
    assert.equal(box.HostConfig.Init, true);
    assert.equal(box.Config.User, 'podman');
    assert.deepEqual(box.NetworkSettings.Ports, expected.ports);
    assert.deepEqual(Object.keys(box.NetworkSettings.Ports).sort(), ['7882/udp', '8080/tcp']);
    assert.deepEqual(box.NetworkSettings.Ports['8080/tcp'], [{ HostIp: '127.0.0.1', HostPort: '8080' }]);
    assert.ok(box.Mounts.some(m => m.Destination === '/workspace' && m.Source === WORKSPACE));
    for (const destination of ['/opt/ploinky', '/workspace/achillesAgentLib', '/opt/ploinky-agentlib']) {
        assert.ok(box.Mounts.some(m => m.Destination === destination && m.RW === false), 'Required source mount must remain read-only');
    }
    if (sources) for (const repo of pins.repositories) {
        const root = path.join(WORKSPACE, repo.path);
        const git = args => command('git', ['-C', root, ...args]);
        assert.equal(git(['rev-parse', 'HEAD']), repo.commit, `Deployment revision changed: ${repo.name}`);
        assert.equal(git(['branch', '--show-current']), repo.branch);
        assert.equal(git(['rev-parse', '--abbrev-ref', '@{upstream}']), `origin/${repo.branch}`);
        assert.equal(git(['status', '--porcelain']), '', `Deployment source is dirty: ${repo.name}`);
    }
    return { boxId: box.Id, instance: expected.name, startedAt: box.State.StartedAt, image: pins.image, repositories: pins.repositories.map(({ name, branch, commit }) => ({ name, branch, commit })) };
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
