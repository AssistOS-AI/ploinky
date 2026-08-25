import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { agentLibRuntimeEnv } from '../../agentlib/contract.mjs';
import { hashFileBytes, sourceIdHash } from '../../agentlib/fingerprint.mjs';
import {
    agentLibEntrypointHashes,
    buildAgentLibAttestation,
} from '../../agentlib/runtime.mjs';
import { buildSelection } from '../../agentlib/source.mjs';
import {
    AGENTLIB_AGENT_ATTEST_SCRIPT,
    attestBwrapAgentLib,
    attestContainerAgentLib,
    attestSeatbeltAgentLib,
} from '../../cli/sandbox/agentLibAttestation.js';
import { attestAgentLibDeployment } from '../../cli/utils/agentLibDeploymentAttestation.js';
import { writeAgentLibCheckout } from '../helpers/agentlibFixture.mjs';

function fixture(t) {
    const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'agentlib-attestation-'));
    t.after(() => fs.rmSync(workspace, { recursive: true, force: true }));
    fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
    const sourceDir = writeAgentLibCheckout(path.join(workspace, 'achillesAgentLib'));
    const selection = buildSelection({ workspaceRoot: workspace, sourceDir, mode: 'local' });
    const grant = Object.freeze({
        sourceDir: selection.sourceDir,
        runtimePath: '/opt/ploinky-agentlib',
        mode: selection.mode,
        fingerprint: selection.contentFingerprint,
        commit: '',
        sourceIdHash: sourceIdHash(selection.sourceId),
        namespaced: true,
    });
    const attestation = Object.freeze({
        schemaVersion: 1,
        deploymentFingerprint: grant.fingerprint,
        mode: grant.mode,
        commit: grant.commit,
        sourceIdHash: grant.sourceIdHash,
        sourceRootRealpath: grant.runtimePath,
        packageJsonHash: hashFileBytes(path.join(grant.sourceDir, 'package.json')),
        entrypoints: agentLibEntrypointHashes(grant.sourceDir),
    });
    return { workspace, selection, grant, attestation };
}

function successfulProbe(attestation, inspect) {
    return (command, args, options) => {
        inspect(command, args, options);
        return { status: 0, stdout: JSON.stringify(attestation), stderr: '' };
    };
}

test('container, bwrap, and seatbelt admissions probe their exact runtime boundaries', (t) => {
    const { grant, attestation } = fixture(t);

    const container = attestContainerAgentLib({
        runtime: 'podman',
        containerId: 'a'.repeat(64),
        grant,
        spawn: successfulProbe(attestation, (command, args, options) => {
            assert.equal(command, 'podman');
            assert.deepEqual(args, [
                'exec', '--workdir', '/code', 'a'.repeat(64),
                'node', AGENTLIB_AGENT_ATTEST_SCRIPT,
            ]);
            assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
        }),
    });
    assert.equal(container.sourceRootRealpath, grant.runtimePath);

    const baseArgs = ['--die-with-parent', '--ro-bind', '/host/source', grant.runtimePath];
    attestBwrapAgentLib({
        bwrapPath: '/usr/bin/bwrap',
        baseArgs,
        grant,
        spawn: successfulProbe(attestation, (command, args) => {
            assert.equal(command, '/usr/bin/bwrap');
            assert.deepEqual(args, [...baseArgs, '--', 'node', AGENTLIB_AGENT_ATTEST_SCRIPT]);
        }),
    });

    const seatbeltGrant = { ...grant, runtimePath: grant.sourceDir, namespaced: false };
    const seatbeltAttestation = { ...attestation, sourceRootRealpath: grant.sourceDir };
    const seatbeltEnv = { TEST: 'exact' };
    attestSeatbeltAgentLib({
        profilePath: '/tmp/profile.sb',
        agentRuntimePath: '/tmp/Agent-runtime',
        cwd: '/tmp/code',
        env: seatbeltEnv,
        grant: seatbeltGrant,
        spawn: successfulProbe(seatbeltAttestation, (command, args, options) => {
            assert.equal(command, 'sandbox-exec');
            assert.deepEqual(args, [
                '-f', '/tmp/profile.sb', 'node', '/tmp/Agent-runtime/lib/agentlibAttest.mjs',
            ]);
            assert.equal(options.cwd, '/tmp/code');
            assert.equal(options.env, seatbeltEnv);
        }),
    });
});

