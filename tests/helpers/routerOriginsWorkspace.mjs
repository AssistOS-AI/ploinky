// Real edge-generation workspace and private-listener caller for Router-origin
// tests. The consumer is a generic fixture agent; no optional agent is needed.

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { signPrivateRouterAssertion } from '../../Agent/lib/agentAssertion.mjs';
import { applyEdgeRoutingGeneration } from '../../cli/sandbox/edgeGeneration.js';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import {
    authorizePrivateRoutePlan,
    readPrivateRequestBody,
    sendPrivateError,
    sendRuntimeRouterOrigins,
} from '../../cli/server/privateRouter.js';
import { derivePrivateAgentRequestSecret } from '../../cli/utils/security/masterKey.js';

export const CONSUMER = Object.freeze({
    agentId: 'agent:fixtures/consumer',
    instanceId: '11111111-2222-4333-8444-555555555555',
    enableGeneration: '66666666-7777-4888-8999-aaaaaaaaaaaa',
    containerName: 'consumer-container',
});

const ENV_NAMES = [
    'PLOINKY_MASTER_KEY',
    'PLOINKY_WORKSPACE_ROOT',
    'PLOINKY_ROUTER_HOST_PORT',
    'PLOINKY_MEDIA_HOST_PORT',
    'PLOINKY_PUBLIC_ROUTER_HOSTS',
];

const RESTORED_TESTS = new WeakSet();

// One restore per test, captured before its first change, so several fixtures
// in one test cannot restore each other's values out of order.
export function setEnvironment(t, values) {
    if (!RESTORED_TESTS.has(t)) {
        RESTORED_TESTS.add(t);
        const previous = Object.fromEntries(ENV_NAMES.map((name) => [name, process.env[name]]));
        t.after(() => {
            for (const [name, value] of Object.entries(previous)) {
                if (value === undefined) delete process.env[name];
                else process.env[name] = value;
            }
        });
    }
    for (const [name, value] of Object.entries(values)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
}

export function stableValue(value) {
    if (Array.isArray(value)) return value.map(stableValue);
    if (value && typeof value === 'object') {
        return Object.fromEntries(Object.keys(value).sort().map((key) => [key, stableValue(value[key])]));
    }
    return value;
}

export function sha256(bytes) {
    return `sha256:${crypto.createHash('sha256').update(bytes).digest('hex')}`;
}

// The generation identity format: length-prefixed labelled source parts.
export function digestGenerationParts(parts) {
    const hash = crypto.createHash('sha256');
    for (const [name, bytes] of parts) {
        const label = Buffer.from(name, 'utf8');
        hash.update(`${label.length}:`);
        hash.update(label);
        hash.update(`:${bytes.length}:`);
        hash.update(bytes);
        hash.update('\n');
    }
    return `sha256:${hash.digest('hex')}`;
}

export function generationDocumentFile(edgeDir, generation) {
    return path.join(edgeDir, 'generations', `${generation.replace(/^sha256:/, '')}.json`);
}

export function readGenerationDocument(edgeDir, generation) {
    return JSON.parse(fs.readFileSync(generationDocumentFile(edgeDir, generation), 'utf8'));
}

export function generationSourceParts(document, { withPublicHosts = true } = {}) {
    const decode = (value) => Buffer.from(value, 'base64');
    const { sources } = document;
    return [
        ['routing.json', decode(sources.routing)],
        ['policy-state.json', decode(sources.policy)],
        ['edge-desired.json', decode(sources.desired)],
        ['agents.json', decode(sources.agents)],
        ['router-host-port', decode(sources.routerHostPort)],
        ['media-host-port', decode(sources.mediaHostPort)],
        ...(withPublicHosts ? [['router-public-hosts', decode(sources.routerPublicHosts)]] : []),
        ...Object.keys(sources.manifests).sort().map((key) => [`manifest:${key}`, decode(sources.manifests[key])]),
    ];
}

export function selectActiveGeneration(edgeDir, generation) {
    const body = {
        schemaVersion: 1,
        state: 'active',
        generation,
        publicationState: 'ready',
        activationId: crypto.randomUUID(),
        activatedAt: new Date().toISOString(),
    };
    const selector = { ...body, selectorDigest: sha256(Buffer.from(JSON.stringify(stableValue(body)))) };
    fs.writeFileSync(path.join(edgeDir, 'active.json'), JSON.stringify(selector, null, 2));
    return selector;
}

// Rewrite one document without its public Router hosts source, with a digest
// that is otherwise self-consistent, then select it. Such a generation is an
// unsupported shape that every loader must reject as corrupt.
export function installGenerationWithoutPublicHosts(edgeDir, current) {
    const document = readGenerationDocument(edgeDir, current);
    const parts = generationSourceParts(document, { withPublicHosts: false });
    delete document.sources.routerPublicHosts;
    delete document.sourceDigests.routerPublicHosts;
    document.generation = digestGenerationParts(parts);
    fs.writeFileSync(generationDocumentFile(edgeDir, document.generation), JSON.stringify(document, null, 2));
    return selectActiveGeneration(edgeDir, document.generation);
}

/** Select the host-created Box publication inputs used by the next capture. */
export function selectBinding({ hosts, routerHostPort = 3000, mediaHostPort = 17891 } = {}) {
    if (hosts === undefined) delete process.env.PLOINKY_PUBLIC_ROUTER_HOSTS;
    else process.env.PLOINKY_PUBLIC_ROUTER_HOSTS = JSON.stringify(hosts);
    process.env.PLOINKY_ROUTER_HOST_PORT = String(routerHostPort);
    process.env.PLOINKY_MEDIA_HOST_PORT = String(mediaHostPort);
}

export function createRouterOriginsWorkspace(t, {
    hosts,
    routerHostPort = 3000,
    masterKey = '5'.repeat(64),
    apply = true,
} = {}) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-router-origins-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    const consumerDir = path.join(ploinkyDir, 'repos', 'fixtures', 'consumer');
    fs.mkdirSync(edgeDir, { recursive: true });
    fs.mkdirSync(policyDir, { recursive: true });
    fs.mkdirSync(consumerDir, { recursive: true });
    fs.writeFileSync(path.join(consumerDir, 'manifest.json'), JSON.stringify({
        routerAccess: {
            httpRoutes: [{ path: '/base-agent-additional-server/consumer/7000/*', access: 'authenticated' }],
        },
    }, null, 2));
    fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        static: { agent: 'consumer', port: 7777 },
        routes: {
            consumer: {
                repo: 'fixtures',
                agent: 'consumer',
                container: CONSUMER.containerName,
                hostPath: consumerDir,
                hostPort: 43111,
            },
        },
    }, null, 2));
    fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        [CONSUMER.containerName]: {
            type: 'agent',
            repoName: 'fixtures',
            agentName: 'consumer',
            instanceId: CONSUMER.instanceId,
            enableGeneration: CONSUMER.enableGeneration,
            auth: { mode: 'sso' },
        },
    }, null, 2));
    fs.writeFileSync(path.join(edgeDir, 'desired.json'), JSON.stringify({ hosts: {} }, null, 2));
    fs.writeFileSync(path.join(policyDir, 'policy-state.json'), JSON.stringify({
        schema: 'router-policy',
        httpRoutes: [],
        mcpTools: [],
    }, null, 2));
    setEnvironment(t, { PLOINKY_MASTER_KEY: masterKey, PLOINKY_WORKSPACE_ROOT: workspace });
    selectBinding({ hosts, routerHostPort });
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    const applied = apply
        ? applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'router-origins-fixture', publicationState: 'ready' })
        : null;
    return { workspace, ploinkyDir, edgeDir, consumerDir, applied };
}

