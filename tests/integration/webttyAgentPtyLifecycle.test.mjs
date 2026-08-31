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

const DRIVER = '/opt/ploinky/tests/integration/webttyAgentPtyLifecycleDriver.mjs';
const REPOSITORY_ROOT = fs.realpathSync(fileURLToPath(new URL('../..', import.meta.url)));
const HARNESS_SOURCES = Object.freeze([
    ['driver', fileURLToPath(new URL('./webttyAgentPtyLifecycleDriver.mjs', import.meta.url)), DRIVER],
    ['readiness', fileURLToPath(new URL('./webttyAgentPtyReadiness.mjs', import.meta.url)),
        '/opt/ploinky/tests/integration/webttyAgentPtyReadiness.mjs'],
    ['agentRuntime', fileURLToPath(new URL('../../cli/server/webtty/agentRuntime.mjs', import.meta.url)),
        '/opt/ploinky/cli/server/webtty/agentRuntime.mjs'],
]);

function sha256(filePath) {
    return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function availableHostPort() {
    return new Promise((resolve, reject) => {
        const server = net.createServer();
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            const address = server.address();
            server.close((error) => {
                if (error) reject(error);
                else resolve(address.port);
            });
        });
    });
}

function availableHostUdpPort() {
    return new Promise((resolve, reject) => {
        const socket = dgram.createSocket('udp4');
        socket.once('error', reject);
        socket.bind(0, '0.0.0.0', () => {
            const address = socket.address();
            socket.close(() => resolve(address.port));
        });
    });
}

async function distinctHostPorts() {
    const first = await availableHostPort();
    let second = await availableHostUdpPort();
    while (second === first) second = await availableHostUdpPort();
    return [first, second];
}

