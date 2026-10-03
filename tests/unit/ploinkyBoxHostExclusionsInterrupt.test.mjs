import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

// After the in-Box update of a host-driven `ploinky update`, the host refreshes
// the Git exclusions the Box deferred. For each folder it holds the folder's
// export lock `.agents/.ploinky-skill-exports.lock` and the common Git
// configuration lock `.git/ploinky-skill-exports-config.lock` as the host
// process, which no in-Box exporter can prove dead; while it applies a Git
// configuration change it also holds Git's own `.git/config.lock`.
//
// Each host run here is one real `update repos` transaction in its own
// process group: the Box supervisor with engine and Box fakes, the real update
// runner exec'ing the real in-Box update command (simulated Box markers, a
// PID-namespace identity of its own), and the real host exclusion refresh of
// the two exported checkouts Alpha and Beta. A Git shim holds the host
// refresh's first Git child in Alpha at the chosen point until released, so
// the signal lands while the host holds Alpha's locks.

const PROJECT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = relative => pathToFileURL(path.join(PROJECT, relative)).href;
const DEFAULT_SOURCES = {
    AchillesCopilotBasicSkills: ['builder'],
    DocumentationSkills: ['specs'],
    PloinkySkills: ['demo', 'other'],
};
const CONFIG_LOCK = 'ploinky-skill-exports-config.lock';
const EXPORT_LOCK = '.ploinky-skill-exports.lock';
const JOURNAL = '.ploinky-skill-exports.journal.json';
const USER_FILES = ['?? .agents/skills/mine/SKILL.md', '?? notes.txt'];

// I014's in-Box writer: the real update command inside a simulated Box run.
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

// The host side of `ploinky update repos` for one workspace.
const hostScript = `
    const fs = (await import('node:fs')).default;
    const path = (await import('node:path')).default;
    const { spawn } = await import('node:child_process');
    const { createBoxSupervisor } = await import(${JSON.stringify(moduleUrl('ploinky-box/supervisor.mjs'))});
    const { runUpdateExec } = await import(${JSON.stringify(moduleUrl('ploinky-box/update/coreRunner.mjs'))});
    const { buildWorkspaceIdentity } = await import(${JSON.stringify(moduleUrl('ploinky-box/identity.mjs'))});
    const { createMutationLockManager } = await import(${JSON.stringify(moduleUrl('ploinky-box/locks.mjs'))});
    const { createUpdateHostState } = await import(${JSON.stringify(moduleUrl('ploinky-box/update/hostState.mjs'))});
    const { agentLibFixture } = await import(${JSON.stringify(moduleUrl('tests/helpers/agentlibFixture.mjs'))});
    const writerScript = ${JSON.stringify(writerScript)};
    const root = process.env.FIXTURE_ROOT;
    const identity = buildWorkspaceIdentity(process.env.FIXTURE_WORKSPACE, { markerFound: true });
    const selection = agentLibFixture(identity.workspaceRoot);
    const containerId = 'b'.repeat(64);
    const ownership = () => ({
        state: 'owned',
        engine: { name: 'podman', identity: 'engine-store' },
        handles: { container: { id: containerId, runtime: { running: true } } },
    });
    const prepared = { action: 'reused', ownership: ownership(), hostPort: 8080, mediaHostPort: 7882, previousAgentLib: selection,
        validate() {}, finalize() {} };
    const writerEnv = { ...process.env };
    for (const key of ['FIXTURE_PARK', 'FIXTURE_PARK_IN', 'FIXTURE_PARK_POINT', 'FIXTURE_RESULT']) delete writerEnv[key];
    const writers = [];
    const liveWriters = () => writers.filter(pid => { try { process.kill(-pid, 0); return true; } catch (_) { return false; } });
    const supervisor = createBoxSupervisor({
        resolveIdentity: () => identity,
        launchCwd: identity.workspaceRoot,
        lockManager: createMutationLockManager({ homeDirectory: root }),
        discover: () => ownership(),
        env: process.env,
        updateHostState: createUpdateHostState({ stateRoot: path.join(root, '.ploinky-box') }),
        runner: {
            run() {},
            query: (_command, args) => (args[0] === 'ps'
                ? { ok: true, stdout: containerId + '\\n' }
                : { ok: true, stdout: JSON.stringify({ initialized: true, routingConfigured: false }) }),
        },
        captureCoreStartArgv: () => ['start', 'agent', '8080'],
        selectAgentLib: async () => ({ selection }),
        reconcile: async () => prepared,
        runUpdateCore: (_engine, _container, coreArgv, _hostPort, _mediaPort, _runner, options) => runUpdateExec({
            command: process.execPath,
            args: ['--input-type=module', '-e', writerScript],
            env: { ...writerEnv, PLOINKY_UPDATE_REPORT_NONCE: options.reportNonce,
                PLOINKY_UPDATE_REPORT_CONTEXT: JSON.stringify(options.reportContext),
                FIXTURE_UPDATE_ARGS: JSON.stringify(coreArgv.slice(1)) },
            nonce: options.reportNonce,
            probeOnSuccess: true,
            stdout: options.stdout,
            stderr: options.stderr,
            probe: () => ({ ok: true, pids: liveWriters() }),
            killInBox: (pids, signal) => { for (const pid of pids) { try { process.kill(-pid, 'SIG' + signal); } catch (_) {} } },
            spawnImpl: (...args) => { const child = spawn(...args); writers.push(child.pid); return child; },
        }),
        resolveHostReachableIpv4: async () => '',
        healthCheck: async () => {},
        revalidateAgentLibSource() {},
        commitAgentLibSelection() {},
        readAgentLibActive: () => null,
        restoreAgentLibActive() {},
    });
    let outcome;
    try {
        const result = await supervisor.runUpdateTransaction(['update', 'repos'], { request: { kind: 'repos' } });
        outcome = { ok: true, exitCode: result.decision.exitCode, records: result.records, warnings: result.warnings };
    } catch (error) {
        outcome = { ok: false, code: error?.code || null, message: error?.message || String(error) };
    }
    fs.writeFileSync(process.env.FIXTURE_RESULT, JSON.stringify(outcome));
    process.exitCode = outcome.ok ? outcome.exitCode : 2;
`;

