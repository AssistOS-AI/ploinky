import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// P3a/P3b: one structured result per `ploinky update`, graph-derived
// `required` membership, exit status and activation decided separately, the
// host report and the in-Box lease — driven through the public entry points
// (launchCli with the real core dispatcher, handleCommand, updateAllRepos) in
// isolated workspaces with local bare remotes and no network.

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
function advance(seed, rel = 'a.txt', content = 'a2\n') {
    writeFile(path.join(seed, rel), content);
    git(seed, 'add', rel);
    git(seed, 'commit', '-q', '-m', 'advance ' + rel);
    git(seed, 'push', '-q');
    return git(seed, 'rev-parse', 'HEAD');
}
const { REPOS_DIR, PLOINKY_DIR } = await import(${JSON.stringify(moduleUrl('cli/utils/config.js'))});

// Default skill sources, a developer-owned local AgentLib (no clone/fetch),
// and one enabled agent whose repository is therefore required.
function defaultSkillSources() {
    for (const name of ['AchillesCopilotBasicSkills', 'DocumentationSkills', 'PloinkySkills']) {
        const source = makeRemote(name, { ['skills/' + name + '-skill/SKILL.md']: '# ' + name + '\n' });
        clone(source.remote, path.join(REPOS_DIR, name));
    }
}
async function standardWorkspace({ requiredFiles = {} } = {}) {
    defaultSkillSources();
    // These agent-entry manifests use the host global SDK even without an
    // agent package.json. Pin discovery must exercise that input using a local
    // remote; the Git boundary below still refuses every network request.
    const sdk = makeRemote('sdk', { 'package.json': '{"name":"mcp-sdk","version":"1.0.0"}' });
    process.env.PLOINKY_TEST_SDK_REMOTE = sdk.remote;
    const { writeAgentLibCheckout } = await import(${JSON.stringify(moduleUrl('tests/helpers/agentlibFixture.mjs'))});
    const agentLibSource = path.join(scratch, 'agentlib-source');
    fs.mkdirSync(agentLibSource, { recursive: true });
    git(agentLibSource, 'init', '-q', '-b', 'main');
    writeAgentLibCheckout(agentLibSource);
    git(agentLibSource, 'add', '.');
    git(agentLibSource, 'commit', '-q', '-m', 'agentlib');
    clone(agentLibSource, path.join(workspaceRoot, 'achillesAgentLib'));
    const required = makeRemote('RequiredRepo', {
        'demo/manifest.json': JSON.stringify({ container: 'node:20-alpine', agent: 'node index.js' }),
        'a.txt': 'a1\n',
        ...requiredFiles,
    });
    const requiredPath = path.join(REPOS_DIR, 'RequiredRepo');
    clone(required.remote, requiredPath);
    writeFile(path.join(PLOINKY_DIR, 'agents.json'), JSON.stringify({
        ploinky_required_demo: { type: 'agent', repoName: 'RequiredRepo', agentName: 'demo' },
        _config: {},
    }));
    return { required, requiredPath };
}

