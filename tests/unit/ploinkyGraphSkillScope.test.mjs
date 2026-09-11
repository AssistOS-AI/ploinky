import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { buildWorkspaceIdentity } from '../../ploinky-box/identity.mjs';
import { buildHostSkillScope } from '../../ploinky-box/skillScope.mjs';
import { GRAPH_SKILL_SCOPE_FILE, readGraphSkillScope, validateGraphSkillScope, writeGraphSkillScope } from '../../ploinky-box/graphSkillScope.mjs';
import { createBoxSupervisor } from '../../ploinky-box/supervisor.mjs';
import { agentLibFixture } from '../helpers/agentlibFixture.mjs';

function fixture(t, { symlinkedState = false } = {}) {
    const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-graph-scope-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const workspace = path.join(root, 'workspace');
    for (const name of ['.ploinky', 'prior', 'candidate']) fs.mkdirSync(path.join(workspace, name), { recursive: true });
    if (symlinkedState) {
        const stateDirectory = path.join(root, 'linked-state');
        fs.renameSync(path.join(workspace, '.ploinky'), stateDirectory);
        fs.symlinkSync(stateDirectory, path.join(workspace, '.ploinky'), 'dir');
    }
    const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
    const priorScope = buildHostSkillScope(workspace, path.join(workspace, 'prior'));
    const candidateScope = buildHostSkillScope(workspace, path.join(workspace, 'candidate'));
    const oldAgentLib = agentLibFixture(workspace);
    const newAgentLib = agentLibFixture(workspace, { sourceRelativePath: '.ploinky/agentlib/candidate' });
    const ownership = id => ({ state: 'owned', engine: { name: 'fixture', identity: 'fixture' }, handles: { container: { id, runtime: { running: true } } } });
    const prior = ownership('a'.repeat(64));
    const candidate = ownership('c'.repeat(64));
    const state = { failAt: '', initial: true, calls: [], healthChecks: 0, acquisitions: 0, held: false };
    const lock = { assertHeld(instance) { assert.equal(instance, identity.instance); assert.equal(state.held, true); } };
    const perform = (containerId, argv, options) => {
        lock.assertHeld(identity.instance);
        state.calls.push({ containerId, argv, scope: options.skillScopeEnv });
        if (!state.initial && containerId === candidate.handles.container.id && state.failAt === 'core') throw new Error('candidate core failed');
    };
    const create = launchCwd => createBoxSupervisor({
        env: {}, launchCwd, resolveIdentity: () => identity, discover: () => prior,
        lockManager: { async acquire() {
            state.acquisitions += 1; state.held = true;
            const directory = path.join(root, `lock-${state.acquisitions}`); fs.mkdirSync(directory);
            return { ...lock, path: directory, release() { state.held = false; } };
        } },
        runner: { run() { return { status: 0, stdout: '', stderr: '' }; } },
        stdout: { write() {} }, stderr: { write() {} }, readEdgeDesired: () => null,
        captureCoreStartArgv: () => ['start', 'fixture', '8080'],
        selectAgentLib: async () => ({ selection: state.initial ? oldAgentLib : newAgentLib }),
        updateAgentLib: async () => ({ selection: state.initial ? oldAgentLib : newAgentLib }),
        updateWorkspacePloinky: async () => null,
        reconcile: async () => ({
            action: state.initial ? 'reused' : 'replaced', ownership: state.initial ? prior : candidate,
            hostPort: 8080, mediaHostPort: 7882, previousAgentLib: oldAgentLib,
            finalize() { if (state.failAt === 'finalize') throw new Error('candidate finalize failed'); },
            rollback: async () => ({ containerId: prior.handles.container.id, hostPort: 8080, mediaHostPort: 7882, agentLib: oldAgentLib }),
        }),
        resolveHostReachableIpv4: async () => '',
        startCore: async (_engine, id, argv, _port, _media, _runner, options) => perform(id, argv, options),
        runCoreCommand: async (_engine, id, argv, _port, _media, _runner, options) => perform(id, argv, options),
        healthCheck: async () => {
            state.healthChecks += 1;
            if (state.failAt === 'health' && state.calls.at(-1)?.containerId === candidate.handles.container.id) throw new Error('candidate health failed');
        },
        revalidateAgentLibSource() {}, commitAgentLibSelection() {},
    });
    return { root, workspace, identity, priorScope, candidateScope, state, create, lock, target: path.join(identity.anchorPath, GRAPH_SKILL_SCOPE_FILE) };
}

