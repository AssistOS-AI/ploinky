import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';

import { applyEdgeRoutingGeneration } from '../../cli/sandbox/edgeGeneration.js';
import {
    AGENT_PORT_NOT_DECLARED,
    AGENT_PORT_RELAY_DISABLED,
    agentPortRelayDenial,
    normalizeAgentPortRelayPolicy,
} from '../../cli/server/agentPortConvention/relayPolicy.js';
import { resolveEdgeRoutePlan } from '../../cli/server/edgeRoutePlan.js';

// One enabled agent whose manifest may opt out of the agent-port relay.
function fixture(t, routerAccess) {
    const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-agent-port-opt-out-'));
    const ploinkyDir = path.join(workspace, '.ploinky');
    const agentDir = path.join(ploinkyDir, 'repos', 'fixtures', 'alpha');
    const edgeDir = path.join(ploinkyDir, 'data', 'edge-routing');
    const policyDir = path.join(ploinkyDir, 'data', 'router-security');
    for (const directory of [agentDir, edgeDir, policyDir]) fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(agentDir, 'manifest.json'), JSON.stringify(routerAccess === undefined ? {} : { routerAccess }));
    fs.writeFileSync(path.join(ploinkyDir, 'routing.json'), JSON.stringify({
        static: { agent: 'alpha', port: 7777 },
        routes: { alpha: { repo: 'fixtures', agent: 'alpha', container: 'alpha-container', hostPath: agentDir, hostPort: 43101 } },
    }));
    fs.writeFileSync(path.join(ploinkyDir, 'agents.json'), JSON.stringify({
        'alpha-container': {
            type: 'agent', repoName: 'fixtures', agentName: 'alpha',
            instanceId: 'alpha-instance', enableGeneration: 'alpha-enabled',
            runtime: 'podman', containerId: 'a'.repeat(64), auth: { mode: 'sso' },
        },
    }));
    fs.writeFileSync(path.join(edgeDir, 'desired.json'), JSON.stringify({ hosts: {} }));
    fs.writeFileSync(path.join(policyDir, 'policy-state.json'), JSON.stringify({ schema: 'router-policy', httpRoutes: [], mcpTools: [] }));
    const previous = process.env.PLOINKY_WORKSPACE_ROOT;
    process.env.PLOINKY_WORKSPACE_ROOT = workspace;
    t.after(() => {
        if (previous === undefined) delete process.env.PLOINKY_WORKSPACE_ROOT;
        else process.env.PLOINKY_WORKSPACE_ROOT = previous;
        fs.rmSync(workspace, { recursive: true, force: true });
    });
    return { activate: () => applyEdgeRoutingGeneration({ workspaceRoot: workspace, reason: 'agent-port-opt-out-unit' }) };
}

function resolve(port, transport = 'http') {
    const req = Readable.from([]);
    req.method = 'GET';
    req.url = `/base-agent-additional-server/alpha/${port}/health`;
    req.headers = { host: '127.0.0.1:8080' };
    return resolveEdgeRoutePlan({ req, listener: 'public', transport });
}

test('the relay policy accepts true, false, or a list of distinct ports', () => {
    assert.deepEqual(normalizeAgentPortRelayPolicy(undefined), { mode: 'all' });
    assert.deepEqual(normalizeAgentPortRelayPolicy(true), { mode: 'all' });
    assert.deepEqual(normalizeAgentPortRelayPolicy(false), { mode: 'none' });
    assert.deepEqual(normalizeAgentPortRelayPolicy([9000, 7000]), { mode: 'listed', ports: [7000, 9000] });
    for (const invalid of [[], [0], [65536], [7000, 7000], ['7000'], 'none', {}]) {
        assert.throws(() => normalizeAgentPortRelayPolicy(invalid), /routerAccess\.agentPorts/, JSON.stringify(invalid));
    }
    assert.equal(agentPortRelayDenial({ mode: 'all' }, 11434), null);
    assert.deepEqual(agentPortRelayDenial({ mode: 'none' }, 7000), { status: 403, code: AGENT_PORT_RELAY_DISABLED });
    assert.deepEqual(agentPortRelayDenial({ mode: 'listed', ports: [7000] }, 8081), { status: 403, code: AGENT_PORT_NOT_DECLARED });
});

test('without the field every port is still relayed (existing behaviour)', (t) => {
    fixture(t, undefined).activate();
    for (const port of [7000, 8081, 11434]) {
        const plan = resolve(port);
        assert.equal(plan.ok, true, String(port));
        assert.equal(plan.kind, 'agent-port');
    }
});

test('an opted-out agent refuses every port before any access decision', (t) => {
    fixture(t, { agentPorts: false }).activate();
    for (const port of [7000, 8081, 11434]) {
        for (const transport of ['http', 'websocket']) {
            const plan = resolve(port, transport);
            assert.equal(plan.ok, false, `${port} ${transport}`);
            assert.equal(plan.status, 403);
            assert.equal(plan.code, AGENT_PORT_RELAY_DISABLED);
            // The refusal precedes the route access policy, so it applies to
            // every caller, administrators included.
            assert.equal(plan.decision, undefined);
        }
    }
});

test('a declared port list relays only those ports', (t) => {
    fixture(t, { agentPorts: [7000] }).activate();
    assert.equal(resolve(7000).ok, true);
    for (const port of [8081, 11434]) {
        const plan = resolve(port);
        assert.equal(plan.ok, false);
        assert.equal(plan.code, AGENT_PORT_NOT_DECLARED);
    }
});

test('a malformed opt-out is rejected when the edge generation is compiled', (t) => {
    assert.throws(fixture(t, { agentPorts: [0] }).activate, /routerAccess\.agentPorts entries must be integer TCP ports/);
});

test('a declared agent-port route on a port the opt-out closes is rejected when compiled', (t) => {
    const route = { '/base-agent-additional-server/alpha/9000/*': 'public' };
    assert.throws(
        () => fixture(t, { agentPorts: false, httpRoutes: route }).activate(),
        /routerAccess\.httpRoutes declares \/base-agent-additional-server\/alpha\/9000\/\* on agent port 9000, which routerAccess\.agentPorts closes/,
    );
    assert.throws(() => fixture(t, { agentPorts: [7000], httpRoutes: route }).activate(), /agent port 9000, which routerAccess\.agentPorts closes/);
    assert.doesNotThrow(() => fixture(t, { agentPorts: [9000], httpRoutes: route }).activate());
    assert.doesNotThrow(() => fixture(t, { httpRoutes: route }).activate());
    assert.doesNotThrow(() => fixture(t, {
        agentPorts: false,
        httpRoutes: [{ path: '/base-agent-additional-server/alpha/9000/*', access: 'public', enabled: false }],
    }).activate());
});
