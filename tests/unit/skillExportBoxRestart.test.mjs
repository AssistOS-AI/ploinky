import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { createUpdateReportNonce, readUpdateReport } from '../../cli/commands/updateOutcome.js';

// A host-driven in-Box `ploinky update` exports skills into a folder while it
// holds that folder's two skill-export locks: the common Git configuration
// lock `.git/ploinky-skill-exports-config.lock` and the export lock
// `.agents/.ploinky-skill-exports.lock`. The host SIGKILLs a writer that is
// still inside such a step when its TERM grace ends, for example while the
// writer waits for a Git child. Both locks and the pending export journal then
// outlive that Box run, and only the next host-attested Box run may recover
// them.
//
// Each writer here runs the real update command in its own process group. The
// Box and container markers are simulated for the in-Box checks only, and
// each Box run gets its own PID-namespace identity. A Git shim holds the
// first Git child that runs in the chosen folder while its export lock is
// held, so the SIGKILL lands inside that export. A Box restart or replacement
// is modeled by what the host does then: it retires the stopped Box's
// workspace lease (noWaitCleanup) and nothing else.

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = relative => pathToFileURL(path.join(PROJECT, relative)).href;
const WORKSPACE_INSTANCE = `ploinky-box-fixture-${'f'.repeat(16)}`;
const ENGINE = 'engine-store';
const FIRST_CONTAINER = 'b'.repeat(64);
const REPLACEMENT_CONTAINER = 'c'.repeat(64);
const DEFAULT_SOURCES = {
    AchillesCopilotBasicSkills: ['builder'],
    DocumentationSkills: ['specs'],
    PloinkySkills: ['demo', 'other'],
};
const CONFIG_LOCK = 'ploinky-skill-exports-config.lock';
const EXPORT_LOCK = '.ploinky-skill-exports.lock';
const JOURNAL = '.ploinky-skill-exports.journal.json';
const RECOVERED = { configLock: false, exportLock: false, journal: false, quarantine: false, staging: [], gitLocks: [] };

function createWorkspace(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-export-box-restart-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const gitEnv = {
        PATH: process.env.PATH,
        HOME: root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
        GIT_TERMINAL_PROMPT: '0',
    };
    const git = (cwd, ...args) => {
        const result = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
        return result.stdout.trim();
    };
    const workspace = path.join(root, 'workspace');
    const repos = path.join(workspace, '.ploinky', 'repos');
    const runtimeRoot = path.join(root, 'runtime-root');
    const bin = path.join(root, 'bin');
    for (const directory of [repos, runtimeRoot, bin]) fs.mkdirSync(directory, { recursive: true });
    // Every default skills source is a local checkout, so nothing is cloned.
    const repositories = { Alpha: { 'file.txt': 'Alpha 1\n' } };
    for (const [name, skills] of Object.entries(DEFAULT_SOURCES)) {
        repositories[name] = Object.fromEntries(skills.map(skill => [path.join('skills', skill, 'SKILL.md'), `# ${skill}\n`]));
    }
    for (const [name, files] of Object.entries(repositories)) {
        const seed = path.join(root, `${name}-seed`);
        git(root, 'init', '-q', '-b', 'main', seed);
        for (const [relative, content] of Object.entries(files)) {
            fs.mkdirSync(path.dirname(path.join(seed, relative)), { recursive: true });
            fs.writeFileSync(path.join(seed, relative), content);
        }
        git(seed, 'add', '.');
        git(seed, 'commit', '-qm', 'first');
        git(root, 'clone', '-q', '--bare', seed, path.join(root, `${name}.git`));
        git(root, 'clone', '-q', path.join(root, `${name}.git`), path.join(repos, name));
    }
    // A workspace folder whose manifest selects one PloinkySkills skill.
    const consumer = path.join(workspace, 'consumer');
    git(root, 'init', '-q', '-b', 'main', consumer);
    fs.writeFileSync(path.join(consumer, 'ploinky-skills-manifest.json'),
        `${JSON.stringify([{ name: 'PloinkySkills', url: path.join(root, 'PloinkySkills.git'), skills: ['demo'] }], null, 2)}\n`);
    fs.writeFileSync(path.join(consumer, 'README.md'), '# consumer\n');
    git(consumer, 'add', '.');
    git(consumer, 'commit', '-qm', 'consumer');
    // User content no export may touch: an untracked file and a user skill.
    const alpha = path.join(repos, 'Alpha');
    for (const folder of [alpha, consumer]) {
        fs.writeFileSync(path.join(folder, 'notes.txt'), 'untracked user notes\n');
        fs.mkdirSync(path.join(folder, '.agents', 'skills', 'mine'), { recursive: true });
        fs.writeFileSync(path.join(folder, '.agents', 'skills', 'mine', 'SKILL.md'), '# mine\n');
    }
    const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(bin, 'git'), [
        '#!/bin/sh',
        '# Snapshot the owner records of the export locks held around this Git child.',
        'if [ -n "$FIXTURE_OWNERS" ] && [ -f .agents/.ploinky-skill-exports.lock/owner.json ]; then',
        '  cp .agents/.ploinky-skill-exports.lock/owner.json "$FIXTURE_OWNERS/$$-export.json"',
        '  if [ -f .git/ploinky-skill-exports-config.lock/owner.json ]; then',
        '    cp .git/ploinky-skill-exports-config.lock/owner.json "$FIXTURE_OWNERS/$$-config.json"',
        '  fi',
        'fi',
        'if [ -n "$FIXTURE_PARK" ] && [ "$(pwd -P)" = "$FIXTURE_PARK_IN" ] && [ -f .agents/.ploinky-skill-exports.lock/owner.json ] \\',
        '    && mkdir "$FIXTURE_PARK" 2>/dev/null; then',
        '  echo $$ > "$FIXTURE_PARK/pid"',
        '  exec sleep 600',
        'fi',
        `exec ${JSON.stringify(realGit)} "$@"`,
        '',
    ].join('\n'), { mode: 0o755 });
    const before = Object.fromEntries([alpha, consumer].map(folder => [folder, {
        head: git(folder, 'rev-parse', 'HEAD'),
        config: fs.readFileSync(path.join(folder, '.git', 'config')),
    }]));
    return { root, workspace, runtimeRoot, bin, alpha, consumer, git, before };
}