// launchCli through the real core dispatcher with an owned AgentLib bootstrap.
async function launchUpdate(args, { spawned = [], staged = [] } = {}) {
    const { launchCli } = await import(${JSON.stringify(moduleUrl('cli/index.js'))});
    const { handleCommand } = await import(${JSON.stringify(moduleUrl('cli/commands/cli.js'))});
    const stdout = [];
    const stderr = [];
    const original = { log: console.log, error: console.error, warn: console.warn, out: process.stdout.write.bind(process.stdout) };
    let captured = null;
    console.log = (...values) => stdout.push(values.map(String).join(' '));
    console.error = console.warn = (...values) => stderr.push(values.map(String).join(' '));
    process.stdout.write = chunk => { stdout.push(String(chunk)); return true; };
    let code;
    let thrown = null;
    try {
        code = await launchCli(args, {
            env: { ...process.env },
            errorOutput: { write: chunk => { stderr.push(String(chunk)); return true; } },
            bootstrapAgentLibImpl: async () => ({ owned: true, selection: null }),
            readActiveImpl: () => null,
            importCoreImpl: async () => ({
                runCoreCli: async (coreArgs, options) => {
                    captured = await handleCommand(coreArgs, options);
                    return captured;
                },
            }),
            writeTransactionImpl: (_root, selection) => staged.push(selection?.mode || 'staged'),
            spawnActivationImpl: (command, spawnArgs) => {
                spawned.push(spawnArgs.slice(-2));
                return { status: 0 };
            },
        });
    } catch (error) {
        thrown = String(error?.message || error);
    } finally {
        console.log = original.log;
        console.error = original.error;
        console.warn = original.warn;
        process.stdout.write = original.out;
    }
    return { code, thrown, result: captured, stdout: stdout.join('\n'), stderr: stderr.join('\n'), spawned, staged };
}
const brief = result => (result?.records || []).map(record => [record.phase, record.id, record.outcome, record.code, record.required]);
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
    if (!fs.existsSync(globalConfig)) {
        fs.writeFileSync(globalConfig, '[user]\n\tname = Ploinky Test\n\temail = test@example.invalid\n[init]\n\tdefaultBranch = main\n');
        const realGit = String(execFileSync('which', ['git'], { encoding: 'utf8' })).trim();
        fs.writeFileSync(path.join(bin, 'git'), [
            '#!/bin/sh',
            'printf \'%s\\n\' "$*" >> "$PLOINKY_TEST_GIT_TRACE"',
            `if [ "$1" = ls-remote ] && [ "$2" = -- ] && [ "$3" = https://github.com/AssistOS-AI/MCPSDK.git ] && [ -n "$PLOINKY_TEST_SDK_REMOTE" ]; then shift 3; exec "${realGit}" ls-remote -- "$PLOINKY_TEST_SDK_REMOTE" "$@"; fi`,
            'for arg in "$@"; do case "$arg" in http://*|https://*|ssh://*|git@*) echo "network Git access is not allowed in this test: $arg" >&2; exit 97;; esac; done',
            'if [ -n "$PLOINKY_TEST_SLOW_FETCH" ]; then for arg in "$@"; do if [ "$arg" = fetch ]; then sleep "$PLOINKY_TEST_SLOW_FETCH"; fi; done; fi',
            `exec "${realGit}" "$@"`,
            '',
        ].join('\n'));
        fs.chmodSync(path.join(bin, 'git'), 0o755);
    }
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

