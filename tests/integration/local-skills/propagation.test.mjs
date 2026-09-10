import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fixture, write, writeSkill, waitFor, deferred, source, roots, RuntimeManager, createAlaEngine,
    createCopilotController, exportPloinky, exportExplorer } from './fixture.mjs';

const selected = (catalog) => catalog.skills.filter((entry) => entry.enabled).map((entry) => entry.name).sort();
const settings = { readAchillesSettings: () => ({}), getCodingAgentModels: () => ({}), getPermissionMode: () => 'ask-for-approval' };
const realPrompts = await source('ala', 'src/anthropic-skills.mjs');
const installation = { ...realPrompts, entryPath: fileURLToPath(new URL('./catalog-consumer.mjs', import.meta.url)),
    discoverCodingAgents: async () => [{ name: 'codex', available: true, binary: process.execPath }] };

test('local edits propagate through a queued existing conversation and both exporters preserve author files', { timeout: 60000 }, async (t) => {
    const f = await fixture(t);
    const localDir = path.join(f.scopeRoot, '.agents/skills/local');
    const original = await writeSkill(localDir, 'local');
    await fs.symlink('.agents', path.join(f.scopeRoot, '.claude'));
    await writeSkill(path.join(f.sibling, '.agents/skills/outside'), 'outside');
    await writeSkill(path.join(f.scopeRoot, 'node_modules/pkg/.agents/skills/dependency'), 'dependency');
    const upstream = path.join(f.root, 'distribution/distributed');
    await writeSkill(upstream, 'distributed');
    const sources = [{ name: 'distributed', path: upstream, source: { name: 'acceptance' } }];
    assert.deepEqual(exportPloinky({ folder: f.scopeRoot, owner: 'manifest', sources }).installed, ['distributed']);
    const exported = path.join(f.scopeRoot, '.agents/skills/distributed');
    const authored = await writeSkill(exported, 'distributed');
    await writeSkill(upstream, 'distributed');
    for (const sync of [exportExplorer, exportPloinky]) {
        const update = sync({ folder: f.scopeRoot, owner: 'manifest', sources });
        assert.ok(update.diagnostics.some((item) => item.reason === 'edited-output-preserved'));
        const removal = sync({ folder: f.scopeRoot, owner: 'manifest', sources: [] });
        assert.ok(removal.diagnostics.some((item) => item.reason === 'edited-output-preserved'));
        assert.match(await fs.readFile(path.join(exported, 'SKILL.md'), 'utf8'), new RegExp(authored.descriptor));
        assert.ok((await fs.lstat(path.join(f.scopeRoot, '.claude'))).isSymbolicLink());
    }
    assert.deepEqual(selected(await f.request()), ['distributed', 'local']);
    t.diagnostic('Bounded launch, contained alias, dependency pruning, and edited exports passed.');

    const controller = Object.assign({ props: { copilotContext: { robot: f.robot.name, sessionId: f.id, dir: f.sibling } },
        state: { copilotItems: [] }, copilotSettingsListEl: { innerHTML: '' } }, createCopilotController(async (agent, name, input) => {
        assert.equal(agent, 'roboTeamAgent');
        assert.equal(input.sessionId, f.id);
        assert.ok(['list_achilles_skills', 'set_achilles_skill_enabled'].includes(name));
        return f.request(input, name === 'set_achilles_skill_enabled');
    }));
    await controller.loadCopilotSettingsData();
    assert.equal(controller.state.copilotItems.filter((item) => item.enabled).length, 2);
    assert.match(controller.copilotSettingsListEl.innerHTML, /Conversation/);
    assert.equal((await f.request()).cwd, f.scopeRoot, 'browser cwd must not replace saved cwd');

    const engine = createAlaEngine({ workingDir: f.scopeRoot, sessionStore: f.sessionStore, skillCatalog: f.catalog,
        settings, installation, interactions: { cancelTurn() {} } });
    f.cleanup.push(() => engine.close());
    const ready = deferred();
    let controls, engineError, captures = 0;
    const realCapture = f.service.live.capture.bind(f.service.live);
    f.service.live.capture = async (...args) => { captures += 1; return realCapture(...args); };
    const manager = new RuntimeManager({ dataDir: f.store.dataDir, workspaceRoot: f.workspaceRoot, skillsets: f.service,
        toolCache: { prepareCodingAgents: async () => ({}) },
        // Replace only the robot-task process launch. The real engine spawns a real
        // child that parses ALA catalog metadata and executes the captured helpers.
        spawnImpl: (_command, args, options) => {
            assert.ok(!args.includes('--skill-catalog'), 'queue launcher must not capture an execution catalog');
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
        return JSON.parse(status.result);
    };
    const firstTask = start('WAIT_FOR_STEERING. Read the current skill files.');
    await ready.promise;
    const active = f.sessionStore.loadSession(f.id).skillExecution;
    assert.equal(captures, 1);
    const secondTask = start('Read the current skill files again.');
    assert.equal(manager.taskStatus(f.robot.id, secondTask.taskId).state, 'queued');
    assert.equal(captures, 1);
    const helperFile = path.join(localDir, 'helper.mjs');
    const before = await fs.stat(helperFile);
    const changed = await writeSkill(localDir, 'local');
    assert.equal((await fs.stat(helperFile)).size, before.size);
    await fs.utimes(helperFile, before.atime, before.mtime);
    await fs.chmod(helperFile, 0o755);
    assert.equal((await f.request()).activeRevision.revision, active.revision);
    assert.equal((await manager.sendTaskMessage(f.robot, firstTask.taskId, 'Finish the active execution.')).delivery, 'delivered');
    const first = await completed(firstTask);
    const second = await completed(secondTask);
    assert.deepEqual(first.before, first.after, 'active steering must retain the initial capture');
    assert.equal(first.before.output.local.descriptor, original.descriptor);
    assert.equal(second.before.output.local.descriptor, changed.descriptor);
    assert.equal(second.before.output.local.helper, `${changed.helper}:${changed.asset}`);
    assert.equal(second.before.output.local.executable, 0o111);
    assert.notEqual(second.before.envelope.revision, first.before.envelope.revision);
    assert.equal(captures, 2);
    assert.deepEqual(second.session, first.session, 'native ID/home/cwd/backend must remain stable');
    assert.equal(second.resumed, true);
    t.diagnostic('Queued edit captured after wait; active steering retained old bytes; native metadata retained.');

    const freshRepo = path.join(f.scopeRoot, 'new-repository');
    await write(path.join(freshRepo, '.git'), 'gitdir: /untracked/worktree-marker\n');
    const newDir = path.join(freshRepo, 'skills/added');
    const added = await writeSkill(newDir, 'added');
    const third = await completed(start('Read the current skill files after the new repository appeared.'));
    assert.deepEqual(Object.keys(third.before.output).sort(), ['added', 'distributed', 'local']);
    assert.equal(third.before.output.added.descriptor, added.descriptor);
    assert.deepEqual(third.session, first.session);
    await controller.loadCopilotSettingsData();
    const addedIndex = controller.state.copilotItems.findIndex((entry) => entry.name === 'added');
    await controller.toggleCopilotSkill(null, String(addedIndex));
    assert.equal((await f.request()).skills.find((entry) => entry.name === 'added').enabled, false);
    const fourth = await completed(start('Read the current skill files after changing the policy.'));
    assert.deepEqual(Object.keys(fourth.before.output).sort(), ['distributed', 'local']);
    t.diagnostic('New descendant repository discovered and Explorer toggle applied to persisted execution policy.');

    await f.catalog.command(f.id, 'use none');
    // Continue the original terminal task after the policy changed. Its stored
    // request predates the explicit empty choice and must not restore old intent.
    const resumed = await manager.resumeTask(f.robot, firstTask.taskId, 'Report the current empty selection.');
    const empty = await completed(resumed);
    assert.deepEqual(empty.before.envelope.entries, []);
    assert.match(empty.before.conveyed, /none; no task skills are selected/);
    assert.deepEqual(empty.session, first.session);
    assert.equal(empty.resumed, true);
    await writeSkill(path.join(f.scopeRoot, '.agents/skills/later'), 'later');
    assert.deepEqual(selected(await f.request()), [], 'new discovery must not undo explicit empty');
    await f.catalog.command(f.id, 'use workspace');
    await fs.rm(path.join(f.scopeRoot, '.agents/skills'), { recursive: true });
    await fs.rm(newDir, { recursive: true });
    const deleted = await completed(start('Report the catalog after all local skills were deleted.'));
    assert.deepEqual(deleted.before.envelope.entries, []);
    assert.match(deleted.before.conveyed, /supersedes earlier catalog messages/);
    assert.deepEqual(deleted.session, first.session);
    assert.equal((await f.request()).activeRevision, null);
    assert.deepEqual(await fs.readdir(path.join(f.root, 'distribution')), ['distributed']);
    t.diagnostic('Terminal continuation used latest explicit empty policy; final deletion conveyed an empty ALA envelope.');
});

for (const change of ['helper', 'asset', 'executable-mode']) {
    test(`isolated ${change} change invalidates the capture without changing SKILL.md`, async (t) => {
        const f = await fixture(t);
        const dir = path.join(f.scopeRoot, '.agents/skills/local');
        await writeSkill(dir, 'local');
        const descriptor = await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8');
        const first = await f.capture();
        await first.release();
        const file = path.join(dir, change === 'asset' ? 'assets/value.txt' : 'helper.mjs');
        const previous = await fs.stat(file);
        if (change === 'executable-mode') await fs.chmod(file, 0o755);
        else {
            const before = await fs.readFile(file, 'utf8');
            const after = change === 'asset' ? before.replace(/[a-f0-9]/, (value) => value === 'a' ? 'b' : 'a')
                : before.replace(/(console\.log\(")([a-f0-9])/, (_match, prefix, value) => prefix + (value === 'a' ? 'b' : 'a'));
            assert.notEqual(after, before);
            assert.equal(Buffer.byteLength(after), previous.size);
            await fs.writeFile(file, after);
            await fs.utimes(file, previous.atime, previous.mtime);
        }
        const next = await f.capture();
        assert.notEqual(next.revision, first.revision);
        assert.equal(await fs.readFile(path.join(dir, 'SKILL.md'), 'utf8'), descriptor);
        assert.equal(await fs.readFile(path.join(first.catalogPath, 'local/SKILL.md'), 'utf8'), descriptor);
    });
}

test('a pinned conversation retains source bytes after deletion and returns to empty in live mode', async (t) => {
    const f = await fixture(t);
    const dir = path.join(f.scopeRoot, '.agents/skills/local');
    const markers = await writeSkill(dir, 'local');
    const first = await f.capture();
    await first.release();
    await f.catalog.command(f.id, 'pin');
    await fs.rm(dir, { recursive: true });
    const pinned = await f.capture();
    assert.equal(pinned.revision, first.revision);
    assert.match(await f.catalog.readSkill('local', f.id), new RegExp(markers.descriptor));
    await pinned.release();
    await f.catalog.command(f.id, 'live');
    assert.deepEqual((await f.capture()).entries, []);
});

test('changing a resolved same-name winner is atomic even when the alternative is rejected', async (t) => {
    const f = await fixture(t);
    await writeSkill(path.join(f.scopeRoot, 'left/.agents/skills/shared'), 'shared');
    await writeSkill(path.join(f.scopeRoot, 'right/.agents/skills/shared'), 'shared');
    let inventory = await f.request();
    const left = inventory.skills.find((item) => item.identity.includes('left/'));
    const right = inventory.skills.find((item) => item.identity.includes('right/'));
    inventory = await f.request({ identity: left.identity, enabled: true, policyVersion: inventory.policyVersion }, true);
    const previous = await f.service.policies.read(f.robot.id, f.id);
    let rejected = false;
    try { await f.request({ identity: right.identity, enabled: true, policyVersion: inventory.policyVersion }, true); }
    catch { rejected = true; }
    if (rejected) assert.deepEqual(await f.service.policies.read(f.robot.id, f.id), previous,
        'a rejected alternative must not persist a conflicting policy');
    const next = await f.request();
    assert.equal(selected(next).length, 1);
    assert.equal((await f.capture()).entries.length, 1);
});

for (const change of ['delete', 'malform']) {
    test(`an individually selected then disabled skill may ${change} without breaking an empty conversation`, async (t) => {
        const f = await fixture(t);
        const dir = path.join(f.scopeRoot, '.agents/skills/optional');
        await writeSkill(dir, 'optional');
        await f.catalog.command(f.id, 'use none');
        let inventory = await f.request();
        const identity = inventory.skills.find((item) => item.name === 'optional').identity;
        inventory = await f.request({ identity, enabled: true, policyVersion: inventory.policyVersion }, true);
        inventory = await f.request({ identity, enabled: false, policyVersion: inventory.policyVersion }, true);
        assert.deepEqual(selected(inventory), []);
        if (change === 'delete') await fs.rm(dir, { recursive: true });
        else await fs.writeFile(path.join(dir, 'SKILL.md'), 'malformed');
        assert.deepEqual(selected(await f.request()), [], 'disabled skill availability cannot block inventory');
        assert.deepEqual((await f.capture()).entries, [], 'disabled skill availability cannot block execution');
    });
}

test('explicit legacy empty selection stays empty after a new untracked skill appears', async (t) => {
    const f = await fixture(t);
    const id = '71c41401-e210-4032-a0ac-dd117cf04675';
    await f.service.policies.ensure(f.robot, id, { legacy: { skillSets: [], skills: [] } });
    await writeSkill(path.join(f.scopeRoot, '.agents/skills/new-local'), 'new-local');
    const capture = await f.service.live.capture(await f.store.get(f.robot.id), id, f.scopeRoot);
    f.cleanup.push(capture.release);
    assert.deepEqual(capture.entries, []);
});
