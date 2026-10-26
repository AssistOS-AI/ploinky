import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { runOuterCli } from '../../ploinky-box/bin/ploinky-box.mjs';
import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { createUpdateHostState } from '../../ploinky-box/update/hostState.mjs';
import { consumeRelaunchHandoff, UPDATE_HANDOFF_ENV } from '../../ploinky-box/update/relaunchHandoff.mjs';
import { createUpdateBoxScenario } from '../helpers/updateBoxScenario.mjs';

// Mutation-gap regression: the host self-update relaunch crosses a real
// process boundary. The parent persists the handoff in file-backed host state
// and spawns a real `node` child running the production outer CLI with its
// default handoff parent pid (process.ppid) and environment. The child must
// consume the handoff exactly once and report the first invocation's host pull.

const CHILD = fileURLToPath(new URL('../fixtures/update-relaunch-child.mjs', import.meta.url));
const OUTER_CLI = fileURLToPath(new URL('../../ploinky-box/bin/ploinky-box.mjs', import.meta.url));

function sink() {
    let text = '';
    return { isTTY: false, write(chunk) { text += String(chunk); return true; }, value: () => text };
}

for (const [label, childOutcome, expectedCode] of [['succeeds', 'verified', 0], ['fails', 'dirty', 1]]) {
    test(`a real relaunched child that ${label} consumes the file-backed handoff once and carries the host-ploinky record`, async (t) => {
        const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-relaunch-')));
        t.after(() => fs.rmSync(root, { recursive: true, force: true }));
        const workspace = path.join(root, 'workspace');
        fs.mkdirSync(workspace);
        const resultFile = path.join(root, 'child-result.json');
        const store = createUpdateHostState({ identity: buildWorkspaceIdentity(workspace) });
        const parent = createUpdateBoxScenario({ root: path.join(root, 'parent'), workspace, store });
        const launches = [];
        let childStdout = '';
        let childStderr = '';
        const output = sink();
        const code = await runOuterCli(['update'], {
            env: {
                HOME: path.join(root, 'home'),
                PLOINKY_WORKSPACE_ROOT: workspace,
                FIXTURE_ROOT: root,
                FIXTURE_WORKSPACE: workspace,
                FIXTURE_RESULT: resultFile,
                FIXTURE_CHILD_OUTCOME: childOutcome,
            },
            cwd: () => workspace,
            input: { isTTY: false },
            output,
            errorOutput: sink(),
            supervisor: parent.supervisor,
            detectInsideBox: () => false,
            updateHostState: store,
            updateHostSource: async () => ({
                updated: true, repoPath: '/host/ploinky', before: '1'.repeat(40), after: '2'.repeat(40),
            }),
            relaunch: (command, args, { env }) => new Promise((resolve, reject) => {
                launches.push({ command, args: [...args], handoff: env[UPDATE_HANDOFF_ENV] });
                // The production relaunch runs the outer CLI file; the child
                // fixture runs the same runOuterCli with the same argv tail.
                const child = spawn(command, [CHILD, ...args.slice(1)], { cwd: workspace, env, stdio: ['ignore', 'pipe', 'pipe'] });
                child.stdout.on('data', chunk => { childStdout += chunk; });
                child.stderr.on('data', chunk => { childStderr += chunk; });
                child.once('error', reject);
                child.once('close', status => resolve(status));
            }),
        });

        assert.equal(launches.length, 1);
        assert.equal(launches[0].command, process.execPath);
        assert.deepEqual(launches[0].args, [OUTER_CLI, 'update']);
        assert.equal(code, expectedCode, childStderr);
        assert.ok(fs.existsSync(resultFile), `the child reported a result: ${childStderr}`);
        const { ppid, result } = JSON.parse(fs.readFileSync(resultFile, 'utf8'));
        assert.equal(ppid, process.pid, 'the handoff was accepted from the default process.ppid');
        const host = result.records[0];
        assert.deepEqual([host.phase, host.outcome, host.required, host.after.revision, host.details.relaunched],
            ['host-ploinky', 'changed', true, '2'.repeat(40), true]);
        assert.equal(result.exitCode, expectedCode);
        assert.match(childStdout, /was updated from 111111111111 to 222222222222 before this relaunch/);
        assert.doesNotMatch(output.value(), /did not accept the relaunch handoff/);
        if (expectedCode) {
            assert.match(output.value(), /updated CLI exited with status 1\. The host Ploinky checkout at \/host\/ploinky remains updated/);
        } else {
            assert.doesNotMatch(output.value(), /exited with status/);
        }
        // Consumed exactly once: nothing is left, and a replay is refused.
        assert.deepEqual(store.list('update-handoffs'), []);
        assert.throws(() => consumeRelaunchHandoff({
            store,
            value: launches[0].handoff,
            argv: ['update'],
            request: { kind: 'all', folder: null, folderPath: null },
            identity: parent.identity,
            parentPid: process.pid,
        }), /no pending handoff exists/);
    });
}

test('without an injected store the outer CLI keeps the relaunch handoff in the workspace host state, never in the home directory', async (t) => {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-relaunch-default-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    fs.mkdirSync(workspace);
    const home = path.join(root, 'home');
    fs.mkdirSync(home, { mode: 0o700 });
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    t.after(() => { if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome; });
    const identity = buildWorkspaceIdentity(workspace);
    const parent = createUpdateBoxScenario({ root: path.join(root, 'parent'), workspace, store: createUpdateHostState({ identity }) });
    const handoffDirectory = path.join(identity.hostStateRoot, 'update-handoffs');
    const seen = [];
    const code = await runOuterCli(['update'], {
        env: { HOME: home, PLOINKY_WORKSPACE_ROOT: workspace },
        cwd: () => workspace,
        input: { isTTY: false },
        output: sink(),
        errorOutput: sink(),
        supervisor: parent.supervisor,
        detectInsideBox: () => false,
        updateHostSource: async () => ({
            updated: true, repoPath: '/host/ploinky', before: '1'.repeat(40), after: '2'.repeat(40),
        }),
        relaunch: async () => {
            seen.push(fs.readdirSync(handoffDirectory).map((name) => ({ name, mode: fs.statSync(path.join(handoffDirectory, name)).mode & 0o777 })));
            return 0;
        },
    });
    assert.equal(code, 0);
    assert.equal(seen.length, 1);
    assert.equal(seen[0].length, 1, 'the handoff was written under <workspace>/.ploinky-box/update-handoffs');
    assert.equal(seen[0][0].mode, 0o600);
    assert.deepEqual(fs.readdirSync(handoffDirectory), [], 'an unconsumed handoff is discarded afterwards');
    assert.deepEqual(fs.readdirSync(home), [], 'nothing is created under the home directory');
});
