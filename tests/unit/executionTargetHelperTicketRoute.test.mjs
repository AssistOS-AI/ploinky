import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { signPrivateRouterAssertion } from '../../Agent/lib/agentAssertion.mjs';
import { postHelperTicketRequest } from '../../Agent/lib/helperTicketTransport.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { EXECUTION_TARGET_HELPER_CONTRACT_ID, TARGET_LIMITS_V1 } from '../../cli/server/executionTarget/declaration.mjs';
import {
    HELPER_TICKET_MAX_BODY_BYTES,
    createHelperTicketRateLimiter,
    createHelperTicketService,
    readWorkerGenerationPointer,
} from '../../cli/server/executionTarget/helperTicketService.mjs';
import { workspaceScopeId } from '../../cli/server/executionTarget/liveScope.mjs';
import {
    instancePaths,
    planExecutionTargetLaunch,
    provisionExecutionTarget,
    TARGET_JOURNAL_PATH,
} from '../../cli/server/executionTarget/provisioning.mjs';
import { createSourceProtectionService } from '../../cli/server/executionTarget/sourceProtectionService.mjs';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';
import {
    authorizePrivateRoutePlan,
    readPrivateRequestBody,
    sendPrivateError,
    sendTargetHelperTicket,
    sourceProtectionHolderCallers,
    targetHelperTicketCallers,
} from '../../cli/server/privateRouter.js';
import { inspectExactTerminalContainer } from '../../cli/server/webtty/terminalTargetResolver.mjs';
import { NETWORK_LABELS, workspaceNetworkIdentity } from '../../cli/sandbox/networkIdentity.js';
import { NETWORK_SCHEMA_VERSION } from '../../cli/sandbox/networkContract.js';
import { derivePrivateAgentRequestSecret } from '../../cli/utils/security/masterKey.js';
import { initializeSourceProtection } from '../../cli/utils/runtime/sourceProtectionGate.mjs';
import { MockResponse } from '../helpers/routerOriginsWorkspace.mjs';
import { domainFixture } from './directDomainFixtures.mjs';

// The private helper-ticket route (mint route spec 2026-10-30, R1-R3): route plan, Router admission of the single
// execution-provider worker, Router-asserted evidence (store pointer, registry record, exact inspection, provisioning
// record, ticket secret, live Box scope), commit-before-mint, and the leak scan. Everything is synthetic and runs in
// temporary directories; container inspection goes through the real projection with a fake podman process result, and
// no process, network or container is started.

const previousMasterKey = process.env.PLOINKY_MASTER_KEY;
process.env.PLOINKY_MASTER_KEY = '6'.repeat(64);
test.after(() => {
    if (previousMasterKey === undefined) delete process.env.PLOINKY_MASTER_KEY;
    else process.env.PLOINKY_MASTER_KEY = previousMasterKey;
});

const ROUTE = '/api/edge/target-helper-ticket';
const WORKER = 'agent:fixtures/explorer';
const TARGET = 'agent:fixtures/provider';
const TARGET_CONTAINER = 'provider-container';
const BOX_ID = 'b'.repeat(64);
const IMAGE = `localhost/rwtarget@sha256:${'e'.repeat(64)}`;
const NOW = Date.UTC(2026, 9, 30, 9, 0, 0);
const providerDeclaration = { version: 1, port: 7300, taskReferences: { path: '/explorer/task-refs' } };

const id = (label) => crypto.createHash('sha256').update(`id:${label}`).digest().subarray(0, 16).toString('base64url');
const nonce = (label) => crypto.createHash('sha256').update(`nonce:${label}`).digest().toString('base64url');
const hex = (label) => crypto.createHash('sha256').update(`digest:${label}`).digest('hex');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

function agentEnv(agentId, instanceId, enableGeneration) {
    return {
        PLOINKY_AGENT_ID: agentId,
        PLOINKY_AGENT_INSTANCE_ID: instanceId,
        PLOINKY_AGENT_ENABLE_GENERATION: enableGeneration,
        PLOINKY_AGENT_PRIVATE_SECRET: derivePrivateAgentRequestSecret(agentId, instanceId, enableGeneration),
    };
}
const callerEnv = (name) => agentEnv(`agent:fixtures/${name}`, `${name}-instance`, `${name}-enable`);

function targetManifest() {
    return {
        container: IMAGE,
        executionTarget: {
            version: 1,
            helper: { contractId: EXECUTION_TARGET_HELPER_CONTRACT_ID, contractDigest: hex('contract'), executableDigest: hex('exe') },
            inventoryDigest: hex('inventory'),
            profile: { id: 'nested-podman-proof', digest: hex('profile') },
            stateExports: [],
            serviceExports: [],
            limits: { ...TARGET_LIMITS_V1 },
        },
    };
}

// Stands in for the target helper's `journal-init --root`.
function journalInit(args) {
    const volume = args[args.indexOf('-v') + 1];
    const journal = path.join(volume.slice(0, volume.indexOf(`:${TARGET_JOURNAL_PATH}`)), 'journal');
    if (!fs.existsSync(journal)) {
        fs.mkdirSync(journal, { mode: 0o700 });
        fs.writeFileSync(path.join(journal, 'journal-store.json'), JSON.stringify({ journalStoreIdentity: crypto.randomBytes(16).toString('base64url') }));
    }
    const identity = JSON.parse(fs.readFileSync(path.join(journal, 'journal-store.json'), 'utf8')).journalStoreIdentity;
    const stat = fs.lstatSync(journal, { bigint: true });
    return { status: 0, stdout: `${JSON.stringify({ ok: true, value: { device: String(stat.dev), inode: String(stat.ino), journalStoreIdentity: identity } })}\n` };
}

