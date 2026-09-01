import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
    PLOINKY_MANAGED_LABEL,
    managedContainerLabelArgs,
} from '../../cli/sandbox/docker/common.js';
import {
    appendLegacyAgentDataGuards,
    buildPersistentAgentRunArgs,
    inspectImageEntrypoint,
    manifestUsesHealthProbeBroker,
} from '../../cli/sandbox/docker/agentServiceManager.js';
import { PLOINKY_WORKSPACE_ROOT } from '../../cli/utils/config.js';
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
        sharedDir: '/workspace/.data/shared',
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

test('container runtimes append final read-only opacity guards for broad workspace mounts', () => {
    for (const runtime of ['docker', 'podman']) {
        const args = ['-v', `${PLOINKY_WORKSPACE_ROOT}:/workspace${runtime === 'podman' ? ':z' : ''}`];
        const targets = appendLegacyAgentDataGuards(args, runtime);
        assert.deepEqual(targets.map(entry => entry.target), [
            '/workspace/.ploinky/data',
            '/workspace/.ploinky/shared',
        ]);
        const mounts = args.filter((_value, index) => args[index - 1] === '-v');
        for (const target of targets) {
            const match = mounts.find(value => value.includes(`:${target.target}:`));
            assert.ok(match, `missing guard ${target.target}`);
            assert.match(match, runtime === 'podman' ? /:z,ro$/ : /:ro$/);
            assert.doesNotMatch(match, new RegExp(`^${target.protectedHostPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:`));
        }
    }
});

test('container runtimes reject project mounts sourced below a protected legacy root', () => {
    for (const runtime of ['docker', 'podman']) {
        const source = path.join(PLOINKY_WORKSPACE_ROOT, '.ploinky', 'data', 'legacy-agent');
        const args = ['-v', `${source}:/project${runtime === 'podman' ? ':z' : ''}`];
        assert.throws(
            () => appendLegacyAgentDataGuards(args, runtime),
            error => error?.code === 'PLOINKY_AGENT_DATA_POLICY_VIOLATION',
        );
    }
});

test('only script-backed health manifests require the in-container broker', () => {
    assert.equal(manifestUsesHealthProbeBroker({}), false);
    assert.equal(manifestUsesHealthProbeBroker({ health: { readiness: {} } }), false);
    assert.equal(manifestUsesHealthProbeBroker({
        health: { readiness: { script: '  ' } },
    }), false);
    assert.equal(manifestUsesHealthProbeBroker({
        health: { readiness: { script: 'ready.sh' } },
    }), true);
    assert.equal(manifestUsesHealthProbeBroker({
        health: { liveness: { script: 'live.sh' } },
    }), true);
});

test('image entrypoint inspection preserves its exact argv without executing the image', () => {
    const calls = [];
    const entrypoint = inspectImageEntrypoint('podman', 'example/image@sha256:abc',
        (command, args, options) => {
            calls.push({ command, args, options });
            return { status: 0, stdout: '["/usr/bin/tini","--","node"]\n', stderr: '' };
        });
    assert.deepEqual(entrypoint, ['/usr/bin/tini', '--', 'node']);
    assert.deepEqual(calls[0].args, [
        'image', 'inspect', '--format', '{{json .Config.Entrypoint}}',
        'example/image@sha256:abc',
    ]);
    assert.deepEqual(calls[0].options.stdio, ['ignore', 'pipe', 'pipe']);

    assert.deepEqual(inspectImageEntrypoint('podman', 'example/no-entrypoint', () => ({
        status: 0, stdout: 'null\n', stderr: '',
    })), []);
    assert.throws(() => inspectImageEntrypoint('podman', 'example/bad', () => ({
        status: 0, stdout: '{', stderr: '',
    })), /returned invalid JSON/);
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
            agentLibGrant: {
                sourceDir: '/workspace/achillesAgentLib',
                runtimePath: '/opt/ploinky-agentlib',
                mode: 'local',
                fingerprint: 'a1'.repeat(32),
                commit: '',
                sourceIdHash: 'b2'.repeat(32),
                namespaced: true,
            },
            absAgentPath: '/workspace/.ploinky/repos/demo/agent',
            sharedDir: '/workspace/.data/shared',
            volumeSuffix: ':z',
            readOnlySuffix: ':ro,z',
            portOptions: '-p 127.0.0.1:17002:7000',
            envVars: '-e HOME=/root',
            containerImage,
        }));
    }
});

