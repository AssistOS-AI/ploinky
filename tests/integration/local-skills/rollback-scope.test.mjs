import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

const sourceRoot = process.env.SKILLS_TEST_PLOINKY;
if (!sourceRoot || !path.isAbsolute(sourceRoot)) {
    throw new Error('Set SKILLS_TEST_PLOINKY to the absolute Ploinky candidate checkout.');
}
const importSource = relative => import(pathToFileURL(path.join(sourceRoot, relative)).href);
const { createBoxSupervisor } = await importSource('ploinky-box/supervisor.mjs');
const { buildWorkspaceIdentity } = await importSource('ploinky-box/identity.mjs');
const { buildHostSkillScope } = await importSource('ploinky-box/skillScope.mjs');
const { readGraphSkillScope } = await importSource('ploinky-box/graphSkillScope.mjs');
const { agentLibFixture } = await importSource('tests/helpers/agentlibFixture.mjs');
const { fakeRestartCore } = await importSource('tests/helpers/fakeUpdateCore.mjs');
const { fingerprintSource } = await importSource('agentlib/fingerprint.mjs');
const { BOX_LABELS, BOX_ROLES } = await importSource('ploinky-box/constants.mjs');
const { createHostStateGuard } = await importSource('ploinky-box/hostState/guard.mjs');
const { hostStateMaskMount } = await importSource('ploinky-box/hostState/root.mjs');
const { createMutationLockManager } = await importSource('ploinky-box/locks.mjs');
const { allowHostProcessesFromEnv } = await importSource('tests/helpers/allowHostProcesses.mjs');

// The workspace is adopted once, behind the real quiescence gate, as the start
// that created its Box would have done. On a desktop Linux host whose helpers
// hold `/` mounted writable, name them after checking they do not write the
// test workspace: PLOINKY_TEST_ALLOW_HOST_PROCESSES=<pid>[,<pid>...]
// (tests/helpers/allowHostProcesses.mjs; a malformed value fails here).
const allowHostProcesses = allowHostProcessesFromEnv();

// The engine's own listing and inspection forms for the Box containers the
// fixture engine holds; the host-state guard reads them through `runner.query`
// exactly as it reads Podman (engine/discovery.mjs).
function fixtureEngineQuery(identity, containers) {
    const record = (handle) => ({
        Id: handle.id,
        Name: identity.instance,
        State: { Running: handle.runtime.running, Status: handle.runtime.running ? 'running' : 'exited' },
        Config: { Labels: { [BOX_LABELS.role]: BOX_ROLES.container, [BOX_LABELS.pathHash]: identity.pathHash } },
        Mounts: handle.runtime.mounts.map((mount) => ({ Type: 'bind', Source: mount.source, Destination: mount.destination, RW: mount.rw })),
    });
    return (command, args) => {
        assert.equal(command, 'fixture-engine');
        const handles = containers();
        if (args.join(' ') === 'ps --all --no-trunc --format {{.ID}}') {
            return { ok: true, status: 0, stdout: handles.map((handle) => `${handle.id}\n`).join(''), stderr: '' };
        }
        if (args[0] === 'container' && args[1] === 'inspect') {
            const selected = args.slice(2).map((id) => handles.find((handle) => handle.id === id));
            if (selected.some((handle) => !handle)) return { ok: false, status: 125, stdout: '', stderr: 'no such container' };
            return { ok: true, status: 0, stdout: JSON.stringify(selected.map(record)), stderr: '' };
        }
        return { ok: false, status: 125, stdout: '', stderr: `fixture-engine does not answer ${args.join(' ')}` };
    };
}

