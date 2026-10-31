// The private `GET /api/edge/runtime-sources` operation on a real edge
// generation: exact route plan, execution-provider holder ACL, lease-checked
// reply and the source list derived only from the lease snapshot. Generic
// fixture names stand for the SPEC's example repositories: `suite` is a
// workspace-origin agent repository, `Docs` a link-install with a checkout of
// its own name, `Language` a link-install not cloned yet.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { signPrivateRouterAssertion } from '../../Agent/lib/agentAssertion.mjs';
import { applyEdgeRoutingGeneration } from '../../cli/sandbox/edgeGeneration.js';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import { authorizePrivateRoutePlan, readPrivateRequestBody, sendPrivateError } from '../../cli/server/privateRouter.js';
import { buildRuntimeSourcesResponse, sendRuntimeSources } from '../../cli/server/runtimeSources.mjs';
import { linkedRepositoryPins, prepareLinkedRepositories } from '../../cli/utils/linkInstall.mjs';
import { derivePrivateAgentRequestSecret } from '../../cli/utils/security/masterKey.js';
import { MockResponse, selectBinding, setEnvironment } from '../helpers/routerOriginsWorkspace.mjs';

const PATH = '/api/edge/runtime-sources';
const DOCS_URL = 'https://github.com/example/Docs.git';
const LANGUAGE_URL = 'https://github.com/example/Language.git';
const HOLDER = Object.freeze({
    agentId: 'agent:suite/coordinator',
    instanceId: '11111111-2222-4333-8444-555555555555',
    enableGeneration: '66666666-7777-4888-8999-aaaaaaaaaaaa',
});
const PLAIN = Object.freeze({
    agentId: 'agent:suite/plain',
    instanceId: '21111111-2222-4333-8444-555555555555',
    enableGeneration: '76666666-7777-4888-8999-aaaaaaaaaaaa',
});

function writeJson(file, value) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function gitCheckout(directory, origin) {
    fs.mkdirSync(path.join(directory, '.git'), { recursive: true });
    fs.writeFileSync(path.join(directory, '.git', 'origin'), origin);
}

/**
 * A real edge generation whose snapshot carries: a routed holder agent in a
 * workspace checkout, with /Agent and /code binds and two link-install
 * declarations; a routed non-holder agent; and a routed agent outside the
 * workspace. `holderRecord` overrides fields of the holder's registry record.
 */
function createSourcesWorkspace(t, { holderRecord = {}, holderManifest = {}, docsCheckout = 'Docs' } = {}) {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-sources-')));
    const outsideRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-runtime-sources-outside-')));
    t.after(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    });
    const ploinkyDir = path.join(workspace, '.ploinky');
    const holderDir = path.join(workspace, 'suite', 'coordinator');
    const plainDir = path.join(workspace, 'suite', 'plain');
    const outsideDir = path.join(outsideRoot, 'elsewhere', 'remote');
    writeJson(path.join(holderDir, 'manifest.json'), {
        container: 'node:20',
        executionProvider: { version: 1, port: 7300, taskReferences: { path: '/coordinator/task-refs' } },
        'link-install': [DOCS_URL, LANGUAGE_URL],
        ...holderManifest,
    });
    writeJson(path.join(plainDir, 'manifest.json'), { container: 'node:20' });
    writeJson(path.join(outsideDir, 'manifest.json'), { container: 'node:20' });
    gitCheckout(path.join(workspace, docsCheckout), DOCS_URL);
    fs.mkdirSync(path.join(workspace, 'ploinky', 'Agent'), { recursive: true });
    fs.mkdirSync(path.join(workspace, 'achillesAgentLib'), { recursive: true });
    writeJson(path.join(ploinkyDir, 'routing.json'), {
        static: { agent: 'coordinator', port: 7777 },
        routes: {
            coordinator: { repo: 'suite', agent: 'coordinator', container: 'holder', hostPath: holderDir, hostPort: 43111 },
            plain: { repo: 'suite', agent: 'plain', container: 'plain-container', hostPath: plainDir, hostPort: 43112 },
            remote: { repo: 'elsewhere', agent: 'remote', container: 'remote-container', hostPath: outsideDir, hostPort: 43113 },
        },
    });
    writeJson(path.join(ploinkyDir, 'agents.json'), {
        holder: {
            type: 'agent',
            repoName: 'suite',
            agentName: 'coordinator',
            instanceId: HOLDER.instanceId,
            enableGeneration: HOLDER.enableGeneration,
            auth: { mode: 'sso' },
            config: {
                binds: [
                    { source: path.join(workspace, 'ploinky', 'Agent'), target: '/Agent' },
                    { source: holderDir, target: '/code' },
                    // A podman-staged /Agent copy lives in Ploinky's own state.
                    { source: path.join(ploinkyDir, 'container-runtime', 'holder', 'Agent'), target: '/Agent' },
                ],
            },
            ...holderRecord,
        },
        'plain-container': {
            type: 'agent',
            repoName: 'suite',
            agentName: 'plain',
            instanceId: PLAIN.instanceId,
            enableGeneration: PLAIN.enableGeneration,
            auth: { mode: 'sso' },
        },
        'remote-container': {
            type: 'agent',
            repoName: 'elsewhere',
            agentName: 'remote',
            instanceId: '31111111-2222-4333-8444-555555555555',
            enableGeneration: '86666666-7777-4888-8999-aaaaaaaaaaaa',
            auth: { mode: 'sso' },
        },
    });
    writeJson(path.join(ploinkyDir, 'data', 'edge-routing', 'desired.json'), { hosts: {} });
    writeJson(path.join(ploinkyDir, 'data', 'router-security', 'policy-state.json'), {
        schema: 'router-policy', httpRoutes: [], mcpTools: [],
    });
    setEnvironment(t, { PLOINKY_MASTER_KEY: '5'.repeat(64), PLOINKY_WORKSPACE_ROOT: workspace });
    selectBinding({ hosts: ['pgx'] });
    const applied = applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'runtime-sources-fixture', publicationState: 'ready' });
    return { workspace, outsideRoot, ploinkyDir, holderDir, applied };
}