// A helper-ticket service whose evidence readers are all counting spies: every reader the Router glue builds (live
// scope, store pointer, registry, manifest, exact inspection, helper facts) and the secret provider's `useSecret`.
const READER_NAMES = Object.freeze(['liveScope', 'readWorkerGeneration', 'readRegistry', 'readManifest', 'inspectInstance', 'readHelper']);
function countingService(inner) {
    const counts = { prepare: 0, reads: Object.fromEntries([...READER_NAMES, 'useSecret'].map((name) => [name, 0])) };
    const service = {
        prepare(args) {
            counts.prepare += 1;
            const readers = args.readers;
            const wrapped = {};
            for (const name of READER_NAMES) {
                wrapped[name] = (...values) => {
                    counts.reads[name] += 1;
                    return readers[name](...values);
                };
            }
            wrapped.secrets = { useSecret: (target, fn) => { counts.reads.useSecret += 1; return readers.secrets.useSecret(target, fn); } };
            return inner.prepare({ ...args, readers: wrapped });
        },
    };
    return { service, counts, total: () => Object.values(counts.reads).reduce((sum, value) => sum + value, 0) };
}

// One provider worker (`explorer`, with a registered source-protection generation), one provisioned global Podman
// target (`provider`) and a Box-like live scope. Fake podman answers inspect for the target's exact container.
async function makeWorld(t, { declare = true, providers = ['explorer'], pointer = true, duplicateProvider = false } = {}) {
    const edge = domainFixture(t);
    const root = edge.root;
    for (const name of providers) {
        const file = path.join(root, 'fixtures', name, 'manifest.json');
        const manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (declare) manifest.executionProvider = providerDeclaration;
        fs.writeFileSync(file, JSON.stringify(manifest, null, 2));
    }
    const agents = JSON.parse(fs.readFileSync(edge.paths.agentsFile, 'utf8'));
    agents[TARGET_CONTAINER].runMode = 'global';
    // A second global Podman agent that is registered and running but never provisioned as a target.
    agents['mailer-container'].runMode = 'global';
    // A second registry record of the provider principal (a staged replacement key), which the helper-ticket ACL
    // deliberately treats as ambiguous: two holder entries, so nobody may call.
    if (duplicateProvider) {
        agents['explorer__candidate_0123456789ab'] = {
            ...agents['explorer-container'], instanceId: 'explorer-instance-next', enableGeneration: 'explorer-enable-next', containerId: hex('explorer-next'),
        };
    }
    edge.write(edge.paths.agentsFile, agents);
    edge.apply();
    const record = agents[TARGET_CONTAINER];

    const scratch = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p4-route-')));
    t.after(() => fs.rmSync(scratch, { recursive: true, force: true }));
    const controllerStateDir = path.join(root, '.ploinky', 'data');
    fs.mkdirSync(controllerStateDir, { recursive: true, mode: 0o700 });
    const boxTmpRoot = path.join(scratch, 'boxtmp');
    fs.mkdirSync(boxTmpRoot, { mode: 0o1777 });
    const provision = (overrides = {}) => provisionExecutionTarget({
        plan: planExecutionTargetLaunch({ manifest: targetManifest(), runMode: 'global', runtime: 'podman', insideBox: true }),
        principal: TARGET,
        containerName: TARGET_CONTAINER,
        instanceId: record.instanceId,
        enableGeneration: record.enableGeneration,
        image: IMAGE,
        controllerStateDir,
        boxTmpRoot,
        runJournalInit: journalInit,
        ...overrides,
    });
    const provisioned = provision();

    // The Box engine evidence the Router's live scope reads.
    const mountInfoPath = path.join(scratch, 'mountinfo');
    const containerEnvPath = path.join(scratch, '.containerenv');
    fs.writeFileSync(mountInfoPath, [
        '7300 7290 0:70 / / rw,relatime - overlay overlay rw',
        `7388 7390 0:73 /containers/overlay-containers/${BOX_ID}/userdata/.containerenv /run/.containerenv rw,nosuid,nodev,relatime - tmpfs tmpfs rw,mode=700`,
        '',
    ].join('\n'));
    fs.writeFileSync(containerEnvPath, '');
    const live = { workspaceId: workspaceScopeId(root), boxIdentity: buildWorkspaceIdentity(root).instance, boxGeneration: BOX_ID };

    // The worker's generation pointer in the source-protection store.
    const created = await initializeSourceProtection({
        workspaceRoot: root, assertWorkspaceLease: () => {}, enumerateExpectedHolders: async () => ({ status: 'known', principals: [WORKER] }),
    });
    assert.equal(created.ok, true, JSON.stringify(created));
    const generation = id('worker-generation-1');
    const advance = async (next, prior) => {
        const service = createSourceProtectionService({
            workspaceRoot: root, liveScope: async () => ({ ...live }),
            isSourceReservationHolder: async (principal) => ({ status: principal === WORKER ? 'holder' : 'not-holder' }),
        });
        const answer = await service.handle({
            identity: { agentId: WORKER, instanceId: 'explorer-instance', enableGeneration: 'explorer-enable' },
            body: Buffer.from(JSON.stringify({ version: 1, op: 'advance', workerGeneration: next, request: {
                version: 1, operationId: id(`advance:${next}`), priorGeneration: prior, nextGeneration: next,
            } })),
        });
        assert.equal(answer.body.ok, true, JSON.stringify(answer.body));
    };
    if (pointer) await advance(generation, null);

    const workspaceHash = workspaceNetworkIdentity(root).hash;
    const inspections = [];
    const world = {
        edge, root, record, controllerStateDir, boxTmpRoot, provision, provisioned, live, generation, advance, inspections,
        scopeSources: { mountInfoPath, containerEnvPath },
        audit: [],
        // podman `container inspect <id>` as the engine prints it; `inspectState` lets a test vary the answer.
        inspectState: { running: true, labels: {}, fail: null, before: null },
    };
    world.fakePodman = (_command, args, _options, callback) => {
        const containerId = args[2];
        inspections.push(containerId);
        const reply = async () => {
            if (world.inspectState.before) await world.inspectState.before();
            if (world.inspectState.fail) {
                callback(Object.assign(new Error('inspect failed'), world.inspectState.fail), '', '');
                return;
            }
            const known = Object.entries(JSON.parse(fs.readFileSync(edge.paths.agentsFile, 'utf8'))).find(([, value]) => value.containerId === containerId);
            if (!known) {
                callback(Object.assign(new Error('absent'), { code: 125 }), '', `Error: no such container ${containerId}\n`);
                return;
            }
            const [name, value] = known;
            callback(null, JSON.stringify([{
                Id: containerId,
                Name: `/${name}`,
                State: { Running: world.inspectState.running, Status: world.inspectState.running ? 'running' : 'exited' },
                HostConfig: { Init: true, NetworkMode: 'none' },
                Config: {
                    User: '0:0',
                    Labels: {
                        [NETWORK_LABELS.managed]: '1',
                        [NETWORK_LABELS.resource]: 'agent',
                        [NETWORK_LABELS.schema]: NETWORK_SCHEMA_VERSION,
                        [NETWORK_LABELS.workspace]: workspaceHash,
                        [NETWORK_LABELS.contract]: hex('contract-label'),
                        [NETWORK_LABELS.instanceId]: value.instanceId,
                        [NETWORK_LABELS.enableGeneration]: value.enableGeneration,
                        ...world.inspectState.labels,
                    },
                },
                Mounts: [],
            }]), '');
        };
        reply();
        return { on() {} };
    };
    world.serving = (extra = {}) => ({
        workspaceRoot: root,
        insideBox: true,
        scopeSources: world.scopeSources,
        boxTmpRoot,
        inspectContainer: (runtime, containerId) => inspectExactTerminalContainer(runtime, containerId, { execFileImpl: world.fakePodman }),
        audit: (event, value) => world.audit.push({ event, ...value }),
        service: world.service,
        ...extra,
    });
    const spied = countingService(createHelperTicketService({ now: () => NOW }));
    world.service = spied.service;
    world.counts = spied.counts;
    world.readTotal = spied.total;
    world.helperSecret = (instanceKey = world.provisioned.instanceKey) => {
        const text = fs.readFileSync(instancePaths(boxTmpRoot, instanceKey).secret, 'utf8');
        const match = /^version=1\nhelperIncarnation=([A-Za-z0-9_-]{22})\nkid=(hti1\.[A-Za-z0-9_-]{22})\nsecret=([A-Za-z0-9_-]{43})\n$/.exec(text);
        return { kid: match[2], secret: Buffer.from(match[3], 'base64url') };
    };
    world.scope = (overrides = {}) => ({
        ...live,
        workerPrincipal: WORKER, workerRuntimeInstanceId: 'explorer-instance', workerEnableGeneration: 'explorer-enable', workerGeneration: generation,
        agentPrincipal: TARGET, containerId: record.containerId, runtimeInstanceId: record.instanceId, enableGeneration: record.enableGeneration,
        helperIncarnation: world.provisioned.helperIncarnation, ...overrides,
    });
    world.request = (overrides = {}, scopeOverrides = {}) => ({
        binding: { version: 1, scope: world.scope(scopeOverrides), limitsDigest: hex('limits'), robotId: id('robot'), executionId: id('execution'), attemptId: id('attempt'), configRevision: 1 },
        leaseId: id('lease-1'), reservationId: id('reservation-1'), operationId: id('operation-1'), requestDigest: hex('request'),
        helperNonce: nonce('n-1'), channelEpoch: '1', previousChannelEpoch: null, permissions: ['commit', 'connect', 'lookup', 'prepare'], ttlSeconds: 30,
        ...overrides,
    });
    return world;
}

