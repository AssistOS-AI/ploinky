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
import { buildAgentImagesResponse, sendAgentImages } from '../../cli/server/agentImages.mjs';
import { derivePrivateAgentRequestSecret } from '../../cli/utils/security/masterKey.js';
import { MockResponse, selectBinding, setEnvironment } from '../helpers/routerOriginsWorkspace.mjs';

const PATH = '/api/edge/agent-images';
const PIN = `sha256:${'a'.repeat(64)}`;
const IMAGE_ID = `sha256:${'b'.repeat(64)}`;
const OTHER = `sha256:${'c'.repeat(64)}`;
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
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-images-')));
    const outsideRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-images-outside-')));
    t.after(() => {
        fs.rmSync(workspace, { recursive: true, force: true });
        fs.rmSync(outsideRoot, { recursive: true, force: true });
    });
    const ploinkyDir = path.join(workspace, '.ploinky');
    const holderDir = path.join(workspace, 'suite', 'coordinator');
    const plainDir = path.join(workspace, 'suite', 'plain');
    const outsideDir = path.join(outsideRoot, 'elsewhere', 'remote');
    writeJson(path.join(holderDir, 'manifest.json'), {
        container: `docker.io/library/node:20@${PIN}`,
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
    const applied = applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'agent-images-fixture', publicationState: 'ready' });
    const query = () => ({ status: 0, stdout: JSON.stringify([{ Id: IMAGE_ID, RepoDigests: [] }]) });
    return { workspace, outsideRoot, ploinkyDir, holderDir, applied, query };
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

async function call(fixture, { method = 'GET', url = PATH, headers = signedHeaders(), body, options = { query: fixture.query }, beforeReply } = {}) {
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
    await sendAgentImages(res, { plan, body: raw, callerIdentity: req.privateAgentIdentity,
        audit: (event, value) => audit.push({ event, value }), ...options });
    return { res, audit, plan };
}

test('A8: only a current execution provider reads pinned manifest identities from the lease snapshot', async (t) => {
    const fixture = createSourcesWorkspace(t);
    const answer = await call(fixture);
    assert.equal(answer.res.statusCode, 200, answer.res.body);
    assert.equal(answer.res.headers['cache-control'], 'no-store');
    assert.deepEqual(answer.res.json().agents.find(({ ref }) => ref === 'suite/coordinator'), {
        ref: 'suite/coordinator', about: '', enableMode: 'isolated', runtime: 'podman',
        image: { reference: 'docker.io/library/node', digest: PIN, imageId: IMAGE_ID }, reason: null,
    });
    const denied = await call(fixture, { headers: signedHeaders(PLAIN) });
    assert.equal(denied.res.statusCode, 403);
    assert.equal(denied.res.json().error, 'PRIVATE_CALLER_DENIED');
    // Neither response nor audit exports container configuration or filesystem state.
    assert.deepEqual(Object.keys(answer.res.json()).sort(), ['agents', 'schemaVersion']);
    assert.deepEqual(answer.audit, [{ event: 'agent_images_served', value: { agents: 3 } }]);
});

test('bare bodyless GET only; query, alias, fragment, method and public surface are refused', async (t) => {
    const fixture = createSourcesWorkspace(t);
    for (const url of [`${PATH}?`, `${PATH}?x=1`, `${PATH}#x`, '/api/edge/a/../agent-images', '/api/edge/%61gent-images']) {
        const { res, plan } = await call(fixture, { url });
        assert.notEqual(res.statusCode, 200, url);
        assert.notEqual(plan.ok, true, url);
    }
    const post = await call(fixture, { method: 'POST', headers: signedHeaders(HOLDER, { method: 'POST' }) });
    assert.equal(post.res.statusCode, 400);
    const body = Buffer.from('{}');
    assert.equal((await call(fixture, { headers: signedHeaders(HOLDER, { body }), body })).res.statusCode, 400);
    for (const listener of ['public', 'managed']) {
        const plan = resolveEdgeRoutePlan({ req: { method: 'GET', url: PATH, headers: signedHeaders() }, listener });
        assert.notEqual(plan.operation, 'agent-images');
    }
});

test('lease invalidity and a generation change during async inspect produce 503 without a partial answer', async (t) => {
    const fixture = createSourcesWorkspace(t);
    const { plan } = await call(fixture);
    await assert.rejects(buildAgentImagesResponse({ ...plan, lease: { ...plan.lease, snapshot: {} } }),
        { code: 'AGENT_IMAGES_LEASE_INVALID', status: 503 });
    await assert.rejects(buildAgentImagesResponse({ ...plan, listener: 'public' }), { status: 403 });
    const query = async () => {
        applyEdgeRoutingGeneration({ workspaceRoot: fixture.workspace, reason: 'images-race' });
        return { status: 0, stdout: JSON.stringify([{ Id: IMAGE_ID, RepoDigests: [] }]) };
    };
    const raced = await call(fixture, { options: { query } });
    assert.equal(raced.res.statusCode, 503);
    assert.deepEqual(raced.res.json(), { ok: false, error: 'edge_generation_changed' });
});

