import assert from 'node:assert/strict';
import test from 'node:test';

import {
    probeNestedPodmanRuntime,
    resolveWebttyProviderLocality,
} from '../../cli/server/webtty/providerLocality.mjs';

test('nested Podman locality probe uses a hard SIGKILL timeout and exact environment', () => {
    const environment = Object.freeze({ PATH: '/usr/bin' });
    const observed = [];
    assert.equal(probeNestedPodmanRuntime({
        environment,
        execFileSync(command, args, options) {
            observed.push({ command, args, options });
            return '5.6.2\n';
        },
    }), 'podman');
    assert.deepEqual(observed, [{
        command: '/usr/bin/podman',
        args: ['version', '--format', '{{.Client.Version}}'],
        options: {
            cwd: '/tmp',
            env: environment,
            encoding: 'utf8',
            timeout: 2_000,
            killSignal: 'SIGKILL',
            maxBuffer: 64 * 1024,
        },
    }]);
});

test('direct-host development leaves Box usable without probing or bridging a remote runtime', () => {
    let probes = 0;
    const result = resolveWebttyProviderLocality({
        boxProviderAvailable: true,
        isPloinkyBoxRuntime: false,
        probeRuntime() {
            probes += 1;
            throw new Error('must not touch a host runtime');
        },
    });
    assert.deepEqual(result, {
        surfaceAvailable: true,
        boxAvailable: true,
        agentAvailable: false,
        agentReason: 'router-not-in-ploinky-box',
    });
    assert.equal(probes, 0);
});

test('Box availability remains the whole-surface gate and skips runtime probing', () => {
    let probes = 0;
    const result = resolveWebttyProviderLocality({
        boxProviderAvailable: false,
        isPloinkyBoxRuntime: true,
        probeRuntime() { probes += 1; return 'podman'; },
    });
    assert.equal(result.surfaceAvailable, false);
    assert.equal(result.boxAvailable, false);
    assert.equal(result.agentAvailable, false);
    assert.equal(result.agentReason, 'box-provider-unavailable');
    assert.equal(probes, 0);
});

test('agent targets require exact local nested Podman', () => {
    assert.deepEqual(resolveWebttyProviderLocality({
        boxProviderAvailable: true,
        isPloinkyBoxRuntime: true,
        probeRuntime() { return 'podman'; },
    }), {
        surfaceAvailable: true,
        boxAvailable: true,
        agentAvailable: true,
        agentReason: 'nested-podman-local',
    });
    assert.equal(resolveWebttyProviderLocality({
        boxProviderAvailable: true,
        isPloinkyBoxRuntime: true,
        probeRuntime() { return 'docker'; },
    }).agentAvailable, false);
});