function privateRequest({ method = 'POST', url = ROUTE, body, env = callerEnv('explorer'), signedPath = ROUTE, headers = {} } = {}) {
    const bytes = Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body ?? {}));
    const req = Readable.from(bytes.length ? [bytes] : []);
    return Object.assign(req, {
        method,
        url,
        ploinkyListenerClass: 'private',
        headers: {
            host: '127.0.0.1:8081',
            ...(env ? { 'ploinky-agent-assertion': signPrivateRouterAssertion({ method, path: signedPath, body: bytes, env }) } : {}),
            ...headers,
        },
    });
}

// RoutingServer's private pipeline for this operation: exact route plan, bounded body, caller authorization, then the
// handler, which reads its evidence, commits the plan and mints. The Router branch itself is pinned by a source test.
async function throughPrivateListener(world, request, extra = {}) {
    const res = new MockResponse();
    const parsedUrl = new URL(request.url, `http://${request.headers.host}`);
    const plan = resolveEdgeRoutePlan({ req: request, parsedUrl, listener: 'private' });
    if (!plan.ok) {
        res.writeHead(plan.status || 404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: plan.code }));
        return { plan, res };
    }
    if (extra.onPlan) extra.onPlan(plan);
    const body = await readPrivateRequestBody(request);
    try {
        authorizePrivateRoutePlan({ req: request, plan, body });
    } catch (error) {
        sendPrivateError(res, error);
        return { plan, res };
    }
    const { onPlan, ...serving } = extra;
    void onPlan;
    await sendTargetHelperTicket(res, { plan, body, callerIdentity: request.privateAgentIdentity, ...world.serving(serving) });
    return { plan, res };
}

const mint = async (world, request, options = {}) => {
    const { env, ...extra } = options;
    const { res } = await throughPrivateListener(world, privateRequest({ body: request, ...(env !== undefined ? { env } : {}) }), extra);
    return res;
};

function verifyTicket(ticket, { kid, secret }) {
    const [header, payload, signature] = ticket.split('.');
    const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString('utf8'));
    const mac = crypto.createHmac('sha256', secret).update(`${header}.${payload}`).digest();
    const given = Buffer.from(signature, 'base64url');
    return {
        ok: decodedHeader.alg === 'HS256' && decodedHeader.kid === kid && given.length === mac.length && crypto.timingSafeEqual(given, mac),
        claims: JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')),
        claimBytes: Buffer.from(payload, 'base64url'),
    };
}

function listFiles(root) {
    const out = [];
    const walk = (directory) => {
        let names;
        try { names = fs.readdirSync(directory).sort(); } catch (_) { return; }
        for (const name of names) {
            const full = path.join(directory, name);
            const stat = fs.lstatSync(full);
            if (stat.isDirectory()) walk(full);
            else if (stat.isFile()) out.push(full);
        }
    };
    walk(root);
    return out;
}

// ---------------------------------------------------------------- U2 route plan