const activate = (supervisor, operation) => operation === 'start'
    ? supervisor.runStartTransaction(['start', 'fixture'])
    : operation === 'restart' ? supervisor.runRestartTransaction(['restart'])
        : supervisor.runUpdateTransaction(['update'], { restartAfterUpdate: true });

for (const operation of ['start', 'restart', 'update']) {
    test(`${operation} accepts linked workspace state and preserves exact saved graph scope`, async t => {
        const f = fixture(t, { symlinkedState: true });
        assert.equal(readGraphSkillScope(f.identity), null);
        await f.create(f.priorScope.PLOINKY_HOST_LAUNCH_CWD).runStartTransaction(['start', 'fixture']);
        assert.deepEqual(readGraphSkillScope(f.identity), f.priorScope);
        await activate(f.create(f.candidateScope.PLOINKY_HOST_LAUNCH_CWD), operation);
        assert.deepEqual(f.state.calls.at(-1).scope, f.candidateScope);
        assert.deepEqual(readGraphSkillScope(f.identity), f.candidateScope);
        assert.equal(fs.lstatSync(f.identity.anchorPath).isSymbolicLink(), true);
        const record = JSON.parse(fs.readFileSync(path.join(f.root, 'linked-state', GRAPH_SKILL_SCOPE_FILE)));
        assert.deepEqual(record, { version: 1, instance: f.identity.instance, launchRelativePath: 'candidate' });
        assert.equal(fs.statSync(f.target).mode & 0o777, 0o600);
        assert.equal(f.state.held, false);
        assert.equal(f.state.acquisitions, 2);
    });
}

for (const operation of ['publication', 'removal']) {
test(`linked state retargeted before atomic ${operation} preserves both directories`, t => {
    const f = fixture(t, { symlinkedState: true });
    f.state.held = true;
    writeGraphSkillScope(f.identity, f.priorScope, f.lock);
    const original = fs.readFileSync(f.target, 'utf8');
    const replacement = path.join(f.root, 'replacement-state');
    fs.mkdirSync(replacement);
    const replacementTarget = path.join(replacement, GRAPH_SKILL_SCOPE_FILE);
    fs.writeFileSync(replacementTarget, 'untouched replacement', { mode: 0o600 });
    let assertions = 0;
    const lock = { assertHeld(instance) {
        f.lock.assertHeld(instance);
        if (++assertions === 2) {
            fs.unlinkSync(f.identity.anchorPath);
            fs.symlinkSync(replacement, f.identity.anchorPath, 'dir');
        }
    } };
    assert.throws(() => writeGraphSkillScope(f.identity, operation === 'removal' ? null : f.candidateScope, lock), /state directory changed/);
    assert.equal(fs.readFileSync(path.join(f.root, 'linked-state', GRAPH_SKILL_SCOPE_FILE), 'utf8'), original);
    assert.equal(fs.readFileSync(replacementTarget, 'utf8'), 'untouched replacement');
    assert.equal(fs.readdirSync(path.join(f.root, 'linked-state')).some(name => name.endsWith('.tmp')), false);
    assert.equal(fs.readdirSync(replacement).some(name => name.endsWith('.tmp')), false);
});
}

for (const operation of ['start', 'restart', 'update']) {
    for (const launch of ['prior', 'candidate']) {
        test(`${operation} rollback restores the admitted scope when the next launch is ${launch}`, async t => {
            const f = fixture(t);
            assert.equal(readGraphSkillScope(f.identity), null);
            await f.create(f.priorScope.PLOINKY_HOST_LAUNCH_CWD).runStartTransaction(['start', 'fixture']);
            assert.deepEqual(readGraphSkillScope(f.identity), f.priorScope);
            f.state.initial = false; f.state.failAt = 'core'; f.state.calls.length = 0;
            const callerScope = launch === 'prior' ? f.priorScope : f.candidateScope;
            await assert.rejects(activate(f.create(callerScope.PLOINKY_HOST_LAUNCH_CWD), operation), /candidate core failed/);
            assert.deepEqual(f.state.calls[0].scope, callerScope);
            assert.deepEqual(f.state.calls.at(-1).argv, ['start', 'fixture', '8080']);
            assert.deepEqual(f.state.calls.at(-1).scope, f.priorScope);
            assert.deepEqual(readGraphSkillScope(f.identity), f.priorScope);
            assert.equal(f.state.held, false);
        });
    }
}