function runScenario(body, extraEnv = {}) {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-result-'));
    try {
        const { env, workspaceRoot } = scenarioEnv(scratch, extraEnv);
        const output = execFileSync(process.execPath, ['--input-type=module', '-e', `${PRELUDE}\n${body}`], {
            cwd: workspaceRoot, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
        });
        const line = output.split('\n').find(entry => entry.startsWith('RESULT:'));
        assert.ok(line, `scenario produced a result:\n${output}`);
        return JSON.parse(line.slice('RESULT:'.length));
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
}

test('a complete verified update exits 0 and activates the AgentLib selection', () => {
    const result = runScenario(String.raw`
        const { required } = await standardWorkspace();
        advance(required.seed);
        const run = await launchUpdate(['update', workspaceRoot]);
        done({ code: run.code, thrown: run.thrown, status: run.result.status, records: brief(run.result), spawned: run.spawned, stdout: run.stdout });
    `);
    assert.equal(result.thrown, null);
    assert.equal(result.code, 0);
    assert.equal(result.status, 'complete-with-skips', 'the not-applicable self-update is a named optional skip');
    assert.deepEqual(result.records.find(record => record[0] === 'registered-repository' && record[1] === 'RequiredRepo'),
        ['registered-repository', 'RequiredRepo', 'changed', 'fast-forward', true]);
    assert.deepEqual(result.records.find(record => record[0] === 'agentlib'),
        ['agentlib', 'achillesAgentLib', 'changed', 'local-checkout', true]);
    assert.deepEqual(result.spawned, [['--agentlib-activate-transaction', 'commit']]);
    assert.match(result.stdout, /Update complete with named skips/);
    assert.match(result.stdout, /achillesAgentLib activation: commit completed; final update status: complete-with-skips \(exit 0\)/);
});

test('a dirty required repository alone blocks activation and exits nonzero without spawning activation', () => {
    const result = runScenario(String.raw`
        const { required, requiredPath } = await standardWorkspace();
        advance(required.seed);
        writeFile(path.join(requiredPath, 'a.txt'), 'local edit\n');
        const head = git(requiredPath, 'rev-parse', 'HEAD');
        const run = await launchUpdate(['update', workspaceRoot]);
        done({
            code: run.code, thrown: run.thrown, result: {
                status: run.result.status, exitCode: run.result.exitCode, activationAllowed: run.result.activationAllowed,
                blockedBy: run.result.blockedBy, errors: run.result.errors, failed: run.result.failed.length,
            },
            spawned: run.spawned, staged: run.staged, stderr: run.stderr,
            headKept: git(requiredPath, 'rev-parse', 'HEAD') === head,
            bytes: fs.readFileSync(path.join(requiredPath, 'a.txt'), 'utf8'),
        });
    `);
    assert.equal(result.thrown, null);
    assert.equal(result.code, 1);
    assert.equal(result.result.exitCode, 1);
    assert.equal(result.result.activationAllowed, false);
    assert.equal(result.result.status, 'failed');
    assert.deepEqual(result.result.errors, [], 'no operation failed');
    assert.equal(result.result.failed, 0);
    assert.deepEqual(result.result.blockedBy, [
        { phase: 'registered-repository', id: 'RequiredRepo', outcome: 'skipped', code: 'dirty-worktree' },
        { phase: 'git-pin', id: 'ploinky_required_demo', outcome: 'skipped', code: 'git-pin-source-not-verified' },
    ]);
    assert.deepEqual(result.spawned, [], 'the AgentLib activation child was not spawned');
    assert.deepEqual(result.staged, [], 'no AgentLib transaction was staged');
    assert.match(result.stderr, /achillesAgentLib activation is pending: blocked by registered-repository RequiredRepo \(skipped, dirty-worktree\)/);
    assert.match(result.stderr, /Update failed: required inputs are not verified/);
    assert.ok(result.headKept);
    assert.equal(result.bytes, 'local edit\n');
});

test('a required repository failure through CLI dispatch: nonzero exit, records and wording agree', () => {
    const result = runScenario(String.raw`
        const { requiredPath } = await standardWorkspace();
        git(requiredPath, 'remote', 'set-url', 'origin', path.join(scratch, 'missing-remote'));
        const run = await launchUpdate(['update', workspaceRoot]);
        done({ code: run.code, status: run.result.status, records: brief(run.result), spawned: run.spawned, stderr: run.stderr, failed: run.result.failed.map(entry => entry.repoName) });
    `);
    assert.equal(result.code, 1);
    assert.equal(result.status, 'failed');
    assert.deepEqual(result.records.find(record => record[1] === 'RequiredRepo'),
        ['registered-repository', 'RequiredRepo', 'failed', 'fetch-failed', true]);
    assert.deepEqual(result.failed, ['RequiredRepo']);
    assert.deepEqual(result.spawned, []);
    assert.match(result.stderr, /Update completed with 1 error\(s\):/);
    assert.match(result.stderr, /Update failed: required inputs are not verified/);
    assert.match(result.stderr, /registered-repository RequiredRepo: failed \(fetch-failed, required\)/);
    assert.doesNotMatch(result.stderr + result.stdout, /Update complete:/);
});

test('an optional workspace repository failure exits nonzero but still allows activation', () => {
    const result = runScenario(String.raw`
        await standardWorkspace();
        const optional = makeRemote('optional');
        const optionalPath = path.join(workspaceRoot, 'projects', 'optional');
        clone(optional.remote, optionalPath);
        advance(optional.seed, 'new.txt', 'upstream\n');
        writeFile(path.join(optionalPath, 'new.txt'), 'local untracked\n');
        const run = await launchUpdate(['update', workspaceRoot]);
        done({ code: run.code, status: run.result.status, activationAllowed: run.result.activationAllowed,
            records: brief(run.result).filter(record => record[0] === 'workspace-repository'), spawned: run.spawned, stderr: run.stderr });
    `);
    assert.equal(result.code, 1);
    assert.equal(result.status, 'partial');
    assert.equal(result.activationAllowed, true);
    assert.equal(result.records.length, 1);
    assert.deepEqual(result.records[0].slice(2), ['failed', 'untracked-would-be-overwritten', false]);
    assert.deepEqual(result.spawned, [['--agentlib-activate-transaction', 'commit']]);
    assert.match(result.stderr, /final update status: partial \(exit 1\)/);
});

test('an in-Box update with no host report defers AgentLib, holds the lease and names host activation', async () => {
    const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ploinky-update-lease-'));
    try {
        const { env, workspaceRoot } = scenarioEnv(scratch, { PLOINKY_TEST_IN_BOX: '1', PLOINKY_TEST_SLOW_FETCH: '1.5' });
        const leaseFile = path.join(workspaceRoot, '.ploinky', 'running', 'workspace-start.json');
        const updater = String.raw`
            ${PRELUDE}
            defaultSkillSources();
            const { remote, seed } = makeRemote('Registered');
            clone(remote, path.join(REPOS_DIR, 'Registered'));
            advance(seed);
            const { handleCommand } = await import(${JSON.stringify(moduleUrl('cli/commands/cli.js'))});
            const out = [];
            const log = console.log;
            console.log = (...values) => out.push(values.map(String).join(' '));
            const result = await handleCommand(['update', 'repos']);
            console.log = log;
            done({ records: brief(result), exitCode: result.exitCode, status: result.status, attempted: result.totals.attempted,
                notice: out.some(line => line.includes('activate it from the host with \`ploinky update\` or \`ploinky restart\`')) });
        `;
        const contender = String.raw`
            import fs from 'node:fs';
            const leaseFile = ${JSON.stringify(leaseFile)};
            const deadline = Date.now() + 20000;
            while (!fs.existsSync(leaseFile) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20));
            const lease = JSON.parse(fs.readFileSync(leaseFile, 'utf8'));
            const { createWorkspaceMutationLease } = await import(${JSON.stringify(moduleUrl('cli/utils/runtime/maintenanceLocks.js'))});
            let refused = null;
            try { createWorkspaceMutationLease({ operation: 'contender' }); refused = false; } catch (error) { refused = error.code; }
            process.stdout.write('RESULT:' + JSON.stringify({ operation: lease.operation, refused }) + '\n');
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
        const parse = value => JSON.parse(value.out.split('\n').find(line => line.startsWith('RESULT:')).slice(7));
        assert.equal(update.code, 0, update.err);
        assert.equal(second.code, 0, second.err);
        const updateResult = parse(update);
        const contenderResult = parse(second);
        assert.equal(contenderResult.operation, 'update');
        assert.equal(contenderResult.refused, 'PLOINKY_WORKSPACE_MUTATION_BUSY', 'a second mutation is refused while the update runs');
        assert.equal(fs.existsSync(leaseFile), false, 'the lease is released afterwards');
        assert.ok(updateResult.notice);
        assert.deepEqual(updateResult.records.find(record => record[0] === 'agentlib'),
            ['agentlib', 'achillesAgentLib', 'deferred', 'owned-by-host', false]);
        assert.equal(updateResult.exitCode, 0, 'host-owned AgentLib is not a failure in the Box');
    } finally {
        fs.rmSync(scratch, { recursive: true, force: true });
    }
});

test('zero-attempt in-Box repositories update is complete with named deferrals', () => {
    const result = runScenario(String.raw`
        const { handleCommand } = await import(${JSON.stringify(moduleUrl('cli/commands/cli.js'))});
        const result = await handleCommand(['update', 'repos']);
        done({ records: brief(result), exitCode: result.exitCode, status: result.status, totals: result.totals, activationAllowed: result.activationAllowed });
    `, { PLOINKY_TEST_IN_BOX: '1' });
    assert.deepEqual(result.records, [['agentlib', 'achillesAgentLib', 'deferred', 'owned-by-host', false]]);
    assert.equal(result.totals.attempted, 0);
    assert.equal(result.exitCode, 0);
    assert.equal(result.status, 'complete-with-skips');
    assert.equal(result.activationAllowed, true);
});

test('a host-requested report is published once with the echoed context and keeps the nonzero exit', () => {
    const nonce = 'a'.repeat(32);
    const context = { workspace: '/w', scope: '.', generation: 'g1' };
    const result = runScenario(String.raw`
        const { required, requiredPath } = await standardWorkspace();
        advance(required.seed);
        writeFile(path.join(requiredPath, 'a.txt'), 'local edit\n');
        const { handleCommand } = await import(${JSON.stringify(moduleUrl('cli/commands/cli.js'))});
        const { readUpdateReport } = await import(${JSON.stringify(moduleUrl('cli/commands/updateOutcome.js'))});
        const out = [];
        const write = process.stdout.write.bind(process.stdout);
        const log = console.log;
        console.log = (...values) => out.push(values.map(String).join(' '));
        process.stdout.write = chunk => { out.push(String(chunk)); return true; };
        const result = await handleCommand(['update', workspaceRoot]);
        console.log = log;
        process.stdout.write = write;
        const report = readUpdateReport(PLOINKY_DIR, process.env.PLOINKY_UPDATE_REPORT_NONCE, { expectedContext: ${JSON.stringify(context)} });
        const reports = fs.readdirSync(path.join(PLOINKY_DIR, 'running', 'update-reports'));
        const reportBytes = fs.readFileSync(path.join(PLOINKY_DIR, 'running', 'update-reports', reports[0]), 'utf8');
        done({
            ok: report.ok, reportExit: report.result?.exitCode, reportActivation: report.result?.activationAllowed,
            reportContext: report.result?.context, exitCode: result.exitCode, reports,
            userinfo: /[a-z][a-z0-9+.-]*:\/\/[^\s\/@"]+@/i.test(reportBytes), reportSize: reportBytes.length,
            leaked: out.some(line => line.includes(process.env.PLOINKY_UPDATE_REPORT_NONCE) || line.includes('ploinky-update-report')),
        });
    `, { PLOINKY_UPDATE_REPORT_NONCE: nonce, PLOINKY_UPDATE_REPORT_CONTEXT: JSON.stringify(context) });
    assert.equal(result.ok, true);
    assert.equal(result.exitCode, 1);
    assert.equal(result.reportExit, 1);
    assert.equal(result.reportActivation, false);
    assert.deepEqual(result.reportContext, context);
    assert.deepEqual(result.reports, [`${nonce}.json`]);
    assert.equal(result.leaked, false, 'the control report never goes to stdout');
    assert.equal(result.userinfo, false, 'the persisted report carries no URL credentials');
    assert.ok(result.reportSize < 512 * 1024, `report size ${result.reportSize} stays far below the 4 MB cap`);
});

test('a malformed report context is published as null and a thrown update still publishes a report', () => {
    const nonce = 'b'.repeat(32);
    const result = runScenario(String.raw`
        const { runUpdateCommand } = await import(${JSON.stringify(moduleUrl('cli/commands/updateCommand.js'))});
        const { readUpdateReport } = await import(${JSON.stringify(moduleUrl('cli/commands/updateOutcome.js'))});
        const quiet = () => {};
        const thrown = await runUpdateCommand([], {
            insideBox: true,
            handlers: { updateAllRepos: async () => { throw new Error('unexpected failure mid-update'); } },
            log: quiet, error: quiet,
        });
        const report = readUpdateReport(PLOINKY_DIR, process.env.PLOINKY_UPDATE_REPORT_NONCE);
        const mismatch = readUpdateReport(PLOINKY_DIR, process.env.PLOINKY_UPDATE_REPORT_NONCE, { expectedContext: { any: 1 } });
        let second = null;
        try {
            await runUpdateCommand([], { handlers: { updateAllRepos: async () => { throw new Error('again'); } }, log: quiet, error: quiet })
                .then(result => { second = result.records.map(record => [record.code, record.outcome]); });
        } catch (error) { second = String(error); }
        done({ records: brief(thrown), exitCode: thrown.exitCode, ok: report.ok, context: report.result?.context,
            mismatch: mismatch.code, second });
    `, { PLOINKY_UPDATE_REPORT_NONCE: nonce, PLOINKY_UPDATE_REPORT_CONTEXT: '{not json' });
    assert.deepEqual(result.records, [['command', 'update', 'uncertain', 'update-threw', null]]);
    assert.equal(result.exitCode, 1);
    assert.equal(result.ok, true);
    assert.equal(result.context, null);
    assert.equal(result.mismatch, 'report-context-mismatch');
    assert.deepEqual(result.second, [['update-threw', 'uncertain'], ['report-publication-failed', 'uncertain']],
        'a second publication for the same nonce is refused and recorded, never overwritten');
});

test('phase records: thrown self-update, skipped self-update count, skipped workspace, interactive deferral and partial manifests', () => {
    const result = runScenario(String.raw`
        const commands = await import(${JSON.stringify(moduleUrl('cli/commands/repoAgentCommands.js'))});
        await standardWorkspace();
        const quiet = async operation => {
            const original = { log: console.log, error: console.error, warn: console.warn };
            const out = [];
            console.log = console.error = console.warn = (...values) => out.push(values.map(String).join(' '));
            try { return { value: await operation(), out }; } finally { Object.assign(console, original); }
        };
        // Thrown self-update: a failed, attempted record (not a graph input).
        const thrown = await quiet(() => commands.updateAllRepos(workspaceRoot, {
            updateSelf: async () => { throw new Error('self-update exploded'); },
        }));
        // A dirty host checkout is a named, optional skip: reported, not blocking.
        const { createOperationRecord } = await import(${JSON.stringify(moduleUrl('cli/commands/updateOutcome.js'))});
        const dirtyRecord = createOperationRecord({ phase: 'host-ploinky', id: '/host/ploinky', outcome: 'skipped', code: 'dirty-worktree', reason: 'uncommitted changes' });
        const dirtySelf = await quiet(() => commands.updateAllRepos(workspaceRoot, {
            updateSelf: async () => ({ skipped: true, code: 'dirty-worktree', reason: 'uncommitted changes', record: dirtyRecord }),
        }));
        // Skipped self-update is not counted (prototype contract).
        const skippedSelf = await quiet(() => commands.updateAllRepos(workspaceRoot));
        // Skipped workspace repository with an unreachable remote.
        const unreachable = path.join(workspaceRoot, 'unreachable');
        const other = makeRemote('unreachable');
        clone(other.remote, unreachable);
        fs.rmSync(other.remote, { recursive: true, force: true });
        const skippedWorkspace = await quiet(() => commands.updateAllRepos(workspaceRoot));
        fs.rmSync(unreachable, { recursive: true, force: true });
        // Interactive deferral of AgentLib is named but optional.
        const interactive = await quiet(() => commands.updateAllRepos(workspaceRoot, { interactiveSession: true }));
        // Partial phase: one valid and one invalid skills manifest.
        writeFile(path.join(workspaceRoot, 'aa-bad', 'ploinky-skills-manifest.json'), '{invalid');
        writeFile(path.join(workspaceRoot, 'zz-good', 'ploinky-skills-manifest.json'), JSON.stringify([{
            name: 'DocumentationSkills', url: path.join(scratch, 'remotes', 'DocumentationSkills.git'), skills: ['DocumentationSkills-skill'],
        }]));
        const partial = await quiet(() => commands.updateAllRepos(workspaceRoot));
        const pick = (run, phase) => brief(run.value).filter(record => record[0] === phase);
        done({
            thrown: { self: pick(thrown, 'host-ploinky'), failed: thrown.value.failed.map(entry => entry.repoName), exitCode: thrown.value.exitCode,
                total: thrown.value.total, updated: thrown.value.updated },
            dirtySelf: { self: pick(dirtySelf, 'host-ploinky'), exitCode: dirtySelf.value.exitCode, activationAllowed: dirtySelf.value.activationAllowed,
                status: dirtySelf.value.status, skipped: dirtySelf.value.skipped.map(entry => [entry.repoName, entry.code]) },
            skippedSelf: { self: pick(skippedSelf, 'host-ploinky'), total: skippedSelf.value.total, updated: skippedSelf.value.updated,
                line: skippedSelf.out.find(line => line.startsWith('Update summary:')), exitCode: skippedSelf.value.exitCode, status: skippedSelf.value.status },
            skippedWorkspace: { records: pick(skippedWorkspace, 'workspace-repository'), exitCode: skippedWorkspace.value.exitCode, status: skippedWorkspace.value.status,
                legacy: skippedWorkspace.value.skipped.map(entry => [entry.repoName, entry.code]) },
            interactive: { agentlib: pick(interactive, 'agentlib'), exitCode: interactive.value.exitCode, blockedBy: interactive.value.blockedBy },
            partial: { manifests: pick(partial, 'skills-manifest').map(record => [path.basename(record[1]), record[2], record[4]]),
                status: partial.value.status, exitCode: partial.value.exitCode, activationAllowed: partial.value.activationAllowed },
        });
    `);
    // The running Ploinky is not one of the graph's required inputs; a failure still exits nonzero.
    assert.deepEqual(result.thrown.self.map(record => [record[2], record[3], record[4]]), [['failed', 'self-update-error', false]]);

    assert.deepEqual(result.dirtySelf.self.map(record => [record[2], record[3], record[4]]), [['skipped', 'dirty-worktree', false]]);
    assert.equal(result.dirtySelf.exitCode, 0);
    assert.equal(result.dirtySelf.activationAllowed, true);
    assert.equal(result.dirtySelf.status, 'complete-with-skips');
    assert.deepEqual(result.dirtySelf.skipped, [['ploinky', 'dirty-worktree']]);
    assert.ok(result.thrown.failed.includes('ploinky'));
    assert.equal(result.thrown.exitCode, 1);
    assert.equal(result.thrown.total - result.thrown.updated, 1, 'a thrown self-update is a failed attempt');

    // The fixture's running Ploinky checkout is outside the workspace folder.
    assert.deepEqual(result.skippedSelf.self.map(record => [record[2], record[3], record[4]]), [['skipped', 'scope-excluded', false]]);
    assert.equal(result.skippedSelf.updated, result.skippedSelf.total, 'a skipped self-update is not counted as failed');
    assert.equal(result.skippedSelf.line,
        `Update summary: ${result.skippedSelf.updated}/${result.skippedSelf.total} update operations succeeded (Ploinky self-update skipped).`);
    assert.equal(result.skippedSelf.exitCode, 0);
    assert.equal(result.skippedSelf.status, 'complete-with-skips');

    assert.deepEqual(result.skippedWorkspace.records.map(record => [record[2], record[3], record[4]]), [['skipped', 'remote-unreachable', false]]);
    assert.deepEqual(result.skippedWorkspace.legacy, [['unreachable', 'remote-unreachable']]);
    assert.equal(result.skippedWorkspace.exitCode, 0, 'an optional named skip is not a failure');
    assert.equal(result.skippedWorkspace.status, 'complete-with-skips');

    // An interactive session names the AgentLib deferral without failing or blocking.
    assert.deepEqual(result.interactive.agentlib.map(record => [record[2], record[3], record[4]]), [['deferred', 'interactive-session', false]]);
    assert.equal(result.interactive.exitCode, 0);
    assert.deepEqual(result.interactive.blockedBy, []);

    assert.deepEqual(result.partial.manifests, [['aa-bad', 'failed', false], ['zz-good', 'changed', false]]);
    assert.equal(result.partial.status, 'partial');
    assert.equal(result.partial.exitCode, 1);
    assert.equal(result.partial.activationAllowed, true);
});

test('steady state: a required repository that received default skills stays clean and updates on the next run', () => {
    // Default skills no longer write the tracked .gitignore (P4 private
    // exclusions), so the second update verifies the repository instead of
    // preserving it as dirty and blocking activation.
    const result = runScenario(String.raw`
        const commands = await import(${JSON.stringify(moduleUrl('cli/commands/repoAgentCommands.js'))});
        await standardWorkspace({ requiredFiles: { '.gitignore': 'node_modules/\n' } });
        const quiet = async operation => {
            const original = { log: console.log, error: console.error, warn: console.warn };
            console.log = console.error = console.warn = () => {};
            try { return await operation(); } finally { Object.assign(console, original); }
        };
        const first = await quiet(() => commands.updateAllRepos(workspaceRoot));
        const second = await quiet(() => commands.updateAllRepos(workspaceRoot));
        const pick = run => brief(run).find(record => record[1] === 'RequiredRepo');
        const repoPath = second.records.find(record => record.id === 'RequiredRepo')?.details?.checkout?.path
            || first.records.find(record => record.id === 'RequiredRepo')?.details?.checkout?.path;
        const trackedChanges = repoPath
            ? git(repoPath, 'status', '--porcelain', '--untracked-files=no')
            : 'unknown';
        done({ first: pick(first), second: pick(second), trackedChanges });
    `);
    assert.deepEqual(result.first.slice(2), ['unchanged', 'current', true]);
    assert.deepEqual(result.second.slice(2), ['unchanged', 'current', true]);
    assert.equal(result.trackedChanges, '', 'no tracked file was modified by default skills');
});

test('a failed activation after verified inputs is recorded, restores the prior selection and rejects', async () => {
    const contract = await import('../../agentlib/contract.mjs');
    const { writeAgentLibCheckout } = await import('../helpers/agentlibFixture.mjs');
    const { buildSelection } = await import('../../agentlib/source.mjs');
    const { launchCli } = await import('../../cli/index.js');
    const { buildCoreUpdateResult } = await import('../../cli/commands/updateRecords.js');
    const { createOperationRecord } = await import('../../cli/commands/updateOutcome.js');
    const workspace = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'ploinky-update-activation-'));
    try {
        fs.mkdirSync(path.join(workspace, '.ploinky'), { recursive: true });
        writeAgentLibCheckout(path.join(workspace, contract.AGENTLIB_LOCAL_DIR_NAME));
        const prior = buildSelection({ workspaceRoot: workspace, sourceDir: path.join(workspace, contract.AGENTLIB_LOCAL_DIR_NAME), mode: 'local' });
        const candidateDir = path.join(workspace, '.ploinky', 'agentlib', 'generations', 'candidate');
        writeAgentLibCheckout(candidateDir);
        const candidate = buildSelection({
            workspaceRoot: workspace, sourceDir: candidateDir, mode: 'managed',
            remoteUrl: 'https://example.invalid/achillesAgentLib.git', resolvedCommit: '3'.repeat(40),
        });
        const verified = buildCoreUpdateResult({
            command: ['update'],
            records: [createOperationRecord({ phase: 'agentlib', id: 'achillesAgentLib', outcome: 'changed', required: true })],
            agentLib: { selection: candidate, previous: prior },
        });
        const env = { PLOINKY_WORKSPACE_ROOT: workspace };
        const staged = [];
        const stderr = [];
        let spawnCalls = 0;
        await assert.rejects(launchCli(['update'], {
            env,
            errorOutput: { write: chunk => { stderr.push(String(chunk)); return true; } },
            bootstrapAgentLibImpl: async () => {
                Object.assign(env, contract.agentLibRuntimeEnv(prior, prior.sourceDir));
                return { owned: true, selection: prior };
            },
            readActiveImpl: () => prior,
            importCoreImpl: async () => ({ runCoreCli: async () => verified }),
            writeTransactionImpl: (_root, value) => staged.push(value),
            spawnActivationImpl: () => ({ status: spawnCalls++ === 0 ? 23 : 0 }),
        }), error => {
            assert.match(error.message, /activation failed with status 23/);
            assert.equal(error.result.status, 'failed');
            assert.deepEqual(error.result.records.at(-1).phase, 'activation');
            assert.equal(error.result.records.at(-1).outcome, 'failed');
            return true;
        });
        assert.deepEqual(staged, [candidate, prior], 'the exact prior selection is staged for restoration');
        assert.equal(spawnCalls, 2);
        assert.match(stderr.join(''), /achillesAgentLib activation: failed; final update status: failed \(exit 1\)/);
    } finally {
        fs.rmSync(workspace, { recursive: true, force: true });
    }
});