test('a non-Node container is attested through a fixed helper over its exact read-only volumes', (t) => {
    const { grant, attestation } = fixture(t);
    const containerId = 'c'.repeat(64);
    const helperImage = `docker.io/library/node:24@sha256:${'d'.repeat(64)}`;
    const helperImageId = `sha256:${'e'.repeat(64)}`;
    const expectedEnvironment = [
        `PLOINKY_AGENTLIB_DIR=${grant.runtimePath}`,
        `PLOINKY_AGENTLIB_MODE=${grant.mode}`,
        `PLOINKY_AGENTLIB_FINGERPRINT=${grant.fingerprint}`,
        `PLOINKY_AGENTLIB_COMMIT=${grant.commit}`,
        `PLOINKY_AGENTLIB_SOURCE_ID=${grant.sourceIdHash}`,
    ];
    let call = 0;

    const result = attestContainerAgentLib({
        runtime: 'podman',
        containerId,
        grant,
        helperImage,
        spawn(command, args, options) {
            assert.equal(command, 'podman');
            assert.deepEqual(options.stdio, ['ignore', 'pipe', 'pipe']);
            call += 1;
            if (call === 1) {
                assert.deepEqual(args, [
                    'exec', '--workdir', '/code', containerId,
                    'node', AGENTLIB_AGENT_ATTEST_SCRIPT,
                ]);
                return {
                    status: 127,
                    stdout: '',
                    stderr: 'crun: executable file `node` not found in $PATH',
                };
            }
            if (call === 2) {
                assert.deepEqual(args, [
                    'container', 'inspect', '--format', '{{json .Config.Env}}', containerId,
                ]);
                return { status: 0, stdout: JSON.stringify(['PATH=/usr/bin', ...expectedEnvironment]), stderr: '' };
            }
            if (call === 3) {
                assert.deepEqual(args, [
                    'image', 'inspect', '--format', '{{.Id}}', helperImage,
                ]);
                return { status: 0, stdout: `${helperImageId}\n`, stderr: '' };
            }
            assert.equal(call, 4);
            assert.deepEqual(args, [
                'run', '--rm', '--pull=never',
                '--network', 'none',
                '--read-only', '--cap-drop=ALL', '--security-opt=no-new-privileges',
                '--pids-limit', '32', '--memory', '128m', '--cpus', '0.25',
                '--volumes-from', `${containerId}:ro`,
                '--workdir', '/code',
                ...expectedEnvironment.flatMap((entry) => ['--env', entry]),
                '--entrypoint', 'node',
                helperImageId,
                AGENTLIB_AGENT_ATTEST_SCRIPT,
            ]);
            return { status: 0, stdout: JSON.stringify(attestation), stderr: '' };
        },
    });

    assert.equal(call, 4);
    assert.equal(result.sourceRootRealpath, grant.runtimePath);
});

test('the non-Node helper path rejects a target container with a divergent AgentLib environment', (t) => {
    const { grant } = fixture(t);
    const containerId = 'd'.repeat(64);
    let call = 0;
    assert.throws(
        () => attestContainerAgentLib({
            runtime: 'podman',
            containerId,
            grant,
            helperImage: `docker.io/library/node:24@sha256:${'e'.repeat(64)}`,
            spawn(_command, args) {
                call += 1;
                if (call === 1) {
                    return { status: 127, stderr: 'node: executable file not found', stdout: '' };
                }
                assert.equal(call, 2);
                assert.equal(args[0], 'container');
                return {
                    status: 0,
                    stderr: '',
                    stdout: JSON.stringify([
                        `PLOINKY_AGENTLIB_DIR=${grant.runtimePath}`,
                        `PLOINKY_AGENTLIB_MODE=${grant.mode}`,
                        'PLOINKY_AGENTLIB_FINGERPRINT=wrong',
                        `PLOINKY_AGENTLIB_COMMIT=${grant.commit}`,
                        `PLOINKY_AGENTLIB_SOURCE_ID=${grant.sourceIdHash}`,
                    ]),
                };
            },
        }),
        /does not carry the exact PLOINKY_AGENTLIB_FINGERPRINT AgentLib contract/,
    );
    assert.equal(call, 2);
});

test('runtime admission rejects a probe whose loaded bytes differ from the selected source', (t) => {
    const { grant, attestation } = fixture(t);
    const divergent = {
        ...attestation,
        entrypoints: { ...attestation.entrypoints, 'jwt/jwtSign.mjs': 'f'.repeat(64) },
    };
    assert.throws(
        () => attestContainerAgentLib({
            runtime: 'podman',
            containerId: 'b'.repeat(64),
            grant,
            spawn: () => ({ status: 0, stdout: JSON.stringify(divergent), stderr: '' }),
        }),
        /loaded the wrong achillesAgentLib/,
    );
});

test('deployment admission requires core and every managed agent to prove one source', (t) => {
    const { workspace, selection, grant } = fixture(t);
    const env = {
        PLOINKY_WORKSPACE_ROOT: workspace,
        ...agentLibRuntimeEnv(selection, selection.sourceDir),
    };
    const core = buildAgentLibAttestation({ env, root: selection.sourceDir });
    const directGrant = { ...grant, runtimePath: selection.sourceDir, namespaced: false };
    const registry = {
        configuredNoWaitAgent: {
            type: 'agent',
            instanceId: 'instance-configured',
            enableGeneration: 'generation-configured',
        },
        demoAgent: {
            type: 'agent',
            runtime: 'seatbelt',
            pid: 12345,
            instanceId: 'instance-1',
            enableGeneration: 'generation-1',
            agentLib: directGrant,
            agentLibAttestation: core,
        },
    };
    const proof = attestAgentLibDeployment({ env, workspaceRoot: workspace, registry });
    assert.equal(proof.deploymentFingerprint, selection.contentFingerprint);
    assert.equal(proof.sourceIdHash, grant.sourceIdHash);
    assert.equal(proof.agents.length, 1);
    assert.equal(proof.agents[0].runtimeName, 'demoAgent');

    registry.configuredNoWaitAgent.runtime = 'podman';
    registry.configuredNoWaitAgent.containerId = 'a'.repeat(64);
    assert.throws(
        () => attestAgentLibDeployment({ env, workspaceRoot: workspace, registry }),
        /configuredNoWaitAgent does not carry the core AgentLib source identity/,
    );
    delete registry.configuredNoWaitAgent.runtime;
    delete registry.configuredNoWaitAgent.containerId;

    registry.demoAgent.agentLibAttestation = {
        ...core,
        sourceIdHash: '0'.repeat(64),
    };
    assert.throws(
        () => attestAgentLibDeployment({ env, workspaceRoot: workspace, registry }),
        /Agent demoAgent achillesAgentLib attestation failed/,
    );
});