test('U2 route: /api/edge/target-helper-ticket resolves only as the exact private POST operation; never public', (t) => {
    const world = domainFixture(t);
    void world;
    const plan = (url, { method = 'POST', listener = 'private', host } = {}) => resolveEdgeRoutePlan({
        req: { url, method, headers: { host: host || (listener === 'private' ? '127.0.0.1:8081' : '127.0.0.1:8080') }, ploinkyListenerClass: listener },
        listener,
    });
    const served = plan(ROUTE);
    assert.equal(served.ok, true);
    assert.equal(served.kind, 'private-operation');
    assert.equal(served.operation, 'target-helper-ticket');
    assert.equal(served.pathname, ROUTE);
    assert.equal(typeof served.lease?.commit, 'function');
    assert.equal(plan(`${ROUTE}#x`).ok, false);
    for (const [url, method] of [[ROUTE, 'GET'], [ROUTE, 'PUT'], [ROUTE, 'DELETE'], [ROUTE, 'HEAD'], [`${ROUTE}?`, 'POST'], [`${ROUTE}?a=1`, 'POST']]) {
        const refused = plan(url, { method });
        assert.equal(refused.ok, false, `${method} ${url}`);
        assert.equal(refused.code, 'TARGET_HELPER_TICKET_REQUEST_INVALID', `${method} ${url}`);
    }
    for (const url of [`${ROUTE}/`, `${ROUTE}/x`, '/api/edge//target-helper-ticket', '/api/edge/target-helper-ticket%2f', '/api/edge/%74arget-helper-ticket',
        '/api/edge/Target-Helper-Ticket', '/api/edge/./target-helper-ticket', '/api/edge/x/../target-helper-ticket']) {
        const refused = plan(url);
        assert.equal(refused.ok === true && refused.operation === 'target-helper-ticket', false, url);
    }
    for (const listener of ['public', 'managed']) {
        const other = plan(ROUTE, { listener, host: listener === 'managed' ? 'host.containers.internal:8080' : undefined });
        assert.equal(other.ok === true && other.kind === 'private-operation', false, listener);
    }
    // The neighbouring private operations are unchanged.
    assert.equal(plan('/api/edge/source-protection').operation, 'source-protection');
    assert.equal(plan('/api/edge/turn-credentials').operation, 'turn-credentials');
});

// ---------------------------------------------------------------- U3 admission

test('U3 the single execution provider is admitted; everyone else, a stale identity, two providers or none are refused', async (t) => {
    const world = await makeWorld(t);
    const snapshot = resolveEdgeRoutePlan({ req: privateRequest({ body: {} }), parsedUrl: new URL(ROUTE, 'http://127.0.0.1:8081'), listener: 'private' }).snapshot;
    assert.deepEqual(targetHelperTicketCallers(snapshot), [{ agentId: WORKER, instanceId: 'explorer-instance', enableGeneration: 'explorer-enable' }]);
    const admitted = await mint(world, world.request());
    assert.equal(admitted.statusCode, 200, admitted.body);
    assert.equal(admitted.json().ok, true, admitted.body);
    // The spies are wired: the admitted request read every kind of evidence and the secret exactly once.
    assert.deepEqual(world.counts.reads, { liveScope: 1, readWorkerGeneration: 1, readRegistry: 1, readManifest: 1, inspectInstance: 1, readHelper: 1, useSecret: 1 });
    const readsAfterAdmitted = world.readTotal();
    const preparesAfterAdmitted = world.counts.prepare;

    const call = (options) => throughPrivateListener(world, privateRequest({ body: world.request({ helperNonce: nonce('u3') }), ...options }));
    const plain = await call({ env: callerEnv('unrelated') });
    assert.equal(plain.res.statusCode, 403);
    assert.equal(plain.res.json().error, 'PRIVATE_CALLER_DENIED');
    assert.equal((await call({ env: agentEnv(WORKER, 'explorer-instance-0', 'explorer-enable') })).res.statusCode, 401);
    assert.equal((await call({ env: agentEnv(WORKER, 'explorer-instance', 'explorer-enable-0') })).res.statusCode, 401);
    assert.equal((await call({ env: null })).res.statusCode, 401);
    assert.equal((await call({ signedPath: '/api/edge/source-protection' })).res.statusCode, 401);
    const otherBody = privateRequest({ body: world.request({ helperNonce: nonce('u3-a') }) });
    otherBody.headers['ploinky-agent-assertion'] = privateRequest({ body: world.request({ helperNonce: nonce('u3-b') }) }).headers['ploinky-agent-assertion'];
    assert.equal((await throughPrivateListener(world, otherBody)).res.statusCode, 401, 'an assertion for another body hash');
    const forged = await call({ env: callerEnv('unrelated'), headers: { 'x-ploinky-agent-id': WORKER, 'x-ploinky-caller': WORKER } });
    assert.equal(forged.res.statusCode, 403);
    // None of the refused callers reached the handler or any evidence reader: no prepare, no read, no inspection.
    assert.equal(world.counts.prepare, preparesAfterAdmitted);
    assert.equal(world.readTotal(), readsAfterAdmitted);
    assert.equal(world.inspections.length, 1);
    assert.equal(world.audit.filter((entry) => entry.event === 'target_helper_ticket_minted').length, 1);
});

test('U3 two execution providers, or none, leave the operation with no caller', async (t) => {
    const two = await makeWorld(t, { providers: ['explorer', 'unrelated'] });
    const snapshot = resolveEdgeRoutePlan({ req: privateRequest({ body: {} }), parsedUrl: new URL(ROUTE, 'http://127.0.0.1:8081'), listener: 'private' }).snapshot;
    assert.equal(targetHelperTicketCallers(snapshot).length, 0);
    for (const name of ['explorer', 'unrelated']) {
        const res = await mint(two, two.request(), { env: callerEnv(name) });
        assert.equal(res.statusCode, 403, name);
        assert.equal(res.json().error, 'PRIVATE_CALLER_DENIED');
    }
    // The handler holds the same rule on its own (defence in depth behind authorizePrivateRoutePlan).
    const plan = resolveEdgeRoutePlan({ req: privateRequest({ body: {} }), parsedUrl: new URL(ROUTE, 'http://127.0.0.1:8081'), listener: 'private' });
    const res = new MockResponse();
    assert.equal(await sendTargetHelperTicket(res, { plan, body: Buffer.from('{}'), callerIdentity: { agentId: WORKER, instanceId: 'explorer-instance', enableGeneration: 'explorer-enable' }, ...two.serving() }), false);
    assert.equal(res.statusCode, 403);
    const none = await makeWorld(t, { declare: false });
    const refused = await mint(none, none.request());
    assert.equal(refused.statusCode, 403);
    assert.equal(two.inspections.length + none.inspections.length, 0);
});