// The host exec's the update into the exact Box container it names, after
// listing every container of this workspace under its workspace lock.
function hostContext(ws, { containerId, listed = [containerId] }) {
    return {
        schema: 'ploinky-update-context',
        version: 1,
        workspace: { instance: WORKSPACE_INSTANCE, workspaceRoot: ws.workspace },
        box: { containerId, engine: ENGINE, action: 'reused', imageId: null, workspaceContainers: listed },
    };
}

const writerScript = `
    const fs = (await import('node:fs')).default;
    const os = (await import('node:os')).default;
    const statSync = fs.statSync;
    fs.statSync = (target, options) => (target === '/etc/ploinky-box'
        ? { isFile: () => true, isDirectory: () => false }
        : statSync(target, options));
    const existsSync = fs.existsSync;
    fs.existsSync = target => (target === '/run/.containerenv' ? true : existsSync(target));
    const run = process.env.FIXTURE_BOX_RUN;
    const readlinkSync = fs.readlinkSync;
    fs.readlinkSync = (target, options) => (target === '/proc/self/ns/pid' ? 'pid:[' + run + ']' : readlinkSync(target, options));
    os.hostname = () => run;
    const { runUpdateCommand } = await import(${JSON.stringify(moduleUrl('cli/commands/updateCommand.js'))});
    const result = await runUpdateCommand(JSON.parse(process.env.FIXTURE_UPDATE_ARGS));
    process.exitCode = result.exitCode;
`;

function startUpdate(t, ws, { args, run, context, park = null, owners = '' }) {
    const nonce = createUpdateReportNonce();
    const env = {
        ...process.env,
        PATH: `${ws.bin}${path.delimiter}${process.env.PATH}`,
        HOME: ws.root,
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        PLOINKY_WORKSPACE_ROOT: ws.workspace,
        PLOINKY_ROOT: ws.runtimeRoot,
        PLOINKY_UPDATE_REPORT_NONCE: nonce,
        FIXTURE_UPDATE_ARGS: JSON.stringify(args),
        FIXTURE_BOX_RUN: run,
        FIXTURE_PARK: park?.marker || '',
        FIXTURE_PARK_IN: park?.folder || '',
        FIXTURE_OWNERS: owners,
    };
    if (context) env.PLOINKY_UPDATE_REPORT_CONTEXT = JSON.stringify(context);
    else delete env.PLOINKY_UPDATE_REPORT_CONTEXT;
    delete env.NODE_TEST_CONTEXT;
    delete env.PLOINKY_SKILL_EXCLUDES_COMPOSE;
    const child = spawn(process.execPath, ['--input-type=module', '-e', writerScript], {
        cwd: ws.workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    });
    return { child, nonce, context, exited, output: () => output };
}