function createWorkspace(t) {
    const root = fs.realpathSync.native(fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'ploinky-host-exclusions-interrupt-')));
    t.after(() => fs.rmSync(root, { recursive: true, force: true }));
    const gitEnv = {
        PATH: process.env.PATH, HOME: root, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
        GIT_COMMITTER_NAME: 'fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid', GIT_TERMINAL_PROMPT: '0',
    };
    const git = (cwd, ...args) => {
        const result = spawnSync('git', args, { cwd, env: gitEnv, encoding: 'utf8' });
        if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
        return result.stdout.trim();
    };
    const workspace = path.join(root, 'workspace');
    const repos = path.join(workspace, '.ploinky', 'repos');
    const bin = path.join(root, 'bin');
    for (const directory of [repos, bin, path.join(root, 'runtime-root'), path.join(root, 'xdg')]) fs.mkdirSync(directory, { recursive: true });
    // Every default skills source is a local checkout, so nothing is cloned.
    const repositories = { Alpha: { 'file.txt': 'Alpha 1\n' }, Beta: { 'file.txt': 'Beta 1\n' } };
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
    // User content no export or refresh may touch: an untracked file and a user skill.
    const alpha = path.join(repos, 'Alpha');
    const beta = path.join(repos, 'Beta');
    for (const folder of [alpha, beta]) {
        fs.writeFileSync(path.join(folder, 'notes.txt'), 'untracked user notes\n');
        fs.mkdirSync(path.join(folder, '.agents', 'skills', 'mine'), { recursive: true });
        fs.writeFileSync(path.join(folder, '.agents', 'skills', 'mine', 'SKILL.md'), '# mine\n');
    }
    const realGit = spawnSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
    fs.writeFileSync(path.join(bin, 'git'), [
        '#!/bin/sh',
        '# Hold the first Git child of the host refresh in the chosen folder at the chosen point.',
        'park=""',
        'if [ -n "$FIXTURE_PARK" ]; then',
        '  journal="$FIXTURE_PARK_IN/.agents/.ploinky-skill-exports.journal.json"',
        '  case "$FIXTURE_PARK_POINT" in',
        '    locks) [ "$(pwd -P)" = "$FIXTURE_PARK_IN" ] && [ -f .agents/.ploinky-skill-exports.lock/owner.json ] && [ ! -e "$journal" ] && park=1 ;;',
        '    prepared) [ "$(pwd -P)" = "$FIXTURE_PARK_IN" ] && grep -q \'"phase": "prepared"\' "$journal" 2>/dev/null && park=1 ;;',
        '    metadata) case " $* " in *" --replace-all "*) grep -q \'"phase": "metadata"\' "$journal" 2>/dev/null && park=1 ;; esac ;;',
        '  esac',
        'fi',
        'if [ -n "$park" ] && mkdir "$FIXTURE_PARK" 2>/dev/null; then',
        '  echo $$ > "$FIXTURE_PARK/pid.tmp" && mv "$FIXTURE_PARK/pid.tmp" "$FIXTURE_PARK/pid"',
        '  while [ ! -e "$FIXTURE_PARK/release" ]; do sleep 0.05; done',
        'fi',
        `exec ${JSON.stringify(realGit)} "$@"`,
        '',
    ].join('\n'), { mode: 0o755 });
    const before = Object.fromEntries([alpha, beta].map(folder => [folder, git(folder, 'rev-parse', 'HEAD')]));
    return { root, workspace, bin, alpha, beta, git, before, marker: path.join(root, 'parked') };
}