function sourceOptions(fixture) {
    return {
        workspaceRoot: fixture.workspace,
        agentLibPath: path.join(fixture.workspace, 'ploinky', 'Agent'),
        agentLibSelection: () => ({ mode: 'local', sourceDir: path.join(fixture.workspace, 'achillesAgentLib') }),
    };
}

function assertionEnv(identity) {
    return {
        PLOINKY_AGENT_ID: identity.agentId,
        PLOINKY_AGENT_INSTANCE_ID: identity.instanceId,
        PLOINKY_AGENT_ENABLE_GENERATION: identity.enableGeneration,
        PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(identity.agentId, identity.instanceId, identity.enableGeneration),
    };
}

function signedHeaders(identity = HOLDER, { method = 'GET', query = '', body = Buffer.alloc(0) } = {}) {
    return {
        host: 'host.containers.internal:8081',
        'ploinky-agent-assertion': signPrivateRouterAssertion({ method, path: PATH, query, body, env: assertionEnv(identity) }),
    };
}

async function call(fixture, { method = 'GET', url = PATH, headers = signedHeaders(), body, options = sourceOptions(fixture), beforeReply } = {}) {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(body)]), { method, url, headers, ploinkyListenerClass: 'private' });
    const res = new MockResponse();
    const audit = [];
    const plan = resolveEdgeRoutePlan({ req, parsedUrl: new URL(url, `http://${headers.host}`), listener: 'private' });
    if (!plan.ok) {
        res.writeHead(plan.status || 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: plan.code || 'private_route_denied' }));
        return { res, audit, plan };
    }
    const raw = await readPrivateRequestBody(req);
    try {
        authorizePrivateRoutePlan({ req, plan, body: raw });
    } catch (error) {
        sendPrivateError(res, error);
        return { res, audit, plan };
    }
    if (beforeReply) await beforeReply(plan);
    sendRuntimeSources(res, { plan, body: raw, callerIdentity: req.privateAgentIdentity,
        audit: (event, value) => audit.push({ event, value }), ...options });
    return { res, audit, plan };
}