for (const differentLaunch of [false, true]) {
    test(differentLaunch
        ? 'failed Box replacement restores the prior activation scope when the new caller launches elsewhere'
        : 'failed Box replacement preserves the nested activation scope during rollback', async t => {
        const temporary = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-rollback-scope-')));
        t.after(() => fs.rmSync(temporary, { recursive: true, force: true }));
        const workspace = path.join(temporary, 'workspace');
        const priorLaunch = path.join(workspace, 'project');
        const candidateLaunch = path.join(workspace, differentLaunch ? 'other-project' : 'project');
        for (const directory of [path.join(workspace, '.ploinky'), priorLaunch, candidateLaunch]) fs.mkdirSync(directory, { recursive: true });
        const identity = buildWorkspaceIdentity(workspace, { markerFound: true });
        const expectedScope = buildHostSkillScope(workspace, priorLaunch);
        const callerScope = buildHostSkillScope(workspace, candidateLaunch);
        const priorAgentLib = agentLibFixture(workspace);
        const candidateAgentLib = agentLibFixture(workspace, { sourceRelativePath: '.ploinky/agentlib/candidate' });
        const priorContainer = 'a'.repeat(64);
        const candidateContainer = 'c'.repeat(64);
        const engine = { name: 'fixture-engine', identity: 'fixture-engine' };
        const mask = hostStateMaskMount(workspace);
        // A Box of this Ploinky: the workspace bind plus the read-only host state mask.
        const ownership = id => ({
            state: 'owned', engine,
            handles: { container: { id, runtime: { running: true, mounts: [
                { type: 'bind', source: workspace, destination: workspace, rw: true },
                { type: 'bind', source: mask.source, destination: mask.destination, rw: false },
            ] } } },
        });
        const oldOwnership = ownership(priorContainer);
        let engineContainers = [];
        const query = fixtureEngineQuery(identity, () => engineContainers);
        const seed = await createMutationLockManager().acquire(identity.instance, { workspaceRoot: workspace });
        try {
            createHostStateGuard({ runner: { query }, allowHostProcesses, stderr: null })
                .underLock(identity, seed, { state: 'absent', engine, handles: null });
        } finally {
            seed.release();
        }
        engineContainers = [oldOwnership.handles.container];
        const calls = [];
        let healthChecks = 0;
        let initial = true;
        let acquisitions = 0;
        let held = false;
        const options = {
            checkHostPrerequisites: () => {},
            env: {}, resolveIdentity: () => identity, discover: () => oldOwnership,
            lockManager: {
                async acquire(instance) {
                    const directory = path.join(temporary, `lock-${++acquisitions}`);
                    fs.mkdirSync(directory); held = true;
                    return {
                        path: directory,
                        assertHeld(expected) { assert.equal(expected, instance); assert.equal(held, true); },
                        release() { held = false; },
                    };
                },
            },
            // Engine processes are substituted; graph admission and scope state
            // use the product implementation and a real disposable filesystem.
            runner: { run() { return { status: 0, stdout: '', stderr: '' }; }, query },
            stdout: { write() {} }, stderr: { write() {} }, readEdgeDesired: () => null,
            selectAgentLib: async () => {
                const contract = initial ? priorAgentLib : candidateAgentLib;
                return { selection: { ...contract, sourceId: fingerprintSource(contract.sourceDir).sourceId, contentFingerprint: contract.fingerprint } };
            },
            captureCoreStartArgv: () => ['start', 'fixture-agent', '8080'],
            reconcile: async () => ({
                action: initial ? 'reused' : 'replaced',
                ownership: initial ? oldOwnership : ownership(candidateContainer),
                hostPort: 8080, mediaHostPort: 7882, previousAgentLib: priorAgentLib,
                async rollback() {
                    return {
                        action: 'restored', ownership: oldOwnership, containerId: priorContainer,
                        hostPort: 8080, mediaHostPort: 7882, agentLib: priorAgentLib,
                    };
                },
            }),
            resolveHostReachableIpv4: async () => '',
            async startCore(_engine, containerId, _argv, _host, _media, _runner, coreOptions) {
                assert.equal(held, true);
                assert.equal(containerId, priorContainer);
                assert.deepEqual(coreOptions.skillScopeEnv, expectedScope);
            },
            async runCoreCommand(_engine, containerId, argv, _host, _media, _runner, coreOptions) {
                assert.equal(held, true);
                calls.push({ containerId, argv: [...argv], skillScopeEnv: coreOptions.skillScopeEnv });
                if (containerId === candidateContainer) throw new Error('fixture candidate restart failed');
            },
            healthCheck: async () => { healthChecks += 1; },
            commitAgentLibSelection() { assert.equal(initial, true, 'A failed candidate must not become active.'); },
        };
        // The workspace restart runs through the bounded restart runner.
        options.runRestartCore = fakeRestartCore(options.runCoreCommand);

        await createBoxSupervisor({ ...options, launchCwd: priorLaunch }).runStartTransaction(['start', 'fixture-agent']);
        assert.deepEqual(readGraphSkillScope(identity), expectedScope, 'Successful graph admission persists its trusted launch scope.');
        initial = false; healthChecks = 0;
        const supervisor = createBoxSupervisor({ ...options, launchCwd: candidateLaunch });
        await assert.rejects(supervisor.runRestartTransaction(['restart']), /fixture candidate restart failed/);
        assert.equal(held, false, 'The workspace mutation lock is released.');
        assert.equal(healthChecks, 1, 'The prior graph is restored and health-checked.');
        assert.equal(calls.length, 2);
        assert.equal(calls[0].containerId, candidateContainer);
        assert.deepEqual(calls[0].skillScopeEnv, callerScope, 'Candidate activation receives its own launch scope.');
        assert.equal(calls[1].containerId, priorContainer);
        assert.deepEqual(calls[1].argv, ['start', 'fixture-agent', '8080']);
        assert.deepEqual(calls[1].skillScopeEnv, expectedScope,
            'Rollback must restore the nested scope; absent metadata defaults to the whole workspace.');
        assert.deepEqual(readGraphSkillScope(identity), expectedScope, 'The failed caller cannot overwrite the admitted scope.');
    });
}