test('interactive container creation rejects a project below protected legacy agent data', () => {
    const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-legacy-child-')));
    try {
        const projectDir = path.join(workspaceRoot, '.ploinky', 'data', 'legacy-agent');
        const homeDir = path.join(workspaceRoot, '.data', 'demo');
        const sharedDir = path.join(workspaceRoot, '.data', 'shared');
        const agentLibPath = path.join(workspaceRoot, 'Agent');
        const absAgentPath = path.join(workspaceRoot, 'agent-code');
        const grantSource = path.join(workspaceRoot, 'achillesAgentLib');
        for (const directory of [projectDir, homeDir, sharedDir, agentLibPath, absAgentPath, grantSource]) {
            fs.mkdirSync(directory, { recursive: true });
        }
        assert.throws(() => buildInteractiveAgentCreateCommand({
            runtime: 'podman',
            containerName: 'ploinky_demo',
            envHash: 'hash',
            projectDir,
            homeDir,
            agentLibPath,
            absAgentPath,
            sharedDir,
            containerImage: 'node:24',
            workspaceRoot,
            agentLibGrant: {
                sourceDir: grantSource,
                runtimePath: '/opt/ploinky-agentlib',
                mode: 'local',
                fingerprint: 'a1'.repeat(32),
                commit: '',
                sourceIdHash: 'b2'.repeat(32),
                namespaced: true,
            },
        }), error => error?.code === 'PLOINKY_AGENT_DATA_POLICY_VIOLATION');
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('interactive agent guards canonical legacy aliases exposed by read-only code mounts', () => {
    const workspaceRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'interactive-legacy-alias-')));
    try {
        const agentCode = path.join(workspaceRoot, 'agent-code');
        const canonicalLegacyData = path.join(agentCode, 'legacy-data');
        const homeDir = path.join(workspaceRoot, '.data', 'demo');
        const sharedDir = path.join(workspaceRoot, '.data', 'shared');
        const agentLibPath = path.join(workspaceRoot, 'Agent');
        const grantSource = path.join(workspaceRoot, 'achillesAgentLib');
        fs.mkdirSync(path.join(workspaceRoot, '.ploinky'), { recursive: true });
        for (const directory of [canonicalLegacyData, homeDir, sharedDir, agentLibPath, grantSource]) {
            fs.mkdirSync(directory, { recursive: true });
        }
        fs.symlinkSync(canonicalLegacyData, path.join(workspaceRoot, '.ploinky', 'data'), 'dir');
        const command = buildInteractiveAgentCreateCommand({
            runtime: 'podman',
            containerName: 'ploinky_demo',
            envHash: 'hash',
            projectDir: homeDir,
            homeDir,
            agentLibPath,
            absAgentPath: agentCode,
            sharedDir,
            volumeSuffix: ':z',
            readOnlySuffix: ':z,ro',
            containerImage: 'node:24',
            workspaceRoot,
            agentLibGrant: {
                sourceDir: grantSource,
                runtimePath: '/opt/ploinky-agentlib',
                mode: 'local',
                fingerprint: 'a1'.repeat(32),
                commit: '',
                sourceIdHash: 'b2'.repeat(32),
                namespaced: true,
            },
        });
        assert.match(command, /:\/code\/legacy-data:z,ro"/);
        assert.ok(command.lastIndexOf(':/code/legacy-data:z,ro"') > command.indexOf(`${agentCode}:/code:z,ro`));
    } finally {
        fs.rmSync(workspaceRoot, { recursive: true, force: true });
    }
});

test('shell-detection probe builder carries the exact managed label', () => {
    assertExactManagedArgv(buildShellDetectionRunArgs('example/image', '/bin/sh'));
});

test('runtime-key probe builder carries the exact managed label', () => {
    assertExactManagedArgv(buildContainerRuntimeKeyProbeRunArgs('example/image'));
});
