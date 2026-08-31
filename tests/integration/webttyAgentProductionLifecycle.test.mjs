import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import dgram from 'node:dgram';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
    createPodmanHarness,
    execInBox,
    requirePodmanCandidate,
} from '../e2e/ploinkyBox/nativeHelpers.mjs';

const BOX_IMAGE_ID = 'sha256:2470a215b6f647c15560cf39bb738e21484ba7fd8bbe8a28133f1df3f4c0b507';
const BOX_DIGEST = 'sha256:ec456ef3a07e7b664c7a08136e844f60e0d3125408e3dbfd375648cb2359921f';
const BOX_REFERENCE = `docker.io/assistos/ploinky-box@${BOX_DIGEST}`;
const AGENT_IMAGE = 'docker.io/assistos/ploinky-node@sha256:d7b9594f73c8f9eead6c5b1717e504bf6c65458e27daf77bb6022085c82faf03';
const DRIVER = '/opt/ploinky/tests/integration/webttyAgentProductionLifecycleDriver.mjs';
const REPOSITORY_ROOT = fs.realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const SOURCES = Object.freeze([
    ['driver', './webttyAgentProductionLifecycleDriver.mjs'],
    ['agentWorkerClient', '../../cli/server/webtty/agentWorkerClient.mjs'],
    ['agentTerminalWorker', '../../cli/server/webtty/agentTerminalWorker.mjs'],
    ['agentProcessIdentity', '../../cli/server/webtty/agentProcessIdentity.mjs'],
    ['agentRuntime', '../../cli/server/webtty/agentRuntime.mjs'],
    ['runtimeRecords', '../../cli/server/webtty/runtimeRecords.mjs'],
]);

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function canonicalImageId(value) {
    const normalized = String(value || '');
    assert.match(normalized, /^(?:sha256:)?[a-f0-9]{64}$/);
    return normalized.startsWith('sha256:') ? normalized : `sha256:${normalized}`;
}

function availableHostPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const { port } = server.address();
            server.close((error) => (error ? reject(error) : resolve(port)));
        });
    });
}

function availableHostUdpPort() {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', reject);
        socket.bind(0, '0.0.0.0', () => {
            const { port } = socket.address();
            socket.close(() => resolve(port));
        });
    });
}

async function distinctHostPorts() {
    const first = await availableHostPort();
    let second = await availableHostUdpPort();
    while (second === first) second = await availableHostUdpPort();
    return [first, second];
}

