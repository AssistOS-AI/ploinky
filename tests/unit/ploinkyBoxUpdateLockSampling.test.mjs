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

// Uses only public entry points that exist before and after the lock-time
// sampling change, so it demonstrates the defect on the unchanged baseline.

function sink() {
    let text = '';
    return { isTTY: false, write(chunk) { text += String(chunk); }, value: () => text };
}

function scenario(t, { before, whileWaiting }) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-lock-sampling-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    fs.mkdirSync(path.join(root, '.ploinky'));
    const identity = buildWorkspaceIdentity(root, { markerFound: true });
    const agentLib = agentLibFixture(identity.workspaceRoot);
    const graph = { ...before };
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
                runtime: { running: graph.running, mounts: agentLibFixtureMounts(agentLib, identity.workspaceRoot) },
            },
        },
    });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        discover: () => ownership(),
        lockManager: {
            async acquire(instance) {
                events.push('lock');
                // Another invocation changes the graph while this one waits.
                Object.assign(graph, whileWaiting);
                return { assertHeld(expected) { assert.equal(expected, instance); }, release() { events.push('release'); } };
            },
        },
        runner: {
            run() {},
            query() {
                return {
                    ok: true,
                    stdout: JSON.stringify({
                        state: 'initialized', initialized: true, routingConfigured: graph.configured,
                        trackedAgents: 0, runningAgents: 0, warnings: [],
                    }),
                };
            },
        },
        validateExistingImage: () => ({ immutableId: 'b'.repeat(64) }),
        validateContainer: () => ({}),
        updateWorkspacePloinky: async () => null,
        updateAgentLib: async () => ({ selection: agentLib, changed: false, previous: agentLib }),
        reconcile: async () => ({ ownership: ownership(), hostPort: 8080, mediaHostPort: 7882, action: 'reused' }),
        runCoreCommand: async (_engine, _id, argv) => { events.push(['core', [...argv]]); },
        runRestartCore: async (_engine, _id, argv) => {
            events.push(['core', [...argv]]);
            return { cause: 'exited', status: 0, signal: null, quiescence: { state: 'confirmed' } };
        },
        // The candidate runs the in-Box update through the report protocol;
        // the baseline ignores this seam and uses runCoreCommand above.
        runUpdateCore: async (_engine, _id, argv, _port, _media, _runner, options) => {
            events.push(['core', [...argv]]);
            const { buildUpdateResult, writeUpdateReport } = await import('../../cli/commands/updateOutcome.js');
            writeUpdateReport(path.join(options.workspaceRoot, '.ploinky'), options.reportNonce, buildUpdateResult({
                command: argv, records: [], context: JSON.parse(JSON.stringify(options.reportContext)),
            }));
            return { cause: 'exited', status: 0, signal: null, quiescence: { state: 'confirmed' } };
        },
        healthCheck: async () => { events.push('health'); },
        revalidateAgentLibSource: () => {},
        commitAgentLibSelection: () => {},
        captureCoreStartArgv: () => ['start', 'agent', '8080'],
        resolveHostReachableIpv4: async () => '',
        stdout: sink(),
        stderr: sink(),
    });
    return { supervisor, identity, events };
}

async function update(fixture) {
    const output = sink();
    const code = await runOuterCli(['update'], {
        env: {},
        cwd: () => fixture.identity.workspaceRoot,
        input: { isTTY: false },
        output,
        errorOutput: sink(),
        supervisor: fixture.supervisor,
        detectInsideBox: () => false,
        updateHostSource: async () => ({ updated: false }),
    });
    return { code, output: output.value() };
}

const restarts = events => events.filter(event => Array.isArray(event) && event[1][0] === 'restart');

test('a graph stopped while update waited for the lock is not restarted or reported as restarted', async (t) => {
    const fixture = scenario(t, {
        before: { running: true, configured: true },
        whileWaiting: { running: false },
    });
    const { code, output } = await update(fixture);
    assert.equal(code, 0);
    assert.deepEqual(restarts(fixture.events), []);
    assert.doesNotMatch(output, /restarted/);
});

test('a graph started while update waited for the lock is restarted under that lock', async (t) => {
    const fixture = scenario(t, {
        before: { running: false, configured: false },
        whileWaiting: { running: true, configured: true },
    });
    const { code, output } = await update(fixture);
    assert.equal(code, 0);
    assert.equal(restarts(fixture.events).length, 1);
    const restart = fixture.events.findIndex(event => Array.isArray(event) && event[1][0] === 'restart');
    assert.ok(fixture.events.indexOf('lock') < restart && restart < fixture.events.indexOf('release'));
    assert.match(output, /restarted/);
});
