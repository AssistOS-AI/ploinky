import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { createMemoryReplayCache } from '../../Agent/lib/jwtVerify.mjs';
import { signAgentAssertion } from '../../Agent/lib/agentAssertion.mjs';
import {
    callsNamed,
    createWorkspaceCheckout,
    deepFreeze,
    installFsCallCounter,
    installGitSpawnCounter,
    manifestReads,
} from './agentLookupCostProbe.mjs';

// The MCP provider principal is derived from the active route, not from a scan
// of installed repositories. Alias routes keep refusing provider resolution.

const originalCwd = process.cwd();
const originalEnv = {
    PLOINKY_MASTER_KEY: process.env.PLOINKY_MASTER_KEY,
    PLOINKY_WORKSPACE_ROOT: process.env.PLOINKY_WORKSPACE_ROOT,
    PLOINKY_ROUTER_HOST_PORT: process.env.PLOINKY_ROUTER_HOST_PORT,
};
const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-provider-principal-'));
const ploinkyDir = path.join(workspace, '.ploinky');
const reposDir = path.join(ploinkyDir, 'repos');

function writeAgent(agentDir, manifest = {}) {
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify(manifest));
    return agentDir;
}

// Workspace checkout `AssistOSExplorer` supplies the registered repository
// AchillesIDE (origin = its registered URL); managed repos live under repos/.
const checkout = path.join(workspace, 'AssistOSExplorer');
createWorkspaceCheckout(checkout);
const explorerDir = writeAgent(path.join(checkout, 'explorer'), { about: 'explorer' });
const dpuDir = writeAgent(path.join(checkout, 'dpuAgent'), { about: 'dpu' });
const gitDir = writeAgent(path.join(checkout, 'gitAgent'), { about: 'git' });
const keycloakDir = writeAgent(path.join(reposDir, 'basic', 'keycloak'), { ssoProvider: true });
const postgresDir = writeAgent(path.join(reposDir, 'basic', 'postgres'), { about: 'postgres' });
// The same bare agent name in a second installed repository.
writeAgent(path.join(reposDir, 'otherRepo', 'dpuAgent'), { about: 'other dpu' });
// Installed but neither routed nor enabled.
writeAgent(path.join(reposDir, 'otherRepo', 'otherOnly'), { about: 'not routed' });

function route(repo, agent, container, hostPath, extra = {}) {
    return { repo, agent, container, hostPath, hostPort: 7400 + Object.keys(ROUTES).length, ...extra };
}
function record(repoName, agentName, extra = {}) {
    return {
        type: 'agent',
        repoName,
        agentName,
        instanceId: `${repoName}-${agentName}-${extra.alias || 'base'}-instance`,
        enableGeneration: `${repoName}-${agentName}-${extra.alias || 'base'}-enable`,
        auth: { mode: 'none' },
        ...extra,
    };
}
const ROUTES = {};
Object.assign(ROUTES, { explorer: route('AchillesIDE', 'explorer', 'c-explorer', explorerDir) });
Object.assign(ROUTES, { explorer2: route('AchillesIDE', 'explorer', 'c-explorer2', explorerDir, { alias: 'explorer2' }) });
Object.assign(ROUTES, { dpuAgent: route('AchillesIDE', 'dpuAgent', 'c-dpu', dpuDir) });
Object.assign(ROUTES, { gitAgent: route('AchillesIDE', 'gitAgent', 'c-git', gitDir) });
Object.assign(ROUTES, { keycloak: route('basic', 'keycloak', 'c-keycloak', keycloakDir) });
Object.assign(ROUTES, { kc2: route('basic', 'keycloak', 'c-kc2', keycloakDir, { alias: 'kc2' }) });
Object.assign(ROUTES, { postgres: route('basic', 'postgres', 'c-postgres', postgresDir) });
const AGENTS = {
    'c-explorer': record('AchillesIDE', 'explorer'),
    'c-explorer2': record('AchillesIDE', 'explorer', { alias: 'explorer2' }),
    'c-dpu': record('AchillesIDE', 'dpuAgent'),
    'c-git': record('AchillesIDE', 'gitAgent'),
    'c-keycloak': record('basic', 'keycloak'),
    'c-kc2': record('basic', 'keycloak', { alias: 'kc2' }),
    'c-postgres': record('basic', 'postgres'),
};
const ALIAS_ROUTES = ['explorer2', 'kc2'];

fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({ routes: ROUTES }, null, 2));
fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify(AGENTS, null, 2));
fs.mkdirSync(path.join(ploinkyDir, 'data', 'edge-routing'), { recursive: true });
fs.mkdirSync(path.join(ploinkyDir, 'data', 'router-security'), { recursive: true });
fs.writeFileSync(path.join(ploinkyDir, 'data', 'edge-routing', 'desired.json'), JSON.stringify({ hosts: {} }));
fs.writeFileSync(path.join(ploinkyDir, 'data', 'router-security', 'policy-state.json'), JSON.stringify({
    schema: 'router-policy',
    httpRoutes: [],
    mcpTools: [],
}));
process.chdir(workspace);
process.env.PLOINKY_MASTER_KEY = '7'.repeat(64);
process.env.PLOINKY_WORKSPACE_ROOT = workspace;
process.env.PLOINKY_ROUTER_HOST_PORT = '18080';

const gitSpawns = installGitSpawnCounter(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-provider-principal-git-')));
const fsCounter = installFsCallCounter();

const { applyEdgeRoutingGeneration } = await import('../../cli/sandbox/edgeGeneration.js');
const { loadActiveRoutingState } = await import('../../cli/server/routingState.js');
const { resolveProviderPrincipal } = await import('../../cli/server/mcp-proxy/invocationMinter.js');
const { getAgentDescriptorByPrincipal, resolveAgentDescriptor } = await import('../../cli/utils/agentRegistry.js');
const { AGENT_TARGET_AMBIGUOUS, resolveAgentTargetFromSnapshot } = await import('../../cli/utils/agentTargetResolver.js');
const { deriveAgentPrincipalId } = await import('../../cli/utils/security/agentIdentity.js');
const legacy = await import('./fixtures/legacyProviderPrincipal00c95dcc/invocationMinter.mjs');
const legacyRegistry = await import('./fixtures/legacyProviderPrincipal00c95dcc/agentRegistry.mjs');
const {
    buildInvocationContextForProviderCall,
    verifyDelegatedAgentToolCall,
} = await import('../../cli/server/mcp-proxy/index.js');
const { deriveAgentRequestSecret, deriveSubkey } = await import('../../cli/utils/security/masterKey.js');
const { mintUserDelegationGrant } = await import('../../cli/server/mcp-proxy/userDelegationGrant.js');

let activated = false;
// The generation is compiled from the fixture (it reads every routed
// manifest), then postgres's directory is deleted while its route stays active.
function activateGeneration() {
    if (activated) return;
    applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'provider-principal-test-fixture' });
    fs.rmSync(postgresDir, { recursive: true, force: true });
    activated = true;
}