async function settle(writer, timeoutMs = 120_000) {
    // An unreferenced deadline never keeps the test process alive after the writer exits.
    const exit = await Promise.race([writer.exited, delay(timeoutMs, null, { ref: false })]);
    if (!exit) {
        try { process.kill(-writer.child.pid, 'SIGKILL'); } catch (_) {}
        assert.fail(`the writer did not stop within ${timeoutMs} ms:\n${writer.output()}`);
    }
    return exit;
}

async function waitFor(what, predicate, writer, timeoutMs = 60_000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
        if (predicate()) return;
        const exit = await Promise.race([writer.exited, delay(20).then(() => null)]);
        if (exit) assert.fail(`the writer exited before ${what}: ${JSON.stringify(exit)}\n${writer.output()}`);
        if (Date.now() >= deadline) assert.fail(`timed out waiting for ${what}:\n${writer.output()}`);
    }
}

const lockPaths = folder => [path.join(folder, '.git', CONFIG_LOCK), path.join(folder, '.agents', EXPORT_LOCK)];
const readOwner = lockPath => JSON.parse(fs.readFileSync(path.join(lockPath, 'owner.json'), 'utf8'));

// Run 1 of the Box is SIGKILLed inside its export into `folder`. The Box then
// stops and starts again, or is replaced.
async function killInsideExport(t, ws, { args, folder }) {
    const marker = path.join(ws.root, 'parked');
    const writer = startUpdate(t, ws, { args, run: 'box-run-1', context: hostContext(ws, { containerId: FIRST_CONTAINER }), park: { marker, folder } });
    await waitFor('it waits for a Git child inside the export lock', () => fs.existsSync(path.join(marker, 'pid')), writer);
    process.kill(-writer.child.pid, 'SIGKILL');
    const exit = await settle(writer);
    assert.equal(exit.signal, 'SIGKILL');
    assert.equal(readUpdateReport(path.join(ws.workspace, '.ploinky'), writer.nonce).code, 'report-missing');
    const state = leftovers(folder);
    assert.deepEqual([state.configLock, state.exportLock, state.journal], [true, true, true],
        'both locks and the pending transaction outlive the killed writer');
    const owners = lockPaths(folder).map(readOwner);
    assert.deepEqual(owners.map(owner => owner.pid), [writer.child.pid, writer.child.pid]);
    fs.rmSync(path.join(ws.workspace, '.ploinky', 'running', 'workspace-start.json'), { force: true });
    return { writer, state, owners };
}

function reportRecords(writer, ws) {
    const report = readUpdateReport(path.join(ws.workspace, '.ploinky'), writer.nonce, { expectedContext: writer.context });
    assert.equal(report.ok, true, `${report.code} ${report.reason}\n${writer.output()}`);
    return report.result.records;
}

const alphaRecords = (writer, ws) => reportRecords(writer, ws)
    .filter(record => record.phase === 'default-skills' && record.id.endsWith('->Alpha'));
const consumerRecords = (writer, ws) => reportRecords(writer, ws)
    .filter(record => record.phase === 'skills-manifest' && record.details?.folder
        && fs.realpathSync(record.details.folder) === ws.consumer);

function leftovers(folder) {
    const agents = path.join(folder, '.agents');
    return {
        configLock: fs.existsSync(path.join(folder, '.git', CONFIG_LOCK)),
        exportLock: fs.existsSync(path.join(agents, EXPORT_LOCK)),
        journal: fs.existsSync(path.join(agents, JOURNAL)),
        quarantine: fs.existsSync(path.join(agents, '.ploinky-export-quarantine')),
        staging: fs.existsSync(path.join(agents, '.ploinky-export-staging'))
            ? fs.readdirSync(path.join(agents, '.ploinky-export-staging')) : [],
        gitLocks: ['index.lock', 'HEAD.lock', 'config.lock', 'config.worktree.lock', 'packed-refs.lock']
            .filter(name => fs.existsSync(path.join(folder, '.git', name))),
    };
}

