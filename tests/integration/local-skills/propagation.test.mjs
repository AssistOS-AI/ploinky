import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixture, write, writeSkill, waitFor, deferred, source, RuntimeManager, createAlaEngine,
    exportPloinky, exportExplorer } from './fixture.mjs';

// The skills the user selected, without the human-report skill that RoboTeam always adds.
const selected = (catalog) => catalog.skills.filter((entry) => entry.enabled && !entry.required).map((entry) => entry.name).sort();
// The links RoboTeam published for one execution, as the native backend sees them.
const linked = (view) => Object.entries(view.output).filter(([, entry]) => entry.link).map(([name]) => name).sort();
const settings = { readAchillesSettings: () => ({}), getCodingAgentModels: () => ({}), getPermissionMode: () => 'ask-for-approval' };
const { INITIAL_SKILL_INSTRUCTIONS, HUMAN_REPORT_INSTRUCTIONS } = await source('achilles', 'roboTeamAgent/copilot/src/lib/prompts.mjs');
const installation = { entryPath: fileURLToPath(new URL('./native-skill-consumer.mjs', import.meta.url)),
    discoverCodingAgents: async () => [{ name: 'codex', available: true, binary: process.execPath }] };

test('local edits propagate through a queued existing conversation and both exporters preserve author files', { timeout: 60000 }, async (t) => {
    const f = await fixture(t);
    const localRepo = path.join(f.scopeRoot, 'local-skills');
    const localDir = path.join(localRepo, 'skills/local');
    const original = await writeSkill(localDir, 'local');
    await fs.symlink('.agents', path.join(f.scopeRoot, '.claude'));
    // RoboTeam never scans the workspace: a registered sibling repository outside the launch scope, an unregistered
    // authoring skill, and a dependency tree inside the registered repository must all stay out of the selection.
    await writeSkill(path.join(f.sibling, 'outside-skills/skills/outside'), 'outside');
    await f.register('outside-skills', path.join(f.sibling, 'outside-skills'));
    await writeSkill(path.join(f.scopeRoot, '.agents/skills/authoring'), 'authoring');
    await writeSkill(path.join(localRepo, 'node_modules/pkg/.agents/skills/dependency'), 'dependency');
    // Ploinky now exports a managed skill only as a link to its source. An author who retargets the link keeps their
    // output through update and removal, and neither the author's files nor the upstream source change.
    const linkedUpstream = path.join(f.root, 'distribution/linked');
    await writeSkill(linkedUpstream, 'linked');
    const linkedSources = [{ name: 'linked', path: linkedUpstream, source: { name: 'acceptance' } }];
    const exportFolder = path.join(f.workspaceRoot, 'export-launch');
    await fs.mkdir(exportFolder);
    assert.deepEqual(exportPloinky({ folder: exportFolder, owner: 'manifest', sources: linkedSources }).installed, ['linked']);
    const linkedOutput = path.join(exportFolder, '.agents/skills/linked');
    assert.ok((await fs.lstat(linkedOutput)).isSymbolicLink());
    const retargeted = path.join(f.root, 'authored-link-target');
    const mine = await writeSkill(retargeted, 'linked');
    await fs.unlink(linkedOutput);
    await fs.symlink(retargeted, linkedOutput);
    for (const sources of [linkedSources, []]) {
        const result = exportPloinky({ folder: exportFolder, owner: 'manifest', sources });
        assert.ok(result.diagnostics.some((item) => item.reason === 'edited-output-preserved'));
        assert.equal(await fs.readlink(linkedOutput), retargeted);
        assert.match(await fs.readFile(path.join(retargeted, 'SKILL.md'), 'utf8'), new RegExp(mine.descriptor));
    }
    // Explorer keeps a compatibility export that publishes a copy. A locally edited copy is preserved the same way.
    const upstream = path.join(f.root, 'distribution/distributed');
    await writeSkill(upstream, 'distributed');
    const sources = [{ name: 'distributed', path: upstream, source: { name: 'acceptance' } }];
    assert.deepEqual(exportExplorer({ folder: f.scopeRoot, owner: 'manifest', sources }).installed, ['distributed']);
    const exported = path.join(f.scopeRoot, '.agents/skills/distributed');
    assert.ok(!(await fs.lstat(exported)).isSymbolicLink());
    const authored = await writeSkill(exported, 'distributed');
    await writeSkill(upstream, 'distributed');
    for (const next of [sources, []]) {
        const result = exportExplorer({ folder: f.scopeRoot, owner: 'manifest', sources: next });
        assert.ok(result.diagnostics.some((item) => item.reason === 'edited-output-preserved'));
        assert.match(await fs.readFile(path.join(exported, 'SKILL.md'), 'utf8'), new RegExp(authored.descriptor));
        assert.ok((await fs.lstat(path.join(f.scopeRoot, '.claude'))).isSymbolicLink());
    }
    await f.useSources({ 'local-skills': localRepo });
    const inventory = await f.request();
    assert.deepEqual(selected(inventory), ['local']);
    assert.ok(inventory.skills.some((entry) => entry.name === 'human-report' && entry.required && entry.enabled));
    assert.deepEqual(inventory.skills.map((entry) => entry.name).sort(), ['human-report', 'local'],
        'sibling, unregistered, exported and dependency skills are not part of the inventory');
    await assert.rejects(f.request({ identity: 'outside-skills/outside', enabled: true, policyVersion: inventory.policyVersion }, true),
        /unavailable/, 'a repository outside the launch scope cannot be selected');
    t.diagnostic('Bounded launch, contained alias, dependency pruning, and edited exports passed.');

    // Conversation skill settings: the WebChat action's robot and session context drive the declared list/set tools.
    const skillSettings = f.settings;
    assert.deepEqual(skillSettings.context, { robot: f.robot.name, sessionId: f.id });
    await skillSettings.load();
    assert.deepEqual(skillSettings.items.filter((item) => item.enabled).map((item) => item.name).sort(), ['human-report', 'local']);
    assert.equal(skillSettings.scope, 'conversation');
    assert.equal((await f.request()).cwd, f.scopeRoot, 'browser cwd must not replace saved cwd');
    assert.equal((await skillSettings.load({ dir: f.sibling })).cwd, f.scopeRoot, 'a browser folder hint must not replace the saved cwd');

    const engine = createAlaEngine({ workingDir: f.scopeRoot, sessionStore: f.sessionStore, skillCatalog: f.catalog,
        settings, installation, interactions: { cancelTurn() {} }, execution: { robotId: f.robot.id } });
    f.cleanup.push(() => engine.close());
    const ready = deferred();
    let controls, engineError;
    const manager = new RuntimeManager({ dataDir: f.store.dataDir, workspaceRoot: f.workspaceRoot, skillsets: f.service,
        toolCache: { prepareCodingAgents: async () => ({}) },
        // Replace only the robot-task process launch. The real engine spawns a child that parses its command line with
        // the real ALA argument parser, then reads and executes the skills RoboTeam linked for the execution.
        spawnImpl: (_command, args, options) => {
            assert.ok(!args.includes('--skill-catalog'), 'queue launcher must not forward a skill catalog');
            assert.ok(args.includes('--resume-session'), 'the pre-existing conversation must use the real bootstrap resume flag');
            assert.equal(options.env.ROBOTEAM_TASK_SKILL_SELECTION, undefined);
            const get = (flag) => args[args.indexOf(flag) + 1];
            const child = new EventEmitter();
            child.stdout = new PassThrough(); child.stderr = new PassThrough(); child.stdin = new PassThrough();
            child.kill = () => true;
            child.stdin.on('data', (chunk) => controls(JSON.parse(chunk.toString())));
            queueMicrotask(() => void fs.readFile(get('--taskFile'), 'utf8').then((prompt) => engine.executeTurn({
                sessionId: get('--session-id'), prompt, onControl: (send) => { controls = send; }, onEvent: (event) => {
                    child.stderr.write(`@@ALA_EVENT@@${JSON.stringify(event)}\n`);
                    if (event.type === 'session-ready') ready.resolve();
                },
            })).then((result) => { child.stdout.write(result.outputText); child.emit('close', 0, null); })
                .catch((error) => { engineError = error; child.emit('error', error); }));
            return child;
        } });
    f.cleanup.push(() => manager.stopAll());
    manager.ensureContainer = async () => ({ mcpPort: 18100 });
    const start = (task) => manager.startTask(f.robot, 'desktop', { cwd: f.scopeRoot, task, ca: 'codex',
        alaSessionId: f.id, skillPolicyRef: f.id, resumeSession: true });
    const completed = async (task) => {
        const status = await waitFor(() => {
            const row = manager.taskStatus(f.robot.id, task.taskId);
            return ['completed', 'failed'].includes(row.state) && row;
        }, 'task completion');
        if (engineError) throw engineError;
        assert.equal(status.state, 'completed', status.error);
        return { ...JSON.parse(status.result), task: status };
    };
    const firstTask = start('WAIT_FOR_STEERING. Read the current skill files.');
    await ready.promise;
    assert.equal(f.installs.count, 1);
    // The conversation reports the revision applied to its execution. activeRevision is not asserted: the catalog API
    // derives it from capture leases, which a live-link execution never creates, so it stays null while running.
    const applied = f.sessionStore.loadSession(f.id).skillExecution;
    assert.equal(applied.active, true);
    assert.equal((await f.request()).lastRevision, applied.revision);
    const secondTask = start('Read the current skill files again.');
    assert.equal(manager.taskStatus(f.robot.id, secondTask.taskId).state, 'queued');
    assert.equal(f.installs.count, 1, 'queueing must not prepare links before the execution boundary');
    const helperFile = path.join(localDir, 'helper.mjs');
    const before = await fs.stat(helperFile);
    const changed = await writeSkill(localDir, 'local');
    assert.equal((await fs.stat(helperFile)).size, before.size);
    await fs.utimes(helperFile, before.atime, before.mtime);
    await fs.chmod(helperFile, 0o755);
    assert.equal((await manager.sendTaskMessage(f.robot, firstTask.taskId, 'Finish the active execution.')).delivery, 'delivered');
    const first = await completed(firstTask);
    const second = await completed(secondTask);
    // The skills are live links to the source, so an edit is visible to the active execution as well as to the next one.
    assert.equal(first.before.output.local.descriptor, original.descriptor);
    assert.equal(first.after.output.local.descriptor, changed.descriptor, 'a live link shows the edit to the active execution');
    assert.equal(first.after.output.local.helper, `${changed.helper}:${changed.asset}`);
    assert.equal(first.before.output.local.link, await fs.realpath(localDir), 'the skill must be a link to the live source, not a copy');
    assert.deepEqual(linked(first.before), ['human-report', 'local']);
    assert.equal(second.before.output.local.descriptor, changed.descriptor);
    assert.equal(second.before.output.local.helper, `${changed.helper}:${changed.asset}`);
    assert.equal(second.before.output.local.executable, 0o111);
    assert.equal(second.task.skillExecution.revision, first.task.skillExecution.revision,
        'the execution revision identifies the installed link set, not file bytes');
    assert.equal(f.installs.count, 2);
    assert.ok(first.prompt.includes(INITIAL_SKILL_INSTRUCTIONS) && first.prompt.includes(HUMAN_REPORT_INSTRUCTIONS));
    assert.ok(!second.prompt.includes(INITIAL_SKILL_INSTRUCTIONS) && second.prompt.includes(HUMAN_REPORT_INSTRUCTIONS));
    assert.deepEqual(second.session, first.session, 'native ID/home/cwd/backend must remain stable');
    assert.equal(second.resumed, true);
    t.diagnostic('Queued edit reached the second execution and the live active one; native metadata retained.');

    // A repository is part of the selection only after it is registered. A skill added inside a registered
    // repository is discovered live, with no commit, update or import.
    const freshRepo = path.join(f.scopeRoot, 'new-repository');
    await write(path.join(freshRepo, '.git'), 'gitdir: /untracked/worktree-marker\n');
    await writeSkill(path.join(freshRepo, 'skills/unregistered'), 'unregistered');
    const newDir = path.join(localRepo, 'skills/added');
    const added = await writeSkill(newDir, 'added');
    const third = await completed(start('Read the current skill files after the new skill appeared.'));
    // The native backend also sees the unmanaged authoring skill and the exported copy; only RoboTeam's links are managed.
    assert.deepEqual(Object.keys(third.before.output).sort(), ['added', 'authoring', 'distributed', 'human-report', 'local']);
    assert.deepEqual(linked(third.before), ['added', 'human-report', 'local']);
    assert.equal(third.before.output.added.descriptor, added.descriptor);
    assert.deepEqual(third.session, first.session);
    await skillSettings.load();
    const addedIdentity = 'local-skills/added';
    assert.equal(skillSettings.items.find((entry) => entry.identity === addedIdentity).enabled, true);
    await skillSettings.toggle(addedIdentity);
    assert.equal(skillSettings.items.find((entry) => entry.identity === addedIdentity).enabled, false);
    const persisted = await f.request();
    assert.equal(persisted.skills.find((entry) => entry.name === 'added').enabled, false);
    assert.ok(persisted.policy.excludedSkills.includes(addedIdentity), 'the toggle must persist the exclusion in the session policy');
    assert.equal(persisted.policyVersion, skillSettings.policyVersion);
    const fourth = await completed(start('Read the current skill files after changing the policy.'));
    assert.deepEqual(linked(fourth.before), ['human-report', 'local']);
    assert.deepEqual(Object.keys(fourth.before.output).sort(), ['authoring', 'distributed', 'human-report', 'local']);
    t.diagnostic('New skill discovered in the registered repository and settings toggle applied to persisted execution policy.');

    // Deselect every skill through the settings tool, then continue the older terminal task.
    await skillSettings.load();
    for (const item of skillSettings.items.filter((entry) => entry.enabled && !entry.required)) await skillSettings.toggle(item.identity);
    assert.deepEqual(selected(await f.request()), []);
    // Continue the original terminal task after the policy changed. Its stored request predates the empty choice.
    const resumed = await manager.resumeTask(f.robot, firstTask.taskId, 'Report the current empty selection.');
    const empty = await completed(resumed);
    assert.deepEqual(linked(empty.before), ['human-report']);
    assert.deepEqual(empty.session, first.session);
    assert.equal(empty.resumed, true);
    await writeSkill(path.join(f.scopeRoot, 'later-skills/skills/later'), 'later');
    await f.register('later-skills', path.join(f.scopeRoot, 'later-skills'));
    assert.deepEqual(selected(await f.request()), [], 'a newly registered source must not undo the deselection');
    await skillSettings.load();
    await skillSettings.toggle('local-skills/local');
    await fs.rm(path.join(f.scopeRoot, '.agents/skills'), { recursive: true });
    await fs.rm(path.join(localRepo, 'skills'), { recursive: true });
    const deleted = await completed(start('Report the catalog after all local skills were deleted.'));
    assert.deepEqual(Object.keys(deleted.before.output), ['human-report']);
    assert.deepEqual(linked(deleted.before), ['human-report']);
    assert.ok(deleted.prompt.includes(HUMAN_REPORT_INSTRUCTIONS));
    assert.deepEqual(deleted.session, first.session);
    assert.deepEqual(selected(await f.request()), []);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'distribution')), ['distributed', 'linked']);
    t.diagnostic('Terminal continuation used the latest deselection; final deletion left only the required skill.');
});