export function consumerAssertionEnv(overrides = {}) {
    const identity = { ...CONSUMER, ...overrides };
    return {
        PLOINKY_AGENT_ID: identity.agentId,
        PLOINKY_AGENT_INSTANCE_ID: identity.instanceId,
        PLOINKY_AGENT_ENABLE_GENERATION: identity.enableGeneration,
        PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(
            identity.agentId,
            identity.instanceId,
            identity.enableGeneration,
        ),
    };
}

export function signedRuntimeOriginsHeaders(env = consumerAssertionEnv()) {
    return {
        host: 'host.containers.internal:8081',
        'ploinky-agent-assertion': signPrivateRouterAssertion({
            method: 'GET',
            path: '/api/edge/runtime-origins',
            env,
        }),
    };
}

export class MockResponse {
    constructor() {
        this.statusCode = 0;
        this.headers = {};
        this.body = '';
    }

    writeHead(statusCode, headers = {}) {
        this.statusCode = statusCode;
        this.headers = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
    }

    end(chunk = '') {
        this.body += chunk ? String(chunk) : '';
    }

    json() {
        return JSON.parse(this.body);
    }
}

/**
 * The private listener's runtime-origins pipeline, in RoutingServer order:
 * exact route plan, bounded body, caller authorization, lease-checked reply.
 */
export async function handlePrivateRuntimeOrigins(req, res, {
    beforeReply = null,
    listener = 'private',
} = {}) {
    req.ploinkyListenerClass = listener;
    const parsedUrl = new URL(req.url || '/', `http://${req.headers.host}`);
    const plan = resolveEdgeRoutePlan({ req, parsedUrl, listener });
    if (!plan.ok) {
        res.writeHead(plan.status || 404, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ error: plan.code || 'private_route_denied' }));
        return plan;
    }
    const body = await readPrivateRequestBody(req);
    try {
        authorizePrivateRoutePlan({ req, plan, body });
    } catch (error) {
        sendPrivateError(res, error);
        return plan;
    }
    if (typeof beforeReply === 'function') await beforeReply(plan);
    sendRuntimeRouterOrigins(res, { plan, body, callerIdentity: req.privateAgentIdentity });
    return plan;
}

/** A local HTTP private listener serving only the runtime-origins pipeline. */
export async function startPrivateOriginsListener(t, options = {}) {
    const requests = [];
    const server = http.createServer((req, res) => {
        requests.push({ method: req.method, url: req.url });
        handlePrivateRuntimeOrigins(req, res, options).catch((error) => {
            if (!res.headersSent) sendPrivateError(res, Object.assign(error, { status: 500 }));
        });
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    return { server, requests, url: `http://127.0.0.1:${server.address().port}` };
}
