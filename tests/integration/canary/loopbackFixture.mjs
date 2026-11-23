import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const routeKey = 'service';
export const rolloutId = 'rollout-1';
export const tool = 'inspect';

export async function listen(t, server) {
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => {
        server.closeAllConnections();
        return new Promise(resolve => server.close(resolve));
    });
    return server.address().port;
}

export function write(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
}

export function json(res, status, data, headers = {}) {
    res.writeHead(status, { 'content-type': 'application/json', ...headers });
    res.end(JSON.stringify(data));
}

export function guarded(handler) {
    return (req, res) => handler(req, res).catch(error => json(res, error.status || 500, { error: error.message }));
}

export function fixtureWorkspace(t, prefix) {
    const cwd = process.cwd();
    const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const previous = { PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT, PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY };
    process.chdir(root);
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    process.env.PLOINKY_MASTER_KEY = randomBytes(32).toString('hex');
    t.after(() => {
        process.chdir(cwd);
        for (const [key, value] of Object.entries(previous)) {
            if (value === undefined) delete process.env[key];
            else process.env[key] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}

export function copyRecord(copy, index, launchId, hostPort) {
    return { type: 'agent', repoName: 'fixture', agentName: routeKey, runtime: 'podman',
        containerId: String(index + 1).repeat(64), instanceId: copy + '-instance', enableGeneration: copy + '-enable',
        launchId, hostPort, auth: { mode: 'sso' } };
}

export function writeCanaryFixture(root, identities) {
    const canary = { container: 'primary__canary', rolloutId, share: 0, testAccounts: ['tester'], mode: 'split', salt: 'salt',
        commit: 'a'.repeat(40), codeDigest: 'sha256:' + 'a'.repeat(64), codePath: '.ploinky/canary/service/export',
        splitStartedAt: new Date().toISOString(), thresholds: {},
        probe: { port: 8787, path: '/health', status: 200 } };
    const hostPath = path.join(root, 'fixture', routeKey);
    const route = { repo: 'fixture', agent: routeKey, container: 'primary', hostPath, hostPort: identities.old.hostPort, canary };
    const manifest = { readiness: { protocol: 'tcp' }, routerAccess: { agentPorts: true, httpRoutes: [
        { path: '/public/*', access: 'public' }, { path: '/guest/*', access: 'guest' },
        { path: '/private/*', access: 'authenticated' },
        { path: '/base-agent-additional-server/service/8787/*', access: 'authenticated' },
    ] } };
    for (const [copy, dir] of [['old', hostPath], ['canary', path.join(root, canary.codePath)]]) {
        write(path.join(dir, 'manifest.json'), manifest);
        write(path.join(dir, 'public/index.html'), '<script src="/service/public/asset.js"></script>' + copy);
        write(path.join(dir, 'public/asset.js'), 'asset-' + copy);
    }
    const state = path.join(root, '.ploinky');
    write(path.join(state, 'routing.json'), { routes: { service: route } });
    write(path.join(state, 'agents.json'), { primary: identities.old, primary__canary: { ...identities.canary, canaryOf: routeKey } });
    const publicHost = 'service.synthetic.test';
    write(path.join(state, 'data/edge-routing/desired.json'), {
        hosts: { [publicHost]: { agent: 'fixture/service' } },
        cloudflare: { tunnelTokenSecret: 'cloudflare/fixture-tunnel' },
    });
    write(path.join(state, 'data/router-security/policy-state.json'), { schema: 'router-policy', httpRoutes: [],
        mcpTools: [{ agent: routeKey, tool, access: 'authenticated', enabled: true }] });
    return { route, state, publicHost };
}

export async function fixtureSessions(t) {
    const { authService } = await import('../../../cli/server/authHandlers/shared.js');
    const { createSessionStore } = await import('../../../cli/server/auth/sessionStore.js');
    const store = createSessionStore();
    const cookies = Object.fromEntries(['tester', 'reader'].map(id => [
        id, 'ploinky_sso=' + store.createSession({ user: { id, roles: ['user'] } }).id,
    ]));
    t.mock.method(authService, 'isConfigured', () => true);
    t.mock.method(authService, 'getSession', store.getSession);
    t.mock.method(authService, 'validateSession', async id => store.getSession(id));
    t.mock.method(authService, 'admissionFence', id => () => Boolean(store.getSession(id)));
    return { cookies, store };
}