test('digest pin wins; tags require exactly one matching repository RepoDigest; native and absent images have reasons', async (t) => {
    const fixture = createSourcesWorkspace(t);
    const { plan } = await call(fixture);
    const withManifest = (container, overrides = {}) => {
        const snapshot = structuredClone(plan.snapshot);
        snapshot.manifests.coordinator.container = container;
        Object.assign(snapshot.agents.holder, overrides);
        return { ...plan, snapshot, lease: { ...plan.lease, snapshot } };
    };
    const inspect = (RepoDigests) => () => ({ status: 0, stdout: JSON.stringify([{ Id: IMAGE_ID, RepoDigests }]) });
    const get = async (current, query) => (await buildAgentImagesResponse(current, { query })).agents
        .find(({ ref }) => ref === 'suite/coordinator');
    assert.equal((await get(withManifest(`node:20@${PIN}`), inspect([`docker.io/library/node@${OTHER}`]))).image.digest, PIN);
    const tag = await get(withManifest('node:20'), inspect([`other.io/library/node@${OTHER}`, `docker.io/library/node@${PIN}`]));
    assert.equal(tag.image.digest, PIN);
    for (const digests of [[], [`other.io/library/node@${PIN}`], [`docker.io/library/node@${PIN}`, `docker.io/library/node@${OTHER}`]]) {
        assert.equal((await get(withManifest('node:20'), inspect(digests))).reason, 'digest_unknown');
    }
    assert.equal((await get(withManifest('node:20', { runtime: 'bwrap' }), inspect([]))).reason, 'not_container');
    const missing = () => ({ status: 125, stderr: 'Error: image not known' });
    assert.equal((await get(withManifest(`node@${PIN}`), missing)).image.imageId, null);
    assert.equal((await get(withManifest('node:20'), missing)).reason, 'digest_unknown');
});

test('resolved lease image is authoritative over a raw manifest template for tags and digest pins', async (t) => {
    setEnvironment(t, { SERVICE_VERSION: 'must-not-be-read' });
    for (const resolved of ['registry.example/service:v1.2.3', `registry.example/service:v1.2.3@${PIN}`]) {
        const fixture = createSourcesWorkspace(t, {
            holderManifest: { container: 'registry.example/service:${SERVICE_VERSION}' },
            holderRecord: { containerImage: resolved },
        });
        const inspected = [];
        const query = (command, args) => {
            inspected.push(args.at(-1));
            return { status: 0, stdout: JSON.stringify([{ Id: IMAGE_ID,
                RepoDigests: [`registry.example/service@${resolved.includes('@') ? OTHER : PIN}`] }]) };
        };
        const { res } = await call(fixture, { options: { query } });
        assert.equal(res.statusCode, 200, res.body);
        const agent = res.json().agents.find(({ ref }) => ref === 'suite/coordinator');
        assert.deepEqual(agent.image, { reference: 'registry.example/service', digest: PIN, imageId: IMAGE_ID });
        assert.equal(agent.reason, null);
        assert.equal(inspected[0], resolved);
        assert.equal(inspected.some((value) => value.includes('${') || value.includes('must-not-be-read')), false);
    }
});

test('unresolved image template without a resolved lease image is unavailable before any inspect', async (t) => {
    setEnvironment(t, { SERVICE_VERSION: 'must-not-be-read' });
    const fixture = createSourcesWorkspace(t, {
        holderManifest: { container: 'registry.example/service:${SERVICE_VERSION}' },
    });
    let calls = 0;
    const query = () => {
        calls += 1;
        return { status: 0, stdout: JSON.stringify([{ Id: IMAGE_ID,
            RepoDigests: [`registry.example/service@${PIN}`] }]) };
    };
    const { res } = await call(fixture, { options: { query } });
    assert.equal(res.statusCode, 503);
    assert.deepEqual(res.json(), { ok: false, error: 'AGENT_IMAGES_UNAVAILABLE' });
    assert.equal(calls, 0);
});

