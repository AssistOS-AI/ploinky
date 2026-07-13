import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assertNetworkStartupCompatibility,
    canonicalizeNetwork,
    deriveNetworkAlias,
    effectiveManifestNetwork,
    logicalNetworkAttachments,
    preflightNetworkAliases,
    validateManifestNetworks,
} from '../../cli/services/networkContract.js';

test('network contract canonicalizes only the four exact modes', () => {
    assert.deepEqual(canonicalizeNetwork(undefined), { mode: 'default' });
    for (const mode of ['default', 'none', 'host']) {
        assert.deepEqual(canonicalizeNetwork({ mode }), { mode });
    }
    assert.deepEqual(canonicalizeNetwork({
        mode: 'bridge',
        attachments: [{ name: 'front', primary: true }, { name: 'data' }],
    }), {
        mode: 'bridge',
        attachments: [{ name: 'front', primary: true }, { name: 'data' }],
    });
    for (const invalid of [
        {},
        { mode: 'DEFAULT' },
        { mode: 'default', attachments: [] },
        { mode: 'default', name: 'legacy' },
        { mode: 'bridge', attachments: [] },
        { mode: 'bridge', attachments: [{ name: 'front' }] },
        { mode: 'bridge', attachments: [{ name: 'front', primary: true }, { name: 'front' }] },
        { mode: 'bridge', attachments: [{ name: 'Bad_Name', primary: true }] },
        { mode: 'bridge', attachments: [{ name: 'front', primary: true, external: true }] },
    ]) {
        assert.throws(() => canonicalizeNetwork(invalid), /network|mode|attachment|field/i);
    }
});

test('profile network omission inherits root and a profile block replaces it atomically', () => {
    const manifest = {
        network: { mode: 'bridge', attachments: [{ name: 'root-net', primary: true }] },
        profiles: {
            default: { env: { A: '1' } },
            host: { network: { mode: 'host' } },
        },
    };
    assert.deepEqual(effectiveManifestNetwork(manifest, 'default'), manifest.network);
    assert.deepEqual(effectiveManifestNetwork(manifest, 'host'), { mode: 'host' });
    assert.equal(validateManifestNetworks(manifest), true);
});

test('alias derivation is deterministic, bounded, and reserves the router identity', () => {
    assert.equal(deriveNetworkAlias('Repo/My Agent'), 'repo-my-agent');
    assert.throws(() => deriveNetworkAlias('---'), /nonempty/);
    assert.throws(() => deriveNetworkAlias('ploinky-router'), /reserved/);
    assert.throws(() => deriveNetworkAlias('a'.repeat(64)), /longer than 63/);
    const first = logicalNetworkAttachments({ mode: 'default' }, 'Agent A', { instanceKey: 'repo/agent-a#canonical' });
    const second = logicalNetworkAttachments({ mode: 'default' }, 'Agent A', { instanceKey: 'repo/agent-a#alias:blue' });
    assert.match(first[0].name, /^default-[a-f0-9]{12}$/);
    assert.notEqual(first[0].name, second[0].name);
    assert.equal(first[0].primary, true);
});

test('preflight detects collisions within a logical network but permits separate networks', () => {
    const shared = { mode: 'bridge', attachments: [{ name: 'shared', primary: true }] };
    assert.throws(() => preflightNetworkAliases([
        { id: 'one', agentRef: 'repo/one', canonicalAgentId: 'same', network: shared },
        { id: 'two', agentRef: 'repo/two', canonicalAgentId: 'same', network: shared },
    ]), /collision/);
    assert.equal(preflightNetworkAliases([
        { id: 'one', canonicalAgentId: 'same', network: shared },
        { id: 'two', canonicalAgentId: 'same', network: { mode: 'bridge', attachments: [{ name: 'other', primary: true }] } },
    ]), true);
});

test('none mode fails preflight for every network-dependent startup surface', () => {
    const none = { mode: 'none' };
    assert.deepEqual(assertNetworkStartupCompatibility({ start: 'sleep infinity' }, {}, none), none);
    assert.throws(() => assertNetworkStartupCompatibility({}, {}, none), /AgentServer/);
    assert.throws(() => assertNetworkStartupCompatibility({ start: 'x' }, { openPorts: ['9000'] }, none), /openPorts/);
    assert.throws(() => assertNetworkStartupCompatibility({ start: 'x' }, { additionalServerPort: 9000 }, none), /additionalServerPort/);
    assert.throws(() => assertNetworkStartupCompatibility({ start: 'x', readiness: { protocol: 'http' } }, {}, none), /readiness/);
});