test('exact production Box proves the selected agent PTY lifecycle backend', {
    timeout: 30 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    const agentImage = String(process.env.PLOINKY_WEBTTY_AGENT_IMAGE || '');
    assert.match(agentImage, /^docker\.io\/assistos\/ploinky-node@sha256:[a-f0-9]{64}$/,
        'PLOINKY_WEBTTY_AGENT_IMAGE must name one immutable production Ploinky agent image');
    const firstCandidate = String(process.env.PLOINKY_WEBTTY_PHASE0_FIRST_CANDIDATE || 'rest');
    assert.match(firstCandidate, /^(?:cli|rest)$/);
    const cliExecMode = String(
        process.env.PLOINKY_WEBTTY_PHASE0_CLI_EXEC_MODE || 'persistent-session',
    );
    assert.match(cliExecMode, /^(?:persistent-session|no-session)$/);

    const harness = createPodmanHarness(t, candidateReference);
    const [routerPort, mediaPort] = await distinctHostPorts();
    try {
        const prepared = await harness.supervisor.prepareBoxForCommand({
            explicitPort: routerPort,
            explicitMediaPort: mediaPort,
            imageRef: candidateReference,
        });
        assert.match(prepared.containerId, /^[a-f0-9]{64}$/);
        const handle = prepared.ownership.handles.container;
        const candidate = harness.runner.query('podman', ['image', 'inspect', candidateReference]);
        assert.equal(candidate.ok, true, candidate.stderr);
        const [candidateImage] = JSON.parse(candidate.stdout);
        assert.equal(handle.id, prepared.containerId);
        assert.equal(handle.runtime.imageId, candidateImage.Id);
        assert.equal(handle.labels['io.assistos.ploinky-box.image-ref'], candidateReference);

        // Native Box reconciliation mounts the exact candidate source tree at
        // /opt/ploinky read-only. Prove that mount explicitly: copying into the
        // destination would both bypass that contract and fail on the required
        // read-only bind. The driver returns its in-Box SHA-256 values below so
        // the host also proves that the executed bytes equal these source files.
        const liveContainer = harness.runner.query('podman', [
            'container', 'inspect', prepared.containerId,
        ]);
        assert.equal(liveContainer.ok, true, liveContainer.stderr);
        const [liveInspection] = JSON.parse(liveContainer.stdout);
        const sourceMount = liveInspection.Mounts.find((mount) => mount.Destination === '/opt/ploinky');
        assert.equal(sourceMount?.Type, 'bind');
        assert.equal(fs.realpathSync(sourceMount.Source), REPOSITORY_ROOT);
        assert.equal(sourceMount.RW, false);
        for (const [, source, destination] of HARNESS_SOURCES) {
            assert.equal(path.isAbsolute(source), true);
            assert.equal(fs.realpathSync(source), fs.realpathSync(path.join(
                REPOSITORY_ROOT,
                path.relative('/opt/ploinky', destination),
            )));
        }

        const encoded = Buffer.from(JSON.stringify({
            agentImage,
            firstCandidate,
            cliExecMode,
        })).toString('base64url');
        const output = execInBox(harness.runner, prepared.containerId, [
            '/usr/local/bin/node', DRIVER, encoded,
        ], { timeoutMs: 25 * 60_000 });
        const evidence = JSON.parse(output.split(/\n/).at(-1));

        assert.equal(evidence.schema, 'ploinky-webtty-agent-phase0/v1');
        assert.deepEqual(evidence.harnessSources, Object.fromEntries(
            HARNESS_SOURCES.map(([name, source]) => [name, sha256(source)]),
        ));
        assert.equal(evidence.selectedBackend,
            'controlled-podman-exec-persistent-session-under-box-node-pty');
        assert.equal(evidence.cliNodePty.execMode, cliExecMode);
        assert.equal(evidence.runtime.rootless, true);
        assert.match(evidence.runtime.imageId, /^[a-f0-9]{64}$/);
        assert.equal(evidence.cliNodePty.root.uid, 0);
        assert.equal(evidence.cliNodePty.nonRoot.uid, 1000);
        assert.equal(evidence.cliNodePty.root.postSpawnReadinessChallenge, true);
        assert.equal(evidence.cliNodePty.root.hostileStartupFrameRejected, true);
        assert.equal(evidence.cliNodePty.root.hostileBashEnvironmentSuppressed, true);
        assert.equal(evidence.cliNodePty.nonRoot.postSpawnReadinessChallenge, true);
        assert.equal(evidence.cliNodePty.nonRoot.hostileStartupFrameRejected, true);
        assert.equal(evidence.cliNodePty.nonRoot.hostileBashEnvironmentSuppressed, true);
        assert.deepEqual(evidence.cliNodePty.root.dimensions, [101, 33]);
        assert.deepEqual(evidence.cliNodePty.nonRoot.dimensions, [101, 33]);
        assert.equal(evidence.cliNodePty.rootClose.controlledClose, true);
        assert.equal(evidence.cliNodePty.nonRootClose.controlledClose, true);
        assert.equal(evidence.cliNodePty.stopRemove.containerAbsent, true);
        assert.equal(evidence.cliNodePty.sameName.staleExactIdRefused, true);
        assert.equal(evidence.cliNodePty.workerCrash.recoveryRecordRemovedAfterProof, true);
        assert.equal(evidence.cliNodePty.shellSelection.fallback.uid, 0);
        assert.equal(evidence.cliNodePty.shellSelection.fallback.postSpawnReadinessChallenge, true);
        assert.equal(evidence.cliNodePty.shellSelection.fallback.hostileStartupFrameRejected, true);
        assert.equal(evidence.cliNodePty.shellSelection.bashAbsence.exactFallbackClassifier, true);
        assert.equal(evidence.cliNodePty.shellSelection.bothMissing.shellUnavailable, true);
        for (const audit of evidence.orphanAudits) {
            if (audit.targetMarkerProof) {
                if (cliExecMode === 'no-session') {
                    assert.equal(audit.exactExecId, null);
                    assert.equal(audit.execRecordAbsentThroughout, true);
                } else {
                    assert.match(audit.exactExecId, /^[a-f0-9]{64}$/);
                    assert.equal(audit.execRecordDrained, true);
                }
            }
        }
        assert.equal(evidence.rest.liveExecProven, true);
        assert.equal(evidence.rest.postAttachReadinessChallenge, true);
        assert.equal(evidence.rest.hostileStartupFrameRejected, true);
        assert.equal(evidence.rest.io, true);
        assert.deepEqual(evidence.rest.dimensions, [97, 29]);
        assert.ok([200, 404].includes(evidence.rest.afterAttachClose.inspectStatus));
        assert.equal(typeof evidence.rest.afterAttachClose.running, 'boolean');
        assert.equal(evidence.rest.fullPhase0Admission, false);
        if (evidence.rest.viabilityProbePassed) {
            assert.equal(evidence.rest.attachSocketClosedBeforeRemoval, true);
            assert.ok([200, 404].includes(evidence.rest.exactExecRemovalStatus));
            assert.equal(
                evidence.rest.terminatedByAttachClose || evidence.rest.terminatedByExactRemove,
                true,
            );
            assert.equal(evidence.rest.removedWhileRunning,
                evidence.rest.terminatedByExactRemove);
            assert.deepEqual(evidence.rest.audit,
                { markerProcesses: 0, boxMarkerProcesses: 0, execIds: 0 });
        } else {
            assert.equal(evidence.rest.exactExecRemovalStatus, null);
            assert.equal(evidence.rest.removedWhileRunning, false);
            assert.equal(evidence.rest.cleanupProven, true);
            assert.equal(evidence.rest.rejection.code,
                'PHASE0_REST_LIVE_EXEC_REMOVAL_REJECTED');
            assert.match(evidence.rest.rejection.reason,
                /REST socket-first exact-exec removal failed after I\/O and resize proof/);
        }
        assert.ok(evidence.orphanAudits.every((entry) => (
            entry.markerProcesses === 0
            && entry.boxMarkerProcesses === 0
            && entry.execIds === 0
        )));
        t.diagnostic(`PLOINKY_WEBTTY_AGENT_PTY_EVIDENCE ${JSON.stringify(evidence)}`);
    } finally {
        await harness.cleanup();
        assert.equal(fs.existsSync(harness.candidateProxy.tracePath), true);
    }
});