function startHost(t, ws, { run, park = null }) {
    const resultPath = path.join(ws.root, `result-${run}.json`);
    const env = {
        ...process.env,
        PATH: `${ws.bin}${path.delimiter}${process.env.PATH}`,
        HOME: ws.root,
        XDG_CONFIG_HOME: path.join(ws.root, 'xdg'),
        GIT_CONFIG_GLOBAL: '/dev/null',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        PLOINKY_WORKSPACE_ROOT: ws.workspace,
        PLOINKY_ROOT: path.join(ws.root, 'runtime-root'),
        FIXTURE_ROOT: ws.root,
        FIXTURE_WORKSPACE: ws.workspace,
        FIXTURE_BOX_RUN: run,
        FIXTURE_RESULT: resultPath,
        FIXTURE_PARK: park ? ws.marker : '',
        FIXTURE_PARK_IN: park ? ws.alpha : '',
        FIXTURE_PARK_POINT: park || '',
    };
    delete env.NODE_TEST_CONTEXT;
    delete env.PLOINKY_SKILL_EXCLUDES_COMPOSE;
    const child = spawn(process.execPath, ['--input-type=module', '-e', hostScript], {
        cwd: ws.workspace, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let output = '';
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { output += chunk; });
    const exited = new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
    t.after(() => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
    });
    return { child, exited, output: () => output, result: () => JSON.parse(fs.readFileSync(resultPath, 'utf8')) };
}

async function settle(host, timeoutMs = 180_000) {
    const exit = await Promise.race([host.exited, delay(timeoutMs, null, { ref: false })]);
    if (!exit) {
        try { process.kill(-host.child.pid, 'SIGKILL'); } catch (_) {}
        assert.fail(`the host did not stop within ${timeoutMs} ms:\n${host.output()}`);
    }
    return exit;
}

// Signal the host once its refresh holds Alpha's locks at `point`. A released
// Git child then runs on; an interrupted one fails as a real one would.
async function interruptHostRefresh(t, ws, { point, signal, target, release = false }) {
    const host = startHost(t, ws, { run: 'box-run-1', park: point });
    const deadline = Date.now() + 120_000;
    while (!fs.existsSync(path.join(ws.marker, 'pid'))) {
        const exit = await Promise.race([host.exited, delay(20).then(() => null)]);
        if (exit) assert.fail(`the host exited before its refresh reached ${point}: ${JSON.stringify(exit)}\n${host.output()}`);
        if (Date.now() >= deadline) assert.fail(`timed out waiting for the refresh to reach ${point}:\n${host.output()}`);
    }
    const held = leftovers(ws.alpha);
    assert.deepEqual([held.configLock?.pid, held.exportLock?.pid], [host.child.pid, host.child.pid], 'the host refresh holds both locks');
    process.kill(target === 'group' ? -host.child.pid : host.child.pid, signal);
    if (release) {
        await delay(300);
        fs.writeFileSync(path.join(ws.marker, 'release'), '');
    }
    const exit = await settle(host);
    fs.writeFileSync(path.join(ws.marker, 'release'), '');
    return { host, exit, held };
}

async function nextUpdate(t, ws, run) {
    const host = startHost(t, ws, { run });
    const exit = await settle(host);
    const result = host.result();
    assert.equal(result.ok, true, `${result.code} ${result.message}\n${host.output()}`);
    return { exit, result, output: host.output() };
}

