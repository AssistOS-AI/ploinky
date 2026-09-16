import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeContainerRuntime } from '../../ploinky-box/contract/container.mjs';
import {
    assertBoxNetworkMode, observedBoxNetworkMode, PASTA_IPV4_NETWORK, selectedBoxNetworkMode,
} from '../../ploinky-box/contract/network.mjs';

test('only native Linux with the selected pasta helper requests IPv4-only networking', () => {
    assert.equal(selectedBoxNetworkMode({ hostKind: 'native-linux', rootlessNetworkCmd: 'pasta' }), PASTA_IPV4_NETWORK);
    for (const engine of [
        { hostKind: 'podman-machine', rootlessNetworkCmd: 'pasta' },
        { hostKind: 'native-linux', rootlessNetworkCmd: 'slirp4netns' },
        { hostKind: 'native-linux', rootlessNetworkCmd: '' },
    ]) assert.equal(selectedBoxNetworkMode(engine), null);
});

test('IPv4-only pasta evidence requires the normalized engine mode and exact recorded options', () => {
    const runtime = normalizeContainerRuntime({
        Config: { CreateCommand: ['podman', 'create', '--network', PASTA_IPV4_NETWORK] },
        HostConfig: { NetworkMode: 'pasta' }, State: {},
    });
    assert.equal(runtime.networkMode, 'pasta');
    assert.equal(observedBoxNetworkMode(runtime), PASTA_IPV4_NETWORK);
    assert.doesNotThrow(() => assertBoxNetworkMode(runtime, PASTA_IPV4_NETWORK));
    assert.throws(() => assertBoxNetworkMode(runtime, null), /network mode/);
    for (const altered of [
        { ...runtime, networkMode: 'host' },
        { ...runtime, createCommand: ['--network', 'pasta'] },
        { ...runtime, createCommand: ['--network', 'pasta:--ipv6-only'] },
        { ...runtime, createCommand: ['--network', `${PASTA_IPV4_NETWORK},--map-gw`] },
        { ...runtime, createCommand: ['--network', PASTA_IPV4_NETWORK, '--net', 'host'] },
        { ...runtime, createCommand: ['--network'] },
    ]) assert.throws(() => assertBoxNetworkMode(altered, PASTA_IPV4_NETWORK), /network mode/);
    assert.equal(observedBoxNetworkMode({ ...runtime, createCommand: [`--network=${PASTA_IPV4_NETWORK}`] }), PASTA_IPV4_NETWORK);
});

test('legacy engine-default networking remains observable but cannot satisfy new pasta readiness', () => {
    for (const networkMode of ['pasta', 'slirp4netns', 'bridge']) {
        const runtime = { networkMode, createCommand: ['podman', 'container', 'create'] };
        assert.equal(observedBoxNetworkMode(runtime), null);
        assert.doesNotThrow(() => assertBoxNetworkMode(runtime));
        assert.throws(() => assertBoxNetworkMode(runtime, PASTA_IPV4_NETWORK), /network mode/);
    }
});