test('F2 two registry records of the provider principal leave the operation with no caller (fail closed, by decision)', async (t) => {
    const world = await makeWorld(t, { duplicateProvider: true });
    const plan = resolveEdgeRoutePlan({ req: privateRequest({ body: {} }), parsedUrl: new URL(ROUTE, 'http://127.0.0.1:8081'), listener: 'private' });
    // The source-protection holder rule lists one entry per record; the helper-ticket rule needs exactly one.
    assert.equal(sourceProtectionHolderCallers(plan.snapshot).length, 2);
    assert.deepEqual(targetHelperTicketCallers(plan.snapshot), []);
    // The current instance of the provider (the first record) is refused by the ACL itself; the staged record's tuple
    // is not the current identity of the principal, so its assertion is refused as stale.
    const current = await mint(world, world.request());
    assert.equal(current.statusCode, 403);
    assert.equal(current.json().error, 'PRIVATE_CALLER_DENIED');
    const staged = await mint(world, world.request(), { env: agentEnv(WORKER, 'explorer-instance-next', 'explorer-enable-next') });
    assert.equal(staged.statusCode, 401, staged.body);
    // The handler holds the same rule behind authorizePrivateRoutePlan, before any evidence.
    const res = new MockResponse();
    assert.equal(await sendTargetHelperTicket(res, { plan, body: Buffer.from(JSON.stringify(world.request())),
        callerIdentity: { agentId: WORKER, instanceId: 'explorer-instance', enableGeneration: 'explorer-enable' }, ...world.serving() }), false);
    assert.equal(res.statusCode, 403);
    assert.equal(res.json().error, 'PRIVATE_CALLER_DENIED');
    assert.equal(world.counts.prepare, 0);
    assert.equal(world.readTotal(), 0);
    assert.equal(world.inspections.length, 0);
});

// ---------------------------------------------------------------- success, U4 and U7

test('U4/U7 a minted ticket verifies with the helper-side secret, carries the session key, and leaks nowhere else', async (t) => {
    const world = await makeWorld(t);
    const request = world.request();
    const res = await mint(world, request);
    assert.equal(res.statusCode, 200, res.body);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(res.headers['content-type'], 'application/json');
    const answer = res.json();
    assert.equal(answer.ok, true, res.body);
    assert.deepEqual(Object.keys(answer.value).sort(), ['exp', 'iat', 'jti', 'kid', 'sessionKey', 'ticket']);
    const helper = world.helperSecret();
    assert.equal(answer.value.kid, helper.kid);
    const verified = verifyTicket(answer.value.ticket, helper);
    assert.equal(verified.ok, true);
    assert.deepEqual(verified.claims.binding, request.binding);
    assert.equal(verified.claims.leaseId, request.leaseId);
    assert.equal(verified.claims.sub, WORKER);
    assert.equal(verified.claims.exp - verified.claims.iat, 30);
    assert.equal(verified.claims.iat, Math.floor(NOW / 1000));
    const expectedKey = Buffer.from(crypto.hkdfSync('sha256', helper.secret, crypto.createHash('sha256').update(verified.claimBytes).digest(),
        Buffer.from('ploinky-target-session-v1', 'ascii'), 32)).toString('base64url');
    assert.equal(answer.value.sessionKey, expectedKey);

    // U7: the audit sink holds the caller, kid, jti and exp only; neither the ticket, its signature, the session key nor
    // the secret is in the audit records or anywhere under the workspace's `.ploinky` tree or the Box tmpfs.
    assert.deepEqual(world.audit, [{ event: 'target_helper_ticket_minted', callerAgentId: WORKER, kid: helper.kid, jti: answer.value.jti, exp: answer.value.exp }]);
    const needles = [answer.value.ticket, answer.value.ticket.split('.')[2], answer.value.sessionKey,
        Buffer.from(answer.value.sessionKey, 'base64url').toString('hex'), Buffer.from(answer.value.sessionKey, 'base64url').toString('base64')];
    const auditText = JSON.stringify(world.audit);
    for (const [index, needle] of needles.entries()) assert.equal(auditText.includes(needle), false, `audit needle ${index}`);
    const files = [...listFiles(path.join(world.root, '.ploinky')), ...listFiles(world.boxTmpRoot)];
    assert.ok(files.length > 3);
    for (const file of files) {
        const bytes = fs.readFileSync(file);
        for (const [index, needle] of needles.entries()) {
            assert.equal(bytes.includes(Buffer.from(needle)), false, `${path.relative(world.root, file)} needle ${index} (sha ${sha(needle).slice(0, 8)})`);
        }
    }
});

// ---------------------------------------------------------------- U5 evidence-fed refusals