const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
function leftovers(folder) {
    const owner = lock => (fs.existsSync(path.join(lock, 'owner.json')) ? readJson(path.join(lock, 'owner.json')) : fs.existsSync(lock) || null);
    const agents = path.join(folder, '.agents');
    return {
        configLock: owner(path.join(folder, '.git', CONFIG_LOCK)),
        exportLock: owner(path.join(agents, EXPORT_LOCK)),
        journal: fs.existsSync(path.join(agents, JOURNAL)) ? readJson(path.join(agents, JOURNAL)).phase : null,
        staging: fs.existsSync(path.join(agents, '.ploinky-export-staging')) ? fs.readdirSync(path.join(agents, '.ploinky-export-staging')) : [],
        quarantine: fs.existsSync(path.join(agents, '.ploinky-export-quarantine')),
        gitLocks: ['index.lock', 'HEAD.lock', 'config.lock', 'config.worktree.lock'].filter(name => fs.existsSync(path.join(folder, '.git', name))),
    };
}
const SETTLED = { configLock: null, exportLock: null, journal: null, staging: [], quarantine: false, gitLocks: [] };

const intentFolders = ws => {
    const directory = path.join(ws.root, '.ploinky-box', 'update-exclusions');
    return fs.existsSync(directory) ? fs.readdirSync(directory).flatMap(name => readJson(path.join(directory, name)).folders) : [];
};
const hostRecords = result => result.records.filter(record => record.id.startsWith('exclusions'))
    .map(record => [record.id.replace(/^(exclusions[^:]*):\.ploinky\/repos\//, '$1:'), record.outcome, record.code]);
const exportRecords = (result, folder) => result.records
    .filter(record => record.phase === 'default-skills' && record.id.endsWith(`->${folder}`));
const cancelled = result => result.records.filter(record => record.phase === 'command' && record.code === 'cancelled');

function assertSettled(ws) {
    for (const folder of [ws.alpha, ws.beta]) {
        assert.deepEqual(leftovers(folder), SETTLED, `${path.basename(folder)} holds no lock, journal, staging or Git lock`);
        assert.deepEqual(ws.git(folder, 'status', '--porcelain', '--untracked-files=all').split('\n').filter(Boolean), USER_FILES,
            `${path.basename(folder)} shows only user files: every export is privately excluded`);
        assert.equal(ws.git(folder, 'rev-parse', 'HEAD'), ws.before[folder]);
        assert.equal(fs.readFileSync(path.join(folder, 'notes.txt'), 'utf8'), 'untracked user notes\n');
        assert.equal(fs.readFileSync(path.join(folder, '.agents', 'skills', 'mine', 'SKILL.md'), 'utf8'), '# mine\n');
    }
    assert.deepEqual(intentFolders(ws), []);
}

test('Ctrl+C in a host refresh applying Git configuration ends the update cancelled without a host or Git lock left', async (t) => {
    const ws = createWorkspace(t);
    const { host, exit, held } = await interruptHostRefresh(t, ws, { point: 'metadata', signal: 'SIGINT', target: 'group' });
    assert.deepEqual(held.gitLocks, ['config.lock'], "the refresh held Git's own configuration lock");
    assert.deepEqual(exit, { code: 1, signal: null }, host.output());
    const first = host.result();
    assert.deepEqual(hostRecords(first), [
        ['exclusions:Alpha', 'uncertain', 'SKILL_EXPORT_RECOVERY_REQUIRED'],
        ['exclusions:Beta', 'skipped', 'cancelled'],
    ]);
    assert.deepEqual(cancelled(first).map(record => [record.outcome, /cancelled by SIGINT/.test(record.reason)]), [['failed', true]]);
    const state = leftovers(ws.alpha);
    assert.deepEqual({ ...state, staging: state.staging.length }, { ...SETTLED, journal: 'metadata', staging: 1 },
        'every lock was released; only the pending transaction and its staging remain for the confined executor');
    assert.deepEqual(leftovers(ws.beta), SETTLED);
    assert.deepEqual(intentFolders(ws), []);

    const next = await nextUpdate(t, ws, 'box-run-2');
    assert.equal(next.exit.code, 0, next.output);
    assert.equal(exportRecords(next.result, 'Alpha')[0].details.recovery?.status, 'rolled-forward',
        'the in-Box export completes the interrupted host transaction');
    assert.deepEqual(hostRecords(next.result), [['exclusions:Alpha', 'unchanged', ''], ['exclusions:Beta', 'changed', '']]);
    assertSettled(ws);
});

test('SIGTERM lets the host refresh finish its folder in progress and skips the rest by name', async (t) => {
    const ws = createWorkspace(t);
    const { host, exit } = await interruptHostRefresh(t, ws, { point: 'locks', signal: 'SIGTERM', target: 'pid', release: true });
    assert.deepEqual(exit, { code: 1, signal: null }, host.output());
    const first = host.result();
    assert.deepEqual(hostRecords(first), [['exclusions:Alpha', 'changed', ''], ['exclusions:Beta', 'skipped', 'cancelled']]);
    assert.deepEqual(cancelled(first).map(record => /cancelled by SIGTERM/.test(record.reason)), [true]);
    for (const folder of [ws.alpha, ws.beta]) assert.deepEqual(leftovers(folder), SETTLED);
    assert.deepEqual(intentFolders(ws), []);

    const next = await nextUpdate(t, ws, 'box-run-2');
    assert.equal(next.exit.code, 0, next.output);
    assert.deepEqual(hostRecords(next.result), [['exclusions:Alpha', 'unchanged', ''], ['exclusions:Beta', 'changed', '']]);
    assertSettled(ws);
});

test('the next update releases the locks of a killed host refresh before its in-Box step and recovers its transaction', async (t) => {
    const ws = createWorkspace(t);
    const { host, exit } = await interruptHostRefresh(t, ws, { point: 'prepared', signal: 'SIGKILL', target: 'pid' });
    assert.equal(exit.signal, 'SIGKILL');
    const stranded = leftovers(ws.alpha);
    for (const lock of [stranded.configLock, stranded.exportLock]) {
        assert.deepEqual([lock.pid, lock.box, lock.authority?.operation], [host.child.pid, null, 'update-exclusions-refresh']);
    }
    assert.equal(stranded.journal, 'prepared');
    assert.deepEqual(intentFolders(ws), [ws.alpha, ws.beta], 'the refresh had recorded its folders in private host state');

    const next = await nextUpdate(t, ws, 'box-run-2');
    assert.equal(next.exit.code, 0, next.output);
    assert.deepEqual(hostRecords(next.result), [
        ['exclusions-recovery:Alpha', 'changed', 'interrupted-refresh-locks-released'],
        ['exclusions:Alpha', 'changed', ''],
        ['exclusions:Beta', 'changed', ''],
    ]);
    assert.ok(next.result.warnings.some(warning => warning.includes(`(pid ${host.child.pid}) ended and released them`)), next.result.warnings.join('\n'));
    assert.deepEqual(exportRecords(next.result, 'Alpha').map(record => [record.outcome, record.code]),
        Object.keys(DEFAULT_SOURCES).map(() => ['unchanged', 'current']));
    assert.equal(exportRecords(next.result, 'Alpha')[0].details.recovery?.status, 'rolled-back');
    assertSettled(ws);
});

test("a host killed while it held Git's config.lock: its own locks are released, Git's lock stays named until the operator removes it", async (t) => {
    const ws = createWorkspace(t);
    const { exit } = await interruptHostRefresh(t, ws, { point: 'metadata', signal: 'SIGKILL', target: 'pid' });
    assert.equal(exit.signal, 'SIGKILL');
    assert.deepEqual(leftovers(ws.alpha).gitLocks, ['config.lock']);

    const blocked = await nextUpdate(t, ws, 'box-run-2');
    assert.equal(blocked.exit.code, 1, blocked.output);
    assert.deepEqual(hostRecords(blocked.result), [
        ['exclusions-recovery:Alpha', 'changed', 'interrupted-refresh-locks-released'],
        ['exclusions:Beta', 'changed', ''],
    ]);
    const exports = exportRecords(blocked.result, 'Alpha');
    assert.deepEqual(exports.map(record => [record.outcome, record.code]),
        Object.keys(DEFAULT_SOURCES).map(() => ['uncertain', 'SKILL_EXPORT_RECOVERY_REQUIRED']));
    assert.match(exports[0].reason, /config\.lock/);
    const state = leftovers(ws.alpha);
    assert.deepEqual([state.configLock, state.exportLock, state.journal, state.gitLocks], [null, null, 'metadata', ['config.lock']],
        "the Ploinky locks are released; the pending transaction and Git's lock are preserved");
    assert.deepEqual(intentFolders(ws), []);

    // The operator removes Git's stale lock, as Git itself instructs.
    fs.rmSync(path.join(ws.alpha, '.git', 'config.lock'));
    const next = await nextUpdate(t, ws, 'box-run-3');
    assert.equal(next.exit.code, 0, next.output);
    assert.equal(exportRecords(next.result, 'Alpha')[0].details.recovery?.status, 'rolled-forward');
    assertSettled(ws);
});
