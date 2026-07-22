import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    createPodmanHarness,
    execInBox,
    requirePodmanCandidate,
} from '../e2e/ploinkyBox/nativeHelpers.mjs';

const MINIMAL_NODE_IMAGE = 'docker.io/library/node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d';

function queryInBox(harness, containerId, argv, timeoutMs = 120_000) {
    return harness.runner.query('podman', [
        'container', 'exec', '--user', 'podman', '--workdir', '/workspace',
        containerId, ...argv,
    ], { timeoutMs });
}

function queryJson(runner, command, args) {
    const result = runner.query(command, args, { timeoutMs: 30_000 });
    assert.equal(result.ok, true, result.stderr);
    return JSON.parse(result.stdout);
}

function selectedPodmanInfo(info) {
    const host = info?.host || info?.Host || {};
    return {
        networkBackend: host.networkBackend || host.NetworkBackend || '',
        rootless: host.security?.rootless ?? host.Security?.Rootless ?? null,
        architecture: host.arch || host.Arch || '',
        operatingSystem: host.os || host.Os || '',
    };
}

function normalizePortBindings(bindings) {
    return Object.fromEntries(Object.entries(bindings || {}).map(([port, entries]) => [
        port,
        (entries || []).map((entry) => ({
            HostIp: String(entry?.HostIp || '') || '0.0.0.0',
            HostPort: String(entry?.HostPort || ''),
        })),
    ]));
}

function writeEvidence(evidence) {
    const artifact = String(process.env.PLOINKY_BOX_PRIVATE_ROUTING_ARTIFACT || '').trim();
    if (artifact) {
        fs.mkdirSync(path.dirname(artifact), { recursive: true });
        fs.writeFileSync(artifact, `${JSON.stringify(evidence, null, 2)}\n`, { mode: 0o600 });
    }
    process.stdout.write(`PLOINKY_PRIVATE_ROUTING_REPRO ${JSON.stringify(evidence)}\n`);
}

test('one nested rootless-Podman container reaches the unpublished private listener', {
    timeout: 8 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    const harness = createPodmanHarness(t, candidateReference);
    let nestedContainerId = '';
    let nestedContainerName = '';
    const evidence = {
        schema: 1,
        candidateReference,
        physicalPodman: {},
        outerBox: {},
        probe: null,
    };

    try {
        const prepared = await harness.supervisor.prepareBoxForCommand({
            imageRef: candidateReference,
        });
        const outerInspection = queryJson(harness.runner, 'podman', [
            'container', 'inspect', prepared.containerId,
        ])[0];
        const sourceMount = (outerInspection?.Mounts || []).find((mount) => (
            mount.Destination === '/opt/ploinky'
        ));
        evidence.physicalPodman.version = queryJson(
            harness.runner, 'podman', ['version', '--format', 'json'],
        );
        evidence.physicalPodman.info = selectedPodmanInfo(queryJson(
            harness.runner, 'podman', ['info', '--format', 'json'],
        ));
        evidence.outerBox = {
            id: prepared.containerId,
            contract: outerInspection?.Config?.Labels?.['io.assistos.ploinky.runtime-contract'] || '',
            exposedPorts: outerInspection?.Config?.ExposedPorts || null,
            rawPortBindings: outerInspection?.HostConfig?.PortBindings || {},
            portBindings: normalizePortBindings(outerInspection?.HostConfig?.PortBindings),
            sourceMount: sourceMount ? {
                source: '<source-checkout>',
                destination: sourceMount.Destination,
                readWrite: sourceMount.RW,
            } : null,
        };

        assert.equal(evidence.outerBox.contract, '6');
        assert.equal(evidence.outerBox.exposedPorts, null);
        assert.deepEqual(evidence.outerBox.portBindings, {
            '7882/udp': [{ HostIp: '0.0.0.0', HostPort: '7882' }],
            '8080/tcp': [{ HostIp: '127.0.0.1', HostPort: '8080' }],
        });
        assert.deepEqual(evidence.outerBox.sourceMount, {
            source: '<source-checkout>',
            destination: '/opt/ploinky',
            readWrite: false,
        });

        const networkArguments = JSON.parse(execInBox(harness.runner, prepared.containerId, [
            '/usr/local/bin/node', '--input-type=module', '-e', [
                "const m=await import('/opt/ploinky/cli/sandbox/docker/agentServiceManager.js');",
                "process.stdout.write(JSON.stringify([...m.buildBoxPodmanHostArgs(),'--replace',...m.buildDefaultPodmanNetworkArgs('linux')]));",
            ].join(''),
        ]));
        assert.deepEqual(networkArguments, [
            '--add-host', 'host.containers.internal:host-gateway',
            '--replace',
            '--network', 'pasta:--map-gw',
        ]);

        const pull = queryInBox(harness, prepared.containerId, [
            'podman', 'pull', MINIMAL_NODE_IMAGE,
        ], 180_000);
        assert.equal(pull.ok, true, pull.stderr);
        nestedContainerName = `ploinky-private-routing-repro-${harness.identity.pathHash.slice(0, 12)}`;
        const launchArguments = [
            'podman', 'run', ...networkArguments,
            '--name', nestedContainerName,
            '--label', 'io.assistos.ploinky.private-routing-repro=1',
            '--detach', MINIMAL_NODE_IMAGE,
            'node', '-e', "setInterval(()=>{},60_000)",
        ];
        evidence.outerBox.nestedLaunchArguments = launchArguments.slice(1);
        const launched = queryInBox(harness, prepared.containerId, launchArguments, 180_000);
        assert.equal(launched.ok, true, launched.stderr);
        nestedContainerId = String(launched.stdout || '').trim();
        assert.match(nestedContainerId, /^[a-f0-9]{64}$/);

        const probe = queryInBox(harness, prepared.containerId, [
            '/usr/local/bin/node',
            '/opt/ploinky/tests/helpers/ploinkyBoxPrivateRoutingProbe.mjs',
            nestedContainerId,
            JSON.stringify(networkArguments),
        ], 30_000);
        const probeOutput = String(probe.stdout || '').trim().split(/\n/).at(-1);
        evidence.probe = JSON.parse(probeOutput);
        writeEvidence(evidence);
        assert.equal(probe.ok, true, probe.stderr || evidence.probe?.error);
        assert.equal(evidence.probe.privateRequest.ok, true);
        assert.equal(evidence.probe.privateRequest.responseMatched, true);
        assert.equal(evidence.probe.nestedPodman.info.rootless, true);
        assert.equal(evidence.probe.nestedPodman.info.networkBackend, 'netavark');
        assert.equal(evidence.probe.nestedContainer.inspect.networkMode, 'pasta:--map-gw');
        assert.match(
            evidence.probe.nestedContainer.namespace.hosts,
            /host\.containers\.internal/,
        );
        assert.ok(
            evidence.probe.nestedContainer.namespace.resolution.addresses?.length > 0,
            JSON.stringify(evidence.probe.nestedContainer.namespace.resolution),
        );
    } catch (error) {
        if (!evidence.probe) writeEvidence({
            ...evidence,
            error: error?.message || String(error),
        });
        throw error;
    } finally {
        if (nestedContainerId || nestedContainerName) {
            queryInBox(harness, harness.identity.instance, [
                'podman', 'container', 'rm', '--force',
                nestedContainerId || nestedContainerName,
            ]);
        }
        await harness.cleanup();
    }
});