function assertUserStatePreserved(ws, folder) {
    assert.equal(ws.git(folder, 'rev-parse', 'HEAD'), ws.before[folder].head, 'HEAD is unchanged');
    assert.equal(ws.git(folder, 'status', '--porcelain', '--untracked-files=no'), '', 'no tracked file changed');
    assert.ok(fs.readFileSync(path.join(folder, '.git', 'config')).equals(ws.before[folder].config), 'the in-Box writer never changes Git config');
    assert.equal(fs.readFileSync(path.join(folder, 'notes.txt'), 'utf8'), 'untracked user notes\n');
    assert.equal(fs.readFileSync(path.join(folder, '.agents', 'skills', 'mine', 'SKILL.md'), 'utf8'), '# mine\n');
}

function assertExported(ws, folder, expected) {
    const ledger = JSON.parse(fs.readFileSync(path.join(folder, '.agents', '.ploinky-skill-exports.json'), 'utf8'));
    assert.deepEqual(Object.entries(ledger.entries).map(([name, entry]) => [name, entry.owner]).sort(),
        expected.map(([skill, owner]) => [skill, owner]).sort());
    for (const [skill, , source] of expected) {
        assert.equal(fs.realpathSync(path.join(folder, '.agents', 'skills', skill)),
            fs.realpathSync(path.join(ws.workspace, '.ploinky', 'repos', source, 'skills', skill)));
    }
    assert.deepEqual(fs.readdirSync(path.join(folder, '.agents', 'skills')).sort(), [...expected.map(([skill]) => skill), 'mine'].sort(),
        'no other published output');
}

const DEFAULTS_IN_ALPHA = Object.entries(DEFAULT_SOURCES)
    .flatMap(([source, skills]) => skills.map(skill => [skill, `defaults:${source}`, source]));
const BINDING = { workspace: WORKSPACE_INSTANCE, containerId: FIRST_CONTAINER, engine: ENGINE };

test('update repos: export locks a SIGKILLed writer left are recovered after a Box restart only with the host attestation', async (t) => {
    const ws = createWorkspace(t);
    const killed = await killInsideExport(t, ws, { args: ['repos'], folder: ws.alpha });

    // The Box restarts: the same container runs in a new PID namespace. An
    // update without the host's attestation cannot prove the owner dead.
    const unattested = startUpdate(t, ws, {
        args: ['repos'], run: 'box-run-2', context: { schema: 'ploinky-update-context', version: 1, workspace: { instance: WORKSPACE_INSTANCE } },
    });
    await settle(unattested);
    assert.deepEqual(alphaRecords(unattested, ws).map(record => [record.outcome, record.code]),
        Object.keys(DEFAULT_SOURCES).map(() => ['failed', 'SKILL_EXPORT_LOCK_UNKNOWN_OWNER']));
    assert.deepEqual(leftovers(ws.alpha), killed.state, 'an unproven owner keeps both locks and the pending journal');

    // The next host-driven update of the restarted Box holds the attestation.
    const attested = startUpdate(t, ws, { args: ['repos'], run: 'box-run-3', context: hostContext(ws, { containerId: FIRST_CONTAINER }) });
    await settle(attested);
    const records = alphaRecords(attested, ws);
    assert.deepEqual(records.map(record => [record.id, record.outcome, record.code]),
        Object.keys(DEFAULT_SOURCES).map(source => [`${source}->Alpha`, 'changed', 'exported']), attested.output());
    assert.equal(records[0].details.recovery?.status, 'rolled-back', 'the killed transaction is rolled back before the new one publishes');
    assert.deepEqual(leftovers(ws.alpha), RECOVERED);
    assertUserStatePreserved(ws, ws.alpha);
    assertExported(ws, ws.alpha, DEFAULTS_IN_ALPHA);
    for (const owner of killed.owners) assert.deepEqual(owner.box, BINDING, 'the killed owner had recorded the exact Box run it ran in');
});