test('U5 the Router-asserted evidence feeds every refusal: target_mismatch, target_not_eligible, caller_mismatch, secret_unavailable', async (t) => {
    const world = await makeWorld(t);
    const code = async (request, options) => {
        const res = await mint(world, request, options);
        assert.equal(res.statusCode, 200, res.body);
        return res.json().ok ? 'ok' : res.json().error.code;
    };
    let n = 0;
    const fresh = (overrides = {}, scope = {}) => world.request({ helperNonce: nonce(`u5-${n += 1}`), leaseId: id(`u5-lease-${n}`), ...overrides }, scope);
    // Unknown principal, unregistered container, another helper incarnation, another instance: target_mismatch.
    assert.equal(await code(fresh({}, { agentPrincipal: 'agent:fixtures/ghost' })), 'target_mismatch');
    assert.equal(await code(fresh({}, { containerId: 'f'.repeat(64) })), 'target_mismatch');
    assert.equal(await code(fresh({}, { helperIncarnation: id('other-incarnation') })), 'target_mismatch');
    assert.equal(await code(fresh({}, { runtimeInstanceId: 'provider-instance-0' })), 'target_mismatch');
    // A registered target that was never provisioned (no record): no helper incarnation, target_mismatch.
    const mailer = world.edge.agents['mailer-container'];
    assert.equal(await code(fresh({}, { agentPrincipal: 'agent:fixtures/mailer', containerId: mailer.containerId, runtimeInstanceId: mailer.instanceId, enableGeneration: mailer.enableGeneration })), 'target_mismatch');
    // A stopped container, a failed or timed-out inspection, foreign ownership labels: target_not_eligible.
    world.inspectState.running = false;
    assert.equal(await code(fresh()), 'target_not_eligible');
    world.inspectState.running = true;
    world.inspectState.fail = { code: null, killed: true, signal: 'SIGKILL' };
    assert.equal(await code(fresh()), 'target_not_eligible', 'inspect timeout (killed by the execFile timeout)');
    world.inspectState.fail = null;
    world.inspectState.labels = { [NETWORK_LABELS.workspace]: 'f00d'.repeat(3) };
    assert.equal(await code(fresh()), 'target_not_eligible', 'another workspace owns the container');
    world.inspectState.labels = {};
    // The binding names another worker generation than the store pointer: caller_mismatch.
    assert.equal(await code(fresh({}, { workerGeneration: id('stale-generation') })), 'caller_mismatch');
    assert.equal(await code(fresh()), 'ok');
    // The pointer advances: the binding of the old generation is refused, the new one admitted.
    const next = id('worker-generation-2');
    await world.advance(next, world.generation);
    assert.equal(await code(fresh()), 'caller_mismatch');
    assert.equal(await code(fresh({}, { workerGeneration: next })), 'ok');
    // A rotation between the evidence and the mint (a new incarnation provisioned while the request is in flight):
    // the target evidence still names the old incarnation, the secret provider refuses it.
    const rotated = await code(fresh({}, { workerGeneration: next }), {
        onPlan: (plan) => {
            // The captured lease is frozen: wrap it, so its own commit runs right after the rotation.
            const original = plan.lease;
            plan.lease = Object.freeze({
                ...original,
                commit: () => {
                    // A replacement instance of the target is provisioned (a re-provision of the same instance only adopts).
                    world.provision({ containerName: 'provider-container-next', instanceId: 'provider-instance-2', enableGeneration: 'provider-enable-2' });
                    return original.commit();
                },
            });
        },
    });
    assert.equal(rotated, 'secret_unavailable');
});

test('U5 a worker without a store pointer gets caller_mismatch and nothing is signed', async (t) => {
    const world = await makeWorld(t, { pointer: false });
    const res = await mint(world, world.request());
    assert.deepEqual(res.json(), { ok: false, error: { code: 'caller_mismatch' } });
    assert.equal(await readWorkerGenerationPointer({ workspaceRoot: world.root, principal: WORKER }), null);
    // No store at all: still null, and nothing is created.
    const empty = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'p4-nostore-')));
    t.after(() => fs.rmSync(empty, { recursive: true, force: true }));
    assert.equal(await readWorkerGenerationPointer({ workspaceRoot: empty, principal: WORKER }), null);
    assert.deepEqual(fs.readdirSync(empty), []);
});

test('U5 outside a Box, or with foreign engine evidence, there is no live scope and every request is target_scope_mismatch', async (t) => {
    const world = await makeWorld(t);
    assert.deepEqual((await mint(world, world.request(), { insideBox: false })).json(), { ok: false, error: { code: 'target_scope_mismatch' } });
    assert.deepEqual((await mint(world, world.request(), { scopeSources: { ...world.scopeSources, mountInfoPath: path.join(world.root, 'absent') } })).json(),
        { ok: false, error: { code: 'target_scope_mismatch' } });
    // The same nonce still mints once the scope is real: refusals consume nothing.
    assert.equal((await mint(world, world.request())).json().ok, true);
});

test('U5 a secret replaced by a symlink to a valid copy is refused (secret_unavailable)', async (t) => {
    const world = await makeWorld(t);
    const routerSecret = instancePaths(world.boxTmpRoot, world.provisioned.instanceKey).routerSecret;
    const copy = path.join(world.boxTmpRoot, 'copy');
    fs.copyFileSync(routerSecret, copy);
    fs.chmodSync(copy, 0o600);
    fs.rmSync(routerSecret);
    fs.symlinkSync(copy, routerSecret);
    assert.deepEqual((await mint(world, world.request())).json(), { ok: false, error: { code: 'secret_unavailable' } });
});

// ---------------------------------------------------------------- R2 commit-before-mint and probes

test('R2 an edge generation change while the evidence is read answers 503, mints nothing, and the same nonce succeeds after', async (t) => {
    const world = await makeWorld(t);
    let swapped = false;
    world.inspectState.before = async () => {
        if (swapped) return;
        swapped = true;
        const file = path.join(world.root, 'fixtures', 'mailer', 'manifest.json');
        fs.writeFileSync(file, JSON.stringify({ enable: [] }, null, 2));
        world.edge.apply();
    };
    const request = world.request();
    const changed = await mint(world, request);
    assert.equal(changed.statusCode, 503, changed.body);
    assert.equal(changed.json().error, 'edge_generation_changed');
    assert.equal(changed.body.includes('ticket'), false);
    assert.deepEqual(world.audit.map((entry) => entry.event), ['target_helper_ticket_refused']);
    assert.equal(world.audit[0].code, 'edge_generation_changed');
    // A retry in the new generation with a fresh assertion and the same helper nonce and epoch mints.
    const retried = await mint(world, request);
    assert.equal(retried.statusCode, 200, retried.body);
    assert.equal(retried.json().ok, true, retried.body);
});

