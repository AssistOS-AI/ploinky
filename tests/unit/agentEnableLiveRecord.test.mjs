import '../helpers/isolatedWorkspaceRoot.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';

import { getAgentContainerName } from '../../cli/sandbox/docker/index.js';
import { previewAgentEnable } from '../../cli/utils/agents.js';

// An enable drops other same-agent registry keys (for example a coordinated replacement's `__candidate_` record). It
// must never drop one whose container still exists: that runtime would keep running unregistered beside the new one,
// with every bind it holds (the read-only target-mailbox root of a worker included).

const BASE = getAgentContainerName('a', 'demo');
const CANDIDATE = `${BASE}__candidate_44b7fad0ab95`;

function record(extra = {}) {
    return { type: 'agent', repoName: 'demo', agentName: 'a', instanceId: 'inst-old', enableGeneration: 'egen-old', containerId: 'c'.repeat(64), ...extra };
}

function preview(registry, { containerPresent, alias = '' } = {}) {
    const routing = { routes: {} };
    const before = structuredClone({ registry, routing });
    const asked = [];
    const resolved = {
        agentPath: '/fixture/demo/a', manifest: { container: 'node:20' }, manifestBytes: Buffer.from('{}'), manifestPath: '/fixture/demo/a/manifest.json',
        normalized: { mode: 'global' }, profile: '', repoName: 'demo', routerEndpoint: null, runtimeAdmission: {}, shortAgentName: 'a',
        profileResolution: { resolvedProfileName: 'default', profileConfig: null, network: { mode: 'default' } },
    };
    try {
        const result = previewAgentEnable({ agentName: 'demo/a', mode: 'global', aliasParam: alias }, {
            readRegistry: () => registry, readRouting: () => routing, resolveInput: () => resolved,
            containerPresent: (name) => { asked.push(name); return containerPresent(name); },
        });
        return { result, asked };
    } catch (error) {
        return { error, asked };
    } finally {
        assert.deepEqual({ registry, routing }, before, 'planning never changes the detached registry or routing');
    }
}

test('an enable refuses to drop a same-agent record whose container still exists, naming that container', () => {
    const { error, asked } = preview({ [CANDIDATE]: record() }, { containerPresent: (name) => name === CANDIDATE });
    assert.equal(error?.code, 'PLOINKY_AGENT_ENABLE_LIVE_RECORD');
    assert.equal(error.containerName, CANDIDATE);
    assert.match(error.message, new RegExp(`registered as '${CANDIDATE}', whose container still exists`));
    assert.match(error.message, /ploinky disable agent demo\/a/);
    assert.deepEqual(asked, [CANDIDATE]);
});

test('a same-agent record whose container is gone is dropped as before, and the enable plans the base name', () => {
    const { result, error, asked } = preview({ [CANDIDATE]: record() }, { containerPresent: () => false });
    assert.equal(error, undefined);
    assert.equal(result.plan.containerName, BASE);
    assert.deepEqual(asked, [CANDIDATE]);
});

test('the ordinary re-enable of the registered key, aliased instances and native runtimes are not container-checked', () => {
    const never = () => assert.fail('no container check');
    // The key being enabled is replaced through its own predecessor ownership, not dropped here.
    assert.equal(preview({ [BASE]: record() }, { containerPresent: never }).result.plan.containerName, BASE);
    // An aliased same-agent instance is another instance, never dropped by an unaliased enable.
    assert.equal(preview({ [`${BASE}_x`]: record({ alias: 'x' }) }, { containerPresent: never }).error, undefined);
    // A native (bwrap/seatbelt) record has no container to inspect.
    for (const runtime of ['bwrap', 'seatbelt']) {
        assert.equal(preview({ [CANDIDATE]: record({ runtime }) }, { containerPresent: never }).error, undefined, runtime);
    }
    // Other agents' records are untouched.
    assert.equal(preview({ other: record({ agentName: 'b' }) }, { containerPresent: never }).error, undefined);
});
