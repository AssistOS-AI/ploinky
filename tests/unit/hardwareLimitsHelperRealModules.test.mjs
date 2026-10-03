// LIVE-C6's in-Box program against the REAL product modules (release plan R23-1). The program's own statements that capture the generation lease
// and build the topology intent (LEASE_AND_INTENT_SOURCE) run here over a generation the real core code compiled on a non-default UDP port, with
// the environment its exec argv sets. The fixture is the one of tests/unit/edgeGenerationHardCut.test.mjs. Offline: no engine, no container.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { applyEdgeRoutingGeneration } from '../../cli/sandbox/edgeGeneration.js';
import * as edge from '../../cli/sandbox/edgeGeneration.js';
import * as attestation from '../../cli/sandbox/routerAuthorityAttestation.js';
import * as identity from '../../cli/utils/security/agentIdentity.js';
import { AUTHORITY_HELPER_PROGRAM, LEASE_AND_INTENT_SOURCE, helperProgramArgv } from '../hardware-limits/liveHelperCommands.mjs';

const { leaseAndIntent } = await import(`data:text/javascript;base64,${Buffer.from(`${LEASE_AND_INTENT_SOURCE}\nexport { leaseAndIntent };`).toString('base64')}`);

const ROUTER_PORT = 23456;     // the run's TCP port, drawn away from 8080
const MEDIA_PORT = 34567;      // the run's UDP port, drawn away from 7882
const OWNER = Object.freeze({ containerName: 'alpha-container', repoName: 'fixtures', agentName: 'alpha', instanceId: 'alpha-instance', enableGeneration: 'alpha-enable-generation' });

function fixture(t, { staticAgent = 'alpha' } = {}) {
    const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'hwl-c6-real-')));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    const alphaDir = path.join(ploinkyDir, 'repos', 'fixtures', 'alpha');
    const betaDir = path.join(ploinkyDir, 'repos', 'fixtures', 'beta');
    for (const directory of [edgeDir, policyDir, alphaDir, betaDir]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(alphaDir, 'manifest.json'), JSON.stringify({ routerAccess: { httpRoutes: [{ path: '/base-agent-additional-server/alpha/7000/*', access: 'authenticated' }] } }, null, 2));
    fs.writeFileSync(path.join(betaDir, 'manifest.json'), '{}');
    fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        static: { agent: staticAgent, port: 7777 },
        routes: {
            alpha: { repo: 'fixtures', agent: 'alpha', container: 'alpha-container', hostPath: alphaDir, hostPort: 43101 },
            beta: { repo: 'fixtures', agent: 'beta', container: 'beta-container', hostPath: betaDir, hostPort: 43102 },
        },
    }, null, 2));
    fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        'alpha-container': { type: 'agent', repoName: 'fixtures', agentName: 'alpha', instanceId: 'alpha-instance', enableGeneration: 'alpha-enable-generation', auth: { mode: 'sso' } },
        'beta-container': { type: 'agent', repoName: 'fixtures', agentName: 'beta', instanceId: 'beta-instance', enableGeneration: 'beta-enable-generation', auth: { mode: 'sso' } },
    }, null, 2));
    fs.writeFileSync(path.join(edgeDir, 'desired.json'), JSON.stringify({ hosts: {} }, null, 2));
    fs.writeFileSync(path.join(policyDir, 'policy-state.json'), JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools: [] }, null, 2));
    const previous = Object.fromEntries(['PLOINKY_WORKSPACE_ROOT', 'PLOINKY_ROUTER_HOST_PORT', 'PLOINKY_MEDIA_HOST_PORT'].map(name => [name, process.env[name]]));
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    t.after(() => {
        for (const [name, value] of Object.entries(previous)) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    return { workspace };
}

// The core compiles the active generation in ITS exec: --port and --udp-port of the run, both away from the defaults.
function compileGeneration(workspace) {
    process.env.PLOINKY_ROUTER_HOST_PORT = String(ROUTER_PORT);
    process.env.PLOINKY_MEDIA_HOST_PORT = String(MEDIA_PORT);
    const applied = applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'c6-real-modules' });
    assert.equal(applied.generation.mediaHostPort, MEDIA_PORT);
}
// The Box exec's environment for the program: the container has neither port variable, and the exec sets exactly the `--env` pairs of its argv.
function execEnvironment(argv, { without = [] } = {}) {
    for (const name of ['PLOINKY_ROUTER_HOST_PORT', 'PLOINKY_MEDIA_HOST_PORT']) delete process.env[name];
    const pairs = argv.flatMap((value, index) => (argv[index - 1] === '--env' ? [value] : []));
    for (const pair of pairs) { const [name, ...rest] = pair.split('='); if (!without.includes(name)) process.env[name] = rest.join('='); }
    return pairs;
}
const PLAN = Object.freeze({ mode: 'default', runtimeProof: { engine: 'podman', rootless: true, backend: 'netavark', remote: false }, networkFingerprint: `sha256:${'a'.repeat(64)}` });
const params = () => ({ root: '/opt/ploinky', cgroupRoot: '/sys/fs/cgroup', mode: 'real', routerPort: ROUTER_PORT, ...OWNER, image: 'img@sha256:x' });
const argvFor = () => helperProgramArgv({ boxId: 'b'.repeat(64), workspace: '/ws', routerPort: ROUTER_PORT, mediaPort: MEDIA_PORT, params: params() });
const modules = { edge, attestation, identity };