test('R2 twenty parallel mints for one lease and epoch produce exactly one ticket', async (t) => {
    const world = await makeWorld(t);
    const results = await Promise.all(Array.from({ length: 20 }, (_, index) => mint(world, world.request({ helperNonce: nonce(`parallel-${index}`) }))));
    const codes = results.map((res) => (res.json().ok ? 'ok' : res.json().error.code));
    assert.equal(codes.filter((value) => value === 'ok').length, 1, codes.join(','));
    assert.deepEqual([...new Set(codes.filter((value) => value !== 'ok'))], ['channel_epoch_conflict']);
});

test('probes: body bounds, malformed JSON, epochs, ttl, unicode lease, __proto__, replay, same epoch twice, rate limit', async (t) => {
    const world = await makeWorld(t);
    const code = async (body, options) => {
        const res = await mint(world, body, options);
        return { status: res.statusCode, body: res.json() };
    };
    // Body size: exactly 65536 bytes reaches the minter (which refuses the padding key); 65537 is 413.
    const padded = (size) => {
        const base = JSON.stringify({ ...world.request({ helperNonce: nonce('pad') }), pad: '' });
        return Buffer.from(base.replace('"pad":""', `"pad":"${'x'.repeat(size - Buffer.byteLength(base))}"`));
    };
    assert.equal(padded(HELPER_TICKET_MAX_BODY_BYTES).length, 65536);
    assert.deepEqual(await code(padded(65536)), { status: 200, body: { ok: false, error: { code: 'invalid_request' } } });
    assert.deepEqual(await code(padded(65537)), { status: 413, body: { error: 'request_too_large' } });
    for (const truncated of ['{"binding":', '', 'null x', '{']) {
        assert.deepEqual(await code(truncated), { status: 400, body: { error: 'invalid_request' } }, JSON.stringify(truncated));
    }
    assert.deepEqual(await code('null'), { status: 200, body: { ok: false, error: { code: 'invalid_request' } } });
    const refusalOf = async (request) => (await code(request)).body.error?.code ?? 'ok';
    assert.equal(await refusalOf(world.request({ ttlSeconds: 0, helperNonce: nonce('ttl0') })), 'ticket_lifetime');
    assert.equal(await refusalOf(world.request({ ttlSeconds: 31, helperNonce: nonce('ttl31') })), 'ticket_lifetime');
    assert.equal(await refusalOf(world.request({ channelEpoch: '0', helperNonce: nonce('e0') })), 'channel_epoch_conflict');
    assert.equal(await refusalOf(world.request({ channelEpoch: (2n ** 64n).toString(), helperNonce: nonce('e64') })), 'channel_epoch_conflict');
    assert.equal(await refusalOf(world.request({ leaseId: 'lease-ééééééééé', helperNonce: nonce('uni') })), 'invalid_request');
    const proto = `{"__proto__":{"admin":true},${JSON.stringify(world.request({ helperNonce: nonce('proto') })).slice(1)}`;
    assert.equal(await refusalOf(proto), 'invalid_request');
    const protoInBinding = world.request({ helperNonce: nonce('proto-b') });
    const protoText = JSON.stringify(protoInBinding).replace('"version":1,', '"__proto__":{"version":2},"version":1,');
    assert.notEqual(protoText, JSON.stringify(protoInBinding));
    assert.equal(await refusalOf(protoText), 'invalid_request');
    // Replay of a consumed helper nonce, and the same epoch twice for a lease.
    assert.equal(await refusalOf(world.request({ helperNonce: nonce('once') })), 'ok');
    assert.equal(await refusalOf(world.request({ leaseId: id('lease-2'), helperNonce: nonce('once') })), 'ticket_replayed');
    assert.equal(await refusalOf(world.request({ helperNonce: nonce('twice') })), 'channel_epoch_conflict');
    assert.equal(await refusalOf(world.request({ channelEpoch: '2', previousChannelEpoch: '1', helperNonce: nonce('twice') })), 'ok');

    // Rate limit: the exact caller gets at most N requests per window (429 capacity_exceeded), counted before any evidence.
    let clock = NOW;
    const limited = countingService(createHelperTicketService({ now: () => clock, rateLimiter: createHelperTicketRateLimiter({ maximumRequests: 3 }) }));
    const before = world.inspections.length;
    const statuses = [];
    const readsPerRequest = [];
    for (let index = 0; index < 5; index += 1) {
        const readsBefore = limited.total();
        statuses.push((await mint(world, world.request({ leaseId: id(`rl-${index}`), helperNonce: nonce(`rl-${index}`) }), { service: limited.service })).statusCode);
        readsPerRequest.push(limited.total() - readsBefore);
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429]);
    // Every admitted request read all seven kinds of evidence; a limited request read none (not even the live scope).
    assert.deepEqual(readsPerRequest, [7, 7, 7, 0, 0], 'a limited request reads no evidence');
    assert.equal(limited.counts.prepare, 5);
    assert.equal(world.inspections.length - before, 3);
    clock += 60_001;
    assert.equal((await mint(world, world.request({ leaseId: id('rl-later'), helperNonce: nonce('rl-later') }), { service: limited.service })).statusCode, 200);
});

test('the default rate limit is 60 per minute per exact caller, independent per caller', () => {
    const limiter = createHelperTicketRateLimiter();
    const results = Array.from({ length: 61 }, () => limiter.consume('a', NOW));
    assert.equal(results.filter(Boolean).length, 60);
    assert.equal(results[60], false);
    assert.equal(limiter.consume('b', NOW), true);
    assert.equal(limiter.consume('a', NOW + 60_001), true);
    assert.equal(limiter.consume('', NOW), false);
});

test('the process minter is pinned to its first live scope; a later different scope is refused, never re-minted', async (t) => {
    const world = await makeWorld(t);
    assert.equal((await mint(world, world.request())).json().ok, true);
    // A different Box generation (engine evidence names another container) is refused by the same service.
    const other = path.join(world.root, 'mountinfo-other');
    fs.writeFileSync(other, fs.readFileSync(world.scopeSources.mountInfoPath, 'utf8').replace(BOX_ID, 'c'.repeat(64)));
    const res = await mint(world, world.request({ channelEpoch: '2', helperNonce: nonce('pin') }, { boxGeneration: 'c'.repeat(64) }),
        { scopeSources: { ...world.scopeSources, mountInfoPath: other } });
    assert.deepEqual(res.json(), { ok: false, error: { code: 'target_scope_mismatch' } });
});

