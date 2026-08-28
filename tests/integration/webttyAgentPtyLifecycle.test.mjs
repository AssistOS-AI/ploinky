import assert from 'node:assert/strict';
import test from 'node:test';

import {
    createPodmanHarness,
    execInBox,
    requirePodmanCandidate,
} from '../e2e/ploinkyBox/nativeHelpers.mjs';

const DRIVER = '/opt/ploinky/tests/integration/webttyAgentPtyLifecycleDriver.mjs';

test('exact production Box proves the selected agent PTY lifecycle backend', {
    timeout: 30 * 60_000,
}, async (t) => {
    const candidateReference = requirePodmanCandidate(t);
    if (!candidateReference) return;
    const agentImage = String(process.env.PLOINKY_WEBTTY_AGENT_IMAGE || '');
    assert.match(agentImage, /^docker\.io\/assistos\/ploinky-node:[a-zA-Z0-9_.-]+$/,
        'PLOINKY_WEBTTY_AGENT_IMAGE must name the production Ploinky agent base tag');
    const firstCandidate = String(process.env.PLOINKY_WEBTTY_PHASE0_FIRST_CANDIDATE || 'rest');
    assert.match(firstCandidate, /^(?:cli|rest)$/);

    const harness = createPodmanHarness(t, candidateReference);
    const prepared = await harness.supervisor.prepareBoxForCommand({
        explicitPort: 19601,
        explicitMediaPort: 19602,
        imageRef: candidateReference,
    });
    assert.match(prepared.containerId, /^[a-f0-9]{64}$/);

    const encoded = Buffer.from(JSON.stringify({ agentImage, firstCandidate })).toString('base64url');
    const output = execInBox(harness.runner, prepared.containerId, [
        '/usr/local/bin/node', DRIVER, encoded,
    ], { timeoutMs: 25 * 60_000 });
    const evidence = JSON.parse(output.split(/\n/).at(-1));

    assert.equal(evidence.schema, 'ploinky-webtty-agent-phase0/v1');
    assert.equal(evidence.selectedBackend, 'controlled-podman-exec-under-box-node-pty');
    assert.equal(evidence.runtime.rootless, true);
    assert.match(evidence.runtime.imageId, /^[a-f0-9]{64}$/);
    assert.equal(evidence.cliNodePty.root.uid, 0);
    assert.equal(evidence.cliNodePty.nonRoot.uid, 1000);
    assert.deepEqual(evidence.cliNodePty.root.dimensions, [101, 33]);
    assert.deepEqual(evidence.cliNodePty.nonRoot.dimensions, [101, 33]);
    assert.equal(evidence.cliNodePty.stopRemove.containerAbsent, true);
    assert.equal(evidence.cliNodePty.sameName.staleExactIdRefused, true);
    assert.equal(evidence.cliNodePty.workerCrash.recoveryRecordRemovedAfterProof, true);
    assert.equal(evidence.rest.unsupportedExactExecTerminationStatus, 404);
    assert.ok(evidence.orphanAudits.every((entry) => (
        entry.markerProcesses === 0 && entry.execIds === 0
    )));
    t.diagnostic(`PLOINKY_WEBTTY_AGENT_PTY_EVIDENCE ${JSON.stringify(evidence)}`);
});
