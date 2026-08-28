import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
    createPodmanHarness,
    execInBox,
    requirePodmanCandidate,
} from '../e2e/ploinkyBox/nativeHelpers.mjs';
import {
    BOX_AGENTLIB_LABELS,
    BOX_LABELS,
    BOX_MEDIA_PORT,
    BOX_ROUTER_CONTAINER_PORT,
} from '../../ploinky-box/constants.mjs';

const MINIMAL_NODE_IMAGE = 'docker.io/library/node:24-bookworm-slim@sha256:6f7b03f7c2c8e2e784dcf9295400527b9b1270fd37b7e9a7285cf83b6951452d';
const REPOSITORY_ROOT = path.resolve(import.meta.dirname, '../..');

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

function mappedGuestAddresses(pastaProcesses) {
    const addresses = [];
    for (const argv of pastaProcesses || []) {
        for (let index = 0; index < argv.length; index += 1) {
            if (argv[index] === '--map-guest-addr' && argv[index + 1]) {
                addresses.push(argv[index + 1]);
            }
        }
    }
    return addresses;
}

function hostsMapsAlias(hosts, address, alias) {
    return String(hosts || '').split(/\n/).some((line) => {
        const [mappedAddress, ...aliases] = line.trim().split(/\s+/);
        return mappedAddress === address && aliases.includes(alias);
    });
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
        kind: 'ploinky-box-private-routing',
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
        assert.ok(sourceMount, 'the Box must mount the exact candidate checkout at /opt/ploinky');
        assert.equal(sourceMount.Type, 'bind');
        assert.equal(path.resolve(sourceMount.Source), REPOSITORY_ROOT);
        evidence.physicalPodman.version = queryJson(
            harness.runner, 'podman', ['version', '--format', 'json'],
        );
        evidence.physicalPodman.info = selectedPodmanInfo(queryJson(
            harness.runner, 'podman', ['info', '--format', 'json'],
        ));
        evidence.outerBox = {
            id: prepared.containerId,
            role: outerInspection?.Config?.Labels?.['io.assistos.ploinky-box.role'] || '',
            exposedPorts: outerInspection?.Config?.ExposedPorts || null,
            rawPortBindings: outerInspection?.HostConfig?.PortBindings || {},
            portBindings: normalizePortBindings(outerInspection?.HostConfig?.PortBindings),
            sourceMount: sourceMount ? {
                source: '<source-checkout>',
                destination: sourceMount.Destination,
                readWrite: sourceMount.RW,
            } : null,
        };

        assert.equal(evidence.outerBox.role, 'box');
        assert.deepEqual(
            Object.keys(outerInspection?.Config?.Labels || {})
                .filter((key) => key.startsWith('io.assistos.ploinky-box.'))
                .sort(),
            [...Object.values(BOX_LABELS), ...Object.values(BOX_AGENTLIB_LABELS)].sort(),
        );
        assert.deepEqual(evidence.outerBox.exposedPorts, {
            [`${BOX_MEDIA_PORT}/udp`]: {},
            [`${BOX_ROUTER_CONTAINER_PORT}/tcp`]: {},
        });
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

        // The helper performs several independently bounded Podman queries
        // before its five-second application request and emits one final
        // frame. Its aggregate deadline must exceed those one-shot bounds.
        const probe = queryInBox(harness, prepared.containerId, [
            '/usr/local/bin/node',
            '/opt/ploinky/tests/helpers/ploinkyBoxPrivateRoutingProbe.mjs',
            nestedContainerId,
            JSON.stringify(networkArguments),
        ], 120_000);
        const probeFrames = String(probe.stdout || '').trim().split(/\n/).filter(Boolean);
        assert.equal(probeFrames.length, 1, JSON.stringify({
            status: probe.status,
            signal: probe.signal,
            errorCode: probe.error?.code || null,
            stdoutBytes: Buffer.byteLength(String(probe.stdout || '')),
            stderr: String(probe.stderr || '').trim(),
        }));
        evidence.probe = JSON.parse(probeFrames[0]);
        writeEvidence(evidence);
        assert.equal(probe.ok, true, probe.stderr || evidence.probe?.error);
        assert.equal(evidence.probe.privateRequest.ok, true);
        assert.equal(evidence.probe.privateRequest.responseMatched, true);
        assert.equal(evidence.probe.nestedPodman.info.rootless, true);
        assert.equal(evidence.probe.nestedPodman.info.networkBackend, 'netavark');
        // Podman normalizes the inspected mode to "pasta". The requested
        // pasta options are asserted above; Podman 5 materializes host-gateway
        // as --map-guest-addr in the live pasta process.
        assert.equal(evidence.probe.nestedContainer.inspect.networkMode, 'pasta');
        const mappedAddresses = mappedGuestAddresses(
            evidence.probe.nestedPodman.pastaProcesses,
        );
        assert.ok(mappedAddresses.length > 0, JSON.stringify(
            evidence.probe.nestedPodman.pastaProcesses,
        ));
        assert.ok(mappedAddresses.some((address) => (
            hostsMapsAlias(
                evidence.probe.nestedContainer.namespace.hosts,
                address,
                'host.containers.internal',
            )
        )), JSON.stringify({
            mappedAddresses,
            hosts: evidence.probe.nestedContainer.namespace.hosts,
        }));
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
