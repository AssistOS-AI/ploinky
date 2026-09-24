import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Core `ploinky update` request parsing, scope validation and the operation
// set, driven through the real core dispatcher in an isolated workspace.

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const moduleUrl = rel => pathToFileURL(path.join(projectRoot, rel)).href;

const PRELUDE = String.raw`
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const scratch = process.env.PLOINKY_TEST_SCRATCH;
const workspaceRoot = process.env.PLOINKY_WORKSPACE_ROOT;
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

function runScenario(body) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-operation-set-'));
    try {
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
            // Unit fixtures never reach the network (for example a default
            // skills source that would otherwise be cloned from its URL).
            'for arg in "$@"; do case "$arg" in http://*|https://*|ssh://*|git@*) echo "network Git access is not allowed in this test: $arg" >&2; exit 97;; esac; done',
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
        };
        for (const name of ['GIT_DIR', 'GIT_WORK_TREE', 'GIT_INDEX_FILE', 'PLOINKY_UPDATED_WORKSPACE_CHECKOUT']) delete env[name];
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', `${PRELUDE}\n${body}`], {
            cwd: workspaceRoot,
            env,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
        });
        const line = output.split('\n').find(entry => entry.startsWith('RESULT:'));
        assert.ok(line, `scenario produced a result:\n${output}`);
        return JSON.parse(line.slice('RESULT:'.length));
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

test('malformed or out-of-workspace update forms are rejected before any Git mutation, including self-update', () => {
    const result = runScenario(String.raw`
        // The running Ploinky checkout is a real Git checkout with an update pending.
        const runtimeRoot = process.env.PLOINKY_ROOT;
        const { remote, seed } = makeRemote('ploinky');
        fs.rmSync(runtimeRoot, { recursive: true, force: true });
        clone(remote, runtimeRoot);
        advance(seed);
        const before = git(runtimeRoot, 'rev-parse', 'HEAD');
        const outside = path.join(scratch, 'outside');
        fs.mkdirSync(outside);
        fs.rmSync(process.env.PLOINKY_TEST_GIT_TRACE, { force: true });
        const { handleCommand } = await import(${JSON.stringify(moduleUrl('cli/commands/cli.js'))});
        const results = {};
        for (const [label, args] of [
            ['outside', ['update', 'all', outside]],
            ['trailing', ['update', 'all', workspaceRoot, 'extra']],
            ['missing', ['update', 'all', path.join(workspaceRoot, 'missing')]],
            ['repoTrailing', ['update', 'repo', 'a', 'b']],
            ['reposTrailing', ['update', 'repos', 'extra']],
        ]) {
            const outcome = await quiet(() => handleCommand(args));
            const value = outcome.value || {};
            results[label] = {
                thrown: outcome.error || null,
                exitCode: value.exitCode,
                activationAllowed: value.activationAllowed,
                records: (value.records || []).map(record => [record.phase, record.outcome, record.code, record.attempted]),
            };
        }
        done({ results, before, after: git(runtimeRoot, 'rev-parse', 'HEAD'), mutations: mutations() });
    `);
    // Every rejection is one failed, unattempted command record with a nonzero exit.
    for (const [label, code] of [
        ['outside', 'PLOINKY_UPDATE_SCOPE_OUTSIDE'],
        ['trailing', 'PLOINKY_UPDATE_REQUEST_INVALID'],
        ['missing', 'PLOINKY_UPDATE_SCOPE_MISSING'],
        ['repoTrailing', 'PLOINKY_UPDATE_REQUEST_INVALID'],
        ['reposTrailing', 'PLOINKY_UPDATE_REQUEST_INVALID'],
    ]) {
        assert.equal(result.results[label].thrown, null, label);
        assert.equal(result.results[label].exitCode, 1, label);
        assert.equal(result.results[label].activationAllowed, false, label);
        assert.deepEqual(result.results[label].records, [['command', 'failed', code, false]], label);
    }
    assert.equal(result.after, result.before, 'the Ploinky self-update did not run');
    assert.deepEqual(result.mutations, []);
});

test('a nested or relative folder limits generic pulls to that folder and returns one record per checkout', () => {
    const result = runScenario(String.raw`
        const top = makeRemote('top');
        const nested = makeRemote('nested');
        const topCheckout = path.join(workspaceRoot, 'top-repo');
        const nestedCheckout = path.join(workspaceRoot, 'sub', 'nested-repo');
        clone(top.remote, topCheckout);
        clone(nested.remote, nestedCheckout);
        const topBefore = git(topCheckout, 'rev-parse', 'HEAD');
        advance(top.seed);
        const nestedUpstream = advance(nested.seed);
        // A developer-owned local AgentLib checkout keeps the non-interactive
        // AgentLib refresh local (no clone or fetch).
        const { writeAgentLibCheckout } = await import(${JSON.stringify(moduleUrl('tests/helpers/agentlibFixture.mjs'))});
        const agentLibSource = path.join(scratch, 'agentlib-source');
        fs.mkdirSync(agentLibSource, { recursive: true });
        git(agentLibSource, 'init', '-q', '-b', 'main');
        writeAgentLibCheckout(agentLibSource);
        git(agentLibSource, 'add', '.');
        git(agentLibSource, 'commit', '-q', '-m', 'agentlib');
        clone(agentLibSource, path.join(workspaceRoot, 'achillesAgentLib'));
        fs.rmSync(process.env.PLOINKY_TEST_GIT_TRACE, { force: true });
        const { handleCommand } = await import(${JSON.stringify(moduleUrl('cli/commands/cli.js'))});
        const outcome = await quiet(() => handleCommand(['update', 'sub']));
        const value = outcome.value || {};
        done({
            error: outcome.error || null,
            topHead: git(topCheckout, 'rev-parse', 'HEAD'),
            topBefore,
            nestedHead: git(nestedCheckout, 'rev-parse', 'HEAD'),
            nestedUpstream,
            nestedCheckout,
            records: (value.records || []).map(record => ({ phase: record.phase, id: record.id, outcome: record.outcome, code: record.code })),
            mutations: mutations(),
        });
    `);
    assert.equal(result.error, null);
    assert.equal(result.nestedHead, result.nestedUpstream);
    assert.equal(result.topHead, result.topBefore, 'a checkout outside the selected folder is not updated');
    assert.ok(result.mutations.every(line => !line.includes('top-repo')), result.mutations.join('\n'));
    const nestedRecords = result.records.filter(record => record.phase === 'workspace-repository');
    assert.deepEqual(nestedRecords.map(record => record.outcome), ['changed']);
    assert.equal(nestedRecords[0].id, result.nestedCheckout);
    assert.ok(result.records.some(record => record.phase === 'host-ploinky'), 'the self-update phase is recorded');
});

test('distinct linked worktrees stay separate operations with their own records', () => {
    const result = runScenario(String.raw`
        const { remote, seed } = makeRemote('shared');
        git(seed, 'push', '-q', 'origin', 'main:feature');
        const mainCheckout = path.join(workspaceRoot, 'main-checkout');
        const linkedCheckout = path.join(workspaceRoot, 'linked-checkout');
        clone(remote, mainCheckout);
        git(mainCheckout, 'worktree', 'add', '-q', '--track', '-b', 'feature', linkedCheckout, 'origin/feature');
        const mainUpstream = advance(seed, 'a.txt', 'main a\n');
        git(seed, 'checkout', '-q', '-b', 'feature', 'origin/feature');
        const featureUpstream = advance(seed, 'b.txt', 'feature b\n', 'feature');
        const commands = await import(${JSON.stringify(moduleUrl('cli/commands/repoAgentCommands.js'))});
        const outcome = await quiet(() => commands.updateAllRepos(workspaceRoot, { interactiveSession: true }));
        done({
            error: outcome.error || null,
            mainHead: git(mainCheckout, 'rev-parse', 'HEAD'),
            linkedHead: git(linkedCheckout, 'rev-parse', 'HEAD'),
            mainUpstream,
            featureUpstream,
            records: (outcome.value?.records || []).filter(record => record.phase === 'workspace-repository')
                .map(record => ({ id: path.basename(record.id), outcome: record.outcome, commonDir: record.details?.checkout?.commonDir })),
        });
    `);
    assert.equal(result.error, null);
    assert.equal(result.mainHead, result.mainUpstream);
    assert.equal(result.linkedHead, result.featureUpstream);
    assert.deepEqual(result.records.map(record => [record.id, record.outcome]).sort(), [
        ['linked-checkout', 'changed'],
        ['main-checkout', 'changed'],
    ]);
    assert.equal(result.records[0].commonDir, result.records[1].commonDir, 'both share one common Git directory lock');
});

test('repositories-only and targeted updates return operation records for registered checkouts', () => {
    const result = runScenario(String.raw`
        const { REPOS_DIR } = await import(${JSON.stringify(moduleUrl('cli/utils/config.js'))});
        const commands = await import(${JSON.stringify(moduleUrl('cli/commands/repoAgentCommands.js'))});
        const { remote, seed } = makeRemote('registered');
        clone(remote, path.join(REPOS_DIR, 'UnitRegistered'));
        for (const name of ['AchillesCopilotBasicSkills', 'DocumentationSkills', 'PloinkySkills']) {
            const source = makeRemote(name, { ['skills/' + name + '-skill/SKILL.md']: '# ' + name + '\n' });
            clone(source.remote, path.join(REPOS_DIR, name));
        }
        const upstream = advance(seed);
        const repos = await quiet(() => commands.updatePloinkyRepos({ interactiveSession: true }));
        const targeted = await quiet(() => commands.updateRepo('UnitRegistered'));
        done({
            upstream,
            head: git(path.join(REPOS_DIR, 'UnitRegistered'), 'rev-parse', 'HEAD'),
            repos: (repos.value?.records || []).filter(record => record.phase === 'registered-repository' && record.id === 'UnitRegistered')
                .map(record => [record.phase, record.id, record.outcome, record.code]),
            phases: [...new Set((repos.value?.records || []).map(record => record.phase))],
            defaultSkills: (repos.value?.records || []).filter(record => record.phase === 'default-skills' && record.details.target === 'UnitRegistered')
                .map(record => [record.id, record.outcome, record.required]),
            targeted: targeted.value?.record ? [targeted.value.record.phase, targeted.value.record.outcome, targeted.value.record.code] : targeted.error,
        });
    `);
    assert.equal(result.head, result.upstream);
    assert.deepEqual(result.repos, [['registered-repository', 'UnitRegistered', 'changed', 'fast-forward']]);
    assert.deepEqual(result.phases, ['agentlib', 'registered-repository', 'default-skills']);
    assert.deepEqual(result.defaultSkills, [
        ['AchillesCopilotBasicSkills->UnitRegistered', 'changed', false],
        ['DocumentationSkills->UnitRegistered', 'changed', false],
        ['PloinkySkills->UnitRegistered', 'changed', false],
    ], 'default skills for a target outside the workspace graph are optional');
    assert.deepEqual(result.targeted, ['registered-repository', 'unchanged', 'current']);
});

for (const dirty of [false, true]) {
    test(`a delegated ancestor Ploinky checkout is ${dirty ? 'preserved when dirty' : 'updated once'} by Core`, () => {
        const result = runScenario(String.raw`
            const commands = await import(${JSON.stringify(moduleUrl('cli/commands/repoAgentCommands.js'))});
            const { remote, seed } = makeRemote('delegated-ploinky', {
                'package.json': JSON.stringify({ name: 'ploinky-cloud', bin: { ploinky: './bin/ploinky' } }),
                'bin/ploinky': 'fixture', 'ploinky-box/bin/ploinky-box.mjs': 'fixture',
                'a.txt': 'a1\n', 'local.txt': 'clean\n',
            });
            const checkout = path.join(workspaceRoot, 'ploinky');
            clone(remote, checkout);
            const nested = path.join(checkout, 'src', 'nested');
            fs.mkdirSync(nested, { recursive: true });
            const before = git(checkout, 'rev-parse', 'HEAD');
            const target = advance(seed);
            if (${dirty}) writeFile(path.join(checkout, 'local.txt'), 'user edit\n');
            fs.writeFileSync(process.env.PLOINKY_TEST_GIT_TRACE, '');
            const outcome = await quiet(() => commands.updateAllRepos(nested, {
                interactiveSession: true, delegatedWorkspacePloinkyPath: checkout,
            }));
            done({ outcome, checkout, before, target, after: git(checkout, 'rev-parse', 'HEAD'),
                local: fs.readFileSync(path.join(checkout, 'local.txt'), 'utf8'), mutations: mutations() });
        `);
        assert.equal(result.outcome.error, undefined);
        const record = result.outcome.value.records.find(entry => entry.details?.checkout?.path === result.checkout);
        assert.ok(record, 'Core must include the ancestor not found by the nested folder scan');
        assert.equal(record.required, true);
        assert.equal(record.outcome, dirty ? 'skipped' : 'changed');
        assert.equal(result.after, dirty ? result.before : result.target);
        assert.equal(result.local, dirty ? 'user edit\n' : 'clean\n');
        assert.equal(result.mutations.filter(line => / fetch /.test(line)).length, dirty ? 0 : 1);
    });
}