for (const failure of ['health', 'finalize']) {
    test(`${failure} failure retains the previous admitted scope and restores its graph`, async t => {
        const f = fixture(t);
        await f.create(f.priorScope.PLOINKY_HOST_LAUNCH_CWD).runStartTransaction(['start', 'fixture']);
        f.state.initial = false; f.state.failAt = failure;
        await assert.rejects(f.create(f.candidateScope.PLOINKY_HOST_LAUNCH_CWD).runRestartTransaction(['restart']), new RegExp(`candidate ${failure} failed`));
        assert.deepEqual(f.state.calls.at(-1).scope, f.priorScope);
        assert.deepEqual(readGraphSkillScope(f.identity), f.priorScope);
    });
}

test('successful whole-graph activation advances scope, while update without restart preserves it', async t => {
    const f = fixture(t);
    await f.create(f.priorScope.PLOINKY_HOST_LAUNCH_CWD).runStartTransaction(['start', 'fixture']);
    await f.create(f.candidateScope.PLOINKY_HOST_LAUNCH_CWD).runUpdateTransaction(['update']);
    assert.deepEqual(readGraphSkillScope(f.identity), f.priorScope);
    await f.create(f.candidateScope.PLOINKY_HOST_LAUNCH_CWD).runRestartTransaction(['restart']);
    assert.deepEqual(readGraphSkillScope(f.identity), f.candidateScope);
    assert.equal(fs.statSync(f.target).mode & 0o777, 0o600);
});

test('legacy missing scope allows success but refuses to guess a prior scope on failure', async t => {
    const f = fixture(t);
    f.state.initial = false; f.state.failAt = 'core';
    await assert.rejects(f.create(f.candidateScope.PLOINKY_HOST_LAUNCH_CWD).runRestartTransaction(['restart']), error => {
        assert.equal(error.code, 'PLOINKY_BOX_TRANSACTION_ROLLBACK_FAILED');
        assert.match(error.message, /prior graph has no saved launch scope/);
        assert.match(error.message, /ploinky start AGENT/);
        return true;
    });
    assert.equal(f.state.calls.length, 1, 'No prior graph is started with an inferred workspace-wide or caller scope.');
    assert.equal(readGraphSkillScope(f.identity), null);
    f.state.failAt = '';
    await f.create(f.candidateScope.PLOINKY_HOST_LAUNCH_CWD).runStartTransaction(['start', 'fixture']);
    assert.deepEqual(readGraphSkillScope(f.identity), f.candidateScope);
});

test('malformed or cross-workspace scope fails before graph mutation', async t => {
    const f = fixture(t);
    for (const bytes of ['{', JSON.stringify({ version: 1, instance: 'another-workspace', launchRelativePath: 'prior' })]) {
        fs.writeFileSync(f.target, bytes, { mode: 0o600 });
        await assert.rejects(f.create(f.candidateScope.PLOINKY_HOST_LAUNCH_CWD).runRestartTransaction(['restart']), /saved graph skill scope|Saved graph skill scope/);
        assert.equal(f.state.calls.length, 0);
    }
});

test('saved scope cannot cross links, escape the workspace, or be written without the mutation lock', async t => {
    const f = fixture(t);
    assert.throws(() => writeGraphSkillScope(f.identity, f.priorScope), /mutation lock/);
    for (const relative of ['../outside', '/workspace', 'prior/../candidate', 'prior//nested']) {
        fs.writeFileSync(f.target, JSON.stringify({ version: 1, instance: f.identity.instance, launchRelativePath: relative }), { mode: 0o600 });
        assert.throws(() => readGraphSkillScope(f.identity), /Saved graph skill scope is invalid/);
    }
    fs.unlinkSync(f.target); fs.symlinkSync(path.join(f.root, 'outside-state'), f.target);
    assert.throws(() => readGraphSkillScope(f.identity), /Could not open/);
    fs.unlinkSync(f.target);
    fs.rmdirSync(path.join(f.workspace, 'prior'));
    fs.symlinkSync(path.join(f.workspace, 'candidate'), path.join(f.workspace, 'prior'));
    assert.throws(() => validateGraphSkillScope(f.identity, f.priorScope), /launch directory changed/);
});