test('inspect cache single-flights exact lease/reference and keeps immutable IDs when a tag moves', async (t) => {
    const fixture = createSourcesWorkspace(t, { holderManifest: { container: 'node:20' } });
    let count = 0;
    const query = async (command, args, options) => {
        count += 1;
        assert.equal(command, 'podman');
        assert.deepEqual(args, ['image', 'inspect', '--', 'node:20']);
        assert.equal(options.shell, undefined);
        assert.ok(options.timeout > 0 && options.timeout <= 2000);
        assert.equal(options.maxBuffer, 256 * 1024);
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { status: 0, stdout: JSON.stringify([{ Id: count === 1 ? IMAGE_ID : OTHER,
            RepoDigests: [`docker.io/library/node@${count === 1 ? PIN : OTHER}`] }]) };
    };
    const answers = await Promise.all([call(fixture, { options: { query } }), call(fixture, { options: { query } })]);
    assert.equal(count, 1);
    for (const { res } of answers) assert.equal(res.json().agents[0].image.imageId, IMAGE_ID);
    const { plan } = answers[0];
    const changedLease = { ...plan, lease: { ...plan.lease, activationId: '11111111-2222-4333-8444-555555555555' } };
    await buildAgentImagesResponse(changedLease, { query });
    assert.equal(count, 2, 'a new activation gets a new observation');
});

test('default runner invokes only bounded image-inspect argv against a fake Podman executable', async (t) => {
    const fixture = createSourcesWorkspace(t);
    const bin = path.join(fixture.workspace, 'fake-bin');
    fs.mkdirSync(bin);
    const log = path.join(fixture.workspace, 'argv.jsonl');
    fs.writeFileSync(path.join(bin, 'podman'), `#!${process.execPath}\n`
        + "import fs from 'node:fs';\n"
        + `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2))+'\\n');\n`
        + "if (JSON.stringify(process.argv.slice(2,5)) !== JSON.stringify(['image','inspect','--'])) process.exit(99);\n"
        + `console.log(${JSON.stringify(JSON.stringify([{ Id: IMAGE_ID, RepoDigests: [] }]))});\n`, { mode: 0o700 });
    setEnvironment(t, { PATH: `${bin}:${process.env.PATH}` });
    const { res } = await call(fixture, { options: {} });
    assert.equal(res.statusCode, 200, res.body);
    const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
    assert.equal(calls.length, 2);
    for (const args of calls) assert.deepEqual(args.slice(0, 3), ['image', 'inspect', '--']);
    assert.equal(calls[0].at(-1), `docker.io/library/node:20@${PIN}`);
});

test('malformed inspect output, invalid manifests and result count/byte bounds fail closed', async (t) => {
    const fixture = createSourcesWorkspace(t);
    for (const result of [{ status: 1 }, { status: 125, stderr: 'permission denied' },
        { error: new Error('missing') }, { status: 0, stdout: '{}' },
        { status: 0, stdout: '[{"Id":"short","RepoDigests":[]}]' },
        { status: 0, stdout: JSON.stringify([{ Id: IMAGE_ID, RepoDigests: ['bad'] }]) }]) {
        const refused = await call(fixture, { options: { query: () => result } });
        assert.equal(refused.res.statusCode, 503);
        assert.deepEqual(Object.keys(refused.res.json()).sort(), ['error', 'ok']);
    }
    const { plan } = await call(fixture);
    for (const alter of [
        (snapshot) => { snapshot.manifests.coordinator.about = 'x'.repeat(4097); },
        (snapshot) => { snapshot.manifests.coordinator.container = '-bad'; },
        (snapshot) => { snapshot.manifests.coordinator.container = 'node@sha256:short'; },
        (snapshot) => { snapshot.agents.holder.repoName = '..'; },
        (snapshot) => { snapshot.agents = Object.fromEntries(Array.from({ length: 257 }, (_, n) => [`a${n}`, { type: 'agent' }])); },
    ]) {
        const snapshot = structuredClone(plan.snapshot);
        alter(snapshot);
        await assert.rejects(buildAgentImagesResponse({ ...plan, snapshot, lease: { ...plan.lease, snapshot } },
            { query: fixture.query }), { code: 'AGENT_IMAGES_UNAVAILABLE' });
    }
});

test('256 agents are accepted at the count boundary; the total response byte bound still applies', async (t) => {
    const fixture = createSourcesWorkspace(t);
    const { plan } = await call(fixture);
    const snapshot = structuredClone(plan.snapshot);
    snapshot.agents = {};
    snapshot.manifests = {};
    for (let index = 0; index < 256; index += 1) {
        snapshot.agents[`a${index}`] = { type: 'agent', repoName: 'suite', agentName: `a${index}`, runtime: 'bwrap' };
        snapshot.manifests[`a${index}`] = { about: '' };
    }
    const current = { ...plan, snapshot, lease: { ...plan.lease, snapshot } };
    assert.equal((await buildAgentImagesResponse(current)).agents.length, 256);
    for (const manifest of Object.values(snapshot.manifests)) manifest.about = 'x'.repeat(4096);
    await assert.rejects(buildAgentImagesResponse(current), { code: 'AGENT_IMAGES_UNAVAILABLE' });
});

