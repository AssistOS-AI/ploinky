import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import { BOX_LABELS } from '../../ploinky-box/constants.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import {
    agentLibFixture,
    agentLibFixtureLabels,
    agentLibFixtureMounts,
} from '../helpers/agentlibFixture.mjs';

// Imports only modules that exist before and after the structured-outcome
// change, and writes the report envelope inline, so it demonstrates on the
// unchanged baseline that the final host message ignored aggregate outcomes.

function sink() {
    let text = '';
    return { isTTY: false, write(chunk) { text += String(chunk); }, value: () => text };
}

// The in-Box core preserved a dirty required repository and published that.
function publishDirtySkipReport(options, argv) {
    const record = {
        phase: 'workspace-repository', id: 'demo', outcome: 'skipped', attempted: false, required: true,
        code: 'dirty-worktree', reason: 'local changes were preserved',
        before: null, after: null, graphImpact: null, details: null,
    };
    const result = {
        schema: 'ploinky-update-result',
        version: 1,
        command: [...argv],
        context: JSON.parse(JSON.stringify(options.reportContext)),
        records: [record],
        status: 'failed',
        exitCode: 1,
        activationAllowed: false,
        agentLib: null,
    };
    const directory = path.join(options.workspaceRoot, '.ploinky', 'running', 'update-reports');
    fs.mkdirSync(directory, { recursive: true });
    fs.writeFileSync(path.join(directory, `${options.reportNonce}.json`), `${JSON.stringify({
        schema: 'ploinky-update-report', version: 1, nonce: options.reportNonce, result,
    })}\n`, { mode: 0o600 });
    return { cause: 'exited', status: 1, signal: null, quiescence: { state: 'confirmed' } };
}

test('a preserved dirty required repository makes update exit nonzero without a restart', async (t) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-aggregate-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky'));
    const identity = buildWorkspaceIdentity(root, { markerFound: true });
    const agentLib = agentLibFixture(identity.workspaceRoot);
    const events = [];
    const ownership = () => ({
        state: 'owned',
        engine: { name: 'podman', identity: 'engine' },
        handles: {
            container: {
                id: 'a'.repeat(64),
                labels: {
                    ...agentLibFixtureLabels(agentLib),
                    [BOX_LABELS.routerHostPort]: '8080',
                    [BOX_LABELS.mediaHostPort]: '7882',
                },
                runtime: { running: true, mounts: agentLibFixtureMounts(agentLib, identity.workspaceRoot) },
            },
        },
    });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        discover: () => ownership(),
        lockManager: { async acquire() { return { assertHeld() {}, release() {} }; } },
        runner: {
            run() {},
            query: () => ({
                ok: true,
                stdout: JSON.stringify({
                    state: 'initialized', initialized: true, routingConfigured: true,
                    trackedAgents: 0, runningAgents: 0, warnings: [],
                }),
            }),
        },
        validateExistingImage: () => ({ immutableId: 'b'.repeat(64) }),
        validateContainer: () => ({}),
        updateWorkspacePloinky: async () => null,
        updateAgentLib: async () => ({ selection: agentLib, changed: false, previous: agentLib }),
        reconcile: async () => ({ ownership: ownership(), hostPort: 8080, mediaHostPort: 7882, action: 'reused' }),
        // Baseline: the in-Box update succeeds as a process.
        runCoreCommand: async (_engine, _id, argv) => { events.push([...argv]); },
        runRestartCore: async (_engine, _id, argv) => {
            events.push([...argv]);
            return { cause: 'exited', status: 0, signal: null, quiescence: { state: 'confirmed' } };
        },
        // Candidate: the same in-Box update reports a preserved required skip.
        runUpdateCore: async (_engine, _id, argv, _port, _media, _runner, options) => {
            events.push([...argv]);
            return publishDirtySkipReport(options, argv);
        },
        healthCheck: async () => {},
        revalidateAgentLibSource: () => {},
        commitAgentLibSelection: () => {},
        captureCoreStartArgv: () => ['start', 'agent', '8080'],
        resolveHostReachableIpv4: async () => '',
        stdout: sink(),
        stderr: sink(),
    });
    const output = sink();
    const code = await runOuterCli(['update'], {
        env: {},
        cwd: () => identity.workspaceRoot,
        input: { isTTY: false },
        output,
        errorOutput: sink(),
        supervisor,
        detectInsideBox: () => false,
        updateHostSource: async () => ({ updated: false }),
    });
    assert.equal(code, 1);
    assert.equal(events.some(argv => argv[0] === 'restart'), false, 'no activation after a required unverified input');
    assert.doesNotMatch(output.value(), /restarted coherently|Update complete/);
    assert.match(output.value(), /dirty-worktree/);
});
