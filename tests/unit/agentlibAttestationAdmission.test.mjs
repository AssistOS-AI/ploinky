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
        demoAgent: {
            type: 'agent',
            runtime: 'seatbelt',
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

    registry.demoAgent.agentLibAttestation = {
        ...core,
        sourceIdHash: '0'.repeat(64),
    };
    assert.throws(
        () => attestAgentLibDeployment({ env, workspaceRoot: workspace, registry }),
        /Agent demoAgent achillesAgentLib attestation failed/,
    );
});
