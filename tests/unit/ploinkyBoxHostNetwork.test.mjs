import assert from 'node:assert/strict';
import test from 'node:test';

import {
    detectHostReachableIpv4,
    isUsableHostIpv4,
    selectHostReachableIpv4,
} from '../../ploinky-box/hostNetwork.mjs';

function ipv4(address, { internal = false, family = 'IPv4' } = {}) {
    return { address, family, internal, netmask: '255.255.255.0', cidr: `${address}/24` };
}

test('host address selection prefers the macOS default-route physical interface over Podman', () => {
    const selected = selectHostReachableIpv4({
        platform: 'darwin',
        routeAddress: '192.168.1.12',
        interfaces: {
            lo0: [ipv4('127.0.0.1', { internal: true })],
            podman0: [ipv4('10.88.0.1')],
            utun3: [ipv4('100.64.12.5')],
            en0: [ipv4('192.168.1.12')],
        },
    });
    assert.equal(selected, '192.168.1.12');
});

test('host address selection prefers another non-virtual default route over interface order', () => {
    const selected = selectHostReachableIpv4({
        platform: 'darwin',
        routeAddress: '10.20.30.40',
        interfaces: {
            en0: [ipv4('192.168.1.12')],
            en1: [ipv4('10.20.30.40')],
        },
    });
    assert.equal(selected, '10.20.30.40');
});

test('host address selection uses a virtual interface only when no host-facing candidate exists', () => {
    assert.equal(selectHostReachableIpv4({
        platform: 'darwin',
        routeAddress: '100.64.12.5',
        interfaces: { utun3: [ipv4('100.64.12.5')] },
    }), '100.64.12.5');
});

test('host address selection never promotes a container bridge into a media candidate', () => {
    assert.equal(selectHostReachableIpv4({
        platform: 'linux',
        routeAddress: '10.88.0.1',
        interfaces: {
            podman0: [ipv4('10.88.0.1')],
            docker0: [ipv4('172.17.0.1')],
            bridge100: [ipv4('192.168.64.1')],
        },
    }), '');
});

test('host address detection survives a route-probe failure and uses enumerated interfaces', async () => {
    const selected = await detectHostReachableIpv4({
        platform: 'linux',
        interfaces: { eth0: [ipv4('172.20.1.9')] },
        routeProbe: async () => { throw new Error('no default route'); },
    });
    assert.equal(selected, '172.20.1.9');
});

test('host address detection returns empty when no usable host IPv4 exists', async () => {
    const selected = await detectHostReachableIpv4({
        interfaces: {
            lo0: [ipv4('127.0.0.1', { internal: true })],
            en0: [ipv4('169.254.4.5')],
        },
        routeProbe: async () => '127.0.0.1',
    });
    assert.equal(selected, '');
});

test('host address validation rejects malformed and non-host address classes', () => {
    for (const address of [
        '192.168.001.12',
        '0.1.2.3',
        '127.0.0.1',
        '169.254.1.2',
        '192.0.2.1',
        '198.18.0.1',
        '224.0.0.1',
        '255.255.255.255',
    ]) {
        assert.equal(isUsableHostIpv4(address), false, address);
    }
    for (const address of ['10.88.0.1', '100.64.0.1', '172.31.255.254', '192.168.1.12', '8.8.8.8']) {
        assert.equal(isUsableHostIpv4(address), true, address);
    }
});