test.after(() => {
    gitSpawns.restore();
    process.chdir(originalCwd);
    for (const [name, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
    }
    fs.rmSync(workspace, { recursive: true, force: true });
});

function measureMint(fn) {
    const spawnsBefore = gitSpawns.count();
    const measured = fsCounter.measure(fn);
    return { ...measured, spawns: gitSpawns.count() - spawnsBefore };
}

// Runs first, before any generation is active.
test('T5: a bare provider ref with no active generation is refused without a scan', () => {
    const { error, spawns, calls } = measureMint(() => resolveProviderPrincipal({ providerAgentRef: 'explorer' }));
    assert.match(String(error?.message), /^invocationMinter: could not resolve provider 'explorer'$/);
    assert.equal(spawns, 0);
    assert.equal(callsNamed(calls, 'readdirSync'), 0);
    assert.equal(manifestReads(calls), 0);
});

test('T5: ambiguous records and a route without repo/agent are refused', () => {
    const ambiguous = {
        routing: { routes: {} },
        agents: { c1: record('repoOne', 'dup'), c2: record('repoTwo', 'dup') },
    };
    assert.throws(() => resolveProviderPrincipal({ providerAgentRef: 'dup', snapshot: ambiguous }), (error) => {
        assert.match(error.message, /could not resolve provider 'dup'.*ambiguous/);
        assert.equal(error.code, AGENT_TARGET_AMBIGUOUS);
        return true;
    });
    const routedTwice = {
        routing: { routes: {
            one: { repo: 'repoOne', agent: 'same', hostPath: '/one/same' },
            two: { repo: 'repoOne', agent: 'same', hostPath: '/two/same' },
        } },
        agents: {},
    };
    assert.throws(() => resolveProviderPrincipal({ providerAgentRef: 'repoOne/same', snapshot: routedTwice }),
        /could not resolve provider 'repoOne\/same'.*ambiguous/);
    const partialRoute = { routing: { routes: { legacy: { container: 'missing', hostPath: '/x' } } }, agents: {} };
    const { error, spawns } = measureMint(() => resolveProviderPrincipal({ providerAgentRef: 'legacy', snapshot: partialRoute }));
    assert.match(String(error?.message), /^invocationMinter: could not resolve provider 'legacy'$/);
    assert.equal(spawns, 0);
    assert.throws(() => resolveProviderPrincipal({ providerAgentRef: '' }), /could not resolve provider/);
});

test('T3: the principal of a routed bare ref comes from the route with no scan', () => {
    const snapshot = {
        routing: { routes: { explorer: { repo: 'AchillesIDE', agent: 'explorer', hostPath: explorerDir } } },
        agents: {},
    };
    const { result, error, spawns, calls } = measureMint(
        () => resolveProviderPrincipal({ providerAgentRef: 'explorer', snapshot }));
    assert.equal(error, null);
    assert.equal(result, 'agent:AchillesIDE/explorer');
    assert.equal(spawns, 0);
    assert.equal(callsNamed(calls, 'readdirSync'), 0);
    assert.equal(manifestReads(calls), 0);
    assert.deepEqual(calls, [], 'an explicit snapshot needs no I/O at all');
});

test('T3: without a caller snapshot the active generation supplies the route', () => {
    activateGeneration();
    resolveProviderPrincipal({ providerAgentRef: 'explorer' });
    const { result, error, spawns, calls } = measureMint(() => resolveProviderPrincipal({ providerAgentRef: 'explorer' }));
    assert.equal(error, null);
    assert.equal(result, 'agent:AchillesIDE/explorer');
    assert.equal(spawns, 0);
    assert.equal(callsNamed(calls, 'readdirSync'), 0);
    assert.equal(manifestReads(calls), 0);
});

function outcome(fn) {
    try {
        return fn();
    } catch (error) {
        assert.match(error.message, /could not resolve provider/);
        return 'refused';
    }
}

test('T4/B3(i): every non-alias route mints the identity of the container serving it', () => {
    activateGeneration();
    const { snapshot } = loadActiveRoutingState();
    assert.deepEqual(Object.keys(snapshot.routing.routes).sort(), Object.keys(ROUTES).sort());
    for (const [routeKey, activeRoute] of Object.entries(snapshot.routing.routes)) {
        const servedBy = snapshot.agents[activeRoute.container];
        const minted = outcome(() => resolveProviderPrincipal({ providerAgentRef: routeKey }));
        if (ALIAS_ROUTES.includes(routeKey)) {
            assert.ok(servedBy.alias, `${routeKey} is an alias instance`);
            assert.equal(minted, 'refused', `${routeKey}: alias routes stay refused`);
            continue;
        }
        assert.equal(minted, deriveAgentPrincipalId(servedBy.repoName, servedBy.agentName), routeKey);
    }
});

test('T4/B3(ii): against 00c95dcc only the two accepted relaxations differ', () => {
    activateGeneration();
    const { snapshot } = loadActiveRoutingState();
    const differences = {};
    const same = {};
    for (const routeKey of Object.keys(snapshot.routing.routes).sort()) {
        legacyRegistry.__internal.clearAgentIndexMemo();
        const before = outcome(() => legacy.resolveProviderPrincipal({ providerAgentRef: routeKey }));
        const after = outcome(() => resolveProviderPrincipal({ providerAgentRef: routeKey }));
        if (before === after) same[routeKey] = after;
        else differences[routeKey] = { before, after };
    }
    assert.deepEqual(differences, {
        // (1) A bare name in two repos, one routed: minted for the routed container.
        dpuAgent: { before: 'refused', after: 'agent:AchillesIDE/dpuAgent' },
        // (2) The routed agent's directory was deleted: minted from the route.
        postgres: { before: 'refused', after: 'agent:basic/postgres' },
    });
    assert.deepEqual(same, {
        explorer: 'agent:AchillesIDE/explorer',
        explorer2: 'refused',
        gitAgent: 'agent:AchillesIDE/gitAgent',
        kc2: 'refused',
        keycloak: 'agent:basic/keycloak',
    });
    // The relaxations follow from the fixture, not from a broken oracle.
    assert.equal(fs.existsSync(postgresDir), false);
    assert.equal(fs.existsSync(path.join(reposDir, 'otherRepo', 'dpuAgent', 'manifest.json')), true);
});

test('Q4: the resolver reads deep-frozen snapshots without mutating them', () => {
    activateGeneration();
    const active = loadActiveRoutingState().snapshot;
    assert.equal(Object.isFrozen(active.routing.routes.explorer), true, 'the active generation is frozen');
    assert.equal(resolveProviderPrincipal({ providerAgentRef: 'keycloak', snapshot: active }), 'agent:basic/keycloak');

    const snapshot = {
        routing: {
            static: { agent: 'staticAgent', container: 'c-static' },
            routes: {
                explorer: { repo: 'AchillesIDE', agent: 'explorer', container: 'c-explorer', hostPath: explorerDir },
                explorer2: { repo: 'AchillesIDE', agent: 'explorer', container: 'c-explorer2', alias: 'explorer2' },
            },
        },
        agents: {
            'c-explorer': record('AchillesIDE', 'explorer'),
            'c-explorer2': record('AchillesIDE', 'explorer', { alias: 'explorer2' }),
            'c-static': record('site', 'staticAgent'),
            'c-solo': record('tools', 'soloAgent'),
            c1: record('repoOne', 'dup'),
            c2: record('repoTwo', 'dup'),
        },
    };
    const pristine = structuredClone(snapshot);
    deepFreeze(snapshot);
    const cases = [
        ['explorer', { repo: 'AchillesIDE', agent: 'explorer', routeKey: 'explorer', hostPath: explorerDir }],
        ['AchillesIDE/explorer', { repo: 'AchillesIDE', agent: 'explorer', routeKey: 'explorer', hostPath: explorerDir }],
        ['tools:soloAgent', { repo: 'tools', agent: 'soloAgent', routeKey: null, hostPath: '' }],
        ['staticAgent', { repo: 'site', agent: 'staticAgent', routeKey: null, hostPath: '' }],
        ['soloAgent', { repo: 'tools', agent: 'soloAgent', routeKey: null, hostPath: '' }],
        ['explorer2', null],
        ['c-explorer2', null],
        ['missing', null],
        ['a/b/c', null],
    ];
    for (const [ref, expected] of cases) {
        assert.deepEqual(resolveAgentTargetFromSnapshot(ref, snapshot), expected, ref);
    }
    assert.throws(() => resolveAgentTargetFromSnapshot('dup', snapshot), { code: AGENT_TARGET_AMBIGUOUS });
    assert.equal(resolveProviderPrincipal({ providerAgentRef: 'soloAgent', snapshot }), 'agent:tools/soloAgent');
    assert.deepEqual(snapshot, pristine, 'the snapshot is unchanged');
});

test('F1: a qualified ref naming the checkout folder, not the canonical repository, is refused as at 00c95dcc', () => {
    activateGeneration();
    const legacyOutcome = (ref) => {
        legacyRegistry.__internal.clearAgentIndexMemo();
        return outcome(() => legacy.resolveProviderPrincipal({ providerAgentRef: ref }));
    };
    const legacyDescriptor = (ref) => {
        legacyRegistry.__internal.clearAgentIndexMemo();
        return legacyRegistry.resolveAgentDescriptor(ref);
    };
    const legacyByPrincipal = (principal) => {
        legacyRegistry.__internal.clearAgentIndexMemo();
        return legacyRegistry.getAgentDescriptorByPrincipal(principal);
    };
    // The checkout folder resolves to a repository path, but it is not a
    // principal name: both implementations refuse every spelling.
    assert.ok(fs.existsSync(path.join(checkout, 'explorer', 'manifest.json')));
    for (const ref of ['AssistOSExplorer/explorer', 'AssistOSExplorer:gitAgent', 'AssistOSExplorer/dpuAgent']) {
        assert.equal(legacyDescriptor(ref), null, `00c95dcc descriptor ${ref}`);
        assert.equal(resolveAgentDescriptor(ref), null, `descriptor ${ref}`);
        assert.equal(resolveAgentDescriptor(ref, { snapshot: loadActiveRoutingState().snapshot }), null, `routed descriptor ${ref}`);
        assert.equal(legacyOutcome(ref), 'refused', `00c95dcc principal ${ref}`);
        assert.equal(outcome(() => resolveProviderPrincipal({ providerAgentRef: ref })), 'refused', `principal ${ref}`);
    }
    for (const principal of ['agent:AssistOSExplorer/explorer', 'agent:AssistOSExplorer/gitAgent']) {
        assert.equal(legacyByPrincipal(principal), null, `00c95dcc ${principal}`);
        assert.equal(getAgentDescriptorByPrincipal(principal), null, principal);
    }
    // The canonical spelling of the same agents still resolves in both.
    for (const ref of ['AchillesIDE/explorer', 'AchillesIDE/gitAgent']) {
        const expected = `agent:${ref}`;
        assert.equal(legacyDescriptor(ref)?.principalId, expected);
        assert.equal(resolveAgentDescriptor(ref)?.principalId, expected);
        assert.equal(getAgentDescriptorByPrincipal(expected)?.principalId, expected);
        assert.equal(legacyOutcome(ref), expected);
        assert.equal(resolveProviderPrincipal({ providerAgentRef: ref }), expected);
    }
});

test('a dot-prefixed qualified ref never falls back to a bare-name lookup', () => {
    activateGeneration();
    // At 00c95dcc the './' prefix was stripped and the bare name searched
    // every repository; the minter now keeps the parsed repo '.'.
    legacyRegistry.__internal.clearAgentIndexMemo();
    assert.equal(legacy.resolveProviderPrincipal({ providerAgentRef: './otherOnly' }), 'agent:otherRepo/otherOnly');
    for (const ref of ['./otherOnly', './explorer', './explorer2', '.:otherOnly']) {
        assert.equal(outcome(() => resolveProviderPrincipal({ providerAgentRef: ref })), 'refused', ref);
    }
});

const SOURCE_AGENT = 'agent:OnlyOfficeAgent/onlyOffice';
const TOOL = 'explorer_tool';
const ARGS = { id: 'doc-1' };

function delegationFor(targetAgentId) {
    return mintUserDelegationGrant({
        signingSecret: deriveSubkey('router-user-delegation', 32),
        now: new Date(),
        ttlSeconds: 600,
        sourceAgentId: SOURCE_AGENT,
        route: { routeKey: 'onlyOffice', pathPrefix: '/onlyOffice/', requestPath: '/control' },
        user: { id: 'local:alice', username: 'alice', roles: ['user'] },
        targetAgentId,
        tools: [TOOL],
        scopes: ['explorer:read'],
    }).token;
}

function delegatedRequest(routeKey, delegationToken) {
    const assertion = signAgentAssertion({
        targetAgent: routeKey,
        tool: TOOL,
        argumentsObj: ARGS,
        env: { PLOINKY_AGENT_ID: SOURCE_AGENT, PLOINKY_AGENT_SECRET: deriveAgentRequestSecret(SOURCE_AGENT) },
    });
    return {
        headers: {
            authorization: `Bearer ${assertion}`,
            ...(delegationToken ? { 'x-ploinky-user-delegation': delegationToken } : {}),
        },
    };
}

const USER_REQUEST = { user: { id: 'local:alice', username: 'alice', roles: ['user'] } };

test('B1: user MCP calls to alias routes stay refused while the base agent mints', () => {
    activateGeneration();
    const base = buildInvocationContextForProviderCall({
        req: USER_REQUEST, agentName: 'explorer', toolName: TOOL, toolArgs: ARGS,
    });
    assert.equal(base.payload.aud, 'agent:AchillesIDE/explorer');
    for (const alias of ALIAS_ROUTES) {
        assert.throws(() => buildInvocationContextForProviderCall({
            req: USER_REQUEST, agentName: alias, toolName: TOOL, toolArgs: ARGS,
        }), new RegExp(`^Error: invocationMinter: could not resolve provider '${alias}'$`));
    }
});

test('B1: delegated MCP calls to alias routes stay refused, even with a grant for the base agent', () => {
    activateGeneration();
    const baseGrant = delegationFor('agent:AchillesIDE/explorer');
    const verified = verifyDelegatedAgentToolCall({
        req: delegatedRequest('explorer', baseGrant),
        agentName: 'explorer',
        toolName: TOOL,
        rawArgs: ARGS,
        assertionCache: createMemoryReplayCache(),
    });
    assert.equal(verified.userDelegation.delegation.targetAgentId, 'agent:AchillesIDE/explorer');

    assert.throws(() => verifyDelegatedAgentToolCall({
        req: delegatedRequest('explorer2', baseGrant),
        agentName: 'explorer2',
        toolName: TOOL,
        rawArgs: ARGS,
        assertionCache: createMemoryReplayCache(),
    }), /^Error: invocationMinter: could not resolve provider 'explorer2'$/);

    // A verified agent caller without a grant: the minted target is the route's.
    const agentOnly = verifyDelegatedAgentToolCall({
        req: delegatedRequest('kc2', null),
        agentName: 'kc2',
        toolName: TOOL,
        rawArgs: ARGS,
        assertionCache: createMemoryReplayCache(),
    });
    assert.throws(() => buildInvocationContextForProviderCall({
        req: { delegatedAgentVerified: agentOnly }, agentName: 'kc2', toolName: TOOL, toolArgs: ARGS,
    }), /^Error: invocationMinter: could not resolve provider 'kc2'$/);
    const baseAgentOnly = verifyDelegatedAgentToolCall({
        req: delegatedRequest('keycloak', null),
        agentName: 'keycloak',
        toolName: TOOL,
        rawArgs: ARGS,
        assertionCache: createMemoryReplayCache(),
    });
    const ctx = buildInvocationContextForProviderCall({
        req: { delegatedAgentVerified: baseAgentOnly }, agentName: 'keycloak', toolName: TOOL, toolArgs: ARGS,
    });
    assert.equal(ctx.payload.aud, 'agent:basic/keycloak');
    assert.equal(ctx.payload.sub, SOURCE_AGENT);
});