// ---------------------------------------------------------------- source pins

test('RoutingServer dispatches the operation after authorization and does not commit before the handler (R2)', () => {
    const source = fs.readFileSync(new URL('../../cli/server/RoutingServer.js', import.meta.url), 'utf8');
    const branch = source.match(/if \(routePlan\.kind === 'private-operation' && routePlan\.operation === 'target-helper-ticket'\) \{\n([\s\S]*?)\n    \}\n/);
    assert.ok(branch, 'the target-helper-ticket branch exists');
    const lines = branch[1].split('\n').map((line) => line.trim()).filter((line) => !line.startsWith('//'));
    assert.deepEqual(lines, [
        'await sendTargetHelperTicket(res, {', 'plan: routePlan,', 'body,', 'callerIdentity: req.privateAgentIdentity,',
        'workspaceRoot: PLOINKY_WORKSPACE_ROOT,', 'insideBox,', 'audit: (event, value) => appendLog(event, value),', '});', 'return;',
    ]);
    assert.ok(source.indexOf('authorizePrivateRoutePlan({ req, plan: routePlan, body })') < source.indexOf("routePlan.operation === 'target-helper-ticket'"));
    assert.equal(source.match(/sendTargetHelperTicket/g).length, 2);
    assert.deepEqual(source.match(/^import .*sendTargetHelperTicket.*$/gm), ["import { sendTargetHelperTicket } from './privateRouter.js';"]);
    assert.ok(source.trimEnd().endsWith("import { sendTargetHelperTicket } from './privateRouter.js';"));
});

test('sendTargetHelperTicket commits after every await and mints and replies with no await in between (R2)', () => {
    const source = fs.readFileSync(new URL('../../cli/server/privateRouter.js', import.meta.url), 'utf8');
    const start = source.indexOf('export async function sendTargetHelperTicket(');
    const body = source.slice(start, source.indexOf('\n}\n', start));
    const commit = body.indexOf('if (!commitRoutePlan(plan)) {');
    const mintCall = body.indexOf('const result = prepared.mint();');
    const reply = body.indexOf('res.end(payload);', mintCall);
    assert.ok(commit > 0 && mintCall > commit && reply > mintCall);
    assert.equal(body.slice(0, commit).match(/\bawait\b/g).length, 1, 'only the evidence phase is awaited, before the commit');
    assert.equal(/\bawait\b/.test(body.slice(commit, reply)), false, 'no await between commit, mint and reply');
    assert.equal(body.match(/\bcommitRoutePlan\(/g).length, 1);
    // The audit never sees the ticket or the session key.
    assert.doesNotMatch(body.slice(reply), /\.ticket\b|sessionKey/);
});

// ---------------------------------------------------------------- agent-side transport

const DESCRIPTOR = () => ({ payload: { internalRouterUrl: 'http://127.0.0.1:8081' } });

function fakeRequest(captured, answer) {
    return (url, options, callback) => {
        const request = new EventEmitter();
        request.destroy = () => {};
        request.end = (body) => {
            captured.url = url;
            captured.method = options.method;
            captured.headers = Object.fromEntries(Object.entries(options.headers).map(([key, value]) => [key.toLowerCase(), value]));
            captured.body = body;
            Promise.resolve(answer(captured)).then((reply) => {
                const response = new EventEmitter();
                response.statusCode = reply.status;
                response.headers = {};
                response.destroy = () => {};
                callback(response);
                response.emit('data', Buffer.from(reply.body));
                response.emit('end');
            });
        };
        return request;
    };
}

test('the agent-side transport posts one signed request through the generated descriptor; the Router admits it', async (t) => {
    const world = await makeWorld(t);
    const captured = {};
    const route = async (sent) => {
        const req = privateRequest({ body: sent.body, env: null });
        req.headers['ploinky-agent-assertion'] = sent.headers['ploinky-agent-assertion'];
        const { res } = await throughPrivateListener(world, req);
        return { status: res.statusCode, body: res.body };
    };
    const body = Buffer.from(JSON.stringify(world.request()));
    const answer = await postHelperTicketRequest(body, { env: callerEnv('explorer'), loadDescriptor: DESCRIPTOR, requestImpl: fakeRequest(captured, route) });
    assert.equal(answer.status, 200);
    assert.equal(captured.method, 'POST');
    assert.equal(captured.url.pathname, ROUTE);
    assert.equal(JSON.parse(answer.body.toString('utf8')).ok, true);
    // Fail closed: no descriptor, no identity, oversize, a non-http Router location.
    const fails = (promise) => assert.rejects(promise, (error) => error.code === 'HELPER_TICKET_TRANSPORT_UNAVAILABLE');
    await fails(postHelperTicketRequest(Buffer.from('{}'), { env: {}, loadDescriptor: () => { throw new Error('none'); } }));
    await fails(postHelperTicketRequest(Buffer.from('{}'), { env: {}, loadDescriptor: DESCRIPTOR }));
    await fails(postHelperTicketRequest(Buffer.alloc(64 * 1024 + 1), { env: callerEnv('explorer'), loadDescriptor: DESCRIPTOR }));
    await fails(postHelperTicketRequest(Buffer.from('{}'), { env: callerEnv('explorer'), loadDescriptor: () => ({ payload: { internalRouterUrl: 'https://127.0.0.1:8081' } }) }));
    // An answer over 64 KiB is refused, not buffered.
    const big = await postHelperTicketRequest(Buffer.from('{}'), {
        env: callerEnv('explorer'), loadDescriptor: DESCRIPTOR, requestImpl: fakeRequest({}, () => ({ status: 200, body: 'x'.repeat(64 * 1024 + 1) })),
    }).then(() => 'resolved', (error) => error.code);
    assert.equal(big, 'HELPER_TICKET_TRANSPORT_UNAVAILABLE');
});