test('X4.c6-real-modules-the-programs-lease-and-intent-are-built-over-a-generation-compiled-on-the-run-udp-port-with-its-argv-environment', t => {
    const { workspace } = fixture(t);
    compileGeneration(workspace);
    const pairs = execEnvironment(argvFor());
    assert.deepEqual(pairs, [`PLOINKY_ROUTER_HOST_PORT=${ROUTER_PORT}`, `PLOINKY_MEDIA_HOST_PORT=${MEDIA_PORT}`]);
    const { lease, intent } = leaseAndIntent(modules, params(), OWNER, PLAN);
    assert.match(String(lease.id), /^sha256:[a-f0-9]{64}$/);
    assert.deepEqual(lease.owner && { instanceId: lease.owner.instanceId, enableGeneration: lease.owner.enableGeneration }, { instanceId: OWNER.instanceId, enableGeneration: OWNER.enableGeneration });
    assert.equal(lease.snapshot.routing.static.agent, 'alpha');
    // The intent: the run's Router port in the public authority, the exact authentication route of the generation, the plan's proof and fingerprint.
    assert.equal(intent.publicAuthority, `127.0.0.1:${ROUTER_PORT}`);
    assert.equal(intent.authRouteKey, 'alpha');
    assert.deepEqual([intent.runtimeProof, intent.networkFingerprint], [PLAN.runtimeProof, PLAN.networkFingerprint]);
    assert.equal(intent.edgeTopologyFile, edge.edgeRuntimeEnvironment('default').PLOINKY_EDGE_TOPOLOGY_FILE);
    assert.equal(lease.isCurrent(), true);
});

test('X4.c6-real-modules-the-intent-names-the-generations-own-authentication-route', t => {
    // The route key is the generation's static agent, never a constant of the program.
    for (const staticAgent of ['alpha', 'beta']) {
        const { workspace } = fixture(t, { staticAgent });
        compileGeneration(workspace);
        execEnvironment(argvFor());
        assert.equal(leaseAndIntent(modules, params(), OWNER, PLAN).intent.authRouteKey, staticAgent);
    }
});

test('X4.c6-real-modules-without-the-media-port-the-real-lease-refuses-the-generation-compiled-on-the-run-udp-port', t => {
    const { workspace } = fixture(t);
    compileGeneration(workspace);
    // The exec that carries the Router port only, as the program was run before this change: the media port falls back to 7882.
    execEnvironment(argvFor(), { without: ['PLOINKY_MEDIA_HOST_PORT'] });
    let failure = null;
    try { leaseAndIntent(modules, params(), OWNER, PLAN); } catch (error) { failure = error; }
    assert.equal(failure?.code, 'EDGE_GENERATION_RUNTIME_MISMATCH');
    assert.match(String(failure?.message), /different physical media host port/);
    // A wrong media port is refused the same way, and the right one is accepted again.
    process.env.PLOINKY_MEDIA_HOST_PORT = String(MEDIA_PORT + 1);
    assert.throws(() => leaseAndIntent(modules, params(), OWNER, PLAN), { code: 'EDGE_GENERATION_RUNTIME_MISMATCH' });
    process.env.PLOINKY_MEDIA_HOST_PORT = String(MEDIA_PORT);
    assert.doesNotThrow(() => leaseAndIntent(modules, params(), OWNER, PLAN));
});

test('X4.c6-real-modules-a-lease-of-another-owner-is-refused-by-the-real-product', t => {
    const { workspace } = fixture(t);
    compileGeneration(workspace);
    execEnvironment(argvFor());
    for (const wrong of [{ instanceId: 'other-instance' }, { enableGeneration: 'other-generation' }, { containerName: 'beta-container' }, { agentName: 'beta' }]) {
        assert.throws(() => leaseAndIntent(modules, { ...params(), ...wrong }, { ...OWNER, ...wrong }, PLAN), error => /owner|identity|principal|mismatch/i.test(String(error?.message)) || /^EDGE_/.test(String(error?.code)), JSON.stringify(wrong));
    }
});

// Every call the program makes on a product module names an export the real module has (the names and the module each variable stands for).
test('X4.c6-real-modules-every-product-function-the-program-calls-is-an-export-of-the-real-module', async () => {
    const loads = [...AUTHORITY_HELPER_PROGRAM.matchAll(/load\('([^']+)'\)/g)].map(match => match[1]);
    const names = /const \[([^\]]+)\] = await Promise\.all/.exec(AUTHORITY_HELPER_PROGRAM)[1].split(',').map(value => value.trim());
    assert.equal(names.length, loads.length);
    const moduleOf = new Map(names.map((name, index) => [name, loads[index]]));
    const calls = [...AUTHORITY_HELPER_PROGRAM.matchAll(/\b(lifecycle|edge|attestation|delegation|requested|registryModule|graph|identity|hardwareState)\.(\w+)\(/g)].map(match => [match[1], match[2]]);
    assert.ok(calls.length >= 9, `the program calls ${calls.length} product functions`);
    for (const [variable, name] of calls) {
        const real = await import(new URL(`../../${moduleOf.get(variable)}`, import.meta.url));
        assert.equal(typeof real[name], 'function', `${moduleOf.get(variable)} exports ${name}`);
    }
    // The pieces of the lease-and-intent statements are exports of the modules this test passes.
    for (const [variable, name] of [['edge', 'createRouterAttestationGenerationLease'], ['edge', 'edgeRuntimeEnvironment'], ['attestation', 'buildRouterAuthorityTopologyIntent'], ['identity', 'deriveAgentPrincipalId']]) {
        assert.equal(typeof modules[variable][name], 'function', `${variable}.${name}`);
    }
    // The program embeds exactly the source this test runs.
    assert.ok(AUTHORITY_HELPER_PROGRAM.includes(LEASE_AND_INTENT_SOURCE.trim()));
    assert.ok(AUTHORITY_HELPER_PROGRAM.includes('leaseAndIntent({ edge, attestation, identity }, params, record, plan)'));
});
