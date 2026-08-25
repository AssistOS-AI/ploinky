import test from 'node:test';
import assert from 'node:assert/strict';

import {
    PLOINKY_MANAGED_LABEL,
    managedContainerLabelArgs,
} from '../../cli/sandbox/docker/common.js';
import { buildPersistentAgentRunArgs } from '../../cli/sandbox/docker/agentServiceManager.js';
import {
    buildInteractiveAgentCreateCommand,
    buildInteractiveCommandCreateCommand,
} from '../../cli/sandbox/docker/interactive.js';
import { buildShellDetectionRunArgs } from '../../cli/sandbox/docker/shellDetection.js';
import { buildContainerInstallRunArgs } from '../../cli/utils/dependencies/dependencyCache.js';
import { buildContainerRuntimeKeyProbeRunArgs } from '../../cli/utils/dependencies/dependencyRuntimeKey.js';

const managed = 'io.assistos.ploinky.managed=1';

function labelValues(args) {
    const values = [];
    for (let index = 0; index < args.length; index += 1) {
        if (args[index] === '--label') values.push(args[index + 1]);
    }
    return values;
}

function assertExactManagedArgv(args) {
    assert.equal(labelValues(args).filter((value) => value === managed).length, 1);
}

function assertExactManagedCommand(command) {
    assertExactManagedArgv(String(command).trim().split(/\s+/));
}

test('managed label helper emits the exact D12 ownership label', () => {
    assert.equal(PLOINKY_MANAGED_LABEL, managed);
    assert.deepEqual(managedContainerLabelArgs(), ['--label', managed]);
});

test('dependency-install helper containers carry the exact managed label', () => {
    const args = buildContainerInstallRunArgs({
        cwd: '/tmp/cache', image: 'example/image', runtime: 'podman', shellPath: '/bin/sh', installScript: 'true',
    });
    const index = args.indexOf('--label');
    assert.notEqual(index, -1);
    assert.equal(args[index + 1], managed);
});

test('persistent agent run builder carries the exact managed label', () => {
    const options = {
        runtime: 'podman',
        containerName: 'ploinky_demo',
        envHash: 'hash',
        containerWorkdir: '/root',
        agentLibMountPath: '/workspace/.ploinky/runtime/Agent',
        codeMountPath: '/workspace/.ploinky/runtime/code',
        codeMountMode: ':z,ro',
        sharedDir: '/workspace/.ploinky/shared',
        healthProbeHostDir: '/workspace/.ploinky/run/health-probes/ploinky_demo',
        cwd: '/workspace/.data/demo',
        cwdMountTarget: '/root',
        // Every container admission now carries the selected achillesAgentLib grant.
        agentLibGrant: {
            sourceDir: '/workspace/achillesAgentLib',
            runtimePath: '/opt/ploinky-agentlib',
            mode: 'local',
            fingerprint: 'a1'.repeat(32),
            commit: '',
            sourceIdHash: 'b2'.repeat(32),
            namespaced: true,
        },
    };
    const args = buildPersistentAgentRunArgs(options);
    assertExactManagedArgv(args);
    assert.equal(args.filter((value) => value === '--init').length, 1);
    assert.equal(args.filter((value) => value === '--image-volume=ignore').length, 1);
    assert.equal(
        args.includes('/workspace/.ploinky/run/health-probes/ploinky_demo:/run/ploinky-health-probes:z'),
        true,
    );

    const dockerArgs = buildPersistentAgentRunArgs({ ...options, runtime: 'docker' });
    assertExactManagedArgv(dockerArgs);
    assert.equal(dockerArgs.includes('--image-volume=ignore'), false);
    assert.equal(
        dockerArgs.includes('/workspace/.ploinky/run/health-probes/ploinky_demo:/run/ploinky-health-probes'),
        true,
    );
});

test('both interactive create/retry command families carry the exact managed label', () => {
    for (const containerImage of ['node:24', 'docker.io/library/node:24']) {
        assertExactManagedCommand(buildInteractiveCommandCreateCommand({
            runtime: 'podman',
            containerName: 'ploinky_demo',
            mountOption: '-v "/workspace:/workspace"',
            portOptions: '-p 127.0.0.1:17002:7000',
            envVars: '-e HOME=/root',
            containerImage,
        }));
        assertExactManagedCommand(buildInteractiveAgentCreateCommand({
            runtime: 'podman',
            containerName: 'ploinky_demo',
            envHash: 'hash',
            projectDir: '/workspace',
            homeDir: '/workspace/.data/demo',
            agentLibPath: '/opt/ploinky/Agent',
            absAgentPath: '/workspace/.ploinky/repos/demo/agent',
            sharedDir: '/workspace/.ploinky/shared',
            volumeSuffix: ':z',
            readOnlySuffix: ':ro,z',
            portOptions: '-p 127.0.0.1:17002:7000',
            envVars: '-e HOME=/root',
            containerImage,
        }));
    }
});

test('shell-detection probe builder carries the exact managed label', () => {
    assertExactManagedArgv(buildShellDetectionRunArgs('example/image', '/bin/sh'));
});

test('runtime-key probe builder carries the exact managed label', () => {
    assertExactManagedArgv(buildContainerRuntimeKeyProbeRunArgs('example/image'));
});
