import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as edge from '../../cli/sandbox/edgeGeneration.js';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';

// One owner host that also carries a root application, and its legacy sibling
// that serves the owner alone. The owner and root application each enable a
// dependency; `unrelated` is installed but outside both closures.
export const rootHost = 'root.synthetic.test';
export const siblingHost = 'sibling.synthetic.test';
export const OWNER_SURFACES = Object.freeze([
    'agent-mcp', 'blob-transfer', 'browser-auth', 'marketplace-ui', 'user-admin', 'webchat', 'webtty', 'workspace-assets',
]);
export const ROOT_APPLICATION = Object.freeze({ agent: 'fixtures/bizanso', port: 8787 });
export const hash = value => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;

const MANIFESTS = {
    explorer: { enable: ['fixtures/provider'] },
    // Public root and assets, authenticated application paths; anything else
    // is undeclared and falls to the route default.
    bizanso: {
        enable: ['fixtures/mailer'],
        routerAccess: { agentPorts: true, httpRoutes: [
            { path: '/base-agent-additional-server/bizanso/8787/', access: 'public' },
            { path: '/base-agent-additional-server/bizanso/8787/static/*', access: 'public' },
            { path: '/base-agent-additional-server/bizanso/8787/app/*', access: 'authenticated' },
            { path: '/base-agent-additional-server/bizanso/8787/api/*', access: 'authenticated' },
        ] },
    },
    provider: { routerAccess: { httpRoutes: [{ path: '/public/*', access: 'authenticated' }] } },
    mailer: {},
    unrelated: { routerAccess: { httpRoutes: [{ path: '/public/*', access: 'authenticated' }] } },
};

export function rootHostEntry(overrides = {}) {
    return {
        agent: 'fixtures/explorer',
        routerSurfaces: [...OWNER_SURFACES],
        rootApplication: { ...ROOT_APPLICATION },
        dnsManagement: 'external',
        ...overrides,
    };
}

export function siblingHostEntry() {
    return { agent: 'fixtures/explorer', routerSurfaces: [...OWNER_SURFACES] };
}

export function desiredFor(mode, { root = rootHostEntry() } = {}) {
    const hosts = {};
    if (mode === 'dual' || mode === 'single') hosts[rootHost] = root;
    if (mode === 'dual' || mode === 'legacy') hosts[siblingHost] = siblingHostEntry();
    return {
        hosts,
        cloudflare: {
            accountId: 'fixture-account', zoneId: 'fixture-zone', tunnelName: 'fixture-tunnel',
            apiTokenSecret: 'publication/fixture-api', deleteTunnelOnTeardown: true,
        },
    };
}

export function domainFixture(t, { mode = 'dual', manifests = {} } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'root-application-')));
    const saved = Object.fromEntries(['PLOINKY_WORKSPACE_ROOT', 'PLOINKY_ROUTER_HOST_PORT', 'PLOINKY_MEDIA_HOST_PORT']
        .map(name => [name, process.env[name]]));
    process.env.PLOINKY_WORKSPACE_ROOT = root;
    process.env.PLOINKY_ROUTER_HOST_PORT = '18080';
    process.env.PLOINKY_MEDIA_HOST_PORT = '17891';
    t.after(() => {
        for (const [name, value] of Object.entries(saved)) {
            if (value === undefined) delete process.env[name];
            else process.env[name] = value;
        }
        fs.rmSync(root, { recursive: true, force: true });
    });
    const options = { workspaceRoot: root };
    const { paths } = edge.initializeFreshEdgeRoutingSources(options);
    const write = (file, value) => fs.writeFileSync(file, JSON.stringify(value, null, 2));
    const routing = { routes: {} };
    const agents = {};
    for (const [index, name] of Object.keys(MANIFESTS).entries()) {
        const hostPath = path.join(root, 'fixtures', name);
        fs.mkdirSync(hostPath, { recursive: true });
        write(path.join(hostPath, 'manifest.json'), manifests[name] ?? MANIFESTS[name]);
        routing.routes[name] = {
            repo: 'fixtures', agent: name, container: `${name}-container`, hostPath, hostPort: 43101 + index,
        };
        agents[`${name}-container`] = {
            type: 'agent', repoName: 'fixtures', agentName: name, instanceId: `${name}-instance`,
            enableGeneration: `${name}-enable`, runtime: 'podman', containerId: hash(name).slice(7),
            auth: { mode: 'sso' },
        };
    }
    write(paths.routingFile, routing);
    write(paths.agentsFile, agents);
    const desired = desiredFor(mode);
    write(paths.desiredFile, desired);
    const apply = () => edge.applyEdgeRoutingGeneration({ ...options, publicationState: 'ready' });
    apply();
    const active = () => edge.loadActiveEdgeRoutingGeneration(options);
    const plan = (url = '/', host = rootHost, transport = 'http', method = 'GET', headers = {}) => resolveEdgeRoutePlan({
        req: { url, method, headers: { host, origin: `https://${host}`, ...headers } }, transport,
    });
    return { root, paths, options, write, routing, agents, desired, apply, active, plan };
}