test('production AgentTerminalWorker and default recovery reclaim exact non-root sessions', {
    timeout: 30 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    assert.equal(candidateReference, BOX_REFERENCE,
        'production lifecycle test is pinned to the admitted local Box candidate');
    const configuredAgent = String(process.env.PLOINKY_WEBTTY_AGENT_IMAGE || AGENT_IMAGE);
    assert.equal(configuredAgent, AGENT_IMAGE,
        'production lifecycle test is pinned to the admitted agent image');

    const harness = createPodmanHarness(t, candidateReference);
    const [routerPort, mediaPort] = await distinctHostPorts();
    try {
        const prepared = await harness.supervisor.prepareBoxForCommand({
            explicitPort: routerPort,
            explicitMediaPort: mediaPort,
            imageRef: candidateReference,
        });
        assert.match(prepared.containerId, /^[a-f0-9]{64}$/);
        const candidate = harness.runner.query('podman', [
            'image', 'inspect', candidateReference,
        ]);
        assert.equal(candidate.ok, true, candidate.stderr);
        const [candidateImage] = JSON.parse(candidate.stdout);
        assert.equal(canonicalImageId(candidateImage.Id), BOX_IMAGE_ID);
        assert.equal(candidateImage.Digest, BOX_DIGEST);
        assert.equal(canonicalImageId(
            prepared.ownership.handles.container.runtime.imageId,
        ), BOX_IMAGE_ID);

        const live = harness.runner.query('podman', [
            'container', 'inspect', prepared.containerId,
        ]);
        assert.equal(live.ok, true, live.stderr);
        const [inspection] = JSON.parse(live.stdout);
        const sourceMount = inspection.Mounts.find(
            (mount) => mount.Destination === '/opt/ploinky',
        );
        assert.equal(sourceMount?.Type, 'bind');
        assert.equal(sourceMount.RW, false);
        assert.equal(fs.realpathSync(sourceMount.Source), REPOSITORY_ROOT);

        const sourceDigests = Object.fromEntries(SOURCES.map(([name, relative]) => {
            const filePath = fileURLToPath(new URL(relative, import.meta.url));
            assert.equal(path.relative(REPOSITORY_ROOT, filePath).startsWith('..'), false);
            return [name, sha256(filePath)];
        }));
        const encoded = Buffer.from(JSON.stringify({ agentImage: configuredAgent }))
            .toString('base64url');
        const output = execInBox(harness.runner, prepared.containerId, [
            '/usr/local/bin/node', DRIVER, encoded,
        ], { timeoutMs: 25 * 60_000 });
        const evidence = JSON.parse(output.split(/\n/).at(-1));

        assert.equal(evidence.schema, 'ploinky-webtty-agent-production-lifecycle/v1');
        assert.deepEqual(evidence.sources, sourceDigests);
        assert.equal(evidence.agent.digest, AGENT_IMAGE.split('@')[1]);
        assert.equal(evidence.agent.rootless, true);
        assert.match(evidence.agent.configuredUser, /^(?:1000(?::1000)?|node)$/);
        assert.equal(evidence.cases.clean.markerProof.innerUid, 1000);
        assert.deepEqual(evidence.cases.clean.markerProof.argv, [
            '/bin/bash', '--noprofile', '--norc', '-p', '-c',
            '/bin/bash --noprofile --norc; ploinky_webtty_status=$?; case "$ploinky_webtty_status" in 126|127) exit 124 ;; *) exit "$ploinky_webtty_status" ;; esac',
            `ploinky-webtty-marker:production_marker_${evidence.runId}_clean`,
        ]);
        assert.deepEqual(evidence.cases.clean.io,
            { uid: 1000, cwd: '/tmp', echoResistant: true });
        assert.deepEqual(evidence.cases.clean.resize,
            { cols: 101, rows: 33, echoResistant: true });
        assert.equal(evidence.cases.clean.cleanupProven, true);
        assert.deepEqual(evidence.cases.clean.readinessChallenge, {
            injection: 'PROMPT_COMMAND',
            staleFrameObserved: true,
            staleFrameHadExactNumericIdentityShape: true,
            postSpawnChallengeAbsentFromRecoveryEvidence: true,
        });
        assert.equal(evidence.cases.starting.durableStateAtCrash, 'pty-starting');
        assert.equal(evidence.cases.starting.recoveryCategory,
            'verified_agent_startup_reclaimed');
        assert.deepEqual(evidence.cases.foreign, {
            durableStateAtCrash: 'pty-starting',
            webttyPtyStarted: false,
            execId: evidence.cases.foreign.execId,
            foreignArgvDistinctAndMarkerFree: true,
            initialRecoveryCategory: 'agent_startup_exec_unowned',
            initialRecoveryTargetScoped: true,
            recordRetainedDuringQuarantine: true,
            foreignExecAliveAfterRecovery: true,
            foreignExecIdentityUnchanged: true,
            exactAbsenceBeforeSelfHeal: true,
            finalRecoveryCategory: 'verified_agent_startup_reclaimed',
            recordRemoved: true,
        });
        assert.equal(evidence.cases.ready.durableStateAtCrash, 'pty-ready');
        assert.equal(evidence.cases.ready.recoveryCategory, 'verified_agent_reclaimed');
        assert.ok(evidence.cases.ready.foregroundSessionMembers >= 3);
        assert.equal(evidence.cases.removed.targetStoppedBeforeRemoval, true);
        assert.equal(evidence.cases.removed.targetRemovedBeforeRecovery, true);
        assert.equal(evidence.cases.removed.recoveryCategory, 'dead_record_removed');
        assert.equal(evidence.cases.fallback.markerProof.innerUid, 1000);
        assert.deepEqual(evidence.cases.fallback.markerProof.argv, [
            '/bin/sh', '-p', '-c',
            '/bin/sh -i; ploinky_webtty_status=$?; exit "$ploinky_webtty_status"',
            `ploinky-webtty-marker:production_marker_${evidence.runId}_fallback`,
        ]);
        assert.deepEqual(evidence.cases.fallback.readinessChallenge, {
            injection: 'ENV',
            staleFrameObserved: true,
            staleFrameHadExactNumericIdentityShape: true,
            postSpawnChallengeAbsentFromRecoveryEvidence: true,
        });
        assert.equal(evidence.cases.fallback.bashAbsenceProvenBeforeExec, true);
        assert.equal(evidence.cases.fallback.cleanupProven, true);
        for (const value of Object.values(evidence.cases)) {
            assert.match(value.execId, /^[a-f0-9]{64}$/);
            if (Object.hasOwn(value, 'recordRemoved')) assert.equal(value.recordRemoved, true);
        }
        assert.deepEqual(evidence.cleanup, {
            labeledContainers: 0,
            recoveryRecords: 0,
            exactWorkers: 0,
            exactClients: 0,
            markerProcesses: 0,
            execRecords: 0,
        });
        t.diagnostic(`PLOINKY_WEBTTY_PRODUCTION_AGENT_EVIDENCE ${JSON.stringify({
            sourceDigests,
            evidence,
        })}`);
    } finally {
        await harness.cleanup();
        assert.equal(fs.existsSync(harness.candidateProxy.tracePath), true);
    }
});