test('update repos: after a Box replacement only the sole listed container of the workspace recovers the export locks', async (t) => {
    const ws = createWorkspace(t);
    const killed = await killInsideExport(t, ws, { args: ['repos'], folder: ws.alpha });

    // The host still lists the old container: its writer may still run.
    const ambiguous = startUpdate(t, ws, {
        args: ['repos'], run: 'box-run-2',
        context: hostContext(ws, { containerId: REPLACEMENT_CONTAINER, listed: [REPLACEMENT_CONTAINER, FIRST_CONTAINER] }),
    });
    await settle(ambiguous);
    assert.deepEqual(alphaRecords(ambiguous, ws).map(record => record.code),
        Object.keys(DEFAULT_SOURCES).map(() => 'SKILL_EXPORT_LOCK_UNKNOWN_OWNER'));
    assert.deepEqual(leftovers(ws.alpha), killed.state);

    const replaced = startUpdate(t, ws, { args: ['repos'], run: 'box-run-3', context: hostContext(ws, { containerId: REPLACEMENT_CONTAINER }) });
    await settle(replaced);
    const records = alphaRecords(replaced, ws);
    assert.deepEqual(records.map(record => [record.outcome, record.code]),
        Object.keys(DEFAULT_SOURCES).map(() => ['changed', 'exported']), replaced.output());
    assert.equal(records[0].details.recovery?.status, 'rolled-back');
    assert.deepEqual(leftovers(ws.alpha), RECOVERED);
    assertUserStatePreserved(ws, ws.alpha);
    assertExported(ws, ws.alpha, DEFAULTS_IN_ALPHA);
});

for (const [form, args] of [['update all (skills manifest folders)', []], ['update repo (manifest consumers of the source)', ['repo', 'PloinkySkills']]]) {
    test(`${form}: export locks a SIGKILLed writer left in a consumer are recovered by the next attested Box run`, async (t) => {
        const ws = createWorkspace(t);
        const killed = await killInsideExport(t, ws, { args, folder: ws.consumer });
        const attested = startUpdate(t, ws, { args, run: 'box-run-2', context: hostContext(ws, { containerId: FIRST_CONTAINER }) });
        await settle(attested);
        const records = consumerRecords(attested, ws);
        assert.deepEqual(records.map(record => [record.outcome, record.code]), [['changed', 'exported']],
            `${JSON.stringify(records.map(record => [record.outcome, record.code, record.reason]))}\n${attested.output()}`);
        assert.equal(records[0].details.recovery?.status, 'rolled-back');
        assert.deepEqual(leftovers(ws.consumer), RECOVERED);
        assertUserStatePreserved(ws, ws.consumer);
        assertExported(ws, ws.consumer, [['demo', 'manifest', 'PloinkySkills']]);
        for (const owner of killed.owners) assert.deepEqual(owner.box, BINDING);
    });
}

// Every export of the update binds both of its locks: default skills, skills
// manifest folders and the manifest consumers of an updated source.
for (const [form, args, exported] of [
    ['update repos', ['repos'], ws => [ws.alpha]],
    ['update all', [], ws => [ws.alpha, ws.consumer]],
    ['update repo Alpha', ['repo', 'Alpha'], ws => [ws.alpha]],
    ['update repo PloinkySkills', ['repo', 'PloinkySkills'], ws => [ws.consumer]],
]) {
    test(`${form}: every skill-export lock the in-Box update takes records the attested Box run`, async (t) => {
        const ws = createWorkspace(t);
        const owners = path.join(ws.root, 'owners');
        fs.mkdirSync(owners);
        const writer = startUpdate(t, ws, { args, run: 'box-run-1', context: hostContext(ws, { containerId: FIRST_CONTAINER }), owners });
        await settle(writer);
        reportRecords(writer, ws);
        const snapshots = fs.readdirSync(owners).map(name => [name.endsWith('-config.json') ? 'config' : 'export',
            JSON.parse(fs.readFileSync(path.join(owners, name), 'utf8'))]);
        const heldBy = kind => [...new Set(snapshots.filter(([held]) => held === kind).map(([, owner]) => owner.folder))].sort();
        assert.deepEqual(heldBy('export'), exported(ws).sort(), writer.output());
        assert.deepEqual(heldBy('config'), exported(ws).map(folder => path.join(folder, '.git')).sort());
        for (const [kind, owner] of snapshots) {
            assert.equal(owner.pid, writer.child.pid);
            assert.deepEqual(owner.box, BINDING, `${kind} lock of ${owner.folder}`);
        }
    });
}
