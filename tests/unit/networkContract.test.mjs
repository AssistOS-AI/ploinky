import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';

import {
    assertHostSandboxNetworkCompatibility,
    assertNetworkStartupCompatibility,
    canonicalizeNetwork,
    deriveNetworkAlias,
    effectiveManifestNetwork,
    logicalNetworkAttachments,
    networkContractHash,
    preflightNetworkAliases,
    validateManifestNetworks,
} from '../../cli/services/networkContract.js';

test('network contract hash hard-cuts to the box host-gateway runtime policy', () => {
    const network = canonicalizeNetwork({ mode: 'default' });
    const legacyHash = crypto.createHash('sha256').update(JSON.stringify({
        schemaVersion: '2',
        runtimePolicy: 'managed-hosts-v1',
        network,
    })).digest('hex');
    assert.match(networkContractHash(network), /^[a-f0-9]{64}$/);
    assert.notEqual(networkContractHash(network), legacyHash);
});

test('host sandboxes fail closed unless the effective network mode is host', () => {
    assert.deepEqual(
        assertHostSandboxNetworkCompatibility({ mode: 'host' }, { runtime: 'bwrap' }),
        { mode: 'host' },
    );

    for (const network of [
        undefined,
        { mode: 'default' },
        { mode: 'none' },
        { mode: 'bridge', attachments: [{ name: 'private', primary: true }] },
    ]) {
        assert.throws(
            () => assertHostSandboxNetworkCompatibility(network, { runtime: 'seatbelt' }),
            (error) => error?.code === 'PLOINKY_NETWORK_CONTRACT_INVALID'
                && /requires an explicit network\.mode 'host'/.test(error.message),
        );
    }
});

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

test('alias derivation is deterministic, bounded, and permits the former router transport name', () => {
    assert.equal(deriveNetworkAlias('Repo/My Agent'), 'repo-my-agent');
    assert.throws(() => deriveNetworkAlias('---'), /nonempty/);
    assert.equal(deriveNetworkAlias('ploinky-router'), 'ploinky-router');
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
    assert.throws(() => assertNetworkStartupCompatibility({ start: 'x', readiness: { protocol: 'http' } }, {}, none), /readiness/);
});
