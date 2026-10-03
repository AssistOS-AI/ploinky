import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Mutation-gap regressions for the core `ploinky update` boundary, driven
// through the real core dispatcher in isolated scratch workspaces:
// - an out-of-workspace folder that contains the running Ploinky checkout is
//   rejected before the self-update can touch it;
// - `update repo <name>` and `update all` hold the workspace mutation lease
//   while their Git writes run, so a second writer is refused.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = rel => pathToFileURL(path.join(projectRoot, rel)).href;

const PRELUDE = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const scratch = process.env.PLOINKY_TEST_SCRATCH;
const workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
if (process.env.PLOINKY_TEST_IN_BOX === '1') {
    // Simulate the Box marker for isInsideBoxRuntime() only.
    const originalStat = fs.statSync;
    fs.statSync = (target, options) => (target === '/etc/ploinky-box' ? { isFile: () => true, isDirectory: () => false } : originalStat(target, options));
}
const git = (cwd, ...args) => String(execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
})).trim();
function writeFile(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}
function makeRemote(name, files = { 'a.txt': 'a1\n' }) {
    const remote = path.join(scratch, 'remotes', name + '.git');
    const seed = path.join(scratch, 'remotes', name + '-seed');
    fs.mkdirSync(path.dirname(remote), { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', remote]);
    fs.mkdirSync(seed, { recursive: true });
    git(seed, 'init', '-q', '-b', 'main');
    for (const [rel, content] of Object.entries(files)) writeFile(path.join(seed, rel), content);
    git(seed, 'add', '.');
    git(seed, 'commit', '-q', '-m', 'initial');
    git(seed, 'remote', 'add', 'origin', remote);
    git(seed, 'push', '-q', '-u', 'origin', 'main');
    return { remote, seed };
}
function clone(remote, dest) {
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    execFileSync('git', ['clone', '-q', remote, dest]);
}
function advance(seed, rel = 'a.txt', content = 'a2\n', refspec = null) {
    writeFile(path.join(seed, rel), content);
    git(seed, 'add', rel);
    git(seed, 'commit', '-q', '-m', 'advance ' + rel);
    if (refspec) git(seed, 'push', '-q', 'origin', refspec);
    else git(seed, 'push', '-q');
    return git(seed, 'rev-parse', 'HEAD');
}
function mutations() {
    const file = process.env.PLOINKY_TEST_GIT_TRACE;
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8').split('\n').filter(line => / (?:pull|fetch|merge|clone)(?: |$)/.test(line));
}
async function quiet(operation) {
    const original = { log: console.log, error: console.error, warn: console.warn };
    console.log = console.error = console.warn = () => {};
    try {
        return { value: await operation() };
    } catch (error) {
        return { error: String(error?.message || error), code: error?.code || null };
    } finally {
        Object.assign(console, original);
    }
}
function done(value) {
    process.stdout.write('RESULT:' + JSON.stringify(value) + '\n');
}
`;

function scenarioEnv(scratch, extra = {}) {
    const home = path.join(scratch, 'home');
    const workspaceRoot = path.join(scratch, 'workspace');
    const runtimeRoot = path.join(scratch, 'runtime-root');
    const bin = path.join(scratch, 'bin');
    for (const dir of [home, path.join(workspaceRoot, '.ploinky'), runtimeRoot, bin]) fs.mkdirSync(dir, { recursive: true });
    const globalConfig = path.join(scratch, 'gitconfig');
    fs.writeFileSync(globalConfig, '[user]\n\tname = Ploinky Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n');
    const realGit = String(execFileSync('which', ['git'], { encoding: 'utf8' })).trim();
    fs.writeFileSync(path.join(bin, 'git'), [
        '#!/bin/sh',
        'printf \'%s\\n\' "$*" >> "$PLOINKY_TEST_GIT_TRACE"',
        // Unit fixtures never reach the network.
        'for arg in "$@"; do case "$arg" in http://*|https://*|ssh://*|git@*) echo "network Git access is not allowed in this test: $arg" >&2; exit 97;; esac; done',
        // The trace line is written before the delay, so a contender can
        // observe that a fetch started and is still running.
        'if [ -n "$PLOINKY_TEST_SLOW_FETCH" ]; then for arg in "$@"; do if [ "$arg" = fetch ]; then sleep "$PLOINKY_TEST_SLOW_FETCH"; fi; done; fi',
        `exec "${realGit}" "$@"`,
        '',
    ].join('\n'));
    fs.chmodSync(path.join(bin, 'git'), 0o755);
    const env = {
        ...process.env,
        HOME: home,
        GIT_CONFIG_GLOBAL: globalConfig,
        GIT_CONFIG_NOSYSTEM: '1',
        PATH: `${bin}${path.delimiter}${process.env.PATH}`,
        PLOINKY_TEST_SCRATCH: scratch,
        PLOINKY_TEST_GIT_TRACE: path.join(scratch, 'git-trace.log'),
        PLOINKY_WORKSPACE_ROOT: workspaceRoot,
        PLOINKY_ROOT: runtimeRoot,
        ...extra,
    };
    for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'PLOINKY_UPDATED_WORKSPACE_CHECKOUT',
        'PLOINKY_UPDATE_REPORT_NONCE', 'PLOINKY_UPDATE_REPORT_CONTEXT']) {
        if (!(name in extra)) delete env[name];
    }
    return { env, workspaceRoot };
}

function parseResult(output) {
    const line = String(output).split('\n').find(entry => entry.startsWith('RESULT:'));
    assert.ok(line, `scenario produced a result:\n${output}`);
    return JSON.parse(line.slice('RESULT:'.length));
}

function runScenario(body, extra = {}) {
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-scope-gaps-')));
    try {
        const { env, workspaceRoot } = scenarioEnv(scratch, extra);
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', `${PRELUDE}\n${body}`], {
            cwd: workspaceRoot,
            env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        return parseResult(output);
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

test('an outside folder that contains the running Ploinky checkout is rejected before the self-update touches it', () => {
    const result = runScenario(String.raw`
        const outside = path.join(scratch, 'outside');
        const runtimeRoot = path.join(outside, 'ploinky');
        const { remote, seed } = makeRemote('ploinky');
        clone(remote, runtimeRoot);
        const upstream = advance(seed);
        const before = git(runtimeRoot, 'rev-parse', 'HEAD');
        process.env.PLOINKY_ROOT = runtimeRoot;
        fs.rmSync(process.env.PLOINKY_TEST_GIT_TRACE, { force: true });
        const { handleCommand } = await import(${JSON.stringify(moduleUrl('cli/commands/cli.js'))});
        const outcome = await quiet(() => handleCommand(['update', 'all', outside]));
        const value = outcome.value || {};
        done({ thrown: outcome.error || null, exitCode: value.exitCode, activationAllowed: value.activationAllowed,
            records: (value.records || []).map(record => [record.phase, record.outcome, record.code, record.attempted]),
            upstream, before, after: git(runtimeRoot, 'rev-parse', 'HEAD'), mutations: mutations() });
    `);
    assert.equal(result.thrown, null);
    assert.equal(result.exitCode, 1);
    assert.equal(result.activationAllowed, false);
    assert.deepEqual(result.records, [['command', 'failed', 'PLOINKY_UPDATE_SCOPE_OUTSIDE', false]]);
    assert.notEqual(result.upstream, result.before, 'an update was pending for the in-folder Ploinky checkout');
    assert.equal(result.after, result.before, 'the in-folder Ploinky checkout was not self-updated');
    assert.deepEqual(result.mutations, [], 'no Git fetch, merge, pull or clone ran');
});

// The updater and a contender run as two real processes against one scratch
// workspace. The contender waits until the updater's first fetch has started
// (the fetch is slowed), then tries to take the workspace mutation lease.
async function runWithContender(updaterBody, { targetRepo }) {
    const scratch = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-contender-')));
    try {
        const { env, workspaceRoot } = scenarioEnv(scratch, { PLOINKY_TEST_IN_BOX: '1', PLOINKY_TEST_SLOW_FETCH: '1.5' });
        const leaseFile = path.join(workspaceRoot, '.ploinky', 'running', 'workspace-start.json');
        const ready = path.join(scratch, 'setup-done');
        const updater = `${PRELUDE}\n${updaterBody}`;
        const contender = String.raw`
            import fs from 'node:fs';
            const trace = process.env.PLOINKY_TEST_GIT_TRACE;
            const ready = ${JSON.stringify(ready)};
            const target = ${JSON.stringify(targetRepo)};
            const deadline = Date.now() + 30000;
            const fetching = () => fs.existsSync(ready) && fs.existsSync(trace)
                && fs.readFileSync(trace, 'utf8').split('\n').some(line => / fetch /.test(' ' + line + ' ') && line.includes(target));
            while (!fetching() && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
            if (!fetching()) {
                process.stdout.write('RESULT:' + JSON.stringify({ observedFetch: false }) + '\n');
                process.exit(0);
            }
            let lease = null;
            try { lease = JSON.parse(fs.readFileSync(${JSON.stringify(leaseFile)}, 'utf8')); } catch (_) {}
            const locks = await import(${JSON.stringify(moduleUrl('cli/utils/runtime/maintenanceLocks.js'))});
            let refused = null;
            try {
                const own = locks.createWorkspaceMutationLease({ operation: 'contender' });
                refused = false;
                locks.releaseWorkspaceMutationLease(own);
            } catch (error) { refused = error.code || String(error); }
            process.stdout.write('RESULT:' + JSON.stringify({ observedFetch: true, operation: lease?.operation ?? null, refused }) + '\n');
        `;
        const run = script => new Promise(resolve => {
            const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: workspaceRoot, env, stdio: ['ignore', 'pipe', 'pipe'] });
            let out = '';
            let err = '';
            child.stdout.on('data', chunk => { out += chunk; });
            child.stderr.on('data', chunk => { err += chunk; });
            child.on('close', code => resolve({ code, out, err }));
        });
        const [update, second] = await Promise.all([run(updater), run(contender)]);
        assert.equal(update.code, 0, update.err);
        assert.equal(second.code, 0, second.err);
        return { update: parseResult(update.out), contender: parseResult(second.out), leaseLeft: fs.existsSync(leaseFile) };
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

const REGISTERED_SETUP = String.raw`
    const { REPOS_DIR } = await import(${JSON.stringify(moduleUrl('cli/utils/config.js'))});
    for (const name of ['AchillesCopilotBasicSkills', 'DocumentationSkills', 'PloinkySkills']) {
        const source = makeRemote(name, { ['skills/' + name + '-skill/SKILL.md']: '# ' + name + '\n' });
        clone(source.remote, path.join(REPOS_DIR, name));
    }
    const { remote, seed } = makeRemote('Registered');
    const checkout = path.join(REPOS_DIR, 'Registered');
    clone(remote, checkout);
    const upstream = advance(seed);
    fs.writeFileSync(path.join(scratch, 'setup-done'), '1');
`;

for (const [label, argv] of [
    ['update repo <name>', ['update', 'repo', 'Registered']],
    ['update all', ['update', 'all']],
]) {
    test(`a concurrent second writer is refused while \`${label}\` runs its Git writes`, async () => {
        const { update, contender, leaseLeft } = await runWithContender(String.raw`
            ${REGISTERED_SETUP}
            const { handleCommand } = await import(${JSON.stringify(moduleUrl('cli/commands/cli.js'))});
            const outcome = await quiet(() => handleCommand(${JSON.stringify(argv)}));
            const value = outcome.value || {};
            done({ thrown: outcome.error || null,
                records: (value.records || []).filter(record => record.id === 'Registered' || record.phase === 'command')
                    .map(record => [record.phase, record.id, record.outcome, record.code]),
                upstream, head: git(checkout, 'rev-parse', 'HEAD') });
        `, { targetRepo: 'Registered' });
        assert.equal(update.thrown, null);
        assert.equal(contender.observedFetch, true, 'the contender saw the update fetch start');
        assert.equal(contender.operation, 'update', 'the update held the workspace mutation lease during its fetch');
        assert.equal(contender.refused, 'PLOINKY_WORKSPACE_MUTATION_BUSY', 'a second mutation is refused while the update runs');
        assert.deepEqual(update.records.filter(record => record[0] === 'registered-repository'),
            [['registered-repository', 'Registered', 'changed', 'fast-forward']]);
        assert.equal(update.head, update.upstream);
        assert.equal(leaseLeft, false, 'the update released its lease afterwards');
    });
}