test('AC7: a holder reads the active sources as workspace-relative repository roots with outside roots counted', async (t) => {
    const fixture = createSourcesWorkspace(t);
    const { res, audit } = await call(fixture);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.deepEqual(res.json(), {
        schemaVersion: 1,
        authorizationGeneration: fixture.applied.selector.generation,
        activationId: fixture.applied.selector.activationId,
        sources: [
            { kind: 'linked-repository', relativePath: 'Docs' },
            { kind: 'linked-repository', relativePath: 'Language' },
            { kind: 'agent-runtime-library', relativePath: 'achillesAgentLib' },
            { kind: 'agent-library', relativePath: 'ploinky' },
            { kind: 'agent-repository', relativePath: 'suite' },
        ],
        outsideWorkspace: 1,
    });
    // No host path leaks, and the audit carries counts only.
    assert.doesNotMatch(res.body, new RegExp(fixture.workspace.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(res.body, /elsewhere|container-runtime|\.ploinky/);
    assert.deepEqual(audit.map(({ event }) => event), ['runtime_sources_served']);
    assert.deepEqual(audit[0].value, {
        callerAgentId: HOLDER.agentId,
        generation: fixture.applied.selector.generation,
        sources: 5,
        kinds: { 'agent-repository': 1, 'agent-library': 1, 'agent-runtime-library': 1, 'linked-repository': 2 },
        outsideWorkspace: 1,
    });
});

test('AC7: a non-holder current agent is refused with 403; an unsigned caller with 401', async (t) => {
    const fixture = createSourcesWorkspace(t);
    const plain = await call(fixture, { headers: signedHeaders(PLAIN) });
    assert.equal(plain.res.statusCode, 403, plain.res.body);
    assert.equal(plain.res.json().error, 'PRIVATE_CALLER_DENIED');
    assert.deepEqual(plain.audit, []);
    const unsigned = await call(fixture, { headers: { host: 'host.containers.internal:8081' } });
    assert.equal(unsigned.res.statusCode, 401);
    const holder = await call(fixture);
    assert.equal(holder.res.statusCode, 200);
});

test('AC7: a query, an alias spelling, another method or a body gets 400 before any source is computed', async (t) => {
    const fixture = createSourcesWorkspace(t);
    for (const url of [`${PATH}?`, `${PATH}?refresh=1`, '/api/edge/./runtime-sources']) {
        const query = url.includes('?') ? url.slice(url.indexOf('?')) : '';
        const { res } = await call(fixture, { url, headers: signedHeaders(HOLDER, { query }) });
        assert.equal(res.statusCode, 400, url);
        assert.equal(res.json().error, 'RUNTIME_SOURCES_REQUEST_INVALID', url);
    }
    const post = await call(fixture, { method: 'POST', headers: signedHeaders(HOLDER, { method: 'POST' }) });
    assert.equal(post.res.statusCode, 400);
    assert.equal(post.res.json().error, 'RUNTIME_SOURCES_REQUEST_INVALID');
    const body = Buffer.from('{}');
    const withBody = await call(fixture, { headers: signedHeaders(HOLDER, { body }), body });
    assert.equal(withBody.res.statusCode, 400);
    assert.equal(withBody.res.json().error, 'RUNTIME_SOURCES_REQUEST_INVALID');
    for (const [listener, host] of [['public', 'localhost:3000'], ['managed', 'host.containers.internal:8080']]) {
        const plan = resolveEdgeRoutePlan({ req: { method: 'GET', url: PATH, headers: { ...signedHeaders(), host } }, listener });
        assert.notEqual(plan.operation, 'runtime-sources', `${listener} ${host}`);
    }
});

test('AC7: a lease change before the reply, or a plan without the exact lease, gives 503 and no list', async (t) => {
    const fixture = createSourcesWorkspace(t);
    const raced = await call(fixture, {
        beforeReply: () => applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'runtime-sources-race' }),
    });
    assert.equal(raced.res.statusCode, 503);
    assert.equal(raced.res.json().error, 'edge_generation_changed');
    assert.deepEqual(raced.audit.map(({ event, value }) => [event, value.code]), [['runtime_sources_rejected', 'edge_generation_changed']]);

    const { plan } = await call(fixture);
    assert.throws(() => buildRuntimeSourcesResponse({ ...plan, lease: { ...plan.lease, snapshot: {} } }, sourceOptions(fixture)),
        { code: 'RUNTIME_SOURCES_LEASE_INVALID', status: 503 });
    assert.throws(() => buildRuntimeSourcesResponse({ ...plan, listener: 'public' }, sourceOptions(fixture)),
        { code: 'PRIVATE_LISTENER_REQUIRED' });
});