for (const change of ['helper', 'asset', 'executable-mode']) {
    test(`isolated ${change} change reaches the live link without changing SKILL.md`, async (t) => {
        const f = await fixture(t);
        const repo = path.join(f.scopeRoot, 'local-skills');
        const dir = path.join(repo, 'skills/local');
        await writeSkill(dir, 'local');
        await f.useSources({ 'local-skills': repo });
        const descriptor = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
        const first = await f.capture();
        const link = path.join(f.scopeRoot, '.agents/skills/local');
        assert.ok((await fs.lstat(link)).isSymbolicLink(), 'the execution must link the live source');
        assert.equal(await fs.realpath(link), await fs.realpath(dir));
        const name = change === 'asset' ? 'assets/value.txt' : 'helper.mjs';
        const file = path.join(dir, name);
        const previous = await fs.stat(file);
        const read = (target) => fs.readFile(path.join(link, name), 'utf8');
        const unchanged = await read();
        if (change === 'executable-mode') await fs.chmod(file, 0o755);
        else {
            const after = change === 'asset' ? unchanged.replace(/[a-f0-9]/, (value) => value === 'a' ? 'b' : 'a')
                : unchanged.replace(/(console\.log\(")([a-f0-9])/, (_match, prefix, value) => prefix + (value === 'a' ? 'b' : 'a'));
            assert.notEqual(after, unchanged);
            assert.equal(Buffer.byteLength(after), previous.size);
            await fs.writeFile(file, after);
            await fs.utimes(file, previous.atime, previous.mtime);
        }
        // Same size and restored mtime: only a live link, never a stat-keyed copy, shows the change at once.
        if (change === 'executable-mode') assert.equal((await fs.stat(path.join(link, name))).mode & 0o111, 0o111);
        else assert.notEqual(await read(), unchanged);
        assert.equal(f.installs.count, 1, 'no new installation is needed for the edit to be visible');
        assert.equal(await fs.readFile(path.join(link, 'SKILL.md'), 'utf8'), descriptor);
        const next = await f.capture();
        assert.equal(next.revision, first.revision, 'the revision identifies the link set; edits do not change it');
        assert.equal(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8'), descriptor);
    });
}

test('a deleted live source is unlinked on the next execution and only the required skill remains', async (t) => {
    const f = await fixture(t);
    const repo = path.join(f.scopeRoot, 'local-skills');
    const dir = path.join(repo, 'skills/local');
    const markers = await writeSkill(dir, 'local');
    await f.useSources({ 'local-skills': repo });
    const first = await f.capture();
    assert.deepEqual(first.entries.map((entry) => entry.name).sort(), ['human-report', 'local']);
    assert.match(await fs.readFile(path.join(f.scopeRoot, '.agents/skills/local/SKILL.md'), 'utf8'), new RegExp(markers.descriptor));
    await fs.rm(dir, { recursive: true });
    const next = await f.capture();
    assert.deepEqual(next.entries.map((entry) => entry.name), ['human-report']);
    assert.notEqual(next.revision, first.revision);
    await assert.rejects(fs.lstat(path.join(f.scopeRoot, '.agents/skills/local')), { code: 'ENOENT' });
    assert.deepEqual(await fs.readdir(path.join(f.scopeRoot, '.agents/skills')), ['human-report']);
    assert.equal(f.installs.removals, 1);
});

test('changing a resolved same-name winner is atomic even when the alternative is rejected', async (t) => {
    const f = await fixture(t);
    await writeSkill(path.join(f.scopeRoot, 'left/skills/shared'), 'shared');
    await writeSkill(path.join(f.scopeRoot, 'right/skills/shared'), 'shared');
    await f.useSources({ 'left-skills': path.join(f.scopeRoot, 'left'), 'right-skills': path.join(f.scopeRoot, 'right') },
        { skillSets: [], skills: [] });
    let inventory = await f.request();
    const left = inventory.skills.find((item) => item.identity.startsWith('left-skills/'));
    const right = inventory.skills.find((item) => item.identity.startsWith('right-skills/'));
    inventory = await f.request({ identity: left.identity, enabled: true, policyVersion: inventory.policyVersion }, true);
    const previous = await f.service.policies.read(f.robot.id, f.id);
    let rejected = false;
    try { await f.request({ identity: right.identity, enabled: true, policyVersion: inventory.policyVersion }, true); }
    catch { rejected = true; }
    if (rejected) assert.deepEqual(await f.service.policies.read(f.robot.id, f.id), previous,
        'a rejected alternative must not persist a conflicting policy');
    const next = await f.request();
    assert.equal(selected(next).length, 1);
    assert.equal((await f.capture()).entries.filter((entry) => !entry.required).length, 1);
});

for (const change of ['delete', 'malform']) {
    test(`an individually selected then disabled skill may ${change} without breaking an empty conversation`, async (t) => {
        const f = await fixture(t);
        const repo = path.join(f.scopeRoot, 'optional-skills');
        const dir = path.join(repo, 'skills/optional');
        await writeSkill(dir, 'optional');
        await f.useSources({ 'optional-skills': repo }, { skillSets: [], skills: [] });
        let inventory = await f.request();
        const identity = inventory.skills.find((item) => item.name === 'optional').identity;
        inventory = await f.request({ identity, enabled: true, policyVersion: inventory.policyVersion }, true);
        assert.deepEqual(selected(inventory), ['optional']);
        inventory = await f.request({ identity, enabled: false, policyVersion: inventory.policyVersion }, true);
        assert.deepEqual(selected(inventory), []);
        if (change === 'delete') await fs.rm(dir, { recursive: true });
        else await fs.writeFile(path.join(dir, 'SKILL.md'), 'malformed');
        assert.deepEqual(selected(await f.request()), [], 'disabled skill availability cannot block inventory');
        assert.deepEqual((await f.capture()).entries.filter((entry) => !entry.required), [], 'disabled skill availability cannot block execution');
    });
}

test('explicit legacy empty selection stays empty after a new untracked skill appears', async (t) => {
    const f = await fixture(t);
    const repo = path.join(f.scopeRoot, 'new-skills');
    await writeSkill(path.join(repo, 'skills/existing'), 'existing');
    await f.register('new-skills', repo);
    // An older conversation record that stored an explicit empty selection migrates through the catalog's policy lookup.
    const legacy = await f.sessionStore.createSession({ select: false });
    await f.sessionStore.updateSession(legacy.sessionId, (session) => { session.skillSelection = { skillSets: [], skills: [] }; });
    await writeSkill(path.join(repo, 'skills/new-local'), 'new-local');
    const capture = await f.catalog.refresh(legacy.sessionId, { execution: true });
    f.cleanup.push(capture.release);
    assert.deepEqual(capture.entries.filter((entry) => !entry.required), []);
    const migrated = f.sessionStore.loadSession(legacy.sessionId);
    assert.deepEqual(migrated.legacySkillSelection, { skillSets: [], skills: [] });
    assert.equal(migrated.skillSelection, undefined);
    assert.deepEqual(await fs.readdir(path.join(f.scopeRoot, '.agents/skills')), ['human-report']);
});
