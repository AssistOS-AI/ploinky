import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
    buildRuntimeRouterEnv,
    ensureAgentService,
    replaceRuntimeRouterEnvFlags,
} from '../../cli/services/docker/agentServiceManager.js';
import { buildRouterEndpoint } from '../../cli/services/routerPort.js';

test('container router env builder preserves endpoint parity for every network mode', () => {
    for (const mode of ['default', 'bridge', 'host']) {
        const endpoint = buildRouterEndpoint(mode, 65535);
        assert.deepEqual(buildRuntimeRouterEnv('podman', {
            networkMode: mode,
            routerEndpoint: endpoint,
            routerPort: 65535,
        }), endpoint.env);
    }
    assert.deepEqual(buildRuntimeRouterEnv('podman', {
        networkMode: 'none',
        routerEndpoint: null,
        routerPort: 'not-a-port',
    }), {});
});

test('ensureAgentService requires callers to pass a resolved endpoint or explicit null', () => {
    for (const options of [undefined, {}, { routerEndpoint: undefined }, 49123]) {
        assert.throws(
            () => ensureAgentService('agent', { network: { mode: 'none' } }, '/tmp/repo/agent', options),
            { code: 'PLOINKY_ROUTER_ENDPOINT_REQUIRED' },
        );
    }
});

test('container router env builder has no default, reread, or host override path', () => {
    assert.throws(
        () => buildRuntimeRouterEnv('podman', { networkMode: 'bridge' }),
        { code: 'PLOINKY_ROUTER_ENDPOINT_REQUIRED' },
    );
    assert.throws(
        () => buildRuntimeRouterEnv('podman', {
            networkMode: 'bridge',
            routerEndpoint: buildRouterEndpoint('bridge', 8097),
            routerPort: 8080,
        }),
        { code: 'PLOINKY_ROUTER_PORT_MISMATCH' },
    );
    assert.throws(
        () => buildRuntimeRouterEnv('podman', {
            networkMode: 'bridge',
            routerEndpoint: buildRouterEndpoint('bridge', 8097),
            routerHost: 'host.docker.internal',
        }),
        /routerHost overrides are not supported/,
    );
});

test('runtime router env replaces config values and none mode strips them entirely', () => {
    const supplied = [
        '-e SAFE="kept"',
        '-e PLOINKY_ROUTER_HOST="profile.invalid"',
        '-e PLOINKY_ROUTER_PORT="1"',
        '-e PLOINKY_ROUTER_URL="http://secret.invalid:1"',
    ];
    replaceRuntimeRouterEnvFlags(supplied, {});
    assert.deepEqual(supplied, ['-e SAFE="kept"']);

    const endpoint = buildRouterEndpoint('default', 49123);
    replaceRuntimeRouterEnvFlags(supplied, endpoint.env);
    assert.equal(supplied[0], '-e SAFE="kept"');
    for (const [name, value] of Object.entries(endpoint.env)) {
        assert.deepEqual(
            supplied.filter((entry) => entry.startsWith(`-e ${name}=`)),
            [`-e ${name}="${value}"`],
        );
    }
});

test('existing-container ownership inspection is unconditional across network modes', () => {
    const source = fs.readFileSync(new URL('../../cli/services/docker/agentServiceManager.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /\bresolveRouterEndpoint\s*\(/, 'service manager must not reread persisted routing state');
    assert.match(source, /const networkLifecycle = createNetworkLifecycleAdapter\(\{ runtime \}\);\s+if \(containerExists\(containerName\)\) \{\s+const contractInspection = networkLifecycle\.inspectContainerContract/);
    assert.doesNotMatch(source, /if \(containerExists\(containerName\) && managedNetworkLifecycle\)/);
    assert.match(source, /runtimeNetworkPlan\.requiresManagedNetwork && !isContainerRunning\(containerName\)/);
});