test('AC7 (F3 delta): a source equal to or containing the workspace root, or an unavailable selection, gives 503', async (t) => {
    const fixture = createSourcesWorkspace(t);
    for (const options of [
        { ...sourceOptions(fixture), agentLibSelection: () => ({ mode: 'local', sourceDir: fixture.workspace }) },
        { ...sourceOptions(fixture), agentLibSelection: () => ({ mode: 'local', sourceDir: path.dirname(fixture.workspace) }) },
        { ...sourceOptions(fixture), agentLibPath: path.join(fixture.workspace, 'Agent') },
        { ...sourceOptions(fixture), agentLibSelection: () => { throw new Error('PLOINKY_AGENTLIB_DIR is not set'); } },
    ]) {
        const { res, audit } = await call(fixture, { options });
        assert.equal(res.statusCode, 503, res.body);
        assert.equal(res.json().error, 'RUNTIME_SOURCES_UNAVAILABLE');
        assert.deepEqual(Object.keys(res.json()).sort(), ['error', 'ok'], 'never a partial list');
        assert.deepEqual(audit.map(({ event, value }) => [event, value.code]), [['runtime_sources_rejected', 'RUNTIME_SOURCES_UNAVAILABLE']]);
    }
    // An image-supplied AgentLib is part of the Box image, not of the workspace.
    const image = await call(fixture, { options: { ...sourceOptions(fixture), agentLibSelection: () => ({ mode: 'image', sourceDir: '/opt/agentlib' }) } });
    assert.equal(image.res.statusCode, 200);
    assert.equal(image.res.json().sources.some(({ kind }) => kind === 'agent-runtime-library'), false);
});

test('AC7: a malformed recorded link-install list gives 503, and empty recorded lists report no linked repository', async (t) => {
    const malformed = createSourcesWorkspace(t, { holderRecord: { linkedRepositories: { Docs: '/x' } } });
    const refused = await call(malformed);
    assert.equal(refused.res.statusCode, 503);
    assert.equal(refused.res.json().error, 'RUNTIME_SOURCES_UNAVAILABLE');

    const recordedNone = createSourcesWorkspace(t, { holderRecord: { linkedRepositories: [] } });
    const answer = await call(recordedNone);
    assert.equal(answer.res.statusCode, 200, answer.res.body);
    assert.equal(answer.res.json().sources.some(({ kind }) => kind === 'linked-repository'), false,
        'a launch-recorded list is authoritative; the manifest is not read lexically for it');
});

test('AC8: the route reports exactly the link-install checkouts the launch resolved and recorded, without resolving again', async (t) => {
    // The Docs declaration matches a checkout under another folder name by
    // its Git origin; Language is cloned by the launch.
    const fixture = createSourcesWorkspace(t, { docsCheckout: 'docs-checkout' });
    const execFile = (command, args) => {
        assert.equal(command, 'git');
        if (args.includes('clone')) {
            gitCheckout(args.at(-1), args.at(-2));
            return '';
        }
        return fs.readFileSync(path.join(args[1], '.git', 'origin'), 'utf8');
    };
    const manifest = JSON.parse(fs.readFileSync(path.join(fixture.holderDir, 'manifest.json'), 'utf8'));
    const launched = prepareLinkedRepositories(manifest, { workspaceRoot: fixture.workspace, execFile, writable: false });
    // The launch record keeps exactly what agentServiceManager records.
    const recorded = linkedRepositoryPins(manifest, launched);
    assert.deepEqual(recorded.map(({ name, origin, realpath }) => [name, origin, path.relative(fixture.workspace, realpath)]),
        [['Docs', 'github.com/example/docs', 'docs-checkout'], ['Language', 'github.com/example/language', 'Language']]);
    const agentsFile = path.join(fixture.ploinkyDir, 'agents.json');
    const agents = JSON.parse(fs.readFileSync(agentsFile, 'utf8'));
    agents.holder.linkedRepositories = recorded;
    fs.writeFileSync(agentsFile, JSON.stringify(agents, null, 2));
    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'runtime-sources-recorded', publicationState: 'ready' });

    const { res } = await call(fixture);
    assert.equal(res.statusCode, 200, res.body);
    const linked = res.json().sources.filter(({ kind }) => kind === 'linked-repository').map(({ relativePath }) => relativePath);
    assert.deepEqual(linked, recorded.map(({ realpath }) => path.relative(fixture.workspace, realpath)).sort(),
        'reported linked repositories equal the launch-resolved sources');
    assert.equal(linked.includes('Docs'), false, 'the lexical default is not reported for a recorded record');
});

test('AC8: a record without the recorded field reports its manifest link-install names lexically, never by a search', async (t) => {
    const fixture = createSourcesWorkspace(t);
    // A checkout elsewhere with the Language origin is not searched for.
    gitCheckout(path.join(fixture.workspace, 'language-elsewhere'), LANGUAGE_URL);
    applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'runtime-sources-lexical', publicationState: 'ready' });
    const { res } = await call(fixture);
    assert.equal(res.statusCode, 200, res.body);
    const linked = res.json().sources.filter(({ kind }) => kind === 'linked-repository').map(({ relativePath }) => relativePath);
    assert.deepEqual(linked, ['Docs', 'Language']);
});
